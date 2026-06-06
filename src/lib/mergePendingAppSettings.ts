import { serializeSettingsForCompare } from "./settingsDraft";
import type { AppSettings } from "../types";

/** Overlay locally edited theme/target/workspace fields onto an acknowledged backend snapshot. */
export function mergePendingLocalOntoAcknowledged(
  acknowledged: AppSettings,
  local: AppSettings,
  savedSerialized: string | null,
): AppSettings {
  if (!savedSerialized || serializeSettingsForCompare(local) === savedSerialized) {
    return acknowledged;
  }
  return {
    ...acknowledged,
    appearance: local.appearance,
    app_font_size: local.app_font_size,
    workspace_path: local.workspace_path,
    enabled_target_ids: [...local.enabled_target_ids],
    accent_color: local.accent_color,
    background_color: local.background_color,
    foreground_color: local.foreground_color,
    revision: acknowledged.revision ?? 0,
  };
}

/** Keep pre-mutation local edits; do not roll back fields the mutator intentionally changed. */
export function applyMutationPreservingPendingLocal(
  saved: AppSettings,
  _sentSerialized: string,
  local: AppSettings | null,
  acknowledgedSerialized: string | null,
): AppSettings {
  if (!local || !acknowledgedSerialized) return saved;
  if (serializeSettingsForCompare(local) === acknowledgedSerialized) {
    return saved;
  }
  return {
    ...saved,
    appearance: local.appearance,
    app_font_size: local.app_font_size,
    workspace_path: local.workspace_path,
    enabled_target_ids: [...local.enabled_target_ids],
    accent_color: local.accent_color,
    background_color: local.background_color,
    foreground_color: local.foreground_color,
  };
}
