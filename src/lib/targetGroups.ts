import type { AgentTargetMeta, TargetProfileMeta } from "../types";

export type TargetPage = "codex" | "opencode" | "cursor" | "misc";

export const PAGE_TARGET_IDS: Record<TargetPage, readonly string[]> = {
  codex: ["codex_rules", "codex_config"],
  opencode: ["opencode_rules", "opencode_config"],
  cursor: ["cursor_setup"],
  misc: ["auggie_rules", "claude_rules"],
};

const CROSS_PROFILE_IDS = new Set(["all_rules", "all_supported"]);

export function filterTargetsForPage(targets: AgentTargetMeta[], page: TargetPage): AgentTargetMeta[] {
  const ids = new Set(PAGE_TARGET_IDS[page]);
  return targets.filter(t => ids.has(t.id));
}

export function filterProfilesForPage(profiles: TargetProfileMeta[], page: TargetPage): TargetProfileMeta[] {
  const pageProfile = profiles.filter(p => p.id === page);
  const crossProfiles = page === "misc"
    ? profiles.filter(p => CROSS_PROFILE_IDS.has(p.id))
    : [];
  return [...pageProfile, ...crossProfiles];
}

export function pageLabelToTargetPage(label: string | undefined): TargetPage | undefined {
  switch (label) {
    case "CODEX": return "codex";
    case "OPENCODE": return "opencode";
    case "CURSOR": return "cursor";
    case "MISC": return "misc";
    default: return undefined;
  }
}
