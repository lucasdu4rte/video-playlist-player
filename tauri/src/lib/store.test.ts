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
