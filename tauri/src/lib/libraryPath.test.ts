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
