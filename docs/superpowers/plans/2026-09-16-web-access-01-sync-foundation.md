# Sync Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every locally stored video state and note a timestamp and a dirty flag, give every opened folder a stable library id, and add the path translation the sync layer needs — with no network and no visible change.

**Architecture:** Timestamps live in side maps (`videoStamps.v1`, `noteStamps.v1`) next to the existing keys, so no stored value changes shape and nothing needs migrating; a missing stamp reads as `0`, which loses to any remote write. Every existing store mutator stamps and marks dirty. Pure helpers (`libraryPath.ts`, `lww.ts`) carry the logic that later plans build on, and are the only new code with tests.

**Tech Stack:** React 19 + TypeScript, Vite 6.4, vitest 5.0.1 (new devDependency).

**Spec:** `docs/superpowers/specs/2026-09-16-web-access-design.md`
**Index / shared contract:** `docs/superpowers/plans/2026-09-16-web-access-00-index.md`

## Global Constraints

All constraints in the index apply. Additionally:

- No stored value changes format. Existing keys (`watchedPaths.v1`, `videoProgress.v1`, `notes.v1`, `recentFolders.v1`, `videoDuration.v1`, `lastPlayed.v1`) are read and written exactly as today.
- No component other than the ones listed below changes, and no user-visible behaviour changes.

**Deviation from spec, on purpose:** the spec says local entries "become `{ value, updatedAt }`". This plan keeps values untouched and stores `updatedAt` in parallel maps instead. Same semantics, zero migration, and a rollback to the previous build still reads its data.

---

## File Structure

| File | Responsibility |
|---|---|
| `tauri/package.json` | Adds `vitest` devDependency and `test` script |
| `tauri/src/lib/libraryPath.ts` (new) | Absolute path ↔ `rel_path`, synthetic web paths |
| `tauri/src/lib/libraryPath.test.ts` (new) | Tests for the above, including Windows separators |
| `tauri/src/lib/lww.ts` (new) | `Stamped<T>` and `newerKeys` |
| `tauri/src/lib/lww.test.ts` (new) | Tests for `newerKeys` |
| `tauri/src/lib/platform.ts` | Exports `SEP` decided from the platform mode |
| `tauri/src/lib/store.ts` | Imports `SEP`; adds stamps, `Dirty`, `LocalChanges`, record helpers, stable library ids |
| `tauri/src/lib/store.test.ts` (new) | Tests stamping, dirty tracking, remote apply, library ids |

---

### Task 1: vitest and path translation

**Files:**
- Modify: `tauri/package.json`
- Create: `tauri/src/lib/libraryPath.ts`
- Test: `tauri/src/lib/libraryPath.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function toRelPath(path: string, root: string, sep: string): string | null;
  export function fromRelPath(relPath: string, root: string, sep: string): string;
  export function webPath(libraryId: string, relPath: string): string;
  export function parseWebPath(path: string): { libraryId: string; relPath: string } | null;
  ```

- [ ] **Step 1: Install vitest and add the script**

Run from `tauri/`:
```bash
npm install --save-dev vitest@5.0.1
```
Then add to `"scripts"` in `tauri/package.json`:
```json
    "test": "vitest run",
```
so the block reads:
```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "tauri": "tauri"
  },
```
vitest picks up `vite.config.ts`, so the `@/` alias works in tests with no extra config.

- [ ] **Step 2: Write the failing tests**

Create `tauri/src/lib/libraryPath.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fromRelPath, parseWebPath, toRelPath, webPath } from "./libraryPath";

describe("toRelPath", () => {
  it("strips the root on POSIX", () => {
    expect(toRelPath("/Courses/Rust/01 Intro/a.mp4", "/Courses/Rust", "/")).toBe(
      "01 Intro/a.mp4"
    );
  });

  it("converts Windows separators to forward slashes", () => {
    expect(
      toRelPath("C:\\Courses\\Rust\\01 Intro\\a.mp4", "C:\\Courses\\Rust", "\\")
    ).toBe("01 Intro/a.mp4");
  });

  it("returns null for a sibling folder that shares a name prefix", () => {
    expect(toRelPath("/Courses/Rust2/a.mp4", "/Courses/Rust", "/")).toBeNull();
  });

  it("returns null for the root itself", () => {
    expect(toRelPath("/Courses/Rust", "/Courses/Rust", "/")).toBeNull();
  });

  it("keeps a backslash that is part of a POSIX file name", () => {
    expect(toRelPath("/Courses/Rust/a\\b.mp4", "/Courses/Rust", "/")).toBe("a\\b.mp4");
  });
});

describe("fromRelPath", () => {
  it("joins with the platform separator", () => {
    expect(fromRelPath("01 Intro/a.mp4", "C:\\Courses\\Rust", "\\")).toBe(
      "C:\\Courses\\Rust\\01 Intro\\a.mp4"
    );
  });

  it("round-trips with toRelPath on POSIX", () => {
    const abs = "/Courses/Rust/01 Intro/a.mp4";
    const rel = toRelPath(abs, "/Courses/Rust", "/")!;
    expect(fromRelPath(rel, "/Courses/Rust", "/")).toBe(abs);
  });
});

describe("webPath / parseWebPath", () => {
  it("builds a synthetic path", () => {
    expect(webPath("lib-1", "01 Intro/a.mp4")).toBe("/lib-1/01 Intro/a.mp4");
  });

  it("parses it back", () => {
    expect(parseWebPath("/lib-1/01 Intro/a.mp4")).toEqual({
      libraryId: "lib-1",
      relPath: "01 Intro/a.mp4",
    });
  });

  it("rejects paths without a relative part", () => {
    expect(parseWebPath("/lib-1")).toBeNull();
    expect(parseWebPath("/lib-1/")).toBeNull();
    expect(parseWebPath("lib-1/a.mp4")).toBeNull();
  });

  it("is consistent with toRelPath using the library root", () => {
    expect(toRelPath(webPath("lib-1", "a/b.mp4"), "/lib-1", "/")).toBe("a/b.mp4");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- src/lib/libraryPath.test.ts`
Expected: FAIL — `Failed to resolve import "./libraryPath"`.

- [ ] **Step 4: Implement**

Create `tauri/src/lib/libraryPath.ts`:
```ts
export function toRelPath(path: string, root: string, sep: string): string | null {
  const prefix = root + sep;
  if (!path.startsWith(prefix)) return null;
  const rel = path.slice(prefix.length);
  if (!rel) return null;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

export function fromRelPath(relPath: string, root: string, sep: string): string {
  return root + sep + relPath.split("/").join(sep);
}

export function webPath(libraryId: string, relPath: string): string {
  return `/${libraryId}/${relPath}`;
}

export function parseWebPath(
  path: string
): { libraryId: string; relPath: string } | null {
  if (!path.startsWith("/")) return null;
  const slash = path.indexOf("/", 1);
  if (slash < 0) return null;
  const relPath = path.slice(slash + 1);
  if (!relPath) return null;
  return { libraryId: path.slice(1, slash), relPath };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/lib/libraryPath.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add tauri/package.json tauri/package-lock.json tauri/src/lib/libraryPath.ts tauri/src/lib/libraryPath.test.ts
git commit -m "feat(tauri): translate library paths for sync"
```

---

### Task 2: Last-write-wins helper

**Files:**
- Create: `tauri/src/lib/lww.ts`
- Test: `tauri/src/lib/lww.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type Stamped<T> = { value: T; updatedAt: number };
  export function newerKeys<T>(
    local: Record<string, number>,
    remote: Record<string, Stamped<T>>
  ): string[];
  ```

- [ ] **Step 1: Write the failing test**

Create `tauri/src/lib/lww.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newerKeys } from "./lww";

describe("newerKeys", () => {
  it("picks remote entries strictly newer than local ones", () => {
    const local = { a: 100, b: 200, c: 300 };
    const remote = {
      a: { value: "x", updatedAt: 150 },
      b: { value: "y", updatedAt: 200 },
      c: { value: "z", updatedAt: 250 },
    };
    expect(newerKeys(local, remote)).toEqual(["a"]);
  });

  it("treats a key missing locally as stamped at zero", () => {
    expect(newerKeys({}, { a: { value: 1, updatedAt: 1 } })).toEqual(["a"]);
  });

  it("never lets a zero-stamped remote beat a missing local entry", () => {
    expect(newerKeys({}, { a: { value: 1, updatedAt: 0 } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/lww.test.ts`
Expected: FAIL — `Failed to resolve import "./lww"`.

- [ ] **Step 3: Implement**

Create `tauri/src/lib/lww.ts`:
```ts
export type Stamped<T> = { value: T; updatedAt: number };

export function newerKeys<T>(
  local: Record<string, number>,
  remote: Record<string, Stamped<T>>
): string[] {
  return Object.keys(remote).filter(
    (key) => remote[key].updatedAt > (local[key] ?? 0)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/lww.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/lib/lww.ts tauri/src/lib/lww.test.ts
git commit -m "feat(tauri): add last-write-wins helper"
```

---

### Task 3: Separator from the platform, not the browser

The web build will use `/`-separated synthetic paths. Deciding `SEP` from the user agent would hand a guest on Windows `\`, and `watchedCount`/`removeAll` would silently match nothing.

**Files:**
- Modify: `tauri/src/lib/platform.ts` (after the `isTauri` export, currently line 17)
- Modify: `tauri/src/lib/store.ts:21-24`

**Interfaces:**
- Consumes: `isTauri` (existing).
- Produces: `export const SEP: "/" | "\\";`

- [ ] **Step 1: Export `SEP` from `platform.ts`**

In `tauri/src/lib/platform.ts`, directly below
```ts
export const isTauri = "__TAURI_INTERNALS__" in window;
```
add:
```ts

// Rust returns backslash paths on Windows, forward slashes elsewhere; the web
// build only ever sees "/"-separated synthetic paths. Decide once from the
// platform: sniffing each path would pick "\" for a POSIX folder whose name
// merely contains a backslash.
export const SEP: "/" | "\\" =
  isTauri && navigator.userAgent.includes("Windows") ? "\\" : "/";
```

- [ ] **Step 2: Use it in `store.ts`**

In `tauri/src/lib/store.ts`, replace:
```ts
// Rust returns backslash paths on Windows, forward slashes elsewhere. Decide
// once from the platform: sniffing each path would pick "\" for a POSIX folder
// whose name merely contains a backslash.
const SEP = navigator.userAgent.includes("Windows") ? "\\" : "/";
```
with nothing, and add at the top of the file:
```ts
import { SEP } from "@/lib/platform";
```

- [ ] **Step 3: Type-check and build**

Run: `npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: both succeed with no errors or warnings.

- [ ] **Step 4: Commit**

```bash
git add tauri/src/lib/platform.ts tauri/src/lib/store.ts
git commit -m "fix(tauri): decide the path separator from the platform mode"
```

---

### Task 4: Stamps, dirty tracking and record helpers in the stores

**Files:**
- Modify: `tauri/src/lib/store.ts`
- Test: `tauri/src/lib/store.test.ts`

**Interfaces:**
- Consumes: `Stamped<T>` from `@/lib/lww`; `SEP` from `@/lib/platform`.
- Produces (exact, per index):
  ```ts
  export type VideoRecord = { watched: boolean; position: number | null; duration: number | null; updatedAt: number };
  export function videoRecord(path: string): VideoRecord;
  export function applyVideoRecord(path: string, record: VideoRecord): void;
  export function noteRecord(path: string): Stamped<string>;
  export function applyNoteRecord(path: string, record: Stamped<string>): void;
  export const Dirty: { take(); restore(batch); isEmpty(); markVideo(path); markNote(path) };
  export const LocalChanges: EventTarget; // dispatches Event("dirty")
  export type DirtyBatch = { videos: string[]; notes: string[] };
  ```
  `markVideo`/`markNote` are used only inside `store.ts`.

- [ ] **Step 1: Write the failing tests**

Create `tauri/src/lib/store.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// store.ts only needs SEP from platform.ts; mocking it keeps the Tauri bridge
// (which reads `window` at import time) out of the Node test environment.
vi.mock("@/lib/platform", () => ({ SEP: "/" }));

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

async function freshStore() {
  vi.resetModules();
  vi.stubGlobal("localStorage", memoryStorage());
  return import("./store");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

describe("video stamps and dirty tracking", () => {
  it("stamps and marks dirty when a video is watched", async () => {
    const s = await freshStore();
    s.Watched.setWatched("/lib/a.mp4", true);
    expect(s.videoRecord("/lib/a.mp4")).toEqual({
      watched: true,
      position: null,
      duration: null,
      updatedAt: 1_000,
    });
    expect(s.Dirty.take()).toEqual({ videos: ["/lib/a.mp4"], notes: [] });
    expect(s.Dirty.isEmpty()).toBe(true);
  });

  it("stamps progress and duration writes", async () => {
    const s = await freshStore();
    s.Watched.setProgress("/lib/a.mp4", 42);
    vi.setSystemTime(2_000);
    s.Playback.setDuration("/lib/a.mp4", 600);
    expect(s.videoRecord("/lib/a.mp4")).toEqual({
      watched: false,
      position: 42,
      duration: 600,
      updatedAt: 2_000,
    });
  });

  it("does not stamp a duration that did not change", async () => {
    const s = await freshStore();
    s.Playback.setDuration("/lib/a.mp4", 600);
    s.Dirty.take();
    vi.setSystemTime(5_000);
    s.Playback.setDuration("/lib/a.mp4", 600);
    expect(s.videoRecord("/lib/a.mp4").updatedAt).toBe(1_000);
    expect(s.Dirty.isEmpty()).toBe(true);
  });

  it("marks every cleared video dirty on removeAll", async () => {
    const s = await freshStore();
    s.Watched.setWatched("/lib/a.mp4", true);
    s.Watched.setProgress("/lib/b.mp4", 10);
    s.Watched.setWatched("/other/c.mp4", true);
    s.Dirty.take();
    vi.setSystemTime(3_000);
    s.Watched.removeAll("/lib");
    expect(s.Dirty.take().videos.sort()).toEqual(["/lib/a.mp4", "/lib/b.mp4"]);
    expect(s.videoRecord("/lib/a.mp4")).toMatchObject({ watched: false, updatedAt: 3_000 });
    expect(s.videoRecord("/lib/b.mp4")).toMatchObject({ position: null, updatedAt: 3_000 });
  });

  it("fires a dirty event", async () => {
    const s = await freshStore();
    const listener = vi.fn();
    s.LocalChanges.addEventListener("dirty", listener);
    s.Notes.setNote("hi", "/lib/a.mp4");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("persists the dirty set across reloads", async () => {
    const s = await freshStore();
    s.Notes.setNote("hi", "/lib/a.mp4");
    const storage = localStorage;
    vi.resetModules();
    vi.stubGlobal("localStorage", storage);
    const reloaded = await import("./store");
    expect(reloaded.Dirty.take()).toEqual({ videos: [], notes: ["/lib/a.mp4"] });
  });

  it("restores a batch after a failed push", async () => {
    const s = await freshStore();
    s.Watched.setWatched("/lib/a.mp4", true);
    const batch = s.Dirty.take();
    s.Dirty.restore(batch);
    expect(s.Dirty.take()).toEqual(batch);
  });
});

describe("remote apply", () => {
  it("applies a video record without marking it dirty", async () => {
    const s = await freshStore();
    s.applyVideoRecord("/lib/a.mp4", {
      watched: false,
      position: 90,
      duration: 600,
      updatedAt: 9_000,
    });
    expect(s.videoRecord("/lib/a.mp4")).toEqual({
      watched: false,
      position: 90,
      duration: 600,
      updatedAt: 9_000,
    });
    expect(s.Dirty.isEmpty()).toBe(true);
  });

  it("drops the position when the remote record is watched", async () => {
    const s = await freshStore();
    s.Watched.setProgress("/lib/a.mp4", 30);
    s.applyVideoRecord("/lib/a.mp4", {
      watched: true,
      position: 30,
      duration: null,
      updatedAt: 9_000,
    });
    expect(s.videoRecord("/lib/a.mp4")).toMatchObject({ watched: true, position: null });
  });

  it("applies and clears notes without marking them dirty", async () => {
    const s = await freshStore();
    s.applyNoteRecord("/lib/a.mp4", { value: "remote", updatedAt: 7_000 });
    expect(s.noteRecord("/lib/a.mp4")).toEqual({ value: "remote", updatedAt: 7_000 });
    s.applyNoteRecord("/lib/a.mp4", { value: "", updatedAt: 8_000 });
    expect(s.Notes.paths()).toEqual([]);
    expect(s.noteRecord("/lib/a.mp4")).toEqual({ value: "", updatedAt: 8_000 });
    expect(s.Dirty.isEmpty()).toBe(true);
  });

  it("reads an unstamped legacy entry as updatedAt 0", async () => {
    vi.resetModules();
    const storage = memoryStorage();
    storage.setItem("notes.v1", JSON.stringify({ "/lib/a.mp4": "old" }));
    vi.stubGlobal("localStorage", storage);
    const s = await import("./store");
    expect(s.noteRecord("/lib/a.mp4")).toEqual({ value: "old", updatedAt: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/store.test.ts`
Expected: FAIL — `s.videoRecord is not a function` (and similar for `Dirty`, `LocalChanges`, `applyVideoRecord`, `applyNoteRecord`, `noteRecord`).

- [ ] **Step 3: Add keys, stamp maps, `Dirty` and `LocalChanges`**

In `tauri/src/lib/store.ts`, add to the imports:
```ts
import type { Stamped } from "@/lib/lww";
```
Extend `KEYS`:
```ts
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
```
Directly after the `underPrefix` function, add:
```ts
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
    videoStamps.set(path, Date.now());
    this.videos.add(path);
    this.changed();
  }
  markNote(path: string) {
    noteStamps.set(path, Date.now());
    this.notes.add(path);
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
```

- [ ] **Step 4: Stamp every `WatchedStore` mutation and add a remote apply**

Replace the whole `WatchedStore` class with:
```ts
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
    cleared.forEach((p) => Dirty.markVideo(p));
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
```

- [ ] **Step 5: Stamp `NotesStore` and add a remote apply**

Replace the whole `NotesStore` class with:
```ts
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
    cleared.forEach((p) => Dirty.markNote(p));
  }
  private writeNote(text: string, path: string) {
    if (text.length === 0) delete this.notes[path];
    else this.notes[path] = text;
    write(KEYS.notes, this.notes);
  }
}
```

- [ ] **Step 6: Stamp `Playback.setDuration` and add a remote apply**

In `PlaybackStore`, replace `setDuration` with:
```ts
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
```

- [ ] **Step 7: Add the record helpers**

Below `export const Recents = new RecentFoldersStore();` add:
```ts
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
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- src/lib/store.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 9: Type-check, build, and run the whole suite**

Run: `npx tsc -p tsconfig.app.json --noEmit && npm run build && npm test`
Expected: no type errors, build without warnings, all tests pass.

- [ ] **Step 10: Commit**

```bash
git add tauri/src/lib/store.ts tauri/src/lib/store.test.ts
git commit -m "feat(tauri): stamp and track unsynced local changes"
```

---

### Task 5: Stable library ids

Removing a folder from Recents currently discards its id. Once ids key synced progress, reopening the folder would mint a new id and orphan everything already synced.

**Files:**
- Modify: `tauri/src/lib/store.ts` (`RecentFoldersStore`)
- Test: `tauri/src/lib/store.test.ts` (append)

**Interfaces:**
- Consumes: `KEYS.libraryIds` from Task 4.
- Produces:
  ```ts
  Recents.libraryIdFor(path: string): string;
  Recents.pathFor(libraryId: string): string | null;
  Recents.link(path: string, libraryId: string): void;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tauri/src/lib/store.test.ts`:
```ts
describe("library ids", () => {
  it("reuses the recent folder id for an existing entry", async () => {
    vi.resetModules();
    const storage = memoryStorage();
    storage.setItem(
      "recentFolders.v1",
      JSON.stringify([{ id: "old-id", name: "Rust", path: "/c/Rust", lastOpenedAt: 1 }])
    );
    vi.stubGlobal("localStorage", storage);
    const s = await import("./store");
    expect(s.Recents.libraryIdFor("/c/Rust")).toBe("old-id");
  });

  it("keeps the id after the folder is removed from recents", async () => {
    const s = await freshStore();
    s.Recents.record("/c/Rust", "Rust");
    const id = s.Recents.libraryIdFor("/c/Rust");
    s.Recents.remove(s.Recents.folders[0].id);
    s.Recents.record("/c/Rust", "Rust");
    expect(s.Recents.folders[0].id).toBe(id);
    expect(s.Recents.libraryIdFor("/c/Rust")).toBe(id);
  });

  it("maps an id back to its path", async () => {
    const s = await freshStore();
    const id = s.Recents.libraryIdFor("/c/Rust");
    expect(s.Recents.pathFor(id)).toBe("/c/Rust");
    expect(s.Recents.pathFor("unknown")).toBeNull();
  });

  it("links a path to an existing library id", async () => {
    const s = await freshStore();
    s.Recents.record("D:/Rust", "Rust");
    s.Recents.link("D:/Rust", "remote-id");
    expect(s.Recents.libraryIdFor("D:/Rust")).toBe("remote-id");
    expect(s.Recents.folders[0].id).toBe("remote-id");
    expect(s.Recents.pathFor("remote-id")).toBe("D:/Rust");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/store.test.ts`
Expected: FAIL — `s.Recents.libraryIdFor is not a function`.

- [ ] **Step 3: Implement**

Replace the whole `RecentFoldersStore` class with:
```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites (29 tests).

- [ ] **Step 5: Type-check and build**

Run: `npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: no errors, no warnings.

- [ ] **Step 6: Commit**

```bash
git add tauri/src/lib/store.ts tauri/src/lib/store.test.ts
git commit -m "feat(tauri): keep library ids stable across recents removal"
```

---

### Task 6: Manual regression check

Nothing in this plan should be visible. This task proves it in the real app.

**Files:** none.

- [ ] **Step 1: Run the desktop app**

Run: `npm run tauri dev`

- [ ] **Step 2: Walk the existing flows**

Check each, in the app window:
1. Recent folders from before this branch still appear with their watched counts.
2. Open a folder, play a video past 3 s, switch videos, reopen — it resumes.
3. Mark a video watched and unwatched from the sidebar.
4. Write a note, close the notes panel, reopen — the note is there and the sidebar marker shows.
5. Remove a folder with watched marks from recents (confirm dialog appears), then reopen it — marks are gone, no error.
6. On Windows, if available: the watched count on a recent card is non-zero for a folder with watched videos (this is the `SEP` path).

- [ ] **Step 3: Inspect the new keys**

In the app devtools console:
```js
["videoStamps.v1", "noteStamps.v1", "syncDirty.v1", "libraryIds.v1"].map((k) => [k, localStorage.getItem(k)])
```
Expected: all four exist; `syncDirty.v1` lists the videos and notes touched in Step 2; `libraryIds.v1` maps every recent folder path to its id.

---

## Self-Review

| Spec requirement | Task |
|---|---|
| Library id reuses `RecentFolder.id` | 5 |
| Removing from Recents keeps the id | 5 |
| `library_id → path` map per machine; linking | 5 (`pathFor`, `link`) |
| `localStorage` stays keyed by absolute path; translate at sync boundary | 1 (`toRelPath`/`fromRelPath`), 4 (no key changes) |
| Synthetic web path `/<library_id>/<rel_path>` | 1 (`webPath`/`parseWebPath`) |
| `rel_path` always `/`-separated | 1 |
| `SEP` from platform mode | 3 |
| Local `updatedAt` + dirty set, legacy = 0 | 4 |
| `removeAll` propagates as tombstones | 4 (marks cleared keys dirty) |
| LWW helper | 2 |
| vitest for LWW and path translation incl. Windows | 1, 2 |
| No visible change | 6 |

Contract check against the index: `SEP`, `toRelPath`, `fromRelPath`, `webPath`, `parseWebPath`, `Stamped`, `newerKeys`, `VideoRecord`, `videoRecord`, `applyVideoRecord`, `noteRecord`, `applyNoteRecord`, `Dirty.take/restore/isEmpty`, `LocalChanges`, `Recents.libraryIdFor/pathFor/link` — all defined above with the index signatures. Extensions: `DirtyBatch` type, `Dirty.markVideo/markNote` (internal), `Watched.applyRemote`, `Notes.applyRemote`, `Playback.applyRemoteDuration`.
