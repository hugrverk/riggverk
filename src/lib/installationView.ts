import {
  surfacesForOverview,
  safeOperationCount,
  type InstallationOverview,
  type OverviewEntry,
  type OverviewId,
} from "../hooks/useInstallationOverview";
import type { GlyphName } from "../ui/Glyph";
import type { Tone } from "../ui/tone";
import type { AppSettings, InstallationState, InstallationStatus, InstallAgent, SetupSurfaceId } from "../types";
import {
  harnessSurfaceStates,
  HARNESS_LABELS,
  HARNESS_NAV_ORDER,
  WORKSPACE_SURFACES,
} from "./harnessInstallation";

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/**
 * A surface state as the pages show it: the backend states plus `off` (target toggle), `unknown` (not fetched)
 * and `user_managed` (a rules file the user chose to manage; the backend reports it as current).
 */
export type SurfaceDisplayState = InstallationState | "off" | "unknown" | "user_managed";

export interface StateDisplay {
  glyph: GlyphName;
  tone: Tone;
  label: string;
}

const STATE_DISPLAY: Record<SurfaceDisplayState, StateDisplay> = {
  current: { glyph: "ok", tone: "ok", label: "current" },
  update_available: { glyph: "partial", tone: "warn", label: "update" },
  not_installed: { glyph: "partial", tone: "warn", label: "not installed" },
  conflict: { glyph: "fail", tone: "fail", label: "conflict" },
  unavailable: { glyph: "none", tone: "dim", label: "unavailable" },
  off: { glyph: "none", tone: "dim", label: "off" },
  unknown: { glyph: "none", tone: "dim", label: "unknown" },
  user_managed: { glyph: "partial", tone: "warn", label: "you manage" },
};

export function overviewLabel(id: OverviewId): string {
  return id === "workspace" ? "workspace" : HARNESS_LABELS[id].toLowerCase();
}

/** Workspace plus the enabled harnesses in tab order: the rows of the harness list and the matrix. */
export function overviewTargets(enabledHarnessIds: readonly InstallAgent[]): OverviewId[] {
  return ["workspace", ...HARNESS_NAV_ORDER.filter(harness => enabledHarnessIds.includes(harness))];
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export interface TargetMeta {
  text: string;
  tone: Tone;
}

/** The right-hand cell of a harness-list row: "current", "2 to update", "1 conflict", "…". */
export function targetMeta(entry: OverviewEntry | undefined, options: { workspaceValid: boolean; id: OverviewId }): TargetMeta {
  if (!options.workspaceValid) {
    return options.id === "workspace" ? { text: "setup needed", tone: "warn" } : { text: "needs workspace", tone: "dim" };
  }
  if (!entry || (entry.loading && !entry.status)) return { text: "…", tone: "dim" };
  if (entry.error) return { text: "status failed", tone: "fail" };
  const status = entry.status;
  if (!status) return { text: "unknown", tone: "dim" };
  const safe = safeOperationCount(status);
  const conflicts = status.counts.conflict_count;
  if (conflicts > 0) {
    return { text: safe > 0 ? `${safe} to update · ${plural(conflicts, "conflict")}` : plural(conflicts, "conflict"), tone: "fail" };
  }
  switch (status.state) {
    case "current":
      return { text: "current", tone: "ok" };
    case "unavailable":
      return { text: "unavailable", tone: "dim" };
    case "not_installed":
      return { text: "not installed", tone: "warn" };
    default:
      return { text: safe > 0 ? `${safe} to update` : "update available", tone: "warn" };
  }
}

/** "claude_rules" -> "rules", "workspace_bundle" -> "bundle". */
export function surfaceShortName(surface: SetupSurfaceId): string {
  return surface.slice(surface.lastIndexOf("_") + 1);
}

export interface SurfaceRowModel {
  surface: SetupSurfaceId;
  name: string;
  /** Backend detail for the surface, or why it is off. */
  detail: string;
  state: SurfaceDisplayState;
  display: StateDisplay;
  /** The target toggle that switched the surface off; null when it is on or never gated. */
  targetId: string | null;
}

function statusRow(status: InstallationStatus | null | undefined, surface: SetupSurfaceId) {
  return status?.surfaces.find(row => row.surface === surface);
}

/**
 * Rows of the surface list for one target. Surfaces whose target toggle is off are listed as `off` and never
 * come from the status (they are not requested either).
 */
export function surfaceRowsFor(
  id: OverviewId,
  entry: OverviewEntry | undefined,
  settings: EnabledSettings | null,
): SurfaceRowModel[] {
  const states =
    id === "workspace" || !settings
      ? surfacesForOverview(id).map(surface => ({ surface, enabled: true, targetId: null as string | null }))
      : harnessSurfaceStates(id, settings);
  return states.map(({ surface, enabled, targetId }) => {
    if (!enabled) {
      return {
        surface,
        name: surfaceShortName(surface),
        detail: targetId ? `target ${targetId} is off` : "off",
        state: "off",
        display: STATE_DISPLAY.off,
        targetId,
      };
    }
    const row = statusRow(entry?.status, surface);
    const state: SurfaceDisplayState = row?.rules?.user_managed ? "user_managed" : (row?.state ?? "unknown");
    return {
      surface,
      name: surfaceShortName(surface),
      detail: row?.detail ?? "",
      state,
      display: STATE_DISPLAY[state],
      targetId: null,
    };
  });
}

export const MATRIX_COLUMNS = ["config", "agents", "rules", "skills", "mcp", "bundle"] as const;
export type MatrixColumn = (typeof MATRIX_COLUMNS)[number];

export type MatrixCellState = SurfaceDisplayState | "na";

export interface MatrixCellModel {
  column: MatrixColumn;
  state: MatrixCellState;
  display: StateDisplay;
}

export interface MatrixRowModel {
  id: OverviewId;
  label: string;
  cells: MatrixCellModel[];
}

const NOT_APPLICABLE: StateDisplay = { glyph: "none", tone: "dim", label: "n/a" };

/** Every target (rows) against every surface kind (columns); "n/a" where the target has no such surface. */
export function matrixModel(
  overview: InstallationOverview | undefined,
  targets: readonly OverviewId[],
  settings: EnabledSettings | null,
): MatrixRowModel[] {
  return targets.map(id => {
    const surfaces = id === "workspace" ? WORKSPACE_SURFACES : surfacesForOverview(id);
    const rows = surfaceRowsFor(id, overview?.entries[id], settings);
    return {
      id,
      label: overviewLabel(id),
      cells: MATRIX_COLUMNS.map((column): MatrixCellModel => {
        const surface = surfaces.find(candidate => surfaceShortName(candidate) === column);
        if (!surface) return { column, state: "na", display: NOT_APPLICABLE };
        const state = rows.find(row => row.surface === surface)?.state ?? "unknown";
        return { column, state, display: STATE_DISPLAY[state] };
      }),
    };
  });
}

export interface UpdateAction {
  /** Key hint: "update", "install", "update safe files", "review conflicts". */
  label: string;
  /** Why the action cannot run right now, or false when it can. */
  disabled: string | false;
}

/**
 * The `u` action of a target: its label follows the installation state, and the reason it is off is the
 * first of: no workspace (harnesses only), a running task, unsaved target changes, status still loading,
 * already current, unavailable.
 */
export function updateActionFor(
  id: OverviewId,
  entry: OverviewEntry | undefined,
  context: { workspaceValid: boolean; busyLabel: string | null; settingsSaving: boolean },
): UpdateAction {
  const state = entry?.status?.state;
  const hasConflicts = (entry?.status?.counts.conflict_count ?? 0) > 0;
  const label =
    state === "not_installed" || (id === "workspace" && !context.workspaceValid)
      ? "install"
      : state === "conflict"
        ? "review conflicts"
        : state === "update_available" && hasConflicts
          ? "update safe files"
          : "update";
  let disabled: string | false = false;
  if (!context.workspaceValid && id !== "workspace") disabled = "no valid workspace installed";
  else if (context.busyLabel) disabled = `${context.busyLabel} is running`;
  else if (context.settingsSaving) disabled = "saving target changes";
  else if (context.workspaceValid && entry?.loading && !entry.status) disabled = "checking status…";
  else if (state === "current") disabled = "already current (p previews anyway)";
  else if (state === "unavailable") disabled = "unavailable on this system";
  return { label, disabled };
}

/** Why a read-only preview cannot run, or false. */
export function previewDisabledFor(
  id: OverviewId,
  context: { workspaceValid: boolean; busyLabel: string | null },
): string | false {
  if (!context.workspaceValid && id !== "workspace") return "no valid workspace installed";
  if (context.busyLabel) return `${context.busyLabel} is running`;
  return false;
}
