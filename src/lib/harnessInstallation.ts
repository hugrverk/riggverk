import {
  INSTALL_AGENTS,
  type AppSettings,
  type InstallAgent,
  type SetupPlan,
  type SetupSurfaceId,
} from "../types";

/**
 * Every surface of a harness, regardless of target toggles. Use `enabledSurfacesForHarness` to install.
 * `skills` is listed for every harness but belongs to none: one global surface installs into the folders
 * all the enabled harnesses read.
 */
export const HARNESS_SURFACES: Record<InstallAgent, SetupSurfaceId[]> = {
  codex: ["codex_config", "codex_agents", "codex_rules", "skills"],
  opencode: ["open_code_config", "open_code_agents", "open_code_rules", "skills"],
  claude: ["claude_rules", "claude_agents", "skills"],
  cursor: ["cursor_agents", "skills", "cursor_mcp"],
};

/** Surfaces shown on every harness page that belong to no single harness. */
const SHARED_SURFACES: readonly SetupSurfaceId[] = ["skills"];

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
 * `skills` and `workspace_bundle` are never gated.
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

/** Target ids in backend registry order (`agent_targets::targets`), which settings normalize to. */
const TARGET_IDS_REGISTRY_ORDER: readonly SetupTargetId[] = [
  "codex_rules",
  "opencode_rules",
  "claude_rules",
  "opencode_agents",
  "claude_agents",
  "codex_agents",
  "opencode_config",
  "codex_config",
  "cursor_setup",
];

/** Mirrors `agent_targets::default_enabled_ids`. */
export const DEFAULT_ENABLED_TARGET_IDS: readonly SetupTargetId[] = TARGET_IDS_REGISTRY_ORDER.filter(
  (id) => !DEFAULT_DISABLED_TARGET_IDS.includes(id),
);

/** The target toggle gating `surface`, or null for ungated surfaces (skills, workspace bundle). */
export function targetIdForSurface(surface: SetupSurfaceId): SetupTargetId | null {
  const ids = Object.keys(TARGET_SURFACES) as SetupTargetId[];
  return ids.find((id) => TARGET_SURFACES[id].includes(surface)) ?? null;
}

/** The harness a surface belongs to, or null for `skills` and `workspace_bundle`. */
export function harnessForSurface(surface: SetupSurfaceId): InstallAgent | null {
  if (SHARED_SURFACES.includes(surface)) return null;
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

/** Whether the harness page `harness` offers `surface`: a disabled harness offers nothing, `skills` included. */
function isSurfaceEnabledFor(harness: InstallAgent, settings: EnabledSettings, surface: SetupSurfaceId): boolean {
  return settings.enabled_harness_ids.includes(harness) && isSurfaceEnabled(settings, surface);
}

/** Surfaces to preview/apply for a harness: its surfaces minus those whose target is off. */
export function enabledSurfacesForHarness(
  harness: InstallAgent,
  settings: EnabledSettings,
): SetupSurfaceId[] {
  return HARNESS_SURFACES[harness].filter((surface) => isSurfaceEnabledFor(harness, settings, surface));
}

/** Surfaces of a harness that Install skips because a target toggle (or the harness) is off. */
export function disabledSurfacesForHarness(
  harness: InstallAgent,
  settings: EnabledSettings,
): SetupSurfaceId[] {
  return HARNESS_SURFACES[harness].filter((surface) => !isSurfaceEnabledFor(harness, settings, surface));
}

/** Per-surface on/off state for a harness page; `targetId` names the toggle that gates it (null = never gated). */
export function harnessSurfaceStates(
  harness: InstallAgent,
  settings: EnabledSettings,
): { surface: SetupSurfaceId; enabled: boolean; targetId: SetupTargetId | null }[] {
  return HARNESS_SURFACES[harness].map((surface) => ({
    surface,
    enabled: isSurfaceEnabledFor(harness, settings, surface),
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

/**
 * Workspace plus every enabled harness, target-filtered: the surfaces for an "update all" preview.
 * `skills` is listed by every harness and requested once.
 */
export function enabledSetupSurfaces(settings: EnabledSettings): SetupSurfaceId[] {
  return [
    ...new Set([
      ...WORKSPACE_SURFACES,
      ...INSTALL_AGENTS.flatMap((harness) => enabledSurfacesForHarness(harness, settings)),
    ]),
  ];
}

export function surfacesNeedingApply(plan: SetupPlan): SetupSurfaceId[] {
  const surfaces = plan.operations
    .filter((op) => op.kind === "create" || op.kind === "update" || op.kind === "remove")
    .map((op) => op.surface);
  return [...new Set(surfaces)];
}
