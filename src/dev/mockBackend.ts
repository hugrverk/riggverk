/**
 * Browser-only mock of the Tauri backend for visual QA (`vite dev` + `?mock=<scenario>`).
 *
 * Loaded by main.tsx only when `import.meta.env.DEV && !isTauri()` and the URL has a
 * `mock` query parameter, so production bundles never contain it. Scenarios:
 *   default   everything installed, OpenCode + Claude have updates
 *   conflict  Claude plan with + ~ − ! rows, Cursor blocked by a conflict
 *   fresh     nothing installed, no backups, no transactions
 *   error     status/diagnostics calls fail (exercises the error line)
 *   empty     valid workspace with no docs, skills or agents
 * `&theme=light|dark|system` sets the persisted appearance.
 *
 * Mutating commands update in-memory state so install/rollback/save flows round-trip.
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  ActionResult,
  AgentMetadataListResponse,
  AgentSourceContent,
  AgentTargetMeta,
  AppSettings,
  BackupRunDetails,
  BackupRunSummary,
  BrainSetupSeedResult,
  ClaudeRuntimeHealth,
  CodexRuntimeHealth,
  ConfigEditorSourceMeta,
  CursorProfileHealth,
  DiscoverLocalGitReposResult,
  DocSummary,
  DocsHealth,
  DocumentContent,
  GetSettingsResponse,
  InstallationState,
  InstallationStatus,
  ListAvailableModelsResult,
  OpenCodeModelSelection,
  OpenCodeRuntimeHealth,
  OperationKind,
  PlannedOperation,
  RepoDashboardSnapshot,
  RepoPromptContext,
  SetupPlan,
  SetupResult,
  SetupSurfaceId,
  SkillSummary,
  StatusData,
  SurfaceInstallationStatus,
  UninstallPlanView,
  WorkspaceDiagnostics,
} from "../types";

type Scenario = "default" | "conflict" | "fresh" | "error" | "empty";

const params = new URLSearchParams(location.search);
const scenarioParam = params.get("mock");
const scenario: Scenario = (["default", "conflict", "fresh", "error", "empty"] as const).includes(
  scenarioParam as Scenario,
)
  ? (scenarioParam as Scenario)
  : "default";
const themeParam = params.get("theme");
const appearance: AppSettings["appearance"] =
  themeParam === "light" || themeParam === "dark" || themeParam === "system" ? themeParam : "dark";

const HOME = "/Users/mock";
const WORKSPACE = `${HOME}/.config/agent-workspace`;
const BACKUP_ROOT = `${HOME}/Library/Application Support/ai.agentworkspace.app/backups`;
const BUNDLE_DIGEST = "a7c3e1";
const INSTALLED_DIGEST = "91be20";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/* ---- settings ---- */

const TARGETS: AgentTargetMeta[] = [
  { id: "codex_rules", label: "codex rules", harness: "codex", kind: "rules", target_rel: ".codex/AGENTS.md", source_rel: "templates/sync/codex-rules.md" },
  { id: "opencode_rules", label: "opencode rules", harness: "opencode", kind: "rules", target_rel: ".config/opencode/AGENTS.md", source_rel: "templates/sync/opencode-rules.md" },
  { id: "claude_rules", label: "claude rules", harness: "claude", kind: "rules", target_rel: ".claude/CLAUDE.md", source_rel: "templates/sync/claude-rules.md" },
  { id: "opencode_agents", label: "opencode agents", harness: "opencode", kind: "agents", target_rel: ".config/opencode/agents", source_rel: "agents" },
  { id: "claude_agents", label: "claude agents", harness: "claude", kind: "agents", target_rel: ".claude/agents", source_rel: "templates/claude/agents" },
  { id: "codex_agents", label: "codex agents", harness: "codex", kind: "agents", target_rel: ".codex/agents", source_rel: "templates/codex/agents" },
  { id: "opencode_config", label: "opencode config", harness: "opencode", kind: "config", target_rel: ".config/opencode/opencode.json", source_rel: "templates/opencode.json" },
  { id: "codex_config", label: "codex config", harness: "codex", kind: "config", target_rel: ".codex/config.toml", source_rel: "templates/codex/config.toml" },
  { id: "cursor_setup", label: "cursor global agents", harness: "cursor", kind: "agents", target_rel: ".cursor/agents", source_rel: "templates/cursor/agents" },
];

let settings: AppSettings = {
  appearance,
  app_font_size: "medium",
  workspace_path: null,
  enabled_target_ids: TARGETS.map(t => t.id).filter(id => id !== "codex_config"),
  enabled_harness_ids: ["codex", "opencode", "claude", "cursor"],
  accent_color: null,
  background_color: null,
  foreground_color: null,
  reduce_motion: false,
  landing_view: "start",
  repo_dashboard_entries: [
    { id: "agent-workspace", label: "agent-workspace", path: `${HOME}/Projects/agent-workspace`, default_branch: "main" },
  ],
  active_repo_dashboard_id: "agent-workspace",
  revision: 3,
};

/* ---- installation state ---- */

const SURFACE_LABELS: Record<SetupSurfaceId, string> = {
  open_code_config: "OpenCode config",
  open_code_agents: "OpenCode agents",
  open_code_rules: "OpenCode rules",
  codex_config: "Codex config",
  codex_agents: "Codex agents",
  codex_rules: "Codex rules",
  claude_rules: "Claude rules",
  claude_agents: "Claude agents",
  claude_skills: "Claude skills",
  open_code_skills: "OpenCode skills",
  codex_skills: "Codex skills",
  cursor_agents: "Cursor agents",
  cursor_skills: "Cursor skills",
  cursor_mcp: "Cursor MCP",
  workspace_bundle: "Workspace bundle",
};

const SURFACE_PATHS: Record<SetupSurfaceId, string> = {
  open_code_config: "~/.config/opencode/opencode.json",
  open_code_agents: "~/.config/opencode/agents",
  open_code_rules: "~/.config/opencode/AGENTS.md",
  codex_config: "~/.codex/config.toml",
  codex_agents: "~/.codex/agents",
  codex_rules: "~/.codex/AGENTS.md",
  claude_rules: "~/.claude/CLAUDE.md",
  claude_agents: "~/.claude/agents",
  claude_skills: "~/.claude/skills",
  open_code_skills: "~/.config/opencode/skills",
  codex_skills: "~/.codex/skills",
  cursor_agents: "~/.cursor/agents",
  cursor_skills: "~/.cursor/skills",
  cursor_mcp: "~/.cursor/mcp.json",
  workspace_bundle: "~/.config/agent-workspace",
};

const ALL_SURFACES = Object.keys(SURFACE_LABELS) as SetupSurfaceId[];

function initialSurfaceStates(): Map<SetupSurfaceId, InstallationState> {
  const states = new Map<SetupSurfaceId, InstallationState>();
  for (const surface of ALL_SURFACES) states.set(surface, "current");
  switch (scenario) {
    case "fresh":
      for (const surface of ALL_SURFACES) states.set(surface, "not_installed");
      break;
    case "conflict":
      states.set("open_code_config", "update_available");
      states.set("open_code_rules", "update_available");
      states.set("claude_rules", "update_available");
      states.set("claude_agents", "update_available");
      states.set("claude_skills", "conflict");
      states.set("cursor_mcp", "conflict");
      break;
    case "empty":
      break;
    default:
      states.set("open_code_config", "update_available");
      states.set("open_code_rules", "update_available");
      states.set("claude_rules", "update_available");
      states.set("claude_agents", "update_available");
      states.set("claude_skills", "update_available");
      states.set("codex_config", "unavailable");
      break;
  }
  return states;
}

const surfaceStates = initialSurfaceStates();
let lastTransactionId: string | null = scenario === "fresh" ? null : "2026-09-28T19-02-40Z-c21a";
let transactionSeq = 0;

function surfaceDetail(surface: SetupSurfaceId, state: InstallationState): string {
  switch (state) {
    case "current": return `installed · ${BUNDLE_DIGEST}`;
    case "update_available": return `bundle ${BUNDLE_DIGEST} → installed ${INSTALLED_DIGEST}`;
    case "conflict": return `${SURFACE_PATHS[surface]} modified locally since install; preserved`;
    case "not_installed": return "not installed";
    case "unavailable": return "target disabled in settings";
  }
}

const STATE_RANK: Record<InstallationState, number> = {
  current: 0, unavailable: 1, not_installed: 2, update_available: 3, conflict: 4,
};

function installationStatus(surfaces: SetupSurfaceId[]): InstallationStatus {
  const rows: SurfaceInstallationStatus[] = surfaces.map(surface => {
    const state = surfaceStates.get(surface) ?? "not_installed";
    return { surface, label: SURFACE_LABELS[surface], state, detail: surfaceDetail(surface, state) };
  });
  const counts = { create_count: 0, update_count: 0, remove_count: 0, conflict_count: 0 };
  for (const row of rows) {
    if (row.state === "not_installed") counts.create_count += 1;
    if (row.state === "update_available") counts.update_count += 1;
    if (row.state === "conflict") counts.conflict_count += 1;
  }
  const state = rows.reduce<InstallationState>(
    (worst, row) => (STATE_RANK[row.state] > STATE_RANK[worst] ? row.state : worst),
    "current",
  );
  const summaryParts = [
    counts.create_count && `${counts.create_count} to create`,
    counts.update_count && `${counts.update_count} to update`,
    counts.conflict_count && `${counts.conflict_count} conflicts`,
  ].filter(Boolean);
  const conflicts = rows.filter(row => row.state === "conflict").map(row => row.detail);
  return {
    state,
    summary: summaryParts.length ? summaryParts.join(", ") : "everything current",
    counts,
    conflict_details: conflicts.length ? conflicts : undefined,
    surfaces: rows,
  };
}

function plannedOperation(surface: SetupSurfaceId): PlannedOperation {
  const state = surfaceStates.get(surface) ?? "not_installed";
  const kindByState: Record<InstallationState, OperationKind> = {
    current: "no_change",
    update_available: "update",
    not_installed: "create",
    conflict: "conflict",
    unavailable: "unavailable",
  };
  const kind = kindByState[state];
  const path = SURFACE_PATHS[surface];
  const summaryByKind: Record<OperationKind, string> = {
    no_change: `${SURFACE_LABELS[surface]} is current`,
    create: `Create ${path}`,
    update: `Update ${path} (bundle ${BUNDLE_DIGEST} → installed ${INSTALLED_DIGEST})`,
    remove: `Remove ${path}`,
    conflict: `Conflict in ${path}`,
    manual: `Manual step for ${path}`,
    unavailable: `${SURFACE_LABELS[surface]} is disabled in settings`,
  };
  const details =
    kind === "update" && surface === "claude_skills"
      ? [
        "+ create skills/handoff/SKILL.md",
        "~ update skills/frontend-design/SKILL.md",
        "~ update skills/diagnose/SKILL.md",
        "− remove skills/zoom-in/SKILL.md (no longer bundled, backed up)",
      ]
      : kind === "update" && surface === "claude_agents"
        ? ["+ create agents/sentinel.md", "~ update agents/verifier.md"]
        : undefined;
  return {
    surface,
    kind,
    summary: summaryByKind[kind],
    details,
    conflict_description:
      kind === "conflict" ? `${path} was modified locally since install; it is preserved and skipped.` : null,
    manual_step: null,
  };
}

function setupPlan(surfaces: SetupSurfaceId[]): SetupPlan {
  const operations = surfaces.map(plannedOperation);
  const pending = operations.filter(op => op.kind === "create" || op.kind === "update" || op.kind === "remove");
  const conflicts = operations.filter(op => op.kind === "conflict");
  const summaryParts = [
    pending.filter(op => op.kind === "create").length && `${pending.filter(op => op.kind === "create").length} to create`,
    pending.filter(op => op.kind === "update").length && `${pending.filter(op => op.kind === "update").length} to update`,
    conflicts.length && `${conflicts.length} conflicts preserved`,
  ].filter(Boolean);
  return {
    operations,
    synced: operations.filter(op => op.kind === "no_change").map(op => op.surface),
    conflicts,
    manual_steps: [],
    summary: summaryParts.length ? summaryParts.join(", ") : "nothing to do",
    has_pending_changes: pending.length > 0,
    is_blocked: pending.length === 0 && conflicts.length > 0,
    plan_fingerprint: pending.length ? `fp-${surfaces.join("+")}-${transactionSeq}` : null,
    preview_token: pending.length ? `tok-${Date.now()}` : null,
  };
}

function applyPlan(surfaces: SetupSurfaceId[]): SetupResult {
  const applied: string[] = [];
  for (const surface of surfaces) {
    const state = surfaceStates.get(surface);
    if (state === "not_installed" || state === "update_available") {
      surfaceStates.set(surface, "current");
      applied.push(SURFACE_PATHS[surface]);
    }
  }
  transactionSeq += 1;
  lastTransactionId = `2026-10-06T08-31-12Z-${(0x7f1c + transactionSeq).toString(16)}`;
  backups.unshift({
    id: lastTransactionId,
    timestamp: new Date().toISOString(),
    path: `${BACKUP_ROOT}/${lastTransactionId}`,
    targets: surfaces,
    file_count: applied.length,
  });
  return {
    success: true,
    transaction_id: lastTransactionId,
    applied,
    failed: [],
    rolled_back: [],
    manual_steps: [],
    message: `applied ${applied.length} · preserved ${surfaces.length - applied.length} · failed 0 · transaction ${lastTransactionId} recorded`,
  };
}

/* ---- backups ---- */

const backups: BackupRunSummary[] = scenario === "fresh"
  ? []
  : [
    { id: "2026-09-28T19-02-40Z-c21a", timestamp: "2026-09-28T19:02:40Z", path: `${BACKUP_ROOT}/2026-09-28T19-02-40Z-c21a`, targets: ["claude_rules", "claude_agents"], file_count: 6 },
    { id: "2026-09-14T08-12-03Z-1b9e", timestamp: "2026-09-14T08:12:03Z", path: `${BACKUP_ROOT}/2026-09-14T08-12-03Z-1b9e`, targets: ["codex_rules", "opencode_config"], file_count: 3 },
  ];

function backupDetails(runId: string): BackupRunDetails {
  const run = backups.find(b => b.id === runId);
  if (!run) throw new Error(`backup ${runId} not found`);
  return {
    id: run.id,
    timestamp: run.timestamp,
    path: run.path,
    files: run.targets.map(target => ({
      target_id: target,
      filename: `${target}.md`,
      backup_path: `${run.path}/${target}.md`,
      backup_size: 2048,
      current_path: `${HOME}/${target}.md`,
      current_exists: true,
      current_status: "changed",
    })),
  };
}

/* ---- status + diagnostics ---- */

function statusData(): StatusData {
  const enabled = new Set(settings.enabled_target_ids);
  const stateFor = (surface: SetupSurfaceId) => surfaceStates.get(surface) ?? "not_installed";
  return {
    repo_path: WORKSPACE,
    git_available: true,
    branch: "main",
    dirty: false,
    latest_commit: `${BUNDLE_DIGEST} feat(workspace): modernize skills, agents, rules`,
    rules_codex: stateFor("codex_rules"),
    rules_opencode: stateFor("open_code_rules"),
    rules_claude: stateFor("claude_rules"),
    opencode_config: stateFor("open_code_config"),
    opencode_agents: stateFor("open_code_agents"),
    claude_agents: stateFor("claude_agents"),
    config_statuses: { opencode_config: stateFor("open_code_config"), codex_config: stateFor("codex_config") },
    agents_statuses: {
      opencode_agents: stateFor("open_code_agents"),
      claude_agents: stateFor("claude_agents"),
      codex_agents: stateFor("codex_agents"),
      cursor_setup: stateFor("cursor_agents"),
    },
    host_name: "mock",
    enabled_rule_target_ids: TARGETS.filter(t => t.kind === "rules" && enabled.has(t.id)).map(t => t.id),
    enabled_config_target_ids: TARGETS.filter(t => t.kind === "config" && enabled.has(t.id)).map(t => t.id),
    enabled_agent_target_ids: TARGETS.filter(t => t.kind === "agents" && enabled.has(t.id)).map(t => t.id),
    enabled_target_ids: [...enabled],
  };
}

function diagnostics(): WorkspaceDiagnostics {
  const valid = scenario !== "error";
  const enabled = new Set(settings.enabled_target_ids);
  return {
    candidate_path: settings.workspace_path ?? WORKSPACE,
    resolved_path: valid ? WORKSPACE : null,
    valid,
    error: valid ? null : "workspace markers missing: metadata/manifest.json",
    markers: [
      { kind: "dir", path: `${WORKSPACE}/skills`, exists: valid },
      { kind: "dir", path: `${WORKSPACE}/agents`, exists: valid },
      { kind: "file", path: `${WORKSPACE}/metadata/manifest.json`, exists: valid },
    ],
    enabled_rule_targets: TARGETS.filter(t => t.kind === "rules" && enabled.has(t.id)).length,
    total_rule_targets: 3,
    enabled_config_targets: TARGETS.filter(t => t.kind === "config" && enabled.has(t.id)).length,
    total_config_targets: 2,
    backup_root: BACKUP_ROOT,
    backup_root_exists: backups.length > 0,
    release_check_available: valid,
    bundled_resources_status: valid ? "current" : "missing",
    missing_bundled_count: valid ? 0 : 12,
    missing_bundled_sample: valid ? [] : ["skills/diagnose/SKILL.md", "agents/verifier.md"],
  };
}

/* ---- runtime health ---- */

function codexHealth(): CodexRuntimeHealth {
  const fresh = scenario === "fresh";
  const status = fresh ? "missing" : "synced";
  return {
    status,
    rules_status: status,
    rules_source_path: `${WORKSPACE}/templates/sync/codex-rules.md`,
    rules_installed_path: `${HOME}/.codex/AGENTS.md`,
    skills_status: status,
    skills_synced_count: fresh ? 0 : 18,
    skills_expected_count: 18,
    skills_missing_count: fresh ? 18 : 0,
    skills_diverged_count: 0,
    legacy_skills_path: `${HOME}/.codex/skills-legacy`,
    legacy_skills_migratable_count: 0,
    legacy_skills_conflict_count: 0,
    agents_status: status,
    bundled_agent_count: 6,
    installed_bundled_agent_count: fresh ? 0 : 6,
    extra_installed_agent_count: 0,
    agent_mismatches: [],
    config_status: "manual",
    template_config_path: `${WORKSPACE}/templates/codex/config.toml`,
    installed_config_path: `${HOME}/.codex/config.toml`,
    approval_policy: fresh ? null : "on-request",
    sandbox_mode: fresh ? null : "workspace-write",
    checks: [
      { id: "cli", label: "codex cli", status: "ok", detail: "codex 0.42.0" },
      { id: "rules", label: "rules", status: fresh ? "missing" : "ok", detail: fresh ? "not installed" : "synced" },
    ],
    warnings: [],
    summary: fresh ? "Codex is not set up yet." : "Codex rules, agents and skills are current.",
    next_action: fresh ? "Install Codex surfaces." : "Nothing to do.",
  };
}

function opencodeHealth(): OpenCodeRuntimeHealth {
  const fresh = scenario === "fresh";
  const update = surfaceStates.get("open_code_config") === "update_available";
  const status = fresh ? "missing" : update ? "stale" : "synced";
  return {
    status,
    template_config_path: `${WORKSPACE}/templates/opencode.json`,
    installed_config_path: `${HOME}/.config/opencode/opencode.json`,
    checks: [
      { id: "config", label: "config", status, detail: update ? "template changed" : "synced" },
      { id: "agents", label: "agents", status: fresh ? "missing" : "ok", detail: fresh ? "0/6" : "6/6" },
    ],
    default_agent: fresh ? null : "claude",
    model: fresh ? null : "anthropic/claude-sonnet-4-5",
    small_model: fresh ? null : "anthropic/claude-haiku-4-5",
    autoupdate: "true",
    snapshot: true,
    bundled_agent_count: 6,
    installed_bundled_agent_count: fresh ? 0 : 6,
    extra_installed_agent_count: 0,
    agent_mismatches: [],
    warnings: [],
    template_tui_path: `${WORKSPACE}/templates/opencode-tui.json`,
    installed_tui_path: `${HOME}/.config/opencode/tui.json`,
    tui_status: fresh ? "missing" : "synced",
    generated_snapshot_base_path: `${WORKSPACE}/templates/opencode.json`,
    generated_snapshot_policy_path: `${WORKSPACE}/templates/opencode-policy.json`,
    generated_snapshot_path: `${WORKSPACE}/generated/opencode.json`,
    generated_snapshot_status: "current",
    generated_snapshot_detail: "generated from template + policy",
    summary: fresh ? "OpenCode is not set up yet." : update ? "OpenCode config has an update available." : "OpenCode is current.",
    next_action: fresh ? "Install OpenCode surfaces." : update ? "Update OpenCode." : "Nothing to do.",
  };
}

function cursorHealth(): CursorProfileHealth {
  const fresh = scenario === "fresh";
  const mcpConflict = surfaceStates.get("cursor_mcp") === "conflict";
  return {
    status: fresh ? "missing" : mcpConflict ? "diverged" : "synced",
    profile_root: `${HOME}/.cursor`,
    profile_root_source: "default",
    workspace_resources_status: fresh ? "missing" : "current",
    manifest_status: fresh ? "missing" : "current",
    user_rules_status: "manual",
    global_agents_status: fresh ? "missing" : "synced",
    global_agents_count: fresh ? 0 : 6,
    expected_global_agents_count: 6,
    global_skills_status: fresh ? "missing" : "synced",
    global_skills_count: fresh ? 0 : 18,
    expected_global_skills_count: 18,
    mcp_status: fresh ? "missing" : mcpConflict ? "diverged" : "synced",
    legacy_permission_cleanup_status: "clean",
    warnings: mcpConflict ? ["~/.cursor/mcp.json was edited locally; the managed block is preserved."] : [],
    next_action: fresh ? "Install Cursor surfaces." : mcpConflict ? "Review the MCP conflict." : "Nothing to do.",
  };
}

function claudeHealth(): ClaudeRuntimeHealth {
  const fresh = scenario === "fresh";
  return {
    rules_synced: !fresh && surfaceStates.get("claude_rules") === "current",
    agents_synced: !fresh && surfaceStates.get("claude_agents") === "current",
    skills_synced: !fresh && surfaceStates.get("claude_skills") === "current",
    expected_agent_count: 6,
    installed_agent_count: fresh ? 0 : 5,
    claude_cli_available: true,
    summary: fresh ? "Claude is not set up yet." : "Claude CLI available · agents 5/6 · skills 17/18",
  };
}

/* ---- library ---- */

const SKILL_ROWS: Array<[string, string, string, string]> = [
  ["minimal-implementation", "implementation · planning", "implementation", "low"],
  ["implementation-plan", "implementation · planning", "implementation", "low"],
  ["tdd", "implementation · planning", "implementation", "low"],
  ["frontend-design", "frontend", "frontend", "medium"],
  ["browser-qa", "frontend", "frontend", "medium"],
  ["screenshot-review", "frontend", "frontend", "low"],
  ["accessibility-review", "frontend", "frontend", "low"],
  ["diagnose", "workflow · diagnosis", "workflow", "medium"],
  ["release-check", "workflow · diagnosis", "workflow", "medium"],
  ["handoff", "workflow · diagnosis", "workflow", "low"],
  ["context-budget", "workflow · diagnosis", "workflow", "low"],
  ["prototype", "workflow · diagnosis", "workflow", "low"],
  ["security-review", "security · data · domain", "security", "high"],
  ["database-migrations", "security · data · domain", "data", "high"],
  ["wordpress-woocommerce", "security · data · domain", "domain", "high"],
  ["current-docs", "security · data · domain", "research", "low"],
  ["zoom-out", "security · data · domain", "research", "low"],
  ["retro", "workflow · diagnosis", "workflow", "low"],
];

const skills: SkillSummary[] = scenario === "empty"
  ? []
  : SKILL_ROWS.map(([id, group, category, risk]) => ({
    id,
    name: id,
    description: `Use the ${id} skill for ${category} work; pair with related skills when the slice map is unclear.`,
    path: `${WORKSPACE}/skills/${id}/SKILL.md`,
    group,
    category,
    risk,
    targets: ["codex", "opencode", "claude", "cursor"],
    related: ["implementation-plan", "diagnose"].filter(r => r !== id),
  }));

function skillContent(id: string): string {
  const title = id.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
  return [
    "---",
    `name: ${id}`,
    `description: Use for ${id.replace(/-/g, " ")} work. Keep the change small, verifiable and inside existing ownership.`,
    "category: implementation",
    "risk: low",
    "targets: codex, opencode, claude, cursor",
    "---",
    "",
    `# ${title}`,
    "",
    "Use for code implementation and refactoring. Build the smallest complete, clear, and verifiable solution.",
    "",
    "## Rules",
    "",
    "- Inspect the owning code and existing patterns before editing.",
    "- Extend the current owner; do not create a parallel path.",
    "- Implement only the requested outcome.",
    "- Avoid unrelated cleanup, renaming, formatting, or modernization.",
    "",
    "## Simplification pass",
    "",
    "Before finishing, remove anything unnecessary: new files, helpers, types, state, branches, or config.",
    "",
    "Verify with the narrowest check that can falsify the change. Report what ran, what did not run, and residual risk.",
    "",
  ].join("\n");
}

const docStore = new Map<string, DocumentContent>();
if (scenario !== "empty") {
  const docRows: Array<[string, string, string]> = [
    ["readme", "README", "root"],
    ["skills-catalog", "SKILLS", "docs"],
    ["prompt-template", "PROMPT_TEMPLATE", "docs"],
    ["harness-matrix", "HARNESS_MATRIX", "docs"],
    ["backlog", "BACKLOG", "docs"],
  ];
  for (const [id, title, section] of docRows) {
    docStore.set(id, {
      id,
      title,
      path: `${WORKSPACE}/${section === "root" ? "" : "docs/"}${title}.md`,
      section,
      source: "workspace",
      content: `# ${title}\n\nThis is the ${title} document in the mock workspace.\n\n## Section\n\n- First point with \`code\`.\n- Second point.\n\n| Column | Value |\n| --- | --- |\n| rows | ${docStore.size + 3} |\n`,
    });
  }
}

const agentRows: Array<[string, string, string]> = [
  ["verifier.md", "verifier", "Run or inspect non-destructive verification after an implementation."],
  ["inspector.md", "inspector", "Review changed files for bugs, regressions and pattern mismatch."],
  ["sentinel.md", "sentinel", "Review security-sensitive diffs."],
  ["scribe.md", "scribe", "Write README, docs, runbooks and changelogs."],
  ["repo-scout.md", "repo-scout", "Map unfamiliar repository areas before implementation."],
  ["planner.md", "planner", "Design implementation plans."],
];

const agentStore = new Map<string, AgentSourceContent>();
if (scenario !== "empty") {
  for (const [filename, title, summary] of agentRows) {
    agentStore.set(filename, {
      id: filename,
      title,
      path: `${WORKSPACE}/agents/${filename}`,
      content: `---\nname: ${title}\ndescription: ${summary}\nmodel: sonnet\n---\n\n# ${title}\n\n${summary}\n\n## Inputs\n\n- Task brief from the caller.\n\n## Output\n\n- Findings with file:line evidence.\n`,
      exists: filename !== "planner.md",
    });
  }
}

function agentMetadata(): AgentMetadataListResponse {
  return {
    agents: [...agentStore.values()].map(agent => ({
      id: agent.id,
      title: agent.title,
      path: agent.path,
      exists: agent.exists,
      metadata: {
        role: agent.title,
        summary: agentRows.find(([filename]) => filename === agent.id)?.[2] ?? "",
        targets: ["codex", "opencode", "claude", "cursor"],
        risk: agent.id === "sentinel.md" ? "high" : "low",
        default_skills: ["minimal-implementation"],
        safe_to_edit_runtime: true,
        notes: [],
      },
    })),
    warnings: scenario === "conflict" ? ["planner.md is referenced by the manifest but missing on disk"] : [],
  };
}

let agentTemplate: DocumentContent = {
  id: "agent-template",
  title: "AGENTS.md template",
  path: `${WORKSPACE}/templates/sync/codex-rules.md`,
  section: "templates",
  source: "workspace",
  content: "# Global Agent Rules\n\n## Priority\nRepository reality overrides assumptions. Explicit user instructions override these defaults.\n\n## Communication\nBe direct, dense, technical, and concise.\n\n## Verification\nNever claim done without evidence.\n",
};

const configSources: ConfigEditorSourceMeta[] = [
  { id: "template", label: "template", rel_path: "templates/opencode.json", editable: true, helper: "bundled base config" },
  { id: "policy", label: "policy", rel_path: "templates/opencode-policy.json", editable: true, helper: "local overrides" },
  { id: "generated", label: "generated", rel_path: "generated/opencode.json", editable: false, helper: "snapshot written on install" },
];

const configStore = new Map<string, DocumentContent>([
  ["template", { id: "template", title: "opencode.json", path: `${WORKSPACE}/templates/opencode.json`, section: "templates", source: "workspace", content: "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"model\": \"anthropic/claude-sonnet-4-5\",\n  \"small_model\": \"anthropic/claude-haiku-4-5\",\n  \"autoupdate\": true\n}\n" }],
  ["policy", { id: "policy", title: "opencode-policy.json", path: `${WORKSPACE}/templates/opencode-policy.json`, section: "templates", source: "workspace", content: "{\n  \"permission\": { \"bash\": \"ask\", \"edit\": \"allow\" }\n}\n" }],
  ["generated", { id: "generated", title: "opencode.json (generated)", path: `${WORKSPACE}/generated/opencode.json`, section: "generated", source: "generated", content: "{\n  \"model\": \"anthropic/claude-sonnet-4-5\",\n  \"permission\": { \"bash\": \"ask\", \"edit\": \"allow\" }\n}\n" }],
]);

let modelSelection: OpenCodeModelSelection = {
  model: "anthropic/claude-sonnet-4-5",
  small_model: "anthropic/claude-haiku-4-5",
};

/* ---- repo dashboard ---- */

function repoSnapshot(repoPath: string): RepoDashboardSnapshot {
  const now = Math.floor(Date.now() / 1000);
  const commits = Array.from({ length: 40 }, (_, i) => ({
    sha: `${(0xa7c3e1 - i * 1234).toString(16).padStart(6, "0")}0000000000000000000000000000000000`,
    short_sha: (0xa7c3e1 - i * 1234).toString(16).padStart(7, "0").slice(0, 7),
    author_name: i % 3 === 0 ? "uxsmedjan" : "codex",
    author_email: "dev@example.com",
    authored_at: now - i * 86400 * 1.5,
    subject: ["feat(workspace): modernize skills", "fix(backups): list managed setup", "test(settings): serialize tilde-home test", "docs: add skill catalog audit"][i % 4],
    is_merge: i % 9 === 0,
  }));
  return {
    repo_path: repoPath,
    git_available: true,
    is_repo: true,
    branch: "feat/hugrverk-overhaul",
    default_branch: "main",
    dirty: true,
    ahead: 12,
    behind: 0,
    latest_commit: commits[0],
    commits,
    commits_truncated: false,
    changed_files: [
      { path: "src/styles/_tokens.scss", status: "M" },
      { path: "src/dev/mockBackend.ts", status: "A" },
    ],
    docs: [
      { path: "docs/BACKLOG.md", found: true, readable: true, truncated: false, content: "# Backlog\n\n## Queue\n\n| ID | Item | Status | Priority |\n| --- | --- | --- | --- |\n| W-12 | Install preview before apply | open | high |\n| W-13 | Keyboard layer | started | high |\n| W-14 | Library filter | open | medium |\n", read_error: null },
      { path: "docs/AUDIT.md", found: true, readable: true, truncated: false, content: "# Audit\n\n- [ ] TODO: verify rollback after partial apply\n- [x] FIX: list managed setup backups\n", read_error: null },
      { path: "README.md", found: true, readable: true, truncated: false, content: "# agent-workspace\n\nControl panel for the Hugrverk harness bundle.\n", read_error: null },
    ],
    docs_source: "local-fallback",
    docs_ref: "main",
    docs_stale: false,
    gh: {
      available: true,
      authenticated: scenario !== "error",
      message: scenario === "error" ? "gh auth status: not logged in" : null,
      merged_prs: [{ number: 41, title: "Serialize env-mutating tests", merged_at: new Date(now * 1000 - 86400000).toISOString(), author: "uxsmedjan", body: null }],
      open_issues: [{ number: 44, title: "Install preview before apply", state: "open", labels: ["enhancement"] }],
    },
    warnings: [],
  };
}

/* ---- actions ---- */

function actionResult(action: string, success: boolean, stdout: string, stderr = ""): ActionResult {
  return { success, action, stdout, stderr, exit_code: success ? 0 : 1 };
}

async function runAction(action: string): Promise<ActionResult> {
  await delay(900);
  switch (action) {
    case "release_check":
      return actionResult(
        action,
        scenario !== "error",
        "git           clean · main · ahead 0\ncargo test    212 passed\nvitest        302 passed · 0 skipped\nmanifest      402 files · digest a7c3e1\nrelease-check ok\n",
        scenario === "error" ? "release-check: workspace invalid" : "",
      );
    default:
      return actionResult(action, true, `${action}: ok\n`);
  }
}

/* ---- dispatcher ---- */

type Args = Record<string, unknown> | undefined;

function arg<T>(args: Args, key: string): T {
  return (args ?? {})[key] as T;
}

function unavailable(label: string): never {
  throw new Error(`${label}: workspace invalid (mock error scenario)`);
}

async function handle(cmd: string, args: Args): Promise<unknown> {
  if (cmd.startsWith("plugin:dialog|")) return null;
  if (cmd.startsWith("open_")) {
    await delay(100);
    return actionResult(cmd, true, "");
  }
  switch (cmd) {
    case "get_settings":
      return { settings, load_warning: scenario === "error" ? "settings.json had an unknown key `theme`; it was ignored." : null } satisfies GetSettingsResponse;
    case "update_settings": {
      const next = arg<AppSettings>(args, "settings");
      const expected = arg<number>(args, "expectedRevision");
      if (expected !== (settings.revision ?? 0)) throw new Error("settings revision conflict");
      settings = { ...next, revision: (settings.revision ?? 0) + 1 };
      return settings;
    }
    case "try_set_active_workspace_path":
      settings = { ...settings, workspace_path: arg<string | null>(args, "path"), revision: (settings.revision ?? 0) + 1 };
      return settings;
    case "get_agent_targets":
      return TARGETS;
    case "get_status":
      return scenario === "error" ? unavailable("Status") : statusData();
    case "get_workspace_diagnostics":
      return diagnostics();
    case "get_installation_status":
      await delay(120);
      return scenario === "error" ? unavailable("Installation status") : installationStatus(arg<SetupSurfaceId[]>(args, "surfaces"));
    case "preview_setup":
      await delay(200);
      return setupPlan(arg<SetupSurfaceId[]>(args, "surfaces"));
    case "apply_setup":
      await delay(700);
      return applyPlan(arg<SetupSurfaceId[]>(args, "surfaces"));
    case "rollback_setup_transaction": {
      await delay(400);
      const dryRun = arg<boolean>(args, "dryRun");
      const id = arg<string>(args, "transactionId");
      if (!lastTransactionId || id !== lastTransactionId) {
        return { success: false, transaction_id: id, applied: [], failed: [id], rolled_back: [], manual_steps: [], message: `transaction ${id} not found` } satisfies SetupResult;
      }
      if (!dryRun) {
        for (const surface of ["claude_rules", "claude_agents", "claude_skills"] as SetupSurfaceId[]) surfaceStates.set(surface, "update_available");
        lastTransactionId = null;
      }
      return { success: true, transaction_id: id, applied: [], failed: [], rolled_back: ["~/.claude/CLAUDE.md", "~/.claude/agents/verifier.md"], manual_steps: [], message: dryRun ? "dry run: 2 files would be restored" : "restored 2 files" } satisfies SetupResult;
    }
    case "preview_uninstall":
      await delay(200);
      return {
        removable: [{ label: "claude rules", path: "~/.claude/CLAUDE.md" }, { label: "codex agents", path: "~/.codex/agents" }],
        preserved: [{ label: "cursor mcp", path: "~/.cursor/mcp.json" }],
        merged: [{ label: "opencode config", path: "~/.config/opencode/opencode.json" }],
        summary: "2 removable, 1 preserved, 1 merged",
        plan_fingerprint: scenario === "fresh" ? null : "uninstall-fp-1",
        preview_token: scenario === "fresh" ? null : "uninstall-tok-1",
      } satisfies UninstallPlanView;
    case "apply_uninstall":
      await delay(700);
      for (const surface of ALL_SURFACES) surfaceStates.set(surface, "not_installed");
      lastTransactionId = "2026-10-06T09-00-00Z-u001";
      return { success: true, transaction_id: lastTransactionId, applied: ["~/.claude/CLAUDE.md", "~/.codex/agents"], failed: [], rolled_back: [], manual_steps: [], message: "uninstalled 2 · preserved 1 · merged 1" } satisfies SetupResult;
    case "run_action":
      return runAction(arg<string>(args, "action"));
    case "list_backups":
      return backups;
    case "get_backup_details":
      return backupDetails(arg<string>(args, "runId"));
    case "get_codex_runtime_health":
      return codexHealth();
    case "get_opencode_runtime_health":
      return opencodeHealth();
    case "get_cursor_profile_health":
      return scenario === "error" ? unavailable("Cursor profile") : cursorHealth();
    case "get_claude_runtime_health":
      return claudeHealth();
    case "read_brain_setup_seed":
      return { status: "found", source: `${WORKSPACE}/templates/brain-setup.md`, content: "# Brain setup\n\nPaste this block into the harness you are configuring.\n\n- Workspace: ~/.config/agent-workspace\n- Skills: 18\n" } satisfies BrainSetupSeedResult;
    case "list_skills":
      return skills;
    case "read_skill": {
      const id = arg<string>(args, "id");
      const skill = skills.find(s => s.id === id);
      if (!skill) throw new Error(`skill ${id} not found`);
      return { id, title: skill.name, path: skill.path, section: "skills", source: "workspace", content: skillContent(id) } satisfies DocumentContent;
    }
    case "list_docs":
      return [...docStore.values()].map(({ id, title, path, section, source }) => ({ id, title, path, section, source })) satisfies DocSummary[];
    case "get_docs_health":
      return { missing_count: scenario === "conflict" ? 1 : 0, missing_prompt_template_docs: false, missing_sample: scenario === "conflict" ? ["docs/RELEASE.md"] : [] } satisfies DocsHealth;
    case "read_doc": {
      const doc = docStore.get(arg<string>(args, "id"));
      if (!doc) throw new Error("doc not found");
      return doc;
    }
    case "save_doc": {
      const doc = docStore.get(arg<string>(args, "id"));
      if (!doc) throw new Error("doc not found");
      docStore.set(doc.id, { ...doc, content: arg<string>(args, "content") });
      return actionResult("save_doc", true, `saved ${doc.path}`);
    }
    case "create_doc": {
      const slug = arg<string>(args, "slug");
      const title = arg<string>(args, "title");
      const doc: DocumentContent = { id: slug, title, path: `${WORKSPACE}/docs/${slug}.md`, section: "docs", source: "workspace", content: `# ${title}\n` };
      docStore.set(slug, doc);
      return doc;
    }
    case "list_agent_metadata":
      return agentMetadata();
    case "read_agent_source": {
      const agent = agentStore.get(arg<string>(args, "filename"));
      if (!agent) throw new Error("agent not found");
      return agent;
    }
    case "save_agent_source": {
      const agent = agentStore.get(arg<string>(args, "filename"));
      if (!agent) throw new Error("agent not found");
      agentStore.set(agent.id, { ...agent, content: arg<string>(args, "content") });
      return actionResult("save_agent_source", true, `saved ${agent.path}`);
    }
    case "read_agent_template":
      return agentTemplate;
    case "save_agent_template":
      agentTemplate = { ...agentTemplate, content: arg<string>(args, "content") };
      return actionResult("save_agent_template", true, `saved ${agentTemplate.path}`);
    case "read_config_template": {
      const targetId = arg<string>(args, "targetId");
      const target = TARGETS.find(t => t.id === targetId);
      return { id: targetId, title: target?.label ?? targetId, path: `${WORKSPACE}/${target?.source_rel ?? targetId}`, section: "templates", source: "workspace", content: configStore.get("template")!.content } satisfies DocumentContent;
    }
    case "list_opencode_config_editor_sources":
      return configSources;
    case "read_opencode_config_source": {
      const source = configStore.get(arg<string>(args, "sourceType"));
      if (!source) throw new Error("config source not found");
      return source;
    }
    case "save_opencode_config_source": {
      const source = configStore.get(arg<string>(args, "sourceType"));
      if (!source) throw new Error("config source not found");
      configStore.set(source.id, { ...source, content: arg<string>(args, "content") });
      return actionResult("save_opencode_config_source", true, `saved ${source.path}`);
    }
    case "read_opencode_model_selection":
      return modelSelection;
    case "list_available_opencode_models":
      return { models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-1", "openai/gpt-5"], warning: scenario === "error" ? "opencode models: provider list unavailable" : null } satisfies ListAvailableModelsResult;
    case "update_opencode_model_selection":
      modelSelection = { model: arg<string>(args, "model"), small_model: arg<string>(args, "smallModel") };
      return `model set to ${modelSelection.model}`;
    case "get_repo_dashboard_snapshot":
      await delay(300);
      return repoSnapshot(arg<string>(args, "repoPath"));
    case "discover_local_git_repos":
      await delay(300);
      return { repos: [{ label: "kretsverket", path: `${HOME}/Projects/kretsverket`, default_branch: "main", repo_slug: "hugrverk/kretsverket", warnings: [] }], warnings: [] } satisfies DiscoverLocalGitReposResult;
    case "get_repo_prompt_context":
      return { repo_slug: "hugrverk/agent-workspace", current_branch: "feat/hugrverk-overhaul", default_branch: "main", is_repo: true, warnings: [] } satisfies RepoPromptContext;
    default:
      throw new Error(`mock backend: unhandled command "${cmd}"`);
  }
}

mockIPC((cmd, args) => handle(cmd, args as Args));

// Report as a Tauri host so the shell lays out exactly as in the app (traffic-light reserve).
(globalThis as { isTauri?: boolean }).isTauri = true;

console.info(`[mock backend] scenario=${scenario} appearance=${appearance}`);
