import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types";

export const SETTINGS_CONFLICT_ERROR = "settings conflict";

export function isSettingsConflictError(error: unknown): boolean {
  return String(error).includes(SETTINGS_CONFLICT_ERROR);
}

/** Read-modify-write with revision compare-and-swap; retries on conflict. */
export async function commitAppSettingsMutation(
  mutator: (current: AppSettings) => AppSettings,
  maxAttempts = 3,
): Promise<AppSettings> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await invoke<AppSettings>("get_settings");
    const expectedRevision = current.revision ?? 0;
    try {
      const next = mutator(current);
      return await invoke<AppSettings>("update_settings", {
        settings: next,
        expectedRevision,
      });
    } catch (error) {
      if (!isSettingsConflictError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
    }
  }
  throw new Error(SETTINGS_CONFLICT_ERROR);
}
