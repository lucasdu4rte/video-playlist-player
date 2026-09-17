import type { Stamped } from "@/lib/lww";
import { SEP } from "@/lib/platform";

const KEYS = {
  watched: "watchedPaths.v1",
  progress: "videoProgress.v1",
  notes: "notes.v1",
  recents: "recentFolders.v1",
  speed: "playbackSpeed.v1",
  durations: "videoDuration.v1",
  lastPlayed: "lastPlayed.v1",
  videoStamps: "videoStamps.v1",
  noteStamps: "noteStamps.v1",
  dirty: "syncDirty.v1",
  libraryIds: "libraryIds.v1",
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

// Appended unconditionally, so a root path yields "//" (or "C:\\") and matches
// nothing — trimming a trailing separator here would make "remove everything
// under /" delete every stored key.
function underPrefix(path: string) {
  return path + SEP;
}

// Timestamps sit beside the values rather than inside them, so stored values
// keep their original shape and an older build still reads them. A missing
// stamp reads as 0 and therefore loses to any remote write.
class StampMap {
  private stamps: Record<string, number>;

  constructor(private key: string) {
    this.stamps = read<Record<string, number>>(key, {});
  }
  get(path: string): number {
    return this.stamps[path] ?? 0;
  }
  set(path: string, at: number) {
    this.stamps[path] = at;
    write(this.key, this.stamps);
  }
  // Keeps stamps monotonic per path so a local edit made after applying a
  // remote record from a fast clock still stamps ahead of it and wins.
  bumpMany(paths: string[]) {
    if (paths.length === 0) return;
    const now = Date.now();
    paths.forEach((p) => {
      this.stamps[p] = Math.max(now, this.get(p) + 1);
    });
    write(this.key, this.stamps);
  }
}

const videoStamps = new StampMap(KEYS.videoStamps);
const noteStamps = new StampMap(KEYS.noteStamps);

export const LocalChanges = new EventTarget();

export type DirtyBatch = { videos: string[]; notes: string[] };

class DirtyStore {
  private videos: Set<string>;
  private notes: Set<string>;

  constructor() {
    const saved = read<DirtyBatch>(KEYS.dirty, { videos: [], notes: [] });
    this.videos = new Set(saved.videos);
    this.notes = new Set(saved.notes);
  }
  markVideo(path: string) {
    this.markVideos([path]);
  }
  markNote(path: string) {
    this.markNotes([path]);
  }
  markVideos(paths: string[]) {
    if (paths.length === 0) return;
    videoStamps.bumpMany(paths);
    paths.forEach((p) => this.videos.add(p));
    this.changed();
  }
  markNotes(paths: string[]) {
    if (paths.length === 0) return;
    noteStamps.bumpMany(paths);
    paths.forEach((p) => this.notes.add(p));
    this.changed();
  }
  take(): DirtyBatch {
    const batch = { videos: [...this.videos], notes: [...this.notes] };
    this.videos.clear();
    this.notes.clear();
    this.persist();
    return batch;
  }
  restore(batch: DirtyBatch) {
    batch.videos.forEach((p) => this.videos.add(p));
    batch.notes.forEach((p) => this.notes.add(p));
    this.persist();
  }
  isEmpty() {
    return this.videos.size === 0 && this.notes.size === 0;
  }
  private changed() {
    this.persist();
    LocalChanges.dispatchEvent(new Event("dirty"));
  }
  private persist() {
    write(KEYS.dirty, { videos: [...this.videos], notes: [...this.notes] });
  }
}

export const Dirty = new DirtyStore();

class WatchedStore {
  watched = new Set<string>(read<string[]>(KEYS.watched, []));
  progress = read<Record<string, number>>(KEYS.progress, {});

  contains(path: string) {
    return this.watched.has(path);
  }
  setWatched(path: string, value: boolean) {
    this.writeWatched(path, value);
    Dirty.markVideo(path);
  }
  getProgress(path: string): number | undefined {
    return this.progress[path];
  }
  setProgress(path: string, seconds: number) {
    this.progress[path] = seconds;
    write(KEYS.progress, this.progress);
    Dirty.markVideo(path);
  }
  clearProgress(path: string) {
    if (!(path in this.progress)) return;
    delete this.progress[path];
    write(KEYS.progress, this.progress);
    Dirty.markVideo(path);
  }
  applyRemote(path: string, watched: boolean, position: number | null) {
    this.writeWatched(path, watched);
    if (watched || position === null) {
      if (!(path in this.progress)) return;
      delete this.progress[path];
    } else {
      this.progress[path] = position;
    }
    write(KEYS.progress, this.progress);
  }
  watchedCount(folderPath: string) {
    const prefix = underPrefix(folderPath);
    let n = 0;
    for (const p of this.watched) if (p.startsWith(prefix)) n++;
    return n;
  }
  removeAll(folderPath: string) {
    const prefix = underPrefix(folderPath);
    const cleared = new Set<string>();
    for (const p of this.watched) if (p.startsWith(prefix)) cleared.add(p);
    for (const p of Object.keys(this.progress)) if (p.startsWith(prefix)) cleared.add(p);
    if (cleared.size === 0) return;
    for (const p of cleared) {
      this.watched.delete(p);
      delete this.progress[p];
    }
    write(KEYS.watched, [...this.watched]);
    write(KEYS.progress, this.progress);
    Dirty.markVideos([...cleared]);
  }
  private writeWatched(path: string, value: boolean) {
    if (value) {
      this.watched.add(path);
      if (path in this.progress) {
        delete this.progress[path];
        write(KEYS.progress, this.progress);
      }
    } else {
      this.watched.delete(path);
    }
    write(KEYS.watched, [...this.watched]);
  }
}

class NotesStore {
  notes = read<Record<string, string>>(KEYS.notes, {});

  note(path: string) {
    return this.notes[path] ?? "";
  }
  paths(): string[] {
    return Object.keys(this.notes);
  }
  setNote(text: string, path: string) {
    this.writeNote(text, path);
    Dirty.markNote(path);
  }
  applyRemote(text: string, path: string) {
    this.writeNote(text, path);
  }
  notesCount(folderPath: string) {
    const prefix = underPrefix(folderPath);
    let n = 0;
    for (const p of Object.keys(this.notes)) if (p.startsWith(prefix)) n++;
    return n;
  }
  removeAll(folderPath: string) {
    const prefix = underPrefix(folderPath);
    const cleared = Object.keys(this.notes).filter((p) => p.startsWith(prefix));
    if (cleared.length === 0) return;
    cleared.forEach((p) => delete this.notes[p]);
    write(KEYS.notes, this.notes);
    Dirty.markNotes(cleared);
  }
  private writeNote(text: string, path: string) {
    if (text.length === 0) delete this.notes[path];
    else this.notes[path] = text;
    write(KEYS.notes, this.notes);
  }
}

export type RecentFolder = {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: number;
};

const PER_PAGE = 8;

class RecentFoldersStore {
  folders = read<RecentFolder[]>(KEYS.recents, []).sort(
    (a, b) => b.lastOpenedAt - a.lastOpenedAt
  );
  // Outlives removal from recents: the id keys synced progress, so reopening a
  // folder must get the same one back.
  private libraryIds = read<Record<string, string>>(KEYS.libraryIds, {});

  constructor() {
    const missing = this.folders.filter((f) => !(f.path in this.libraryIds));
    if (missing.length === 0) return;
    missing.forEach((f) => (this.libraryIds[f.path] = f.id));
    write(KEYS.libraryIds, this.libraryIds);
  }

  get pageCount() {
    const total = this.folders.length;
    return total <= PER_PAGE ? 1 : Math.ceil(total / PER_PAGE);
  }
  page(index: number) {
    if (this.folders.length === 0) return [];
    const clamped = Math.max(0, Math.min(index, this.pageCount - 1));
    const start = clamped * PER_PAGE;
    return this.folders.slice(start, start + PER_PAGE);
  }
  libraryIdFor(path: string): string {
    const known = this.libraryIds[path];
    if (known) return known;
    const id = crypto.randomUUID();
    this.libraryIds[path] = id;
    write(KEYS.libraryIds, this.libraryIds);
    return id;
  }
  pathFor(libraryId: string): string | null {
    const entry = Object.entries(this.libraryIds).find(([, id]) => id === libraryId);
    return entry ? entry[0] : null;
  }
  link(path: string, libraryId: string) {
    this.libraryIds[path] = libraryId;
    write(KEYS.libraryIds, this.libraryIds);
    const folder = this.folders.find((f) => f.path === path);
    if (!folder) return;
    folder.id = libraryId;
    this.persist();
  }
  record(path: string, name: string) {
    const now = Date.now();
    const idx = this.folders.findIndex((f) => f.path === path);
    if (idx >= 0) {
      const [existing] = this.folders.splice(idx, 1);
      existing.lastOpenedAt = now;
      existing.name = name;
      this.folders.unshift(existing);
    } else {
      this.folders.unshift({ id: this.libraryIdFor(path), name, path, lastOpenedAt: now });
    }
    this.persist();
  }
  remove(id: string) {
    this.folders = this.folders.filter((f) => f.id !== id);
    this.persist();
  }
  persist() {
    write(KEYS.recents, this.folders);
  }
}

export type LastPlayed = {
  path: string;
  name: string;
  folderName: string;
  rootPath: string;
  at: number;
};

// Durations are only known once a video has been opened; they turn the stored
// resume position into a percentage for the "continue watching" card.
class PlaybackStore {
  durations = read<Record<string, number>>(KEYS.durations, {});
  last = read<LastPlayed | null>(KEYS.lastPlayed, null);

  duration(path: string): number | undefined {
    return this.durations[path];
  }
  setDuration(path: string, seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    if (this.durations[path] === seconds) return;
    this.durations[path] = seconds;
    write(KEYS.durations, this.durations);
    Dirty.markVideo(path);
  }
  applyRemoteDuration(path: string, seconds: number | null) {
    if (seconds === null) return;
    if (this.durations[path] === seconds) return;
    this.durations[path] = seconds;
    write(KEYS.durations, this.durations);
  }
  setLastPlayed(entry: LastPlayed) {
    this.last = entry;
    write(KEYS.lastPlayed, entry);
  }
  clearLastPlayedUnder(folderPath: string) {
    if (!this.last) return;
    const prefix = underPrefix(folderPath);
    if (!this.last.path.startsWith(prefix)) return;
    this.last = null;
    write(KEYS.lastPlayed, null);
  }
}

export const Watched = new WatchedStore();
export const Playback = new PlaybackStore();
export const Notes = new NotesStore();
export const Recents = new RecentFoldersStore();

export type VideoRecord = {
  watched: boolean;
  position: number | null;
  duration: number | null;
  updatedAt: number;
};

export function videoRecord(path: string): VideoRecord {
  return {
    watched: Watched.contains(path),
    position: Watched.getProgress(path) ?? null,
    duration: Playback.duration(path) ?? null,
    updatedAt: videoStamps.get(path),
  };
}

export function applyVideoRecord(path: string, record: VideoRecord) {
  Watched.applyRemote(path, record.watched, record.position);
  Playback.applyRemoteDuration(path, record.duration);
  videoStamps.set(path, record.updatedAt);
}

export function noteRecord(path: string): Stamped<string> {
  return { value: Notes.note(path), updatedAt: noteStamps.get(path) };
}

export function applyNoteRecord(path: string, record: Stamped<string>) {
  Notes.applyRemote(record.value, path);
  noteStamps.set(path, record.updatedAt);
}

export function getShowDetails(): boolean {
  return read<boolean>("showDetails.v1", true);
}
export function setShowDetails(value: boolean) {
  write("showDetails.v1", value);
}

export function getSpeed(): number {
  return read<number>(KEYS.speed, 1.0);
}
export function setSpeed(value: number) {
  write(KEYS.speed, value);
}

export const AUTH_STORAGE_KEY = "supabaseAuth.v1";

export function hasStoredSession(): boolean {
  return localStorage.getItem(AUTH_STORAGE_KEY) !== null;
}

const SYNC_CURSOR_KEY = "syncCursor.v1";

export const SyncCursor = {
  get(): string | null {
    return read<string | null>(SYNC_CURSOR_KEY, null);
  },
  set(iso: string) {
    write(SYNC_CURSOR_KEY, iso);
  },
  clear() {
    localStorage.removeItem(SYNC_CURSOR_KEY);
  },
};
