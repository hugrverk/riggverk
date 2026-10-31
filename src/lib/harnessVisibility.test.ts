import { describe, expect, it } from "vitest";
import { filterVisibleMetadataTargets } from "./harnessVisibility";

describe("filterVisibleMetadataTargets", () => {
  it("hides metadata restricted to disabled harnesses", () => {
    expect(filterVisibleMetadataTargets(["claude"], ["codex"])).toBeNull();
  });

  it("keeps multi-harness metadata with only enabled chips", () => {
    expect(filterVisibleMetadataTargets(["codex", "claude"], ["codex"])).toEqual(["codex"]);
  });

  it("treats the light harnesses as harnesses, not as generic values", () => {
    expect(filterVisibleMetadataTargets(["claude", "pi", "grok"], ["claude", "pi"])).toEqual(["claude", "pi"]);
    expect(filterVisibleMetadataTargets(["grok"], ["claude"])).toBeNull();
  });

  it("keeps generic and unknown metadata values", () => {
    expect(filterVisibleMetadataTargets([], [])).toEqual([]);
    expect(filterVisibleMetadataTargets(["custom"], [])).toEqual(["custom"]);
  });
});
