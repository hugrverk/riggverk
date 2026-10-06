import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HARNESS_NAV_ORDER, HARNESS_SURFACES, WORKSPACE_SURFACES } from "../lib/harnessInstallation";
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
  workspaceValid: boolean;
  /** A workspace task (apply, uninstall, rollback) is running; the overview re-fetches when it ends. */
  busy: boolean;
  enabledHarnessIds: readonly InstallAgent[];
  /** Bump to force a re-fetch (e.g. after a model save). */
  refreshKey?: number;
}

export function surfacesForOverview(id: OverviewId): SetupSurfaceId[] {
  return id === "workspace" ? WORKSPACE_SURFACES : HARNESS_SURFACES[id];
}

/**
 * Single source for installation state across the shell (tab status dots, `:update` suggestions) and,
 * from S2 on, the Start page lists and surface matrix. Same fetch as HarnessInstallationCard
 * (`get_installation_status` per target), minus the card's dialog and rendering. Failures stay in the entry;
 * they never reach the global error line.
 */
export function useInstallationOverview({
  workspaceValid,
  busy,
  enabledHarnessIds,
  refreshKey,
}: UseInstallationOverviewOptions): InstallationOverview {
  const [entries, setEntries] = useState<Partial<Record<OverviewId, OverviewEntry>>>({});
  const [loading, setLoading] = useState(false);
  const generationRef = useRef(0);
  const harnessKey = HARNESS_NAV_ORDER.filter(harness => enabledHarnessIds.includes(harness)).join(",");

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!workspaceValid) {
      setEntries({});
      setLoading(false);
      return;
    }
    const harnesses = harnessKey ? (harnessKey.split(",") as InstallAgent[]) : [];
    const ids: OverviewId[] = ["workspace", ...harnesses];
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
          const status = await invoke<InstallationStatus>("get_installation_status", { surfaces: surfacesForOverview(id) });
          return { id, status, loading: false, error: null };
        } catch (error) {
          return { id, status: null, loading: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    if (generation !== generationRef.current) return;
    setEntries(Object.fromEntries(results.map(entry => [entry.id, entry])));
    setLoading(false);
  }, [workspaceValid, harnessKey]);

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
