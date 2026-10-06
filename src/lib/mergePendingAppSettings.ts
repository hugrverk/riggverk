import { serializeSettingsForCompare } from "./settingsDraft";
import type { AppSettings } from "../types";
import { INSTALL_AGENTS } from "../types";

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
    enabled_harness_ids: [...(local.enabled_harness_ids ?? INSTALL_AGENTS)],
    accent_color: local.accent_color,
    background_color: local.background_color,
    foreground_color: local.foreground_color,
    reduce_motion: local.reduce_motion,
    landing_view: local.landing_view,
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
    enabled_harness_ids: [...(local.enabled_harness_ids ?? INSTALL_AGENTS)],
    accent_color: local.accent_color,
    background_color: local.background_color,
    foreground_color: local.foreground_color,
    reduce_motion: local.reduce_motion,
    landing_view: local.landing_view,
  };
}
