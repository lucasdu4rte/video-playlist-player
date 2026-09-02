// localStorage stand-in for the Swift app's UserDefaults stores.

const KEYS = {
  watched: "watchedPaths.v1",
  progress: "videoProgress.v1",
  notes: "notes.v1",
  recents: "recentFolders.v1",
  speed: "playbackSpeed.v1",
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

// Rust returns backslash paths on Windows, forward slashes elsewhere. Decide
// once from the platform: sniffing each path would pick "\" for a POSIX folder
// whose name merely contains a backslash.
const SEP = navigator.userAgent.includes("Windows") ? "\\" : "/";

// Appended unconditionally, so a root path yields "//" (or "C:\\") and matches
// nothing — trimming a trailing separator here would make "remove everything
// under /" delete every stored key.
function underPrefix(path: string) {
  return path + SEP;
}

class WatchedStore {
  watched = new Set<string>(read<string[]>(KEYS.watched, []));
  progress = read<Record<string, number>>(KEYS.progress, {});

  contains(path: string) {
    return this.watched.has(path);
  }
  setWatched(path: string, value: boolean) {
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
  getProgress(path: string): number | undefined {
    return this.progress[path];
  }
  setProgress(path: string, seconds: number) {
    this.progress[path] = seconds;
    write(KEYS.progress, this.progress);
  }
  clearProgress(path: string) {
    if (!(path in this.progress)) return;
    delete this.progress[path];
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
    let changed = false;
    for (const p of [...this.watched]) {
      if (p.startsWith(prefix)) {
        this.watched.delete(p);
        changed = true;
      }
    }
    if (changed) write(KEYS.watched, [...this.watched]);
    let progressChanged = false;
    for (const p of Object.keys(this.progress)) {
      if (p.startsWith(prefix)) {
        delete this.progress[p];
        progressChanged = true;
      }
    }
    if (progressChanged) write(KEYS.progress, this.progress);
  }
}

class NotesStore {
  notes = read<Record<string, string>>(KEYS.notes, {});

  note(path: string) {
    return this.notes[path] ?? "";
  }
  setNote(text: string, path: string) {
    if (text.length === 0) delete this.notes[path];
    else this.notes[path] = text;
    write(KEYS.notes, this.notes);
  }
  notesCount(folderPath: string) {
    const prefix = underPrefix(folderPath);
    let n = 0;
    for (const p of Object.keys(this.notes)) if (p.startsWith(prefix)) n++;
    return n;
  }
  removeAll(folderPath: string) {
    const prefix = underPrefix(folderPath);
    let changed = false;
    for (const p of Object.keys(this.notes)) {
      if (p.startsWith(prefix)) {
        delete this.notes[p];
        changed = true;
      }
    }
    if (changed) write(KEYS.notes, this.notes);
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
  record(path: string, name: string) {
    const now = Date.now();
    const idx = this.folders.findIndex((f) => f.path === path);
    if (idx >= 0) {
      const [existing] = this.folders.splice(idx, 1);
      existing.lastOpenedAt = now;
      existing.name = name;
      this.folders.unshift(existing);
    } else {
      this.folders.unshift({ id: crypto.randomUUID(), name, path, lastOpenedAt: now });
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

export const Watched = new WatchedStore();
export const Notes = new NotesStore();
export const Recents = new RecentFoldersStore();

export function getSpeed(): number {
  return read<number>(KEYS.speed, 1.0);
}
export function setSpeed(value: number) {
  write(KEYS.speed, value);
}
