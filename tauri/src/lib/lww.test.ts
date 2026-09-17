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
