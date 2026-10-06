export const SETTINGS_CONFLICT_ERROR = "settings conflict";

export function isSettingsConflictError(error: unknown): boolean {
  return String(error).includes(SETTINGS_CONFLICT_ERROR);
}
