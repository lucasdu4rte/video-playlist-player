import { describe, expect, it } from "vitest";
import type { VideoRecord } from "@/lib/store";
import { toLocalNotes, toLocalVideos, toSyncRows, type RecordReaders } from "@/lib/syncRows";

const NOON = Date.UTC(2026, 8, 16, 12);

const watchedVideo: VideoRecord = { watched: true, position: null, duration: 600, updatedAt: NOON };

const read: RecordReaders = {
  video: () => watchedVideo,
  note: () => ({ value: "remember this", updatedAt: NOON }),
};

const posixLibrary = [{ id: "lib-1", root: "/Users/me/Rust" }];
const windowsLibrary = [{ id: "lib-1", root: "C:\\Courses\\Rust" }];

describe("toSyncRows", () => {
  it("turns POSIX absolute paths into library rows", () => {
    const rows = toSyncRows(
      { videos: ["/Users/me/Rust/01 Intro/a.mp4"], notes: ["/Users/me/Rust/b.mp4"] },
      posixLibrary,
      "/",
      read
    );

    expect(rows.videos).toEqual([
      {
        library_id: "lib-1",
        rel_path: "01 Intro/a.mp4",
        watched: true,
        position: null,
        duration: 600,
        updated_at: "2026-09-16T12:00:00.000Z",
      },
    ]);
    expect(rows.notes).toEqual([
      {
        library_id: "lib-1",
        rel_path: "b.mp4",
        text: "remember this",
        updated_at: "2026-09-16T12:00:00.000Z",
      },
    ]);
    expect(rows.unmatched).toEqual({ videos: [], notes: [] });
  });

  it("uses forward slashes for Windows paths", () => {
    const rows = toSyncRows(
      { videos: ["C:\\Courses\\Rust\\01 Intro\\a.mp4"], notes: [] },
      windowsLibrary,
      "\\",
      read
    );

    expect(rows.videos.map((row) => row.rel_path)).toEqual(["01 Intro/a.mp4"]);
  });

  it("keeps paths outside every library, including prefix-sharing siblings, as unmatched", () => {
    const rows = toSyncRows(
      { videos: ["/Elsewhere/a.mp4", "/Users/me/Rust 2/a.mp4"], notes: ["/Elsewhere/b.mp4"] },
      posixLibrary,
      "/",
      read
    );

    expect(rows.videos).toEqual([]);
    expect(rows.notes).toEqual([]);
    expect(rows.unmatched).toEqual({
      videos: ["/Elsewhere/a.mp4", "/Users/me/Rust 2/a.mp4"],
      notes: ["/Elsewhere/b.mp4"],
    });
  });

  it("writes one row per library when roots are nested", () => {
    const rows = toSyncRows(
      { videos: ["/Users/me/Rust/a.mp4"], notes: [] },
      [{ id: "outer", root: "/Users/me" }, ...posixLibrary],
      "/",
      read
    );

    expect(rows.videos.map((row) => [row.library_id, row.rel_path])).toEqual([
      ["outer", "Rust/a.mp4"],
      ["lib-1", "a.mp4"],
    ]);
  });

  it("drops a path whose only place has a backslash in its rel_path, without restoring it", () => {
    const rows = toSyncRows(
      { videos: ["/Users/me/Rust/a\\b.mp4"], notes: ["/Users/me/Rust/c\\d.mp4"] },
      posixLibrary,
      "/",
      read
    );

    expect(rows.videos).toEqual([]);
    expect(rows.notes).toEqual([]);
    expect(rows.unmatched).toEqual({ videos: [], notes: [] });
    expect(rows.invalid).toEqual({
      videos: ["/Users/me/Rust/a\\b.mp4"],
      notes: ["/Users/me/Rust/c\\d.mp4"],
    });
  });

  it("strips NUL and replaces unpaired surrogates in note text", () => {
    const rows = toSyncRows(
      { videos: [], notes: ["/Users/me/Rust/a.mp4"] },
      posixLibrary,
      "/",
      { video: read.video, note: () => ({ value: "a\u0000b\uD800c", updatedAt: NOON }) }
    );

    expect(rows.notes[0].text).toBe("ab\uFFFDc");
  });

  it("stamps a legacy zero updatedAt as just after the epoch", () => {
    const rows = toSyncRows(
      { videos: ["/Users/me/Rust/a.mp4"], notes: [] },
      posixLibrary,
      "/",
      { video: () => ({ ...watchedVideo, updatedAt: 0 }), note: read.note }
    );

    expect(rows.videos[0].updated_at).toBe("1970-01-01T00:00:00.001Z");
  });
});

describe("toLocalVideos / toLocalNotes", () => {
  it("maps rows back to absolute paths and skips libraries this machine has not linked", () => {
    const videos = toLocalVideos(
      [
        {
          library_id: "lib-1",
          rel_path: "01 Intro/a.mp4",
          watched: true,
          position: null,
          duration: 600,
          updated_at: "2026-09-16T12:00:00+00:00",
        },
        {
          library_id: "not-linked",
          rel_path: "x.mp4",
          watched: true,
          position: null,
          duration: null,
          updated_at: "2026-09-16T12:00:00+00:00",
        },
      ],
      windowsLibrary,
      "\\"
    );

    expect(videos).toEqual({
      "C:\\Courses\\Rust\\01 Intro\\a.mp4": { value: watchedVideo, updatedAt: NOON },
    });
  });

  it("keeps the newest note when nested libraries resolve to the same file", () => {
    const notes = toLocalNotes(
      [
        { library_id: "lib-1", rel_path: "a.mp4", text: "newer", updated_at: "2026-09-16T12:00:00+00:00" },
        { library_id: "outer", rel_path: "Rust/a.mp4", text: "older", updated_at: "2026-09-16T11:00:00+00:00" },
      ],
      [{ id: "outer", root: "/Users/me" }, ...posixLibrary],
      "/"
    );

    expect(notes).toEqual({ "/Users/me/Rust/a.mp4": { value: "newer", updatedAt: NOON } });
  });
});
