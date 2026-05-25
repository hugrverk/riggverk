import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { AppSettings, RepoDashboardEntry } from "../types";

/** Read-only saved Repo Dashboard entries from app settings (no writes). */
export function useSavedRepoDashboardEntries(): {
  entries: RepoDashboardEntry[];
  activeEntryId: string | null;
  loading: boolean;
} {
  const [entries, setEntries] = useState<RepoDashboardEntry[]>([]);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings>("get_settings")
      .then(settings => {
        if (cancelled) return;
        setEntries(settings.repo_dashboard_entries ?? []);
        setActiveEntryId(settings.active_repo_dashboard_id ?? null);
      })
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
  }, []);

  return { entries, activeEntryId, loading };
}
