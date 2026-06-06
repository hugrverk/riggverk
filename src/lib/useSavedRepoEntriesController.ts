import type { AppSettings, RepoDashboardEntry } from "../types";

export type MutateAppSettings = (
  mutator: (current: AppSettings) => AppSettings,
) => Promise<AppSettings>;

/** Pure view adapter: repo dashboard fields from canonical app settings state. */
export function savedRepoEntriesFromSettings(appSettings: AppSettings | null): {
  entries: RepoDashboardEntry[];
  activeEntryId: string | null;
  loading: boolean;
} {
  return {
    entries: appSettings?.repo_dashboard_entries ?? [],
    activeEntryId: appSettings?.active_repo_dashboard_id ?? null,
    loading: appSettings === null,
  };
}
