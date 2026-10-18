import { describe, expect, it } from "vitest";
import { compareVersions, releasesSince, type ReleaseNotes } from "./releaseNotes";

function release(version: string): ReleaseNotes {
  return { version, sections: [{ title: "New", items: [`Thing in ${version}`] }] };
}

describe("compareVersions", () => {
  it("compares dotted versions numerically", () => {
    expect(compareVersions("2026.10.2", "2026.10.1")).toBeGreaterThan(0);
    expect(compareVersions("2026.10.10", "2026.10.9")).toBeGreaterThan(0);
    expect(compareVersions("2026.9.5", "2026.10.1")).toBeLessThan(0);
    expect(compareVersions("2027.1.1", "2026.12.9")).toBeGreaterThan(0);
    expect(compareVersions("2026.10.1", "2026.10.1")).toBe(0);
    expect(compareVersions("2026.10.1", "0.1.0")).toBeGreaterThan(0);
  });

  it("returns null for anything that is not a plain N.N.N version", () => {
    for (const bad of ["", "2026.10", "2026.10.1.1", "v2026.10.1", "2026.10.1-rc.1", "x.y.z"]) {
      expect(compareVersions(bad, "2026.10.1")).toBeNull();
      expect(compareVersions("2026.10.1", bad)).toBeNull();
    }
  });
});

describe("releasesSince", () => {
  const all = [release("2026.9.1"), release("2026.10.1"), release("2026.10.2"), release("2026.11.1")];

  it("returns the releases after the last seen version up to the current one, newest first", () => {
    expect(releasesSince(all, "2026.9.1", "2026.10.2").map(entry => entry.version)).toEqual(["2026.10.2", "2026.10.1"]);
    expect(releasesSince(all, "0.1.0", "2026.11.1").map(entry => entry.version)).toEqual([
      "2026.11.1",
      "2026.10.2",
      "2026.10.1",
      "2026.9.1",
    ]);
  });

  it("leaves out the last seen release itself and releases newer than this build", () => {
    expect(releasesSince(all, "2026.10.1", "2026.10.1")).toEqual([]);
    expect(releasesSince(all, "2026.10.2", "2026.10.2")).toEqual([]);
    expect(releasesSince(all, "2026.9.1", "2026.10.1").map(entry => entry.version)).toEqual(["2026.10.1"]);
  });

  it("returns nothing when no notes exist for the versions in between", () => {
    expect(releasesSince(all, "2026.11.1", "2026.12.3")).toEqual([]);
    expect(releasesSince([], "0.1.0", "2026.10.1")).toEqual([]);
  });

  it("does not reorder or mutate its input", () => {
    const input = [release("2026.10.1"), release("2026.10.2")];
    releasesSince(input, "0.1.0", "2026.10.2");
    expect(input.map(entry => entry.version)).toEqual(["2026.10.1", "2026.10.2"]);
  });
});
