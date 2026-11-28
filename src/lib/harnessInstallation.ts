import {
  BEST_EFFORT_AGENTS,
  CENTRAL_AGENTS,
  INSTALL_AGENTS,
  LIGHT_AGENTS,
  type AppSettings,
  type InstallAgent,
  type LightAgent,
  type SetupPlan,
  type SetupSurfaceId,
  type SupportTier,
} from "../types";

/**
 * Every surface of a harness, regardless of target toggles. Use `requestedSurfacesForHarness` to install.
 * `skills` is listed for every harness but belongs to none: one global surface installs into the folders
 * all the enabled harnesses read. The light harnesses (Copilot, Pi, Kilo, Antigravity) add one rules file and one MCP entry each;
 * Grok reads Claude Code's rules file, so it adds only its MCP entry.
 */
export const HARNESS_SURFACES: Record<InstallAgent, SetupSurfaceId[]> = {
  codex: ["codex_config", "codex_agents", "codex_rules", "skills"],
  opencode: ["open_code_config", "open_code_agents", "open_code_rules", "skills"],
  claude: ["claude_rules", "claude_agents", "claude_config", "skills"],
  cursor: ["cursor_agents", "skills", "cursor_mcp"],
  copilot: ["copilot_rules", "skills", "copilot_mcp"],
  pi: ["pi_rules", "skills", "pi_mcp"],
  kilo: ["kilo_rules", "skills", "kilo_mcp"],
  antigravity: ["antigravity_rules", "skills", "antigravity_mcp"],
  grok: ["skills", "grok_mcp"],
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
  | "claude_config"
  | "claude_skill_overrides"
  | "cursor_setup"
  | "copilot_rules"
  | "copilot_mcp"
  | "pi_rules"
  | "pi_mcp"
  | "kilo_rules"
  | "kilo_mcp"
  | "antigravity_rules"
  | "antigravity_mcp"
  | "grok_mcp";

/**
 * Surfaces gated by each target toggle. Mirrors `agent_targets::target_surfaces` in the backend.
 * `skills` and `workspace_bundle` are never gated. `claude_config` has two targets: the surface is on while either is.
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
  claude_config: ["claude_config"],
  claude_skill_overrides: ["claude_config"],
  cursor_setup: ["cursor_agents", "cursor_mcp"],
  copilot_rules: ["copilot_rules"],
  copilot_mcp: ["copilot_mcp"],
  pi_rules: ["pi_rules"],
  pi_mcp: ["pi_mcp"],
  kilo_rules: ["kilo_rules"],
  kilo_mcp: ["kilo_mcp"],
  antigravity_rules: ["antigravity_rules"],
  antigravity_mcp: ["antigravity_mcp"],
  grok_mcp: ["grok_mcp"],
};

/**
 * Targets that start OFF: `codex_config` rewrites the user's Codex approval/sandbox posture, `claude_config` changes
 * how Claude Code attributes commits and pull requests in `~/.claude/settings.json`, `claude_skill_overrides` sets
 * `skillOverrides` in the same file, `kilo_mcp` edits Kilo's main config file, which may hold provider keys,
 * `antigravity_mcp` is opt-in like Kilo's, and `grok_mcp` edits `~/.grok/config.toml`, which may hold `api_key`.
 */
const DEFAULT_DISABLED_TARGET_IDS: readonly SetupTargetId[] = [
  "codex_config",
  "claude_config",
  "claude_skill_overrides",
  "kilo_mcp",
  "antigravity_mcp",
  "grok_mcp",
];

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
  "claude_config",
  "claude_skill_overrides",
  "cursor_setup",
  "copilot_rules",
  "copilot_mcp",
  "pi_rules",
  "pi_mcp",
  "kilo_rules",
  "kilo_mcp",
  "antigravity_rules",
  "antigravity_mcp",
  "grok_mcp",
];

/** Mirrors `agent_targets::default_enabled_ids`. */
export const DEFAULT_ENABLED_TARGET_IDS: readonly SetupTargetId[] = TARGET_IDS_REGISTRY_ORDER.filter(
  (id) => !DEFAULT_DISABLED_TARGET_IDS.includes(id),
);

/** Every target toggle gating `surface`, in registry order; empty for ungated surfaces. Mirrors `agent_targets::surface_target_ids`. */
export function targetIdsForSurface(surface: SetupSurfaceId): SetupTargetId[] {
  return TARGET_IDS_REGISTRY_ORDER.filter((id) => TARGET_SURFACES[id].includes(surface));
}

/** The first target toggle gating `surface`, or null for ungated surfaces (skills, workspace bundle). */
export function targetIdForSurface(surface: SetupSurfaceId): SetupTargetId | null {
  return targetIdsForSurface(surface)[0] ?? null;
}

/**
 * Surfaces whose values the app removes at the next update once every target gating them is off. An update or a
 * status request of an enabled harness names them even then; the backend plans one only while the file still holds
 * the app's values, and drops it otherwise. Mirrors `retiring_surfaces` in `commands/setup.rs`.
 */
export const RETIRING_SURFACES: readonly SetupSurfaceId[] = ["claude_config"];

/** The harness a surface belongs to, or null for `skills` and `workspace_bundle`. */
export function harnessForSurface(surface: SetupSurfaceId): InstallAgent | null {
  if (SHARED_SURFACES.includes(surface)) return null;
  return INSTALL_AGENTS.find((harness) => HARNESS_SURFACES[harness].includes(surface)) ?? null;
}

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/**
 * Mirrors `settings::surface_enabled`: the surface's harness is enabled and, for
 * target-gated surfaces, any target toggle that gates it is on.
 */
export function isSurfaceEnabled(settings: EnabledSettings, surface: SetupSurfaceId): boolean {
  const harness = harnessForSurface(surface);
  if (harness && !settings.enabled_harness_ids.includes(harness)) return false;
  const targetIds = targetIdsForSurface(surface);
  return targetIds.length === 0 || targetIds.some((id) => settings.enabled_target_ids.includes(id));
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

/** What an update or a status request of a harness names: the enabled surfaces, and while the harness is on its `RETIRING_SURFACES`. */
export function requestedSurfacesForHarness(
  harness: InstallAgent,
  settings: EnabledSettings,
): SetupSurfaceId[] {
  const on = settings.enabled_harness_ids.includes(harness);
  return HARNESS_SURFACES[harness].filter(
    (surface) => isSurfaceEnabledFor(harness, settings, surface) || (on && RETIRING_SURFACES.includes(surface)),
  );
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
  copilot: "Copilot",
  pi: "Pi",
  kilo: "Kilo",
  antigravity: "Antigravity",
  grok: "Grok",
};

/** Tab order of the harness pages: `PRIMARY_AGENTS` (digits 2-5), then `BEST_EFFORT_AGENTS`. */
export const HARNESS_NAV_ORDER: InstallAgent[] = ["codex", "opencode", "antigravity", "claude", "cursor", "copilot", "pi", "kilo", "grok"];

/** The support tier of `harness`: a label only, it changes nothing the app writes or turns on. */
export function supportTier(harness: InstallAgent): SupportTier {
  return (BEST_EFFORT_AGENTS as readonly string[]).includes(harness) ? "best_effort" : "primary";
}

/** The tag a best-effort harness shows beside its name. */
export const BEST_EFFORT_LABEL = "Best effort";

/** What the best-effort tag means, in one sentence. */
export const BEST_EFFORT_NOTE = "Riggverk supports this agent, but checks new versions of it later than those of the primary agents.";

/** The harnesses on for a fresh install and for a settings file that names none. Mirrors `HarnessId::DEFAULT_ON`. */
export const DEFAULT_ENABLED_HARNESS_IDS: readonly InstallAgent[] = CENTRAL_AGENTS;

/** Whether `harness` is in the light tier (Copilot, Pi, Kilo, Antigravity, Grok): one shared page, health loaded by `get_light_runtime_health`. */
export function isLightAgent(harness: InstallAgent): harness is LightAgent {
  return (LIGHT_AGENTS as readonly string[]).includes(harness);
}

export function harnessForView(view: string): InstallAgent | null {
  return (INSTALL_AGENTS as readonly string[]).includes(view) ? (view as InstallAgent) : null;
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

/** `enabledSetupSurfaces` with each enabled harness's `RETIRING_SURFACES`: the request of an "update all". */
export function requestedSetupSurfaces(settings: EnabledSettings): SetupSurfaceId[] {
  return [
    ...new Set([
      ...WORKSPACE_SURFACES,
      ...INSTALL_AGENTS.flatMap((harness) => requestedSurfacesForHarness(harness, settings)),
    ]),
  ];
}

export function surfacesNeedingApply(plan: SetupPlan): SetupSurfaceId[] {
  const surfaces = plan.operations
    .filter((op) => op.kind === "create" || op.kind === "update" || op.kind === "remove")
    .map((op) => op.surface);
  return [...new Set(surfaces)];
}
