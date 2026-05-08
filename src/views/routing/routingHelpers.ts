import type { RoutingProfile } from "../../types";

export function riskClass(risk: string): string {
  switch (risk.toLowerCase()) {
    case "low": return "ws-color-ok";
    case "medium": return "ws-color-warn";
    case "high": return "ws-color-fail";
    default: return "";
  }
}

export function riskLabel(risk: string): string {
  switch (risk.toLowerCase()) {
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    default: return risk;
  }
}

/** Build the brain setup instruction block for external assistants. */
export function buildBrainSetupBlock(): string {
  return [
    "Agent Workspace Brain Setup",
    "",
    "You are an AI coding assistant. Your user has installed a set of specialised skills",
    "that you should use as execution guidance. Skill routing is manual: the user or",
    "their workspace tells you which skills apply. Agent Workspace is a local macOS",
    "configuration tool — it does not automatically control ChatGPT, Claude Web,",
    "Codex, or any external chat UI.",
    "",
    "## Core behavior",
    "",
    "- Route coding and product tasks through relevant installed skills.",
    "- Recommend target model/tool before implementation prompts.",
    "- Include DB/migration status before implementation prompts.",
    "- Include relevant skills before implementation prompts.",
    "- Include risk, token, or cost notes when applicable.",
    "- Translate skill names into concrete execution instructions, acceptance",
    "  criteria, and verification steps.",
    "- Prefer repository reality over assumptions, stale docs, or memory.",
    "- Inspect relevant files before editing.",
    "- Keep diffs small and bounded.",
    "- Never print secrets, tokens, credentials, cookies, env values, private",
    "  keys, private tokenized URLs, or sensitive config.",
    "- Never claim verification passed unless commands were actually run.",
    "- Use English for code, comments, filenames, commits, prompts, and",
    "  implementation output unless the user asks otherwise.",
    "- Use the user's language for conversation and user-facing copy when",
    "  appropriate.",
    "",
    "## Skill routing reference",
    "",
    "diagnose: use for bugs, regressions, flakes, slowness, and root-cause",
    "  work. Require cause before patch.",
    "implementation-plan: use for larger or risky implementation slices.",
    "  Require file map, patch sequence, verification, risks, and no",
    "  placeholders.",
    "frontend-design: use for UI polish. Require clear aesthetic direction,",
    "  existing design patterns, and non-generic UI.",
    "browser-qa: use for runtime UI verification, responsive checks,",
    "  console checks, and route smoke tests.",
    "accessibility-review: use for keyboard navigation, focus states,",
    "  semantic HTML, ARIA-sensitive UI, forms, dialogs, and contrast-",
    "  sensitive surfaces.",
    "security-review: use for auth, permissions, uploads, forms, API routes,",
    "  secrets, shell execution, webhooks, database access, checkout,",
    "  customer data, and sensitive data.",
    "database-migrations: use for schema changes, migration order, rollback,",
    "  backfills, destructive data risk, and DB verification.",
    "release-check: use before merge, deploy, release, or handoff. Require",
    "  verification evidence.",
    "agent-report-review: use when reviewing another coding agent final",
    "  report before writing the next implementation prompt.",
    "context-budget: use for large prompts, noisy reports, repo-wide audits,",
    "  and slicing/token discipline.",
    "",
    "Before implementing any task, read the relevant skill instructions (in",
    "skills/<name>/SKILL.md) to understand the full workflow and acceptance",
    "criteria for that skill.",
  ].join("\n");
}

/** Build a profile header block suitable for pasting at the top of an implementation prompt. */
export function buildProfileHeader(profile: RoutingProfile): string {
  const riskText = riskLabel(profile.risk);
  const skills = profile.skills.join(", ") || "none";
  const agent = profile.agent_profile ?? "none";
  const block = [
    `Recommended target model/tool: ${profile.target_tool} / ${profile.recommended_model}`,
    `DB push before running this slice: ${profile.db_migration}`,
    `Relevant skills: ${skills}`,
    `Execution profile: ${profile.id}`,
    `Risk/token/cost notes: ${riskText}`,
    `Agent profile: ${agent}`,
    "",
    "Instructions:",
    "- Use the listed skills as execution constraints.",
    "- Convert each skill into concrete steps, acceptance criteria, and verification.",
    "- Inspect repository reality before editing.",
    "- Keep the diff bounded to the requested slice.",
    "- Do not claim verification passed unless commands were actually run.",
  ].join("\n");
  return block;
}

/** Legacy alias kept for compatibility — returns the same block as buildProfileHeader. */
export function copyMetadataBlock(profile: RoutingProfile): string {
  return buildProfileHeader(profile);
}

export function profileStatus(profile: RoutingProfile): "ready" | "warnings" {
  if (profile.missing_skills.length > 0 || profile.missing_agent) return "warnings";
  return "ready";
}
