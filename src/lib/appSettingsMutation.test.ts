import { describe, expect, it } from "vitest";
import { SETTINGS_CONFLICT_ERROR, isSettingsConflictError } from "./appSettingsMutation";

describe("isSettingsConflictError", () => {
  it("detects settings conflict errors from rejected IPC strings and Error objects", () => {
    expect(isSettingsConflictError(SETTINGS_CONFLICT_ERROR)).toBe(true);
    expect(isSettingsConflictError(new Error(`${SETTINGS_CONFLICT_ERROR}: stale revision`))).toBe(true);
    expect(isSettingsConflictError(new Error("disk full"))).toBe(false);
  });
});
