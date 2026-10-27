import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HARNESS_NAV_ORDER } from "../lib/harnessInstallation";
import type { EffectiveSkillLoads, InstallAgent } from "../types";

export interface EffectiveSkillLoadsState {
  /** The last successful read; kept while the next one runs, dropped when it fails or there is nothing to read. */
  loads: EffectiveSkillLoads | null;
  loading: boolean;
  /** Last failure. It stays here, like the installation overview's: it never reaches the global error line. */
  error: string | null;
  /** Reads again; resolves when the read has settled. */
  refresh: () => Promise<void>;
}

export interface UseEffectiveSkillLoadsOptions {
  dataFolderOk: boolean;
  /** A workspace task (apply, uninstall, rollback) is running; the view is read again when it ends. */
  busy: boolean;
  enabledHarnessIds: readonly InstallAgent[];
  /** Bump to force a read (shared with the installation overview). */
  refreshKey?: number;
}

/**
 * Which skill copies each enabled harness loads (`get_effective_skill_loads`). Read when the workspace is valid,
 * after a running task ends and when the set of enabled harnesses changes, next to the installation overview:
 * both describe the same folders. Read-only on the backend.
 */
export function useEffectiveSkillLoads({
  dataFolderOk,
  busy,
  enabledHarnessIds,
  refreshKey,
}: UseEffectiveSkillLoadsOptions): EffectiveSkillLoadsState {
  const [loads, setLoads] = useState<EffectiveSkillLoads | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  // A string key keeps `refresh` stable while the set is unchanged (the array identity changes every render).
  const harnessKey = HARNESS_NAV_ORDER.filter((harness) => enabledHarnessIds.includes(harness)).join(",");

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!dataFolderOk || harnessKey === "") {
      setLoads(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await invoke<EffectiveSkillLoads>("get_effective_skill_loads");
      if (generation !== generationRef.current) return;
      setLoads(next);
      setError(null);
    } catch (failure) {
      if (generation !== generationRef.current) return;
      setLoads(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setLoading(false);
  }, [dataFolderOk, harnessKey]);

  useEffect(() => {
    if (!busy) void refresh();
  }, [busy, refresh, refreshKey]);

  return useMemo(() => ({ loads, loading, error, refresh }), [loads, loading, error, refresh]);
}
