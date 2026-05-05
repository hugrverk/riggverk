import type { AgentMetadataResponse, RoutingProfile, SkillSummary } from "../../types";

export interface CompatibilityRow {
  tool: string;
  skillCount: number;
  agentCount: number;
  profileCount: number;
  readyProfileCount: number;
}

const VALID_TOOLS = ["codex", "opencode", "claude", "gemini", "auggie"];

/** Count skills whose metadata.targets includes the given tool. */
function countSkillsByTarget(skills: SkillSummary[], tool: string): number {
  return skills.filter((s) => s.targets.includes(tool)).length;
}

/** Count agents whose metadata.targets includes the given tool. */
function countAgentsByTarget(agentSources: AgentMetadataResponse[], tool: string): number {
  return agentSources.filter((a) => (a.metadata?.targets ?? []).includes(tool)).length;
}

/** Count profiles targeting the given tool. */
function countProfilesByTarget(profiles: RoutingProfile[], tool: string): number {
  return profiles.filter((p) => p.target_tool === tool).length;
}

/** Count profiles targeting the given tool that have NO missing skills and NO missing agent. */
function countReadyProfilesByTarget(profiles: RoutingProfile[], tool: string): number {
  return profiles.filter(
    (p) => p.target_tool === tool && p.missing_skills.length === 0 && !p.missing_agent,
  ).length;
}

/**
 * Build a deterministic compatibility overview.
 * Uses profile-level data (missing_skills, missing_agent) instead of
 * brittle string matching on global warnings.
 */
export function buildCompatibilityRows(
  skills: SkillSummary[],
  agentSources: AgentMetadataResponse[],
  profiles: RoutingProfile[],
): CompatibilityRow[] {
  return VALID_TOOLS.map((tool) => ({
    tool,
    skillCount: countSkillsByTarget(skills, tool),
    agentCount: countAgentsByTarget(agentSources, tool),
    profileCount: countProfilesByTarget(profiles, tool),
    readyProfileCount: countReadyProfilesByTarget(profiles, tool),
  }));
}

/** Returns true when at least one row has non-zero counts (available data). */
export function hasCompatibilityData(rows: CompatibilityRow[]): boolean {
  return rows.some(
    (r) => r.skillCount > 0 || r.agentCount > 0 || r.profileCount > 0,
  );
}
