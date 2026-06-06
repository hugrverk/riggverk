import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_CONFLICT_ERROR,
  commitAppSettingsMutation,
  isSettingsConflictError,
} from "./appSettingsMutation";
import type { AppSettings } from "../types";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const baseSettings: AppSettings = {
  appearance: "dark",
  app_font_size: "medium",
  workspace_path: null,
  enabled_target_ids: [],
  accent_color: null,
  background_color: null,
  foreground_color: null,
  repo_dashboard_entries: [],
  active_repo_dashboard_id: null,
  revision: 2,
};

describe("commitAppSettingsMutation", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("detects settings conflict errors", () => {
    expect(isSettingsConflictError(new Error(SETTINGS_CONFLICT_ERROR))).toBe(true);
    expect(isSettingsConflictError(new Error("other"))).toBe(false);
  });

  it("retries after conflict and preserves both mutations", async () => {
    invoke
      .mockResolvedValueOnce({ settings: { ...baseSettings, revision: 2 }, load_warning: null })
      .mockRejectedValueOnce(new Error(SETTINGS_CONFLICT_ERROR))
      .mockResolvedValueOnce({ settings: { ...baseSettings, revision: 3, appearance: "light" }, load_warning: null })
      .mockResolvedValueOnce({ ...baseSettings, revision: 4, appearance: "light", app_font_size: "large" });

    const saved = await commitAppSettingsMutation(current => ({
      ...current,
      app_font_size: "large",
    }));

    expect(saved.app_font_size).toBe("large");
    expect(invoke).toHaveBeenCalledTimes(4);
  });
});
