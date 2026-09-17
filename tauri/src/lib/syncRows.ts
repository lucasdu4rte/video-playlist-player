import type { Stamped } from "@/lib/lww";
import type { DirtyBatch, VideoRecord } from "@/lib/store";
import { fromRelPath, toRelPath } from "@/lib/libraryPath";

export type { DirtyBatch };
export type MappedLibrary = { id: string; root: string };

export type VideoStateRow = {
  library_id: string;
  rel_path: string;
  watched: boolean;
  position: number | null;
  duration: number | null;
  updated_at: string;
};

export type NoteRow = {
  library_id: string;
  rel_path: string;
  text: string;
  updated_at: string;
};

export type RecordReaders = {
  video: (path: string) => VideoRecord;
  note: (path: string) => Stamped<string>;
};

type Place = { libraryId: string; relPath: string };

// Nested roots are separate libraries, so one file can belong to several.
// A rel_path containing a backslash fails the SQL CHECK constraint even on
// POSIX (a literal backslash in a filename), so such a place is dropped here
// rather than sent to the server.
function placesOf(path: string, libraries: MappedLibrary[], sep: string): Place[] {
  return libraries.flatMap((library) => {
    const relPath = toRelPath(path, library.root, sep);
    return relPath === null || relPath.includes("\\") ? [] : [{ libraryId: library.id, relPath }];
  });
}

function hasAnyPlace(path: string, libraries: MappedLibrary[], sep: string): boolean {
  return libraries.some((library) => toRelPath(path, library.root, sep) !== null);
}

const iso = (ms: number) => new Date(Math.max(ms, 1)).toISOString();

// Postgres text columns reject a NUL byte outright and choke on an unpaired
// UTF-16 surrogate, so either one left in a note stalls every push forever.
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function sanitizeText(text: string): string {
  return text.replace(/\u0000/g, "").replace(UNPAIRED_SURROGATE, "\uFFFD");
}

export function toSyncRows(
  batch: DirtyBatch,
  libraries: MappedLibrary[],
  sep: string,
  read: RecordReaders
): { videos: VideoStateRow[]; notes: NoteRow[]; unmatched: DirtyBatch; invalid: DirtyBatch } {
  const videos: VideoStateRow[] = [];
  const notes: NoteRow[] = [];
  const unmatched: DirtyBatch = { videos: [], notes: [] };
  const invalid: DirtyBatch = { videos: [], notes: [] };

  for (const path of batch.videos) {
    const places = placesOf(path, libraries, sep);
    if (places.length === 0) {
      (hasAnyPlace(path, libraries, sep) ? invalid : unmatched).videos.push(path);
      continue;
    }
    const { watched, position, duration, updatedAt } = read.video(path);
    for (const { libraryId, relPath } of places)
      videos.push({
        library_id: libraryId,
        rel_path: relPath,
        watched,
        position,
        duration,
        updated_at: iso(updatedAt),
      });
  }

  for (const path of batch.notes) {
    const places = placesOf(path, libraries, sep);
    if (places.length === 0) {
      (hasAnyPlace(path, libraries, sep) ? invalid : unmatched).notes.push(path);
      continue;
    }
    const { value, updatedAt } = read.note(path);
    const text = sanitizeText(value);
    for (const { libraryId, relPath } of places)
      notes.push({ library_id: libraryId, rel_path: relPath, text, updated_at: iso(updatedAt) });
  }

  return { videos, notes, unmatched, invalid };
}

type SyncedRow = { library_id: string; rel_path: string; updated_at: string };

function byLocalPath<R extends SyncedRow, T>(
  rows: R[],
  libraries: MappedLibrary[],
  sep: string,
  valueOf: (row: R, updatedAt: number) => T
): Record<string, Stamped<T>> {
  const roots = new Map(libraries.map((library) => [library.id, library.root]));
  const records: Record<string, Stamped<T>> = {};
  for (const row of rows) {
    const root = roots.get(row.library_id);
    if (root === undefined) continue;
    const path = fromRelPath(row.rel_path, root, sep);
    const updatedAt = Date.parse(row.updated_at);
    if ((records[path]?.updatedAt ?? -1) >= updatedAt) continue;
    records[path] = { value: valueOf(row, updatedAt), updatedAt };
  }
  return records;
}

export function toLocalVideos(
  rows: VideoStateRow[],
  libraries: MappedLibrary[],
  sep: string
): Record<string, Stamped<VideoRecord>> {
  return byLocalPath(rows, libraries, sep, (row, updatedAt) => ({
    watched: row.watched,
    position: row.position,
    duration: row.duration,
    updatedAt,
  }));
}

export function toLocalNotes(
  rows: NoteRow[],
  libraries: MappedLibrary[],
  sep: string
): Record<string, Stamped<string>> {
  return byLocalPath(rows, libraries, sep, (row) => row.text);
}
