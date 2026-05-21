import type { AgentTargetMeta, TargetProfileMeta } from "../types";

export type TargetPage = "codex" | "opencode" | "cursor" | "claude" | "augment";

export const PAGE_TARGET_IDS: Record<TargetPage, readonly string[]> = {
  codex: ["codex_rules", "codex_config"],
  opencode: ["opencode_rules", "opencode_agents", "opencode_config"],
  cursor: ["cursor_setup"],
  claude: ["claude_rules", "claude_agents"],
  augment: ["auggie_rules", "auggie_agents"],
};

const CROSS_PROFILE_IDS = new Set(["all_rules", "all_supported"]);
const PASSIVE_PAGES = new Set<TargetPage>(["claude", "augment"]);

export function filterTargetsForPage(targets: AgentTargetMeta[], page: TargetPage): AgentTargetMeta[] {
  const ids = new Set(PAGE_TARGET_IDS[page]);
  return targets.filter(t => ids.has(t.id));
}

export function filterProfilesForPage(profiles: TargetProfileMeta[], page: TargetPage): TargetProfileMeta[] {
  const pageProfile = profiles.filter(p => p.id === page);
  const crossProfiles = PASSIVE_PAGES.has(page)
    ? profiles.filter(p => CROSS_PROFILE_IDS.has(p.id))
    : [];
  return [...pageProfile, ...crossProfiles];
}

export function pageLabelToTargetPage(label: string | undefined): TargetPage | undefined {
  switch (label) {
    case "CODEX": return "codex";
    case "OPENCODE": return "opencode";
    case "CURSOR": return "cursor";
    case "CLAUDE": return "claude";
    case "AUGMENT": return "augment";
    default: return undefined;
  }
}
