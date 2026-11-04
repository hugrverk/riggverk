import {
  surfacesForOverview,
  type OverviewEntry,
  type OverviewId,
} from "../hooks/useInstallationOverview";
import type { Tone } from "../ui/tone";
import type {
  AgentTargetMeta,
  AppSettings,
  InstallationState,
  InstallationStatus,
  InstallAgent,
  SetupSurfaceId,
} from "../types";
import {
  harnessSurfaceStates,
  TARGET_SURFACES,
  targetIdForSurface,
  type SetupTargetId,
} from "./harnessInstallation";

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/**
 * A surface state as the pages show it: the backend states plus `off` (target toggle), `unknown` (not fetched)
 * and `user_managed` (a rules file, or skill or agent files, the user chose to keep; the backend reports it as current).
 */
export type SurfaceDisplayState = InstallationState | "off" | "unknown" | "user_managed";

export interface StateDisplay {
  tone: Tone;
  label: string;
}

const STATE_DISPLAY: Record<SurfaceDisplayState, StateDisplay> = {
  current: { tone: "ok", label: "current" },
  update_available: { tone: "warn", label: "update" },
  not_installed: { tone: "warn", label: "not installed" },
  conflict: { tone: "fail", label: "conflict" },
  unavailable: { tone: "dim", label: "unavailable" },
  off: { tone: "dim", label: "off" },
  unknown: { tone: "dim", label: "unknown" },
  user_managed: { tone: "warn", label: "you manage" },
};

/**
 * Why nothing that needs the workspace folder can run. The folder is unusable only when it is a link, a file, or a
 * missing `RIGGVERK_WORKSPACE_PATH` folder: a fresh profile without one is fine, its first install creates it.
 */
export const WORKSPACE_FOLDER_UNUSABLE = "workspace folder unusable";

/** Why it cannot run yet: the diagnostics that judge the folder have not answered (launch, a workspace switch). */
export const WORKSPACE_FOLDER_UNCHECKED = "workspace folder not checked yet";

/** What an off target tells beyond its name, for a target whose default is not obvious from the name. */
const OFF_DETAIL: Partial<Record<string, string>> = {
  claude_config: "off · Claude Code keeps its default commit and PR attribution",
};

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
        detail: targetId ? (OFF_DETAIL[targetId] ?? `target ${targetId} is off`) : "off",
        state: "off",
        display: STATE_DISPLAY.off,
        targetId,
      };
    }
    const row = statusRow(entry?.status, surface);
    const keepsFiles = row?.state === "current" && (row.files?.kept ?? 0) > 0;
    const state: SurfaceDisplayState = row?.rules?.user_managed || keepsFiles ? "user_managed" : (row?.state ?? "unknown");
    return {
      surface,
      // The workspace surface installs nothing any more: it removes the old copies of the bundle.
      name: surface === "workspace_bundle" ? "old copies" : surfaceShortName(surface),
      detail: row?.detail ?? "",
      state,
      display: STATE_DISPLAY[state],
      targetId: null,
    };
  });
}

export interface HarnessRowModel {
  surface: SetupSurfaceId;
  name: string;
  /**
   * The gating target's own path (`target_rel`). Empty for an ungated surface, for a target the backend did not
   * list, and for a target's secondary surface (Cursor's MCP shares `cursor_setup` with the agents, whose path
   * this is not).
   */
  path: string;
  /** Backend detail for the surface ("1 to update"); empty while it is off or not fetched. */
  detail: string;
  state: SurfaceDisplayState;
  display: StateDisplay;
  /** The target toggle gating the surface, whether it is on or off; null for ungated skills. */
  targetId: SetupTargetId | null;
  /** The backend's metadata for `targetId`, or null when ungated or not listed. */
  target: AgentTargetMeta | null;
  /** Whether the toggle is on; null when ungated. */
  targetEnabled: boolean | null;
  /** The other surfaces the same toggle gates. */
  alsoSurfaces: SetupSurfaceId[];
}

/**
 * Rows of a harness page: one per surface, carrying the toggle of the target that gates it. Built from the
 * surfaces (not from the backend's target list) so every gating target is offered, whatever the backend sent.
 */
export function harnessRowsFor(
  harness: InstallAgent,
  entry: OverviewEntry | undefined,
  settings: EnabledSettings,
  agentTargets: readonly AgentTargetMeta[],
): HarnessRowModel[] {
  return surfaceRowsFor(harness, entry, settings).map(row => {
    const targetId = targetIdForSurface(row.surface);
    const gated = targetId ? TARGET_SURFACES[targetId] : [];
    const target = targetId ? (agentTargets.find(candidate => candidate.id === targetId) ?? null) : null;
    return {
      surface: row.surface,
      name: row.name,
      path: target && gated[0] === row.surface ? target.target_rel : "",
      detail: row.state === "off" ? "" : row.detail,
      state: row.state,
      display: row.display,
      targetId,
      target,
      targetEnabled: targetId ? settings.enabled_target_ids.includes(targetId) : null,
      alsoSurfaces: gated.filter(surface => surface !== row.surface),
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
 * first of: an unusable workspace folder (harnesses only), a running task, unsaved target changes, status still loading,
 * already current, unavailable.
 */
export function updateActionFor(
  id: OverviewId,
  entry: OverviewEntry | undefined,
  context: { dataFolderOk: boolean; busyLabel: string | null; settingsSaving: boolean },
): UpdateAction {
  const state = entry?.status?.state;
  const hasConflicts = (entry?.status?.counts.conflict_count ?? 0) > 0;
  const label =
    state === "not_installed" || (id === "workspace" && !context.dataFolderOk)
      ? "install"
      : state === "conflict"
        ? "review conflicts"
        : state === "update_available" && hasConflicts
          ? "update safe files"
          : "update";
  let disabled: string | false = false;
  if (!context.dataFolderOk && id !== "workspace") disabled = WORKSPACE_FOLDER_UNUSABLE;
  else if (context.busyLabel) disabled = `${context.busyLabel} is running`;
  else if (context.settingsSaving) disabled = "saving target changes";
  else if (context.dataFolderOk && entry?.loading && !entry.status) disabled = "checking status…";
  else if (state === "current") disabled = "already current (p previews anyway)";
  else if (state === "unavailable") disabled = "unavailable on this system";
  return { label, disabled };
}

/** Why a read-only preview cannot run, or false. */
export function previewDisabledFor(
  id: OverviewId,
  context: { dataFolderOk: boolean; busyLabel: string | null },
): string | false {
  if (!context.dataFolderOk && id !== "workspace") return WORKSPACE_FOLDER_UNUSABLE;
  if (context.busyLabel) return `${context.busyLabel} is running`;
  return false;
}
