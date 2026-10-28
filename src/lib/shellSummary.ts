import type { InstallationOverview, OverviewEntry } from "../hooks/useInstallationOverview";
import type { AppSettings, InstallAgent } from "../types";
import { codexConfigModelFor, CODEX_CONFIG_SURFACE } from "./codexConfig";
import { fileConflictModelFor } from "./fileConflicts";
import { surfaceRowsFor, WORKSPACE_FOLDER_UNUSABLE } from "./installationView";
import { rulesModelFor, rulesSurfaceOf } from "./rulesView";
import { surfaceUiState, type UiItem } from "./uiState";

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/** Shown as the reason (and tooltip) of a disabled Update all when nothing is waiting. */
export const ALL_UP_TO_DATE = "Everything Riggverk can update is already up to date.";

/**
 * The counted items of one harness (one per surface row), with the state the pages show for them. The sidebar badge
 * reads the decisions among them; the Overview and harness pages build the same items.
 */
export function harnessUiItems(
  harness: InstallAgent,
  entry: OverviewEntry | undefined,
  settings: EnabledSettings,
  dataFolderOk: boolean,
): UiItem[] {
  const rulesSurface = rulesSurfaceOf(harness);
  const rules = dataFolderOk ? rulesModelFor(harness, entry?.status) : null;
  const codexConfig = dataFolderOk && harness === "codex" ? codexConfigModelFor(entry?.status) : null;
  return surfaceRowsFor(harness, entry, settings).map(row => {
    const { state, subline } = surfaceUiState({
      display: row.state,
      surface: row.surface,
      detail: row.detail,
      rules: row.surface === rulesSurface ? rules : null,
      files: dataFolderOk ? fileConflictModelFor(entry?.status, row.surface) : null,
      codexConfig: row.surface === CODEX_CONFIG_SURFACE ? codexConfig : null,
      dataFolderOk,
      entryError: entry?.error,
    });
    return { key: `${harness}:${row.surface}`, owner: harness, surface: row.surface, state, subline };
  });
}

/** How many items of each enabled harness wait for a decision; harnesses with none are left out. */
export function decideCountsByHarness(
  overview: InstallationOverview,
  harnesses: readonly InstallAgent[],
  settings: EnabledSettings | null,
  dataFolderOk: boolean,
): Partial<Record<InstallAgent, number>> {
  const counts: Partial<Record<InstallAgent, number>> = {};
  if (!settings) return counts;
  for (const harness of harnesses) {
    const count = harnessUiItems(harness, overview.entries[harness], settings, dataFolderOk).filter(
      item => item.state === "decide",
    ).length;
    if (count > 0) counts[harness] = count;
  }
  return counts;
}

/**
 * Why Update all (the review of every enabled surface) cannot open right now, or false. In order: an unusable
 * workspace folder, a running task, unsaved target changes, status still loading, nothing to apply, a failed check.
 * A conflict counts as something to review.
 */
export function updateAllDisabledReason(
  overview: InstallationOverview,
  context: { dataFolderOk: boolean; busyLabel: string | null; settingsSaving: boolean },
): string | false {
  if (!context.dataFolderOk) return WORKSPACE_FOLDER_UNUSABLE;
  if (context.busyLabel) return `${context.busyLabel} is running`;
  if (context.settingsSaving) return "Saving target changes…";
  const entries = Object.values(overview.entries).filter((entry): entry is OverviewEntry => entry !== undefined);
  if (entries.length === 0 || entries.some(entry => entry.loading && !entry.status)) return "Checking status…";
  const actionable = entries.some(
    entry => entry.status && entry.status.state !== "current" && entry.status.state !== "unavailable",
  );
  if (actionable) return false;
  if (entries.some(entry => entry.error)) return "Couldn't check every agent. Try Check again.";
  return ALL_UP_TO_DATE;
}
