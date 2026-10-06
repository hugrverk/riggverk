import type { InstallationState, InstallAgent, SetupPlan, SetupSurfaceId } from "../types";

export const HARNESS_SURFACES: Record<InstallAgent, SetupSurfaceId[]> = {
  codex: ["codex_config", "codex_agents", "codex_rules", "codex_skills"],
  opencode: ["open_code_config", "open_code_agents", "open_code_rules", "open_code_skills"],
  claude: ["claude_rules", "claude_agents", "claude_skills"],
  cursor: ["cursor_agents", "cursor_skills", "cursor_mcp"],
};

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
