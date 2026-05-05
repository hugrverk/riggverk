export interface ProfileTemplate {
  id: string;
  title: string;
  description: string;
  target_tool: string;
  recommended_model: string;
  db_migration: string;
  risk: string;
  skills: string[];
  agent_profile: string | null;
  notes: string[];
}

export const VALID_STARTER_SKILLS: Set<string> = new Set([
  "accessibility-review",
  "agent-report-review",
  "browser-qa",
  "caveman",
  "context-budget",
  "current-docs",
  "database-migrations",
  "dependency-evaluation",
  "diagnose",
  "frontend-design",
  "grill-me",
  "grill-with-docs",
  "implementation-plan",
  "improve-codebase-architecture",
  "release-check",
  "screenshot-review",
  "security-review",
  "tdd",
  "to-prd",
  "triage",
  "write-a-skill",
  "zoom-out",
]);

export const VALID_STARTER_AGENTS: Set<string> = new Set([
  "autopilot.md",
  "code-reviewer.md",
  "docs-writer.md",
  "qa-verifier.md",
  "repo-scout.md",
  "security-auditor.md",
]);

function isValidTemplateSkill(skill: string): boolean {
  return VALID_STARTER_SKILLS.has(skill);
}

function isValidTemplateAgent(agent: string): boolean {
  return VALID_STARTER_AGENTS.has(agent);
}

export const PROFILE_TEMPLATES: { label: string; profile: ProfileTemplate }[] = [
  {
    label: "generic-codex-review",
    profile: {
      id: "generic-codex-review",
      title: "Generic Codex Review",
      description: "Code review with Codex for general-purpose tasks.",
      target_tool: "codex",
      recommended_model: "GPT-5.5 Medium",
      db_migration: "NO",
      risk: "low",
      skills: ["agent-report-review"],
      agent_profile: "code-reviewer.md",
      notes: [],
    },
  },
  {
    label: "generic-opencode-implementation",
    profile: {
      id: "generic-opencode-implementation",
      title: "Generic OpenCode Implementation",
      description: "Implementation work using OpenCode with diagnostics support.",
      target_tool: "opencode",
      recommended_model: "opencode-go/deepseek-v4-pro",
      db_migration: "NO",
      risk: "medium",
      skills: ["diagnose", "implementation-plan"],
      agent_profile: null,
      notes: [],
    },
  },
  {
    label: "frontend-ui",
    profile: {
      id: "frontend-ui",
      title: "Frontend UI",
      description: "Frontend design and implementation with accessibility review.",
      target_tool: "opencode",
      recommended_model: "opencode-go/deepseek-v4-pro",
      db_migration: "NO",
      risk: "medium",
      skills: ["frontend-design", "accessibility-review", "browser-qa"],
      agent_profile: null,
      notes: [],
    },
  },
  {
    label: "security-review",
    profile: {
      id: "security-review",
      title: "Security Review",
      description: "Security audit with backend code analysis.",
      target_tool: "opencode",
      recommended_model: "opencode-go/deepseek-v4-pro",
      db_migration: "NO",
      risk: "high",
      skills: ["security-review", "diagnose"],
      agent_profile: "security-auditor.md",
      notes: ["Run security-review before any deployment affecting auth, uploads, or payments."],
    },
  },
];

// Verify built-in templates reference only known starter skills and agents
for (const t of PROFILE_TEMPLATES) {
  for (const skill of t.profile.skills) {
    if (!isValidTemplateSkill(skill)) {
      throw new Error(`Template ${t.label}: unknown skill "${skill}"`);
    }
  }
  if (t.profile.agent_profile && !isValidTemplateAgent(t.profile.agent_profile)) {
    throw new Error(`Template ${t.label}: unknown agent "${t.profile.agent_profile}"`);
  }
}
