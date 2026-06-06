import { describe, expect, it } from "vitest";
import { createSaveOperationTracker, shouldApplyOpenCodeSourceSave } from "./editorSaveOperation";

describe("shouldApplyOpenCodeSourceSave", () => {
  it("rejects a late legacy template response after source switch", () => {
    const tracker = createSaveOperationTracker();
    const saveOpId = tracker.capture();
    const activeSource = "policy";
    const identity = `opencode_config:${activeSource}`;
    expect(
      shouldApplyOpenCodeSourceSave(
        "opencode_config",
        activeSource,
        identity,
        saveOpId,
        tracker.isCurrent,
        "base",
      ),
    ).toBe(false);
  });

  it("accepts the matching source response", () => {
    const tracker = createSaveOperationTracker();
    const saveOpId = tracker.capture();
    const activeSource = "base";
    const identity = `opencode_config:${activeSource}`;
    expect(
      shouldApplyOpenCodeSourceSave(
        "opencode_config",
        activeSource,
        identity,
        saveOpId,
        tracker.isCurrent,
        "base",
      ),
    ).toBe(true);
  });
});
