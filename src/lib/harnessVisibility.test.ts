import { describe, expect, it } from "vitest";
import { filterVisibleMetadataTargets } from "./harnessVisibility";

describe("filterVisibleMetadataTargets", () => {
  it("hides metadata restricted to disabled harnesses", () => {
    expect(filterVisibleMetadataTargets(["claude"], ["codex"])).toBeNull();
  });

  it("keeps multi-harness metadata with only enabled chips", () => {
    expect(filterVisibleMetadataTargets(["codex", "claude"], ["codex"])).toEqual(["codex"]);
  });

  it("keeps generic and unknown metadata values", () => {
    expect(filterVisibleMetadataTargets([], [])).toEqual([]);
    expect(filterVisibleMetadataTargets(["custom"], [])).toEqual(["custom"]);
  });
});
