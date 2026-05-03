import type { AppSettings } from "../types";

export const DEFAULT_TARGET_IDS = ["codex_rules", "opencode_rules", "auggie_rules", "opencode_config"];

export function defaultSettings(): AppSettings {
  return {
    appearance: "dark",
    workspace_path: null,
    enabled_target_ids: DEFAULT_TARGET_IDS,
  };
}

export function serializeSettingsForCompare(settings: AppSettings): string {
  return JSON.stringify(settings);
}
