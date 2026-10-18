import { serializeSettingsForCompare } from "./settingsDraft";
import type { AppSettings } from "../types";
import { DEFAULT_ENABLED_HARNESS_IDS } from "./harnessInstallation";

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
    enabled_harness_ids: [...(local.enabled_harness_ids ?? DEFAULT_ENABLED_HARNESS_IDS)],
    accent_color: local.accent_color,
    background_color: local.background_color,
    foreground_color: local.foreground_color,
    motion: local.motion,
    landing_view: local.landing_view,
    revision: acknowledged.revision ?? 0,
  };
}
