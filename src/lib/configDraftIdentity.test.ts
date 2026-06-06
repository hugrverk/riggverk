import { describe, expect, it } from "vitest";
import { shouldApplyOpenCodeSourceSave } from "./editorSaveOperation";

describe("shouldApplyOpenCodeSourceSave", () => {
  it("rejects a late legacy template response after source switch", () => {
    const activeSource = "policy";
    const identity = `opencode_config:${activeSource}`;
    expect(
      shouldApplyOpenCodeSourceSave("opencode_config", activeSource, identity, 2, 1, "base"),
    ).toBe(false);
  });

  it("accepts the matching source response", () => {
    const activeSource = "base";
    const identity = `opencode_config:${activeSource}`;
    expect(
      shouldApplyOpenCodeSourceSave("opencode_config", activeSource, identity, 3, 3, "base"),
    ).toBe(true);
  });
});
