import { describe, expect, it } from "vitest";
import { createSaveOperationTracker } from "./editorSaveOperation";

describe("createSaveOperationTracker", () => {
  it("invalidates captured save operations", () => {
    const tracker = createSaveOperationTracker();
    const saveOpId = tracker.capture();
    tracker.invalidate();
    expect(tracker.isCurrent(saveOpId)).toBe(false);
    expect(tracker.isCurrent(tracker.capture())).toBe(true);
  });
});
