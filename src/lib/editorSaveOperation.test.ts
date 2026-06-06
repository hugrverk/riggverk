import { describe, expect, it } from "vitest";
import { createSaveOperationTracker, shouldApplyOpenCodeSourceSave } from "./editorSaveOperation";

describe("createSaveOperationTracker", () => {
  it("issues distinct monotonic tokens from capture", () => {
    const tracker = createSaveOperationTracker();
    const first = tracker.capture();
    const second = tracker.capture();
    expect(first).not.toBe(second);
    expect(second).toBeGreaterThan(first);
  });

  it("makes the first token stale after a second capture", () => {
    const tracker = createSaveOperationTracker();
    const first = tracker.capture();
    tracker.capture();
    expect(tracker.isCurrent(first)).toBe(false);
  });

  it("invalidates the latest captured token", () => {
    const tracker = createSaveOperationTracker();
    const saveOpId = tracker.capture();
    tracker.invalidate();
    expect(tracker.isCurrent(saveOpId)).toBe(false);
    expect(tracker.isCurrent(tracker.capture())).toBe(true);
  });
});

describe("shouldApplyOpenCodeSourceSave", () => {
  it("rejects a late config save response for the same source", () => {
    const tracker = createSaveOperationTracker();
    const first = tracker.capture();
    tracker.capture();
    expect(
      shouldApplyOpenCodeSourceSave(
        "opencode_config",
        "base",
        "opencode_config:base",
        first,
        tracker.isCurrent,
        "base",
      ),
    ).toBe(false);
  });
});
