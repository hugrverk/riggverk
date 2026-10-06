import {
  INSTALL_AGENTS,
  type AppSettings,
  type InstallationState,
  type InstallAgent,
  type SetupPlan,
  type SetupSurfaceId,
} from "../types";

/** Every surface of a harness, regardless of target toggles. Use `enabledSurfacesForHarness` to install. */
export const HARNESS_SURFACES: Record<InstallAgent, SetupSurfaceId[]> = {
  codex: ["codex_config", "codex_agents", "codex_rules", "codex_skills"],
  opencode: ["open_code_config", "open_code_agents", "open_code_rules", "open_code_skills"],
  claude: ["claude_rules", "claude_agents", "claude_skills"],
  cursor: ["cursor_agents", "cursor_skills", "cursor_mcp"],
};

export type SetupTargetId =
  | "codex_rules"
  | "codex_agents"
  | "codex_config"
  | "opencode_rules"
  | "opencode_agents"
  | "opencode_config"
  | "claude_rules"
  | "claude_agents"
  | "cursor_setup";

/**
 * Surfaces gated by each target toggle. Mirrors `agent_targets::target_surfaces` in the backend.
 * Skills surfaces and `workspace_bundle` are never gated.
 */
export const TARGET_SURFACES: Record<SetupTargetId, readonly SetupSurfaceId[]> = {
  codex_rules: ["codex_rules"],
  codex_agents: ["codex_agents"],
  codex_config: ["codex_config"],
  opencode_rules: ["open_code_rules"],
  opencode_agents: ["open_code_agents"],
  opencode_config: ["open_code_config"],
  claude_rules: ["claude_rules"],
  claude_agents: ["claude_agents"],
  cursor_setup: ["cursor_agents", "cursor_mcp"],
};

/** Targets that start OFF (`codex_config` rewrites the user's Codex approval/sandbox posture). */
const DEFAULT_DISABLED_TARGET_IDS: readonly SetupTargetId[] = ["codex_config"];

/** Mirrors `agent_targets::default_enabled_ids`. */
export const DEFAULT_ENABLED_TARGET_IDS: readonly SetupTargetId[] = (
  Object.keys(TARGET_SURFACES) as SetupTargetId[]
).filter((id) => !DEFAULT_DISABLED_TARGET_IDS.includes(id));

/** The target toggle gating `surface`, or null for ungated surfaces (skills, workspace bundle). */
export function targetIdForSurface(surface: SetupSurfaceId): SetupTargetId | null {
  const ids = Object.keys(TARGET_SURFACES) as SetupTargetId[];
  return ids.find((id) => TARGET_SURFACES[id].includes(surface)) ?? null;
}

/** The harness a surface belongs to, or null for `workspace_bundle`. */
export function harnessForSurface(surface: SetupSurfaceId): InstallAgent | null {
  return INSTALL_AGENTS.find((harness) => HARNESS_SURFACES[harness].includes(surface)) ?? null;
}

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/**
 * Mirrors `settings::surface_enabled`: the surface's harness is enabled and, for
 * target-gated surfaces, its target toggle is on.
 */
export function isSurfaceEnabled(settings: EnabledSettings, surface: SetupSurfaceId): boolean {
  const harness = harnessForSurface(surface);
  if (harness && !settings.enabled_harness_ids.includes(harness)) return false;
  const targetId = targetIdForSurface(surface);
  return targetId === null || settings.enabled_target_ids.includes(targetId);
}

/** Surfaces to preview/apply for a harness: its surfaces minus those whose target is off. */
export function enabledSurfacesForHarness(
  harness: InstallAgent,
  settings: EnabledSettings,
): SetupSurfaceId[] {
  return HARNESS_SURFACES[harness].filter((surface) => isSurfaceEnabled(settings, surface));
}

/** Surfaces of a harness that Install skips because a target toggle (or the harness) is off. */
export function disabledSurfacesForHarness(
  harness: InstallAgent,
  settings: EnabledSettings,
): SetupSurfaceId[] {
  return HARNESS_SURFACES[harness].filter((surface) => !isSurfaceEnabled(settings, surface));
}

/** Per-surface on/off state for a harness page; `targetId` names the toggle that gates it (null = never gated). */
export function harnessSurfaceStates(
  harness: InstallAgent,
  settings: EnabledSettings,
): { surface: SetupSurfaceId; enabled: boolean; targetId: SetupTargetId | null }[] {
  return HARNESS_SURFACES[harness].map((surface) => ({
    surface,
    enabled: isSurfaceEnabled(settings, surface),
    targetId: targetIdForSurface(surface),
  }));
}

export const HARNESS_LABELS: Record<InstallAgent, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude",
  cursor: "Cursor",
};
export const HARNESS_NAV_ORDER: InstallAgent[] = ["codex", "opencode", "cursor", "claude"];

export function harnessForView(view: string): InstallAgent | null {
  return (["codex", "opencode", "claude", "cursor"] as const).includes(view as InstallAgent)
    ? view as InstallAgent
    : null;
}

export const WORKSPACE_SURFACES: SetupSurfaceId[] = ["workspace_bundle"];

/** Workspace plus every enabled harness, target-filtered: the surfaces for an "update all" preview. */
export function enabledSetupSurfaces(settings: EnabledSettings): SetupSurfaceId[] {
  return [
    ...WORKSPACE_SURFACES,
    ...INSTALL_AGENTS.flatMap((harness) => enabledSurfacesForHarness(harness, settings)),
  ];
}

export function surfacesNeedingApply(plan: SetupPlan): SetupSurfaceId[] {
  const surfaces = plan.operations
    .filter((op) => op.kind === "create" || op.kind === "update" || op.kind === "remove")
    .map((op) => op.surface);
  return [...new Set(surfaces)];
}

export function installationChipTone(
  state: InstallationState,
): "ok" | "warn" | "fail" | "muted" {
  switch (state) {
    case "current": return "ok";
    case "update_available":
    case "not_installed": return "warn";
    case "conflict": return "fail";
    case "unavailable": return "muted";
  }
}

export function installationChipLabel(state: InstallationState): string {
  switch (state) {
    case "current": return "current";
    case "update_available": return "update available";
    case "not_installed": return "not installed";
    case "conflict": return "conflicts";
    case "unavailable": return "unavailable";
  }
}

export function installationPrimaryAction(state: InstallationState): {
  label: string;
  variant: "primary" | "warn" | "default";
  disabled: boolean;
} {
  switch (state) {
    case "current":
      return { label: "current", variant: "default", disabled: true };
    case "update_available":
      return { label: "update", variant: "primary", disabled: false };
    case "not_installed":
      return { label: "install", variant: "primary", disabled: false };
    case "conflict":
      return { label: "review conflicts", variant: "warn", disabled: false };
    case "unavailable":
      return { label: "unavailable", variant: "default", disabled: true };
  }
}
