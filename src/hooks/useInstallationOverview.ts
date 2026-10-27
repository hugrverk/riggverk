import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  enabledSurfacesForHarness,
  HARNESS_NAV_ORDER,
  HARNESS_SURFACES,
  WORKSPACE_SURFACES,
} from "../lib/harnessInstallation";
import type { InstallationState, InstallationStatus, InstallAgent, SetupSurfaceId } from "../types";

export type OverviewId = "workspace" | InstallAgent;

export interface OverviewEntry {
  id: OverviewId;
  status: InstallationStatus | null;
  loading: boolean;
  /** Last fetch failure; the status of the previous successful fetch is dropped. */
  error: string | null;
}

export interface InstallationOverview {
  /** One entry per overviewed target (workspace plus every enabled harness) once its first fetch has started. */
  entries: Partial<Record<OverviewId, OverviewEntry>>;
  /** True while any fetch is in flight. */
  loading: boolean;
  /** Re-fetches every status; resolves when all have settled. */
  refresh: () => Promise<void>;
}

export interface UseInstallationOverviewOptions {
  dataFolderOk: boolean;
  /** A workspace task (apply, uninstall, rollback) is running; the overview re-fetches when it ends. */
  busy: boolean;
  enabledHarnessIds: readonly InstallAgent[];
  /**
   * Enabled target toggles. When given, surfaces whose target is off are not requested (the pages list them as
   * "off"), so the state shown matches what an update would touch. Omit to request every surface of a harness.
   */
  enabledTargetIds?: readonly string[];
  /** Bump to force a re-fetch (e.g. after a model save). */
  refreshKey?: number;
}

export function surfacesForOverview(id: OverviewId, enabledTargetIds?: readonly string[]): SetupSurfaceId[] {
  if (id === "workspace") return WORKSPACE_SURFACES;
  if (!enabledTargetIds) return HARNESS_SURFACES[id];
  return enabledSurfacesForHarness(id, { enabled_target_ids: [...enabledTargetIds], enabled_harness_ids: [id] });
}

/**
 * Single source for installation state: the shell (tab status dots, `:update` suggestions) and the Start and
 * harness pages (lists, surface matrix). One `get_installation_status` per target and refresh. Failures stay in
 * the entry; they never reach the global error line.
 */
export function useInstallationOverview({
  dataFolderOk,
  busy,
  enabledHarnessIds,
  enabledTargetIds,
  refreshKey,
}: UseInstallationOverviewOptions): InstallationOverview {
  const [entries, setEntries] = useState<Partial<Record<OverviewId, OverviewEntry>>>({});
  const [loading, setLoading] = useState(false);
  const generationRef = useRef(0);
  const harnessKey = HARNESS_NAV_ORDER.filter(harness => enabledHarnessIds.includes(harness)).join(",");
  // A string key keeps `refresh` stable while the toggles are unchanged (the array identity changes every render).
  const targetKey = enabledTargetIds ? [...enabledTargetIds].sort().join(",") : null;

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!dataFolderOk) {
      setEntries({});
      setLoading(false);
      return;
    }
    const harnesses = harnessKey ? (harnessKey.split(",") as InstallAgent[]) : [];
    const ids: OverviewId[] = ["workspace", ...harnesses];
    const targetIds = targetKey === null ? undefined : targetKey === "" ? [] : targetKey.split(",");
    setLoading(true);
    setEntries(previous => {
      const next: Partial<Record<OverviewId, OverviewEntry>> = {};
      for (const id of ids) {
        next[id] = { id, status: previous[id]?.status ?? null, loading: true, error: null };
      }
      return next;
    });
    const results = await Promise.all(
      ids.map(async (id): Promise<OverviewEntry> => {
        try {
          const status = await invoke<InstallationStatus>("get_installation_status", {
            surfaces: surfacesForOverview(id, targetIds),
          });
          return { id, status, loading: false, error: null };
        } catch (error) {
          return { id, status: null, loading: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    if (generation !== generationRef.current) return;
    setEntries(Object.fromEntries(results.map(entry => [entry.id, entry])));
    setLoading(false);
  }, [dataFolderOk, harnessKey, targetKey]);

  useEffect(() => {
    if (!busy) void refresh();
  }, [busy, refresh, refreshKey]);

  return useMemo(() => ({ entries, loading, refresh }), [entries, loading, refresh]);
}

/** Installation state of one target, or null while unknown. */
export function overviewState(overview: InstallationOverview | undefined, id: OverviewId): InstallationState | null {
  return overview?.entries[id]?.status?.state ?? null;
}

/** Operations an update would apply without touching conflicts. */
export function safeOperationCount(status: InstallationStatus): number {
  const { create_count, update_count, remove_count } = status.counts;
  return create_count + update_count + remove_count;
}

/** One-line suggestion text for `:update <target>`: "apply 7 safe, skip 1 conflict". */
export function describeUpdate(status: InstallationStatus | null | undefined): string | undefined {
  if (!status) return undefined;
  const safe = safeOperationCount(status);
  const conflicts = status.counts.conflict_count;
  if (safe === 0 && conflicts === 0) return status.state === "unavailable" ? "unavailable" : "current";
  const skipped = conflicts > 0 ? `, skip ${conflicts} conflict${conflicts === 1 ? "" : "s"}` : "";
  if (safe === 0) return `nothing safe to apply${skipped}`;
  return `apply ${safe} safe${skipped}`;
}
