import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, RepoDashboardEntry } from "../types";
import { commitAppSettingsMutation } from "./appSettingsMutation";

export function useSavedRepoEntriesController(): {
  entries: RepoDashboardEntry[];
  activeEntryId: string | null;
  loading: boolean;
  revision: number;
  mutateEntries: (
    mutator: (current: AppSettings) => AppSettings,
  ) => Promise<AppSettings>;
  reloadEntries: () => Promise<AppSettings>;
} {
  const [entries, setEntries] = useState<RepoDashboardEntry[]>([]);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const revisionRef = useRef(0);

  const applySettings = useCallback((settings: AppSettings) => {
    revisionRef.current = settings.revision ?? 0;
    setEntries(settings.repo_dashboard_entries ?? []);
    setActiveEntryId(settings.active_repo_dashboard_id ?? null);
    return settings;
  }, []);

  const reloadEntries = useCallback(async () => {
    const settings = await invoke<AppSettings>("get_settings");
    return applySettings(settings);
  }, [applySettings]);

  const mutateEntries = useCallback(async (mutator: (current: AppSettings) => AppSettings) => {
    const saved = await commitAppSettingsMutation(mutator);
    return applySettings(saved);
  }, [applySettings]);

  useEffect(() => {
    let cancelled = false;
    reloadEntries()
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          setActiveEntryId(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadEntries]);

  return {
    entries,
    activeEntryId,
    loading,
    revision: revisionRef.current,
    mutateEntries,
    reloadEntries,
  };
}
