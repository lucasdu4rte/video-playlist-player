import type { Account } from "@/lib/auth";
import { newerKeys } from "@/lib/lww";
import { SEP } from "@/lib/platform";
import {
  Dirty,
  LocalChanges,
  Notes,
  Playback,
  Recents,
  SyncCursor,
  Watched,
  applyNoteRecord,
  applyVideoRecord,
  noteRecord,
  videoRecord,
} from "@/lib/store";
import { getSupabase } from "@/lib/supabase";
import {
  toLocalNotes,
  toLocalVideos,
  toSyncRows,
  type MappedLibrary,
  type NoteRow,
  type VideoStateRow,
} from "@/lib/syncRows";

export type RemoteLibrary = { id: string; name: string };
export type LinkRequest = { path: string; name: string; candidates: RemoteLibrary[] };

/** Fires "change" after a pull wrote remote records into the local stores. */
export const RemoteChanges = new EventTarget();

const PUSH_DELAY_MS = 30_000;
const PAGE_SIZE = 1000; // matches max_rows in supabase/config.toml
// synced_at is the server clock at transaction start, so a slow transaction can
// commit a row older than the cursor we already advanced past. Re-reading a
// minute is cheap: newerKeys drops anything already applied.
const PULL_OVERLAP_MS = 60_000;

type Synced<Row> = Row & { synced_at: string };

let account: Account | null = null;
let remoteLibraries: RemoteLibrary[] = [];
let librariesLoaded = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<void> = Promise.resolve();

// The returned promise settles with the task's own outcome, but `queue` itself
// only ever resolves — a failed task must not poison every task queued after it.
function serialized(task: () => Promise<void>): Promise<void> {
  const result = queue.then(task);
  queue = result.catch((error: unknown) => console.error("sync failed", error));
  return result;
}

function mappedLibraries(): MappedLibrary[] {
  return remoteLibraries.flatMap(({ id }) => {
    const root = Recents.pathFor(id);
    return root === null ? [] : [{ id, root }];
  });
}

function unmappedLibraries(): RemoteLibrary[] {
  return remoteLibraries.filter(({ id }) => Recents.pathFor(id) === null);
}

// Values saved before signing in carry no dirty mark; queue them so the first
// push uploads the library's history.
function markLibraryDirty(root: string) {
  const prefix = root + SEP;
  const under = (paths: Iterable<string>) => [...paths].filter((path) => path.startsWith(prefix));
  const videoPaths = new Set([
    ...Watched.watched,
    ...Object.keys(Watched.progress),
    ...Object.keys(Playback.durations),
  ]);
  Dirty.restore({ videos: under(videoPaths), notes: under(Notes.paths()) });
}

async function callSync(fn: "sync_video_state" | "sync_notes", rows: VideoStateRow[] | NoteRow[]) {
  const supabase = await getSupabase();
  const { error } = await supabase.rpc(fn, { rows });
  if (error) throw error;
}

async function push(): Promise<void> {
  if (!account || Dirty.isEmpty()) return;
  const batch = Dirty.take();
  const rows = toSyncRows(batch, mappedLibraries(), SEP, { video: videoRecord, note: noteRecord });
  if (rows.invalid.videos.length + rows.invalid.notes.length > 0)
    console.error("dropping unsyncable paths", rows.invalid);
  try {
    if (rows.videos.length > 0) await callSync("sync_video_state", rows.videos);
    if (rows.notes.length > 0) await callSync("sync_notes", rows.notes);
    Dirty.done();
    Dirty.restore(rows.unmatched);
  } catch (error) {
    Dirty.restore(batch);
    schedulePush();
    throw error;
  }
}

function schedulePush() {
  if (pushTimer !== null) return;
  // Counted from the first change rather than reset by each one: progress is
  // saved every 5 s while playing, which would postpone a sliding debounce forever.
  pushTimer = setTimeout(() => void flushNow(), PUSH_DELAY_MS);
}

// Rejects on failure, for callers (linkLibrary) that need to know the push failed.
function flush(): Promise<void> {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = null;
  if (!account) return Promise.resolve();
  return serialized(push);
}

/** Same as `flush`, but swallows and logs — safe for fire-and-forget callers. */
export function flushNow(): Promise<void> {
  return flush().catch((error: unknown) => console.error("flush failed", error));
}

// RLS already scopes this to the owner's libraries plus whatever a guest is
// allowed to see, so no owner_id filter is needed (and one would drop guests'
// shared libraries).
async function refreshLibraries() {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from("libraries").select("id, name");
  if (error) throw error;
  remoteLibraries = data as RemoteLibrary[];
  librariesLoaded = true;
}

type PulledRow = { library_id: string; rel_path: string };

// Offset paging would skip or repeat rows while another device writes
// concurrently; a keyset on (synced_at, library_id, rel_path) does not.
async function pullSince<Row extends PulledRow>(
  fn: "pull_video_state" | "pull_notes",
  since: string
): Promise<Synced<Row>[]> {
  const supabase = await getSupabase();
  const rows: Synced<Row>[] = [];
  let afterLibrary: string | null = null;
  let afterPath: string | null = null;
  for (;;) {
    const { data, error } = await supabase.rpc(fn, {
      since,
      after_library: afterLibrary,
      after_path: afterPath,
      max_rows: PAGE_SIZE,
    });
    if (error) throw error;
    const page = data as unknown as Synced<Row>[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    const last = page[page.length - 1];
    since = last.synced_at;
    afterLibrary = last.library_id;
    afterPath = last.rel_path;
  }
}

function localStamps(paths: string[], stampOf: (path: string) => number): Record<string, number> {
  return Object.fromEntries(paths.map((path) => [path, stampOf(path)]));
}

async function pull(full = false): Promise<void> {
  if (!account) return;
  await refreshLibraries();
  const libraries = mappedLibraries();
  const cursor = Date.parse(SyncCursor.get() ?? "") || 0;
  const since = new Date(full ? 0 : Math.max(0, cursor - PULL_OVERLAP_MS)).toISOString();
  const [videoRows, noteRows] = await Promise.all([
    pullSince<VideoStateRow>("pull_video_state", since),
    pullSince<NoteRow>("pull_notes", since),
  ]);
  // Signed out while the fetches were in flight: don't apply stale data or move the cursor.
  if (!account) return;

  const videos = toLocalVideos(videoRows, libraries, SEP);
  const notes = toLocalNotes(noteRows, libraries, SEP);
  const videoKeys = Object.keys(videos);
  const noteKeys = Object.keys(notes);
  const newVideos = newerKeys(localStamps(videoKeys, (p) => videoRecord(p).updatedAt), videos);
  const newNotes = newerKeys(localStamps(noteKeys, (p) => noteRecord(p).updatedAt), notes);
  for (const path of newVideos) applyVideoRecord(path, videos[path].value);
  for (const path of newNotes) applyNoteRecord(path, notes[path]);

  const latest = [...videoRows, ...noteRows].reduce(
    (max, row) => Math.max(max, Date.parse(row.synced_at)),
    cursor
  );
  if (latest > cursor) SyncCursor.set(new Date(latest).toISOString());
  if (newVideos.length + newNotes.length > 0) RemoteChanges.dispatchEvent(new Event("change"));
}

// With unlinked remote libraries around, a local folder may be one of them, so
// it waits for the linking dialog instead of being registered as new.
async function registerRecents() {
  if (unmappedLibraries().length > 0) return;
  const known = new Set(remoteLibraries.map(({ id }) => id));
  for (const folder of Recents.folders) {
    const id = Recents.libraryIdFor(folder.path);
    // registerRecents already runs inside a queued task, so it calls the
    // unqueued helper directly — awaiting the queued upsertLibrary here would
    // deadlock on the very task that's running it.
    if (!known.has(id)) await registerLibrary(id, folder.name);
  }
}

async function registerLibrary(libraryId: string, name: string): Promise<void> {
  if (!account) return;
  const now = new Date().toISOString();
  const supabase = await getSupabase();
  const { error } = await supabase.from("libraries").upsert({
    id: libraryId,
    owner_id: account.userId,
    name,
    last_opened_at: now,
    updated_at: now,
  });
  if (error) throw error;
  if (!remoteLibraries.some(({ id }) => id === libraryId))
    remoteLibraries = [...remoteLibraries, { id: libraryId, name }];
  // Re-pushing unchanged values is harmless (SQL LWW ignores them), so this
  // always marks the library dirty rather than only on its first registration.
  const root = Recents.pathFor(libraryId);
  if (root !== null) markLibraryDirty(root);
  schedulePush();
}

export function upsertLibrary(libraryId: string, name: string): Promise<void> {
  return serialized(() => registerLibrary(libraryId, name));
}

/**
 * Registers a folder opened while signed in, or resolves to the choice the
 * user has to make first. The decision runs inside the sync queue, after the
 * library list has loaded at least once this sign-in — deciding against a
 * still-empty `remoteLibraries` right after sign-in would register a folder
 * that actually belongs on another device as a brand-new (duplicate) library.
 * Never rejects: a queue failure just means no link dialog this time.
 */
export async function registerOpenedLibrary(path: string, name: string): Promise<LinkRequest | null> {
  if (!account) return null;
  let request: LinkRequest | null = null;
  try {
    await serialized(async () => {
      if (!librariesLoaded) await refreshLibraries();
      const id = Recents.libraryIdFor(path);
      const known = remoteLibraries.some((library) => library.id === id);
      const candidates = known ? [] : unmappedLibraries();
      if (candidates.length > 0) {
        request = { path, name, candidates };
        return;
      }
      // registerLibrary, not the queued upsertLibrary: we're already inside
      // the queue, and awaiting upsertLibrary here would deadlock on the
      // very task that's running it.
      await registerLibrary(id, name);
    });
  } catch (error) {
    console.error("library sync failed", error);
    return null;
  }
  return request;
}

export async function linkLibrary(path: string, libraryId: string, name: string): Promise<void> {
  Recents.link(path, libraryId);
  await upsertLibrary(libraryId, name);
  // Rows for this library were skipped by earlier pulls while it had no local path.
  await serialized(() => pull(true));
  await flush();
}

export function startSync(signedIn: Account): () => void {
  account = signedIn;
  const onDirty = () => schedulePush();
  const onFocus = () => void serialized(pull).catch(() => {});
  const onFlush = () => void flushNow();

  LocalChanges.addEventListener("dirty", onDirty);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onFlush);
  window.addEventListener("beforeunload", onFlush);
  void serialized(async () => {
    await pull();
    await registerRecents();
  }).catch(() => {});
  if (!Dirty.isEmpty()) schedulePush();

  return () => {
    LocalChanges.removeEventListener("dirty", onDirty);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("online", onFlush);
    window.removeEventListener("beforeunload", onFlush);
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = null;
    account = null;
    remoteLibraries = [];
    librariesLoaded = false;
  };
}
