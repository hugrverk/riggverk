import { describe, expect, it } from "vitest";
import type { RepoDashboardEntry } from "../types";
import { mergeImportedRepoEntries, upsertRepoEntry } from "./repoDashboardEntries";

const existing: RepoDashboardEntry[] = [
  { id: "app", label: "app", path: "/work/one/app", default_branch: "main" },
];

describe("upsertRepoEntry", () => {
  it("adds a new entry with a slug id and basename label", () => {
    const { entries, id } = upsertRepoEntry([], "/work/My Repo/", "develop");
    expect(id).toBe("my-repo");
    expect(entries).toEqual([{ id: "my-repo", label: "My Repo", path: "/work/My Repo/", default_branch: "develop" }]);
  });

  it("updates the entry with the same path and keeps its id and label", () => {
    const { entries, id } = upsertRepoEntry(existing, "/work/one/app/", "release");
    expect(id).toBe("app");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "app", label: "app", path: "/work/one/app/", default_branch: "release" });
  });

  it("does not overwrite a different checkout that has the same basename", () => {
    const { entries, id } = upsertRepoEntry(existing, "/work/two/app", null);
    expect(id).toBe("app-2");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(existing[0]);
    expect(entries[1]).toMatchObject({ id: "app-2", path: "/work/two/app", default_branch: null });
  });

  it("does not mutate the input list", () => {
    const input = [...existing];
    upsertRepoEntry(input, "/work/two/app", null);
    expect(input).toEqual(existing);
  });
});

describe("mergeImportedRepoEntries", () => {
  it("skips known paths and suffixes colliding ids", () => {
    const merged = mergeImportedRepoEntries(existing, [
      { id: "app", label: "app", path: "/work/one/app/" },
      { id: "app", label: "app", path: "/work/three/app" },
    ]);
    expect(merged.map(e => [e.id, e.path])).toEqual([
      ["app", "/work/one/app"],
      ["app-2", "/work/three/app"],
    ]);
  });
});
