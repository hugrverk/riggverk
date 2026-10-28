/**
 * Browser-only mock of the Tauri backend for visual QA (`vite dev` + `?mock=<scenario>`).
 *
 * Loaded by main.tsx only when `import.meta.env.DEV && !isTauri()` and the URL has a
 * `mock` query parameter, so production bundles never contain it. Scenarios:
 *   default   everything installed, OpenCode + Claude have updates
 *   conflict  Claude plan with + ~ − ! rows, Cursor blocked by a conflict; rules files in every state:
 *             Claude edited block (`&rules=legacy|malformed|managed|update|current|absent` picks another state),
 *             Codex base update keeping 14 refinement lines plus the AGENTS.override.md warning,
 *             OpenCode plain file that differs from every shipped base;
 *             skills: an older app copy of `tdd` beside the current one for Codex, and two copies of the user's own `my-deploy`;
 *             skill and agent files in conflict (edited `tdd`, two files of `security-audit`, an edited Claude agent `verifier`)
 *             and kept ones (`diagnose` with a bundled update waiting, the agent `sentinel`);
 *             the Codex config is on, with `approvals_reviewer = "auto_review"` differing from Riggverk's value (`m` keeps it)
 *   fresh     nothing installed, no backups, no transactions
 *   error     status/diagnostics calls fail (exercises the error line); the workspace is not valid, so the
 *             Library still lists the bundled items but no personal doc
 *   empty     valid workspace with no docs, skills or agents (the empty states of the lists; the real bundle is never empty)
 * `&theme=light|dark|system` sets the persisted appearance. Copilot, Pi and Kilo are off until Settings turns
 * them on; `&light=unserved` leaves Copilot and Pi without a skills folder (an isolated Codex home).
 *
 * Mutating commands update in-memory state so install/rollback/save flows round-trip. Apply, uninstall and
 * rollback emit `apply-progress` events like the backend does (backup, then one file at a time, then done).
 */
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { isLightAgent } from "../lib/harnessInstallation";
import type {
  ActionResult,
  CodexConfigDefaultsPreview,
  CodexConfigKey,
  AgentMetadataListResponse,
  AgentSourceContent,
  AgentTargetMeta,
  AppSettings,
  ApplyProgress,
  BackupRunDetails,
  BackupRunSummary,
  ClaudeRuntimeHealth,
  CodexRuntimeHealth,
  ConfigEditorSourceMeta,
  CursorProfileHealth,
  DocSummary,
  DocumentContent,
  EffectiveSkillLoads,
  FileDiffView,
  FilesStatus,
  FilesSurfaceId,
  FileUnit,
  GetSettingsResponse,
  InstallAgent,
  InstallationState,
  InstallationStatus,
  LightAgent,
  LightRuntimeHealth,
  ListAvailableModelsResult,
  OpenCodeModelSelection,
  OpenCodeRuntimeHealth,
  OperationKind,
  PlannedOperation,
  RulesConversionPreview,
  RulesDiffMode,
  RulesDiffView,
  RulesFileContent,
  RulesFileSummary,
  RulesMalformedReason,
  RulesStatus,
  RulesSurfaceId,
  SecurityPosture,
  SetupPlan,
  SetupResult,
  SetupSurfaceId,
  SkillCopy,
  SkillLoad,
  SkillLoadFlag,
  SkillReadFolder,
  SkillSummary,
  StatusData,
  SurfaceInstallationStatus,
  TakeBundledPreview,
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
const WORKSPACE = `${HOME}/.config/riggverk`;
const BACKUP_ROOT = `${HOME}/Library/Application Support/se.hugrverk.riggverk/backups`;
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
  { id: "claude_config", label: "claude config", harness: "claude", kind: "config", target_rel: ".claude/settings.json", source_rel: "" },
  { id: "cursor_setup", label: "cursor global agents", harness: "cursor", kind: "agents", target_rel: ".cursor/agents", source_rel: "templates/cursor/agents" },
  { id: "copilot_rules", label: "copilot rules", harness: "copilot", kind: "rules", target_rel: ".copilot/copilot-instructions.md", source_rel: "templates/sync/copilot-rules.md" },
  { id: "copilot_mcp", label: "copilot mcp", harness: "copilot", kind: "mcp", target_rel: ".copilot/mcp-config.json", source_rel: "templates/mcp/copilot.playwright.json" },
  { id: "pi_rules", label: "pi rules", harness: "pi", kind: "rules", target_rel: ".pi/agent/AGENTS.md", source_rel: "templates/sync/pi-rules.md" },
  { id: "pi_mcp", label: "pi mcp", harness: "pi", kind: "mcp", target_rel: ".pi/agent/mcp.json", source_rel: "templates/mcp/pi.playwright.json" },
  { id: "kilo_rules", label: "kilo rules", harness: "kilo", kind: "rules", target_rel: ".config/kilo/AGENTS.md", source_rel: "templates/sync/kilo-rules.md" },
  { id: "kilo_mcp", label: "kilo mcp", harness: "kilo", kind: "mcp", target_rel: ".config/kilo/kilo.jsonc", source_rel: "templates/mcp/kilo.playwright.json" },
];

let settings: AppSettings = {
  appearance,
  app_font_size: "medium",
  workspace_path: null,
  // The conflict scenario turns the Codex config on: it shows the enforced key the user can keep.
  enabled_target_ids: TARGETS.map(t => t.id).filter(
    id => (id !== "codex_config" || scenario === "conflict") && id !== "claude_config" && id !== "kilo_mcp",
  ),
  enabled_harness_ids: ["codex", "opencode", "claude", "cursor"],
  accent_color: null,
  background_color: null,
  foreground_color: null,
  motion: "full",
  landing_view: "start",
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
  claude_config: "Claude config",
  skills: "Skills",
  cursor_agents: "Cursor agents",
  cursor_mcp: "Cursor MCP",
  copilot_rules: "Copilot rules",
  pi_rules: "Pi rules",
  kilo_rules: "Kilo rules",
  copilot_mcp: "Copilot MCP",
  pi_mcp: "Pi MCP",
  kilo_mcp: "Kilo MCP",
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
  claude_config: "~/.claude/settings.json",
  skills: "~/.claude/skills and ~/.agents/skills",
  cursor_agents: "~/.cursor/agents",
  cursor_mcp: "~/.cursor/mcp.json",
  copilot_rules: "~/.copilot/copilot-instructions.md",
  pi_rules: "~/.pi/agent/AGENTS.md",
  kilo_rules: "~/.config/kilo/AGENTS.md",
  copilot_mcp: "~/.copilot/mcp-config.json",
  pi_mcp: "~/.pi/agent/mcp.json",
  kilo_mcp: "~/.config/kilo/kilo.jsonc",
  workspace_bundle: "~/.config/riggverk",
};

const ALL_SURFACES = Object.keys(SURFACE_LABELS) as SetupSurfaceId[];
const LIGHT_MCP_SURFACES = ["copilot_mcp", "pi_mcp", "kilo_mcp"] as const;

function initialSurfaceStates(): Map<SetupSurfaceId, InstallationState> {
  const states = new Map<SetupSurfaceId, InstallationState>();
  for (const surface of ALL_SURFACES) states.set(surface, "current");
  switch (scenario) {
    case "fresh":
      for (const surface of ALL_SURFACES) states.set(surface, "not_installed");
      // A fresh profile has no old copies of the bundle to remove.
      states.set("workspace_bundle", "current");
      break;
    case "conflict":
      states.set("open_code_config", "update_available");
      states.set("open_code_rules", "update_available");
      states.set("claude_rules", "update_available");
      states.set("claude_agents", "update_available");
      states.set("skills", "conflict");
      // The owner set approvals_reviewer on purpose: the recorded digest no longer matches.
      states.set("codex_config", "conflict");
      states.set("cursor_mcp", "conflict");
      // Pi's file has comments, which the app does not edit; Kilo's entry has an update waiting.
      states.set("copilot_mcp", "not_installed");
      states.set("pi_mcp", "conflict");
      states.set("kilo_mcp", "update_available");
      break;
    case "empty":
      break;
    default:
      states.set("open_code_config", "update_available");
      states.set("open_code_rules", "update_available");
      states.set("claude_rules", "update_available");
      states.set("claude_agents", "update_available");
      states.set("skills", "update_available");
      states.set("codex_config", "unavailable");
      // The light harnesses are off until Settings turns them on; once on, nothing is installed yet.
      for (const surface of LIGHT_MCP_SURFACES) states.set(surface, "not_installed");
      break;
  }
  return states;
}

const surfaceStates = initialSurfaceStates();
let lastTransactionId: string | null = scenario === "fresh" ? null : "2026-09-28T19-02-40Z-c21a";
let transactionSeq = 0;

/* ---- rules files (managed base block) ---- */

const RULES_SURFACES: RulesSurfaceId[] = ["claude_rules", "codex_rules", "open_code_rules", "copilot_rules", "pi_rules", "kilo_rules"];

function isRulesSurface(surface: SetupSurfaceId): surface is RulesSurfaceId {
  return (RULES_SURFACES as SetupSurfaceId[]).includes(surface);
}

const MALFORMED_TEXT: Record<RulesMalformedReason, string> = {
  not_utf8: "file is not valid UTF-8",
  too_large: "file is larger than 4 MB",
  duplicate_begin: "more than one BEGIN base marker",
  duplicate_end: "more than one END base marker",
  missing_end: "BEGIN marker has no matching END marker",
  missing_begin: "END marker has no matching BEGIN marker",
  end_before_begin: "END marker appears before the BEGIN marker",
};

interface RulesVariant {
  state: InstallationState;
  file: RulesStatus;
}

const RULES_VARIANTS: Record<string, RulesVariant> = {
  edited: { state: "conflict", file: { layout: "block", refinement_lines: 2, conflict_reason: "base_block_edited", user_managed: false } },
  legacy: { state: "conflict", file: { layout: "legacy", refinement_lines: 0, conflict_reason: "legacy_diverged", user_managed: false } },
  malformed: { state: "conflict", file: { layout: "malformed", refinement_lines: 0, conflict_reason: "malformed_markers", malformed_reason: "missing_end", user_managed: false } },
  managed: { state: "current", file: { layout: "block", refinement_lines: 2, conflict_reason: "base_block_edited", user_managed: true } },
  update: { state: "update_available", file: { layout: "block", refinement_lines: 14, user_managed: false } },
  current: { state: "current", file: { layout: "block", refinement_lines: 3, user_managed: false } },
  absent: { state: "not_installed", file: { layout: "absent", refinement_lines: 0, user_managed: false } },
  /** Pi: `AGENTS.override.md` next to the rules file. */
  masked: { state: "conflict", file: { layout: "block", refinement_lines: 0, conflict_reason: "masked_by_override", user_managed: false } },
  /** Pi: a `CLAUDE.md` and no `AGENTS.md`. */
  peer: { state: "conflict", file: { layout: "absent", refinement_lines: 0, conflict_reason: "peer_context_file", user_managed: false } },
};

const rulesFiles = new Map<RulesSurfaceId, RulesStatus>();

function seedRules() {
  const set = (surface: RulesSurfaceId, variant: RulesVariant) => {
    rulesFiles.set(surface, { ...variant.file });
    surfaceStates.set(surface, variant.state);
  };
  const requested = RULES_VARIANTS[params.get("rules") ?? ""];
  switch (scenario) {
    case "fresh":
      for (const surface of RULES_SURFACES) set(surface, RULES_VARIANTS.absent!);
      break;
    case "conflict":
      set("claude_rules", requested ?? RULES_VARIANTS.edited!);
      set("codex_rules", RULES_VARIANTS.update!);
      set("open_code_rules", RULES_VARIANTS.legacy!);
      set("copilot_rules", RULES_VARIANTS.absent!);
      set("pi_rules", RULES_VARIANTS.masked!);
      set("kilo_rules", RULES_VARIANTS.update!);
      break;
    case "empty":
      for (const surface of RULES_SURFACES) set(surface, RULES_VARIANTS.current!);
      break;
    default:
      set("claude_rules", RULES_VARIANTS.update!);
      set("codex_rules", RULES_VARIANTS.current!);
      set("open_code_rules", { state: "update_available", file: { layout: "block", refinement_lines: 0, user_managed: false } });
      // The light harnesses are off until Settings turns them on; once on, nothing is installed yet.
      for (const surface of ["copilot_rules", "pi_rules", "kilo_rules"] as const) set(surface, RULES_VARIANTS.absent!);
      break;
  }
}
seedRules();

/** What a file and its state were before a conversion, by transaction, so a rollback can restore them. */
const rulesSnapshots = new Map<string, Array<[RulesSurfaceId, RulesStatus, InstallationState]>>();

function rulesDetail(file: RulesStatus, state: InstallationState): string {
  const kept = file.refinement_lines === 0 ? "" : `; refinements: ${file.refinement_lines} line${file.refinement_lines === 1 ? "" : "s"} preserved`;
  if (file.user_managed) return "base updates available; you manage this file, so none are applied";
  switch (file.conflict_reason) {
    case "base_block_edited": return `base block was edited, left as is${kept}`;
    case "legacy_diverged": return "file differs from every shipped base, left as is";
    case "malformed_markers": return `base block markers are malformed (${MALFORMED_TEXT[file.malformed_reason ?? "missing_end"]}), left as is`;
    case "masked_by_override": return "an override file in the same folder masks this file, left as is";
    case "peer_context_file": return "another context file in this folder would be hidden by a new one, nothing written";
  }
  if (state === "update_available") return `base update available${kept}`;
  if (state === "not_installed") return "not installed";
  return `installed and current${kept}`;
}

function rulesFor(surface: SetupSurfaceId): RulesStatus | undefined {
  return isRulesSurface(surface) ? rulesFiles.get(surface) : undefined;
}

function convertible(file: RulesStatus | undefined): boolean {
  return file?.conflict_reason === "base_block_edited" || file?.conflict_reason === "legacy_diverged";
}

const RULES_BASE_LINES = [
  "# Global Agent Rules",
  "",
  "## Priority",
  "Repository reality overrides assumptions. Explicit user instructions override these defaults. Instructions after the Riggverk base block are the user's refinements and override the base where they conflict.",
  "",
  "## Communication",
  "Be direct, dense, technical, and concise. Respond in the user's language. Use English for code, comments, identifiers, commits, filenames, docs, and agent prompts.",
  "",
  "## Security",
  "Credential-bearing data is NO-PRINT. Never print, quote, or pass onward secrets, tokens, passwords, private keys, or raw env values.",
  "",
  "## Verification",
  "Never claim done without evidence. Verify with the lightest check that can falsify the change.",
];

function mockRulesDiff(surface: RulesSurfaceId, mode: RulesDiffMode): RulesDiffView {
  const file = rulesFiles.get(surface);
  const base = { surface, mode, compared_base: null as string | null, truncated: false };
  if (!file || file.layout === "absent") {
    return { ...base, from_label: "shipped base", to_label: "installed", applicable: false, note: "no rules file is installed", added: 0, removed: 0, diff: "" };
  }
  if (file.layout === "malformed") {
    return { ...base, from_label: "installed", to_label: "new", applicable: false, note: `base block markers are malformed: ${MALFORMED_TEXT[file.malformed_reason ?? "missing_end"]}`, added: 0, removed: 0, diff: "" };
  }
  if (mode === "edits") {
    const label = "shipped base sha256:5f3a91c0b2e4d6a8";
    return {
      ...base,
      from_label: label,
      to_label: "installed",
      applicable: true,
      note: "compared with the closest shipped base (4 lines differ)",
      compared_base: "sha256:5f3a91c0b2e4d6a8c1d2e3f4a5b6c7d8",
      added: 3,
      removed: 1,
      diff: [
        `--- ${label}`,
        "+++ installed",
        "@@ -5,7 +5,9 @@",
        " ",
        " ## Communication",
        "-Be direct, dense, technical, and concise. Respond in the user's language. Use English for code, comments, identifiers, commits, filenames, docs, and agent prompts.",
        "+Be direct and concise. Respond in the user's language, and in Swedish for Swedish user-facing copy.",
        "+Prefer short answers; no praise or filler.",
        " ",
        " ## Security",
        "+Never run destructive git commands without asking first.",
        " Credential-bearing data is NO-PRINT. Never print, quote, or pass onward secrets, tokens, passwords, private keys, or raw env values.",
        "",
      ].join("\n"),
    };
  }
  const refused = file.conflict_reason !== undefined;
  const from = refused ? "your base block" : "installed";
  const to = refused ? "new base" : "after update";
  return {
    ...base,
    from_label: from,
    to_label: to,
    applicable: !refused,
    note: refused ? "update refused: the managed base block was edited; this shows what the new base contains" : null,
    added: 3,
    removed: 1,
    diff: [
      `--- ${from}`,
      `+++ ${to}`,
      "@@ -9,3 +9,6 @@",
      " ## Security",
      "-Credential-bearing data is NO-PRINT.",
      "+Credential-bearing or credential-adjacent data is NO-PRINT. Never print, quote, or pass onward secrets, tokens, passwords, private keys, or raw env values.",
      "+",
      "+## Verification",
      "+Never claim done without evidence. Verify with the lightest check that can falsify the change.",
      "",
    ].join("\n"),
  };
}

function conversionResult(file: RulesStatus): string {
  const refinements = file.layout === "block"
    ? ["", "## Communication", "Be direct and concise. Respond in the user's language, and in Swedish for Swedish user-facing copy.", "Prefer short answers; no praise or filler.", "", "## My refinements", "Never run destructive git commands without asking first."]
    : ["", "## Communication", "Be direct and concise. Swedish copy for Swedish user-facing text.", "", "## Local tooling", "Use rtk for inspection-style commands.", "Prefer small diffs."];
  return [
    "<!-- BEGIN RIGGVERK BASE: managed by Riggverk; edits inside are replaced on update; add refinements below END -->",
    ...RULES_BASE_LINES,
    "<!-- END RIGGVERK BASE -->",
    ...refinements,
    "",
  ].join("\n");
}

let rulesPreviewSeq = 0;
let rulesPreview: { surface: RulesSurfaceId; fingerprint: string; token: string } | null = null;

function mockRulesConversion(surface: RulesSurfaceId): RulesConversionPreview {
  const file = rulesFiles.get(surface);
  const refused = (reason: string): RulesConversionPreview => ({
    surface, applicable: false, reason, origin: null, compared_base: null, compared_base_changed_lines: null,
    moved_sections: [], removed_sections: [], result: "", diff: "", diff_truncated: false, plan_fingerprint: null, preview_token: null,
  });
  if (!file || file.layout === "absent") return refused("no rules file is installed");
  if (file.layout === "malformed") return refused("the base block markers are malformed; fix or remove them by hand first");
  if (file.conflict_reason === "masked_by_override") return refused("another file in the same folder masks this one, so the harness never reads it; remove or rename that file first");
  if (file.conflict_reason === "peer_context_file") return refused("the harness reads another context file in this folder; add the base to that file by hand or move it first");
  if (!file || !convertible(file)) return refused("this file is managed by the base block already; use the regular update");
  const edited = file.layout === "block";
  rulesPreviewSeq += 1;
  rulesPreview = { surface, fingerprint: `rulesfp${rulesPreviewSeq}-${surface}`, token: `rulestok-${Date.now()}-${rulesPreviewSeq}` };
  return {
    surface,
    applicable: true,
    reason: null,
    origin: edited ? "edited_block" : "legacy_file",
    compared_base: "sha256:5f3a91c0b2e4d6a8c1d2e3f4a5b6c7d8",
    compared_base_changed_lines: edited ? 4 : 11,
    moved_sections: edited ? ["## Communication", "## My refinements"] : ["## Communication", "## Local tooling"],
    removed_sections: edited ? [] : ["## Priority", "## Verification"],
    result: conversionResult(file),
    diff: [
      "--- installed",
      "+++ after conversion",
      "@@ -1,6 +1,18 @@",
      "+<!-- BEGIN RIGGVERK BASE: managed by Riggverk; edits inside are replaced on update; add refinements below END -->",
      " # Global Agent Rules",
      " ",
      " ## Priority",
      "-Repository reality overrides assumptions.",
      "+Repository reality overrides assumptions. Explicit user instructions override these defaults.",
      "+<!-- END RIGGVERK BASE -->",
      "",
    ].join("\n"),
    diff_truncated: false,
    plan_fingerprint: rulesPreview.fingerprint,
    preview_token: rulesPreview.token,
  };
}

function applyRulesConversion(surface: RulesSurfaceId, fingerprint: string | null, token: string | null): SetupResult {
  const file = rulesFiles.get(surface);
  if (!rulesPreview || rulesPreview.surface !== surface || fingerprint !== rulesPreview.fingerprint) {
    throw new Error("Plan fingerprint mismatch: the file changed after preview. Re-run preview before applying.");
  }
  if (token !== rulesPreview.token) throw new Error("Preview token expired or already used. Re-run preview before applying.");
  if (!file || !convertible(file)) throw new Error("this file is managed by the base block already; use the regular update");
  rulesPreview = null;
  transactionSeq += 1;
  const id = `2026-10-06T08-40-00Z-${(0x9a00 + transactionSeq).toString(16)}`;
  rulesSnapshots.set(id, [[surface, { ...file }, surfaceStates.get(surface) ?? "conflict"]]);
  rulesFiles.set(surface, { layout: "block", refinement_lines: file.layout === "block" ? file.refinement_lines + 7 : 9, user_managed: false });
  surfaceStates.set(surface, "current");
  lastTransactionId = id;
  backups.unshift({ id, timestamp: new Date().toISOString(), path: `${BACKUP_ROOT}/${id}`, targets: [surface], file_count: 1 });
  return {
    success: true,
    transaction_id: id,
    applied: [SURFACE_PATHS[surface]],
    failed: [],
    rolled_back: [],
    manual_steps: [],
    message: `applied 1 · preserved 0 · failed 0 · transaction ${id} recorded`,
  };
}

function setRulesUserManaged(surface: RulesSurfaceId, userManaged: boolean) {
  const file = rulesFiles.get(surface);
  if (!file) throw new Error(`${surface} is not a rules surface`);
  if (userManaged && !convertible(file)) throw new Error("this file is not a conflict; there is nothing to leave as is");
  rulesFiles.set(surface, { ...file, user_managed: userManaged });
  surfaceStates.set(surface, userManaged ? "current" : "conflict");
}

/* ---- the Library's view of the rules files: refinements below the managed block ---- */

const DEFAULT_REFINEMENTS = [
  "",
  "## My refinements",
  "",
  "- Answer in Swedish when I write Swedish.",
  "- Prefer small, reviewable diffs.",
  "- Never run destructive git commands without asking first.",
  "",
].join("\n");

const rulesRefinements = new Map<RulesSurfaceId, string>();
const rulesRevisions = new Map<RulesSurfaceId, number>();

/** Like the backend's gate: the harness and its rules target are both on. */
function rulesSurfaceEnabled(surface: RulesSurfaceId): boolean {
  const targetId = surface === "open_code_rules" ? "opencode_rules" : surface;
  const harness = TARGETS.find(target => target.id === targetId)?.harness;
  return !!harness && settings.enabled_harness_ids.includes(harness) && settings.enabled_target_ids.includes(targetId);
}

/** Why the backend would refuse to edit the refinements of `file`, or null. */
function rulesFileRefusal(file: RulesStatus): string | null {
  if (file.conflict_reason === "masked_by_override") return "an override file in the same folder masks this file";
  if (file.conflict_reason === "peer_context_file") return "another context file in the same folder would be hidden by a new one";
  switch (file.layout) {
    case "absent": return "no file yet: install rules from the harness page first";
    case "legacy": return "no base block: convert or install first (harness page, v)";
    case "malformed": return MALFORMED_TEXT[file.malformed_reason ?? "missing_end"];
    default: return null;
  }
}

function enabledRulesFile(surface: RulesSurfaceId): RulesStatus {
  const file = rulesFiles.get(surface);
  if (!file) throw new Error(`Unknown surface ID: ${surface}`);
  if (!rulesSurfaceEnabled(surface)) throw new Error(`${SURFACE_LABELS[surface]} is disabled`);
  return file;
}

function rulesFileSummary(surface: RulesSurfaceId): RulesFileSummary {
  const file = rulesFiles.get(surface)!;
  const reason = rulesFileRefusal(file);
  return {
    surface,
    label: SURFACE_LABELS[surface],
    file: SURFACE_PATHS[surface],
    layout: file.layout,
    conflict: file.conflict_reason ?? null,
    malformed: file.malformed_reason ?? null,
    refinement_lines: file.refinement_lines,
    editable: reason === null,
    reason,
  };
}

function rulesFileContent(surface: RulesSurfaceId): RulesFileContent {
  const file = enabledRulesFile(surface);
  const summary = rulesFileSummary(surface);
  if (file.layout !== "block") return { ...summary, before: "", refinements: "", revision: null };
  return {
    ...summary,
    before: ["<!-- BEGIN RIGGVERK BASE: managed by Riggverk; edits inside are replaced on update; add refinements below END -->", ...RULES_BASE_LINES, "<!-- END RIGGVERK BASE -->", ""].join("\n"),
    refinements: rulesRefinements.get(surface) ?? DEFAULT_REFINEMENTS,
    revision: `mock-revision-${surface}-${rulesRevisions.get(surface) ?? 0}`,
  };
}

/** Like the backend: only the refinements of an editable file, and only while the file still has the opened revision. */
function saveRulesRefinements(surface: RulesSurfaceId, content: string, expectedRevision: string): ActionResult {
  const current = rulesFileContent(surface);
  if (!current.editable) throw new Error(`${current.label}: nothing written: ${current.reason}`);
  if (current.revision !== expectedRevision) {
    throw new Error(`${current.label}: nothing written: the file changed on disk since it was opened: reload it`);
  }
  if (content === current.refinements) return actionResult("save_rules_refinements", true, "unchanged");
  rulesRefinements.set(surface, content);
  rulesRevisions.set(surface, (rulesRevisions.get(surface) ?? 0) + 1);
  const lines = content.split("\n").filter(line => line.trim() !== "").length;
  rulesFiles.set(surface, { ...rulesFiles.get(surface)!, refinement_lines: lines });
  return actionResult("save_rules_refinements", true, "saved with backup");
}

/* ---- skill and agent files in conflict, or kept ---- */

const fileUnits = new Map<FilesSurfaceId, FileUnit[]>();

function mockFile(rel: string, state: FileUnit["state"], reason: FileUnit["reason"], bundleChanged = false): FileUnit["files"][number] {
  return { rel, state, reason, bundle_changed: bundleChanged };
}

function seedFileUnits() {
  if (scenario !== "conflict") return;
  fileUnits.set("skills", [
    {
      key: "skill:claude:tdd", kind: "skill", name: "tdd", folder: "~/.claude/skills", wanted: true, state: "conflict", reason: "edited",
      bundle_changed: false, read_by: ["Claude", "OpenCode", "Cursor"], files: [mockFile("SKILL.md", "conflict", "edited")], more_files: 0,
    },
    {
      key: "skill:agents:security-audit", kind: "skill", name: "security-audit", folder: "~/.agents/skills", wanted: true, state: "conflict", reason: "edited",
      bundle_changed: false, read_by: ["Codex", "OpenCode", "Cursor"], more_files: 0,
      files: [
        mockFile("HUNTING.md", "conflict", "edited"),
        mockFile("CLIENT-SIDE.md", "conflict", "unproven"),
        mockFile("assets/report.bin", "conflict", "unproven"),
        mockFile("scripts/deploy.sh", "conflict", "unproven"),
      ],
    },
    {
      key: "skill:claude:diagnose", kind: "skill", name: "diagnose", folder: "~/.claude/skills", wanted: true, state: "kept", reason: "edited",
      bundle_changed: true, read_by: ["Claude", "OpenCode", "Cursor"], files: [mockFile("SKILL.md", "kept", "edited", true)], more_files: 0,
    },
  ]);
  fileUnits.set("claude_agents", [
    {
      key: "agent:verifier", kind: "agent", name: "verifier", folder: "~/.claude/agents", wanted: true, state: "conflict", reason: "edited",
      bundle_changed: false, read_by: ["Claude"], files: [mockFile("verifier.md", "conflict", "edited")], more_files: 0,
    },
    {
      key: "agent:sentinel", kind: "agent", name: "sentinel", folder: "~/.claude/agents", wanted: true, state: "kept", reason: "unproven",
      bundle_changed: false, read_by: ["Claude"], files: [mockFile("sentinel.md", "kept", "unproven")], more_files: 0,
    },
  ]);
}

seedFileUnits();

function filesFor(surface: SetupSurfaceId): FilesStatus | undefined {
  const units = fileUnits.get(surface as FilesSurfaceId) ?? [];
  if (units.length === 0) return undefined;
  const files = units.flatMap(unit => unit.files);
  const sorted = [...units].sort((a, b) => Number(a.state === "kept") - Number(b.state === "kept"));
  return {
    conflicts: files.filter(file => file.state === "conflict").length,
    kept: files.filter(file => file.state === "kept").length,
    kept_updates: files.filter(file => file.state === "kept" && file.bundle_changed).length,
    units: sorted,
    more: 0,
  };
}

const DIFF_BODY: Record<string, string> = {
  "skill:claude:tdd/SKILL.md": ["--- yours", "+++ bundled", "@@ -8,5 +8,5 @@", " ## Loop", " ", "-1. Write one failing test for the behavior you want.", "+1. Write one failing test for one behavior.", " 2. Make it pass with the smallest change.", " 3. Refactor with the tests green.", ""].join("\n"),
  "skill:agents:security-audit/HUNTING.md": ["--- yours", "+++ bundled", "@@ -1,4 +1,6 @@", " # Hunting", " ", "-Start from the entry points you know.", "+Start from the trust boundaries.", "+Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789", " Keep notes per boundary.", "+Fake session: prose stays readable", ""].join("\n"),
  "skill:claude:diagnose/SKILL.md": ["--- yours", "+++ bundled", "@@ -20,3 +20,4 @@", " ## Reproduce", " Build a loop that fails on demand.", "+Minimise it before you hypothesise.", ""].join("\n"),
  "agent:verifier/verifier.md": ["--- yours", "+++ bundled", "@@ -3,4 +3,4 @@", " name: verifier", "-description: Runs the checks.", "+description: Use after implementation to run non-destructive verification.", " tools: Read, Bash", ""].join("\n"),
  "agent:sentinel/sentinel.md": ["--- yours", "+++ bundled", "@@ -5,3 +5,3 @@", " Review the diff for security-sensitive mistakes.", "-Report findings.", "+Report findings with evidence.", ""].join("\n"),
};

function mockFileDiff(surface: FilesSurfaceId, key: string): FileDiffView {
  const unit = (fileUnits.get(surface) ?? []).find(candidate => candidate.key === key);
  if (!unit) throw new Error("this skill or agent has no conflicting or kept files right now");
  const files = unit.files.map((file): FileDiffView["files"][number] => {
    const base = {
      rel: file.rel, state: file.state, from_label: "yours", to_label: "bundled", installed: null, bundled: null, note: null,
      added: 0, removed: 0, truncated: false, diff: "",
    };
    const side = (bytes: number) => ({ bytes, digest: `sha256:${fakeHash(`${key}${file.rel}${bytes}`)}` });
    if (file.rel === "CLIENT-SIDE.md") {
      return { ...base, kind: "identical_text", installed: side(2144), bundled: side(2110), note: "differs only in line endings or trailing bytes" };
    }
    if (file.rel === "assets/report.bin") {
      return { ...base, kind: "binary", installed: side(48210), bundled: side(48190), note: "not text; sizes and digests only" };
    }
    if (file.rel === "scripts/deploy.sh") {
      return { ...base, kind: "withheld", installed: side(912), bundled: side(640), note: "contains key material, not shown" };
    }
    const diff = DIFF_BODY[`${key}/${file.rel}`] ?? "";
    const lines = diff.split("\n");
    return {
      ...base,
      kind: "text",
      installed: side(3012),
      bundled: side(2988),
      added: lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length,
      removed: lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length,
      diff,
    };
  });
  return { name: unit.name, folder: unit.folder, files, more_files: 0, truncated: false };
}

function setFilesKept(surface: FilesSurfaceId, keys: string[], kept: boolean) {
  const units = fileUnits.get(surface) ?? [];
  if (keys.length === 0) throw new Error("name at least one skill or agent");
  for (const key of keys) {
    const unit = units.find(candidate => candidate.key === key);
    if (!unit) {
      if (kept) throw new Error("this skill or agent has no conflicting or kept files right now");
      continue;
    }
    unit.files = unit.files.map(file =>
      kept && file.state === "conflict"
        ? { ...file, state: "kept" as const, bundle_changed: false }
        : !kept && file.state === "kept"
          ? { ...file, state: "conflict" as const, bundle_changed: false }
          : file,
    );
    unit.state = unit.files.some(file => file.state === "conflict") ? "conflict" : "kept";
    unit.bundle_changed = unit.files.some(file => file.bundle_changed);
  }
  // The skills surface is only in conflict while a unit still blocks it.
  if (surface === "skills") {
    surfaceStates.set("skills", units.some(unit => unit.state === "conflict") ? "conflict" : "current");
  }
}

let takeBundledSeq = 0;
let takeBundledOpen: { surface: FilesSurfaceId; key: string; fingerprint: string; token: string; state: FileUnit["state"] } | null = null;
/** The unit a take bundled replaced, by transaction, so the rollback brings the conflict back. */
const takeBundledSnapshots = new Map<string, { surface: FilesSurfaceId; unit: FileUnit }>();

function mockTakeBundled(surface: FilesSurfaceId, keys: string[]): TakeBundledPreview {
  const [key] = keys;
  if (keys.length !== 1 || !key) throw new Error("the mock takes one skill or agent at a time");
  const diff = mockFileDiff(surface, key);
  const unit = (fileUnits.get(surface) ?? []).find(candidate => candidate.key === key)!;
  if (!unit.wanted) throw new Error("no bundled copy is wanted in this folder");
  takeBundledSeq += 1;
  const fingerprint = `${fakeHash(`take-bundled-${key}`)}${fakeHash(`seq-${takeBundledSeq}`)}`;
  const token = `tok-take-${takeBundledSeq}`;
  takeBundledOpen = { surface, key, fingerprint, token, state: unit.state };
  const prefix = surface === "skills" ? `skill-${unit.key.split(":")[1]}-${unit.name}` : `${surface.replace("_agents", "")}-agent-${unit.name}`;
  return {
    surface,
    units: [
      {
        key,
        name: unit.name,
        folder: unit.folder,
        more_files: 0,
        diff,
        files: unit.files.map(file => ({
          rel: file.rel,
          state: file.state,
          backup_name: `artifacts/${prefix}~${file.rel.replace(/\//g, "~")}`,
          installed_digest: `sha256:${fakeHash(`${key}${file.rel}mine`)}`,
          bundled_digest: `sha256:${fakeHash(`${key}${file.rel}bundled`)}`,
        })),
      },
    ],
    plan_fingerprint: fingerprint,
    preview_token: token,
  };
}

function applyTakeBundled(surface: FilesSurfaceId, keys: string[], fingerprint: string | null, token: string | null): SetupResult {
  const open = takeBundledOpen;
  const key = keys[0];
  if (!open || open.surface !== surface || open.key !== key || fingerprint !== open.fingerprint) {
    throw new Error("Plan fingerprint mismatch: the files changed after preview. Re-run preview before applying.");
  }
  if (token !== open.token) throw new Error("invalid or expired preview token");
  const units = fileUnits.get(surface) ?? [];
  const unit = units.find(candidate => candidate.key === key);
  if (!unit || unit.state !== open.state) {
    throw new Error("Plan fingerprint mismatch: the files changed after preview. Re-run preview before applying.");
  }
  takeBundledOpen = null;
  transactionSeq += 1;
  const id = `2026-10-06T08-50-00Z-${(0x9b00 + transactionSeq).toString(16)}`;
  takeBundledSnapshots.set(id, { surface, unit: { ...unit, files: unit.files.map(file => ({ ...file })) } });
  fileUnits.set(surface, units.filter(candidate => candidate.key !== key));
  if (surface === "skills") {
    surfaceStates.set("skills", units.some(candidate => candidate.key !== key && candidate.state === "conflict") ? "conflict" : "current");
  }
  lastTransactionId = id;
  const applied = unit.files.map(file => `${unit.folder}/${unit.kind === "skill" ? `${unit.name}/` : ""}${file.rel}`);
  backups.unshift({ id, timestamp: new Date().toISOString(), path: `${BACKUP_ROOT}/${id}`, targets: [surface], file_count: applied.length });
  return {
    success: true,
    transaction_id: id,
    applied,
    failed: [],
    rolled_back: [],
    manual_steps: [],
    message: `applied ${applied.length} · preserved 0 · failed 0 · transaction ${id} recorded`,
  };
}

/* ---- Codex config: enforced keys the user keeps ---- */

const CODEX_CONFIG_REASON =
  "approvals_reviewer differs from Riggverk's and changed since Riggverk wrote the file, so nothing is written; m keeps your value";

let codexConfigKeys: { kept: CodexConfigKey[]; differing: CodexConfigKey[] } = {
  kept: [],
  differing: scenario === "conflict" ? [{ key: "approvals_reviewer", value: "auto_review" }] : [],
};

function codexConfigDetail(state: InstallationState): string | null {
  const { kept, differing } = codexConfigKeys;
  if (state === "conflict" && differing.length > 0) return CODEX_CONFIG_REASON;
  if (kept.length > 0) return `you keep ${kept.map(item => `${item.key} = ${item.value}`).join(", ")}; other managed keys follow Riggverk`;
  return null;
}

function setCodexConfigKept(kept: boolean) {
  if (kept) {
    if (codexConfigKeys.differing.length === 0) {
      throw new Error("no enforced key differs from the bundled config; there is nothing to keep");
    }
    codexConfigKeys = { kept: [...codexConfigKeys.kept, ...codexConfigKeys.differing], differing: [] };
    surfaceStates.set("codex_config", "current");
  } else if (codexConfigKeys.kept.length > 0) {
    // The value is still the user's, and the recorded digest still does not match: a conflict again.
    codexConfigKeys = { kept: [], differing: [...codexConfigKeys.kept, ...codexConfigKeys.differing] };
    surfaceStates.set("codex_config", "conflict");
  }
}

/** Riggverk's value for each enforced key, as the bundled config sets them. */
const CODEX_RIGGVERK_VALUES: Record<string, string> = {
  approval_policy: "on-request",
  approvals_reviewer: "user",
  sandbox_mode: "workspace-write",
  "apps._default.approvals_reviewer": "user",
  "apps._default.default_tools_approval_mode": "prompt",
};

/** What Riggverk writes for each kept or differing key. */
function codexConfigExpected(): CodexConfigKey[] {
  return [...codexConfigKeys.kept, ...codexConfigKeys.differing].flatMap(item => {
    const value = CODEX_RIGGVERK_VALUES[item.key];
    return value === undefined ? [] : [{ key: item.key, value }];
  });
}

let codexDefaultsSeq = 0;
let codexDefaultsOpen: { fingerprint: string; token: string; keys: CodexConfigKey[] } | null = null;
/** The differing keys a reset replaced, by transaction, so the rollback brings them back. */
const codexDefaultsSnapshots = new Map<string, CodexConfigKey[]>();

function mockCodexDefaults(): CodexConfigDefaultsPreview {
  const { differing } = codexConfigKeys;
  if (differing.length === 0) {
    throw new Error("no enforced key differs from the bundled config; there is nothing to reset");
  }
  codexDefaultsSeq += 1;
  const keys = differing.map(item => ({ key: item.key, yours: item.value, riggverk: CODEX_RIGGVERK_VALUES[item.key] ?? "" }));
  const fingerprint = `${fakeHash(`codex-defaults-${keys.map(item => item.key).join(",")}`)}${fakeHash(`seq-${codexDefaultsSeq}`)}`;
  const token = `tok-codex-defaults-${codexDefaultsSeq}`;
  codexDefaultsOpen = { fingerprint, token, keys: [...differing] };
  return {
    keys,
    diff: keys.flatMap(item => [`- ${item.key} = ${JSON.stringify(item.yours)}`, `+ ${item.key} = ${JSON.stringify(item.riggverk)}`]).join("\n"),
    plan_fingerprint: fingerprint,
    preview_token: token,
  };
}

function applyCodexDefaults(fingerprint: string | null, token: string | null): SetupResult {
  const open = codexDefaultsOpen;
  if (!open || fingerprint !== open.fingerprint || open.keys.length !== codexConfigKeys.differing.length) {
    throw new Error("Plan fingerprint mismatch: the config changed after preview. Re-run preview before applying.");
  }
  if (token !== open.token) throw new Error("invalid or expired preview token");
  codexDefaultsOpen = null;
  transactionSeq += 1;
  const id = `2026-10-06T08-55-00Z-${(0x9c00 + transactionSeq).toString(16)}`;
  codexDefaultsSnapshots.set(id, open.keys);
  codexConfigKeys = { kept: codexConfigKeys.kept, differing: [] };
  surfaceStates.set("codex_config", "current");
  lastTransactionId = id;
  backups.unshift({ id, timestamp: new Date().toISOString(), path: `${BACKUP_ROOT}/${id}`, targets: ["codex_config"], file_count: 1 });
  return {
    success: true,
    transaction_id: id,
    applied: ["Codex config"],
    failed: [],
    rolled_back: [],
    manual_steps: [],
    message: `applied 1 · preserved 0 · failed 0 · transaction ${id} recorded`,
  };
}

/** The mock data folder: the old copies an update removes, and what it leaves alone. */
const MOCK_OLD_COPIES = 133;

function surfaceDetail(surface: SetupSurfaceId, state: InstallationState): string {
  if (surface === "workspace_bundle") {
    return state === "update_available" ? `${MOCK_OLD_COPIES} old copies to remove` : state === "current" ? "none" : "unavailable";
  }
  switch (state) {
    case "current": return `installed · ${BUNDLE_DIGEST}`;
    case "update_available": return `bundle ${BUNDLE_DIGEST} → installed ${INSTALLED_DIGEST}`;
    case "conflict":
      return surface === "pi_mcp"
        ? "the file has comments; the app edits strict JSON only and writes nothing"
        : `${SURFACE_PATHS[surface]} modified locally since install; preserved`;
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
    const file = rulesFor(surface);
    return {
      surface,
      label: SURFACE_LABELS[surface],
      state,
      detail: file ? rulesDetail(file, state) : ((surface === "codex_config" && codexConfigDetail(state)) || surfaceDetail(surface, state)),
      ...(file ? { rules: { ...file } } : {}),
      ...(surface === "codex_config" && (codexConfigKeys.kept.length > 0 || codexConfigKeys.differing.length > 0)
        ? { codex_config: { kept: [...codexConfigKeys.kept], differing: [...codexConfigKeys.differing], expected: codexConfigExpected() } }
        : {}),
      ...(filesFor(surface) ? { files: filesFor(surface) } : {}),
      ...(surface === "workspace_bundle"
        ? { data_folder: { personal_docs: scenario === "fresh" ? 0 : 2, ownership_records: scenario !== "fresh", left_in_place: 0 } }
        : {}),
    };
  });
  const counts = { create_count: 0, update_count: 0, remove_count: 0, conflict_count: 0, kept_count: 0 };
  for (const row of rows) {
    if (row.state === "not_installed") counts.create_count += 1;
    if (row.state === "update_available" && row.surface === "workspace_bundle") counts.remove_count += MOCK_OLD_COPIES;
    else if (row.state === "update_available") counts.update_count += 1;
    // Like the backend: every conflicting file counts, the files the user keeps do not.
    if (row.files) counts.conflict_count += row.files.conflicts;
    else if (row.state === "conflict") counts.conflict_count += 1;
    counts.kept_count += row.files?.kept ?? 0;
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
  // Like the backend, a rules conflict is named by its artifact label; the reason is in `rules` and `detail`.
  const conflicts = rows.filter(row => row.state === "conflict").map(row => (row.rules ? row.label : row.detail));
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
  // A rules file the user keeps is not planned for writing; the plan lists it as a manual step.
  const kind: OperationKind = rulesFor(surface)?.user_managed ? "manual" : kindByState[state];
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
    kind === "update" && surface === "skills"
      ? [
        `+ ~/.agents/skills (${skills.length} skills, ${skills.length} files)`,
        `~ ~/.claude/skills (${skills.length} skills, ${skills.length} files)`,
        `- $CODEX_HOME/skills (${skills.length} skills, owned copies)`,
        "! ~/.cursor/skills/tdd (edited, kept)",
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
    manual_step: kind === "manual" ? `${path} is left as is; convert it in the app or hand it back to take base updates` : null,
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
      if (surface === "open_code_config") {
        installedModelSelection = { ...modelSelection };
        opencodeTemplateUpdate = false;
      }
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
  return {
    repo_path: WORKSPACE,
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
    resolved_path: valid ? settings.workspace_path ?? WORKSPACE : null,
    valid,
    // Like the backend: only the folder itself decides (a link, a file, a missing override folder).
    error: valid ? null : "the folder is a symlink",
    enabled_rule_targets: TARGETS.filter(t => t.kind === "rules" && enabled.has(t.id)).length,
    total_rule_targets: TARGETS.filter(t => t.kind === "rules").length,
    enabled_config_targets: TARGETS.filter(t => t.kind === "config" && enabled.has(t.id)).length,
    total_config_targets: TARGETS.filter(t => t.kind === "config").length,
    backup_root: BACKUP_ROOT,
    backup_root_exists: backups.length > 0,
  };
}

/* ---- runtime health ---- */

function codexHealth(): CodexRuntimeHealth {
  const fresh = scenario === "fresh";
  // Codex reads AGENTS.override.md instead of AGENTS.md when it has content, which drops the base.
  const override = scenario === "conflict";
  const overrideDetail = `${HOME}/.codex/AGENTS.override.md exists and replaces AGENTS.md; the Riggverk base block is not loaded until it is removed or emptied`;
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
    legacy_skills_path: `${HOME}/.codex/skills`,
    legacy_skills_migratable_count: 0,
    legacy_skills_conflict_count: 0,
    agents_status: status,
    bundled_agent_count: 6,
    installed_bundled_agent_count: fresh ? 0 : 6,
    extra_installed_agent_count: 0,
    agent_mismatches: [],
    config_status: scenario === "conflict" && codexConfigKeys.differing.length > 0 ? "diverged" : "manual",
    config_kept: codexConfigKeys.kept.map(item => item.key),
    template_config_path: `${WORKSPACE}/templates/codex/config.toml`,
    installed_config_path: `${HOME}/.codex/config.toml`,
    approval_policy: fresh ? null : "on-request",
    sandbox_mode: fresh ? null : "workspace-write",
    checks: [
      { id: "cli", label: "codex cli", status: "ok", detail: "codex 0.42.0" },
      { id: "rules", label: "rules", status: fresh ? "missing" : "ok", detail: fresh ? "not installed" : "synced" },
      ...(override ? [{ id: "rules_override", label: "AGENTS.override.md replaces AGENTS.md", status: "warn", detail: overrideDetail }] : []),
    ],
    warnings: override ? [overrideDetail] : [],
    summary: fresh ? "Codex is not set up yet." : "Codex rules, agents and skills are current.",
    next_action: fresh ? "Install Codex surfaces." : "Nothing to do.",
  };
}

function opencodeHealth(): OpenCodeRuntimeHealth {
  const fresh = surfaceStates.get("open_code_config") === "not_installed";
  const divergedKeys = [...new Set([...(opencodeTemplateUpdate ? ["model", "lsp"] : []), ...opencodeModelDivergedKeys()])];
  const update = divergedKeys.length > 0;
  const status = fresh ? "missing" : update ? "stale" : "synced";
  const installedSubagent = installedModelSelection.subagent_model || null;
  const installedCritic = installedModelSelection.critic_model || installedSubagent;
  return {
    status,
    template_config_path: `${WORKSPACE}/templates/opencode.json`,
    installed_config_path: `${HOME}/.config/opencode/opencode.json`,
    checks: [
      { id: "config", label: "config", status, detail: update ? "template changed" : "synced" },
      { id: "agents", label: "agents", status: fresh ? "missing" : "ok", detail: fresh ? "0/6" : "6/6" },
    ],
    default_agent: fresh ? null : "claude",
    model: fresh ? null : installedModelSelection.model,
    small_model: fresh ? null : installedModelSelection.small_model,
    subagent_model: fresh || (!modelSelection.critic_model && installedCritic !== installedSubagent) ? null : installedSubagent,
    critic_model: fresh ? null : installedCritic,
    autoupdate: "true",
    snapshot: true,
    bundled_agent_count: 6,
    installed_bundled_agent_count: fresh ? 0 : 6,
    extra_installed_agent_count: 0,
    agent_mismatches: [],
    warnings: [],
    cli: { status: "supported", version: "1.19.3", major: 1, detail: "OpenCode 1.19.3" },
    config_status: fresh ? "missing" : update ? "diverged" : "synced",
    config_diverged_keys: divergedKeys,
    rules_status: fresh ? "missing" : "synced",
    playwright_mcp_version: fresh ? null : "0.0.83",
    config_precedence: { installed_not_strict: [], sibling_files: [], env_vars: [], system_managed_paths: [] },
    template_tui_path: `${WORKSPACE}/templates/opencode-tui.json`,
    installed_tui_path: `${HOME}/.config/opencode/tui.json`,
    tui_status: fresh ? "missing" : update ? "diverged" : "synced",
    tui_diverged_keys: update ? ["theme", "mouse"] : [],
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
    skills_synced: !fresh && surfaceStates.get("skills") === "current",
    expected_agent_count: 6,
    installed_agent_count: fresh ? 0 : 5,
    claude_cli_available: true,
    summary: fresh ? "Claude is not set up yet." : "Claude CLI available · agents 5/6 · skills 17/18",
  };
}

/**
 * Copilot, Pi and Kilo. The CLI differs per harness so every row shows once: Copilot is on PATH, Pi is not found,
 * Kilo is found in nvm. `&light=unserved` leaves Copilot and Pi without a skills folder (Codex isolated).
 */
function lightHealth(harness: LightAgent): LightRuntimeHealth {
  const unserved = params.get("light") === "unserved" && harness !== "kilo";
  const state = scenario === "fresh" ? "not_installed" : (surfaceStates.get("skills") ?? "not_installed");
  const expected = scenario === "empty" ? 0 : skills.length;
  const status = unserved
    ? "unserved"
    : state === "current" ? "synced" : state === "update_available" ? "partial" : state === "conflict" ? "diverged" : "missing";
  const synced = status === "synced" ? expected : status === "partial" ? Math.max(expected - 3, 0) : 0;
  const label = harness === "copilot" ? "Copilot" : harness === "pi" ? "Pi" : "Kilo";
  const rulesSurface = `${harness}_rules` as RulesSurfaceId;
  const rulesState = surfaceStates.get(rulesSurface) ?? "not_installed";
  const rulesFile = rulesFiles.get(rulesSurface);
  const rulesOn = settings.enabled_target_ids.includes(rulesSurface);
  const rulesStatus = !rulesOn
    ? "off"
    : rulesState === "current" ? "synced" : rulesState === "update_available" ? "stale" : rulesState === "conflict" ? "diverged" : "missing";
  const rules: LightRuntimeHealth["rules"] = {
    status: rulesStatus,
    path: SURFACE_PATHS[rulesSurface],
    refinement_lines: rulesFile?.refinement_lines ?? 0,
    user_managed: rulesFile?.user_managed ?? false,
    conflict_reason: rulesFile?.conflict_reason ?? null,
    detail: rulesFile ? rulesDetail(rulesFile, rulesState) : "not installed",
  };
  const rulesWarnings =
    rulesStatus === "off"
      ? []
      : harness === "kilo"
        ? [`Kilo loads one global rules file and ${rules.path} comes first: while it exists Kilo does not read ~/.claude/CLAUDE.md. Move what Kilo should keep from there below the managed block.`]
        : harness === "pi" && rulesFile?.conflict_reason === "masked_by_override"
          ? ["AGENTS.override.md in ~/.pi/agent replaces AGENTS.md, so Pi never reads the managed block. Remove or rename it."]
          : harness === "copilot" && settings.enabled_harness_ids.includes("claude") && settings.enabled_target_ids.includes("claude_rules")
            ? ["VS Code can load both ~/.claude/CLAUDE.md and ~/.copilot/copilot-instructions.md, so the shared base may appear twice there. The Copilot CLI reads only ~/.copilot."]
            : [];
  const cli: LightRuntimeHealth["cli"] =
    harness === "copilot"
      ? { status: "found", version: "1.0.98", source: "path", detail: "Copilot 1.0.98" }
      : harness === "pi"
        ? { status: "missing", version: null, source: null, detail: "pi is not on PATH; Riggverk does not read your shell profile, so start it from a shell where pi runs" }
        : { status: "found", version: "7.8.12", source: "nvm", detail: "Kilo 7.8.12 (found in nvm v24.14.0, not on PATH)" };
  const mcpSurface = `${harness}_mcp` as (typeof LIGHT_MCP_SURFACES)[number];
  const mcpState = surfaceStates.get(mcpSurface) ?? "not_installed";
  const mcpOn = settings.enabled_target_ids.includes(mcpSurface);
  const mcpStatus = !mcpOn
    ? "off"
    : mcpState === "current" ? "synced" : mcpState === "update_available" ? "stale" : mcpState === "conflict" ? "invalid" : "missing";
  const mcp: LightRuntimeHealth["mcp"] = {
    status: mcpStatus,
    path: SURFACE_PATHS[mcpSurface],
    playwright_version: mcpStatus === "synced" || mcpStatus === "stale" ? "0.0.83" : null,
    detail: mcpStatus === "synced" ? "installed and current" : surfaceDetail(mcpSurface, mcpState),
  };
  const mcpWarnings =
    mcpStatus !== "off" && harness === "pi"
      ? ["Pi does not declare the tools of this server to the model until the entry sets exposure (for example \"direct\"); by default they are callable from codemode scripts only."]
      : [];
  const overall = status !== "synced"
    ? status
    : rulesStatus !== "off" && rulesStatus !== "synced" ? rulesStatus : mcpStatus !== "off" && mcpStatus !== "synced" ? mcpStatus : "synced";
  return {
    harness,
    status: overall,
    cli,
    rules,
    mcp,
    skills: { status, synced, expected, roots: unserved ? [] : harness === "kilo" ? ["~/.claude/skills", "~/.agents/skills"] : ["~/.agents/skills"] },
    warnings: [
      ...(unserved ? [`No skills are installed for ${label}: it reads ~/.agents/skills, and a customised CODEX_HOME keeps Codex out of that folder.`] : []),
      ...rulesWarnings,
      ...mcpWarnings,
    ],
    next_action: unserved
      ? `Disable Codex or unset CODEX_HOME to install skills for ${label}.`
      : overall === "synced" ? "No runtime action needed." : `Run Install or Update on the ${label} page.`,
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
    path: `skills/${id}/SKILL.md`,
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

// Like the backend: bundled docs have their bundle-relative path as id ("curated"), personal docs `custom:<slug>`
// (read from the workspace folder, which the error scenario does not have).
const docStore = new Map<string, DocumentContent>();
if (scenario !== "empty") {
  const docRows: Array<[string, string, string, string]> = [
    ["README.md", "README", "Start", "curated"],
    ["docs/SKILLS.md", "SKILLS", "Reference", "curated"],
    ["docs/TROUBLESHOOTING.md", "TROUBLESHOOTING", "Reference", "curated"],
    ["docs/SECURITY_BASELINE.md", "Security Baseline", "Guides", "curated"],
    ["custom:project-notes", "Project notes", "Context", "custom"],
  ];
  for (const [id, title, section, source] of docRows) {
    const rel = source === "custom" ? `docs/context/${id.slice("custom:".length)}.md` : id;
    docStore.set(id, {
      id,
      title,
      path: rel,
      section,
      source,
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
      path: `agents/${filename}`,
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

const agentTemplate: DocumentContent = {
  id: "agent-template",
  title: "Agent Rules",
  path: "templates/global-agent-rules.md",
  section: "",
  source: "curated",
  content: "# Global Agent Rules\n\n## Priority\nRepository reality overrides assumptions. Explicit user instructions override these defaults.\n\n## Communication\nBe direct, dense, technical, and concise.\n\n## Verification\nNever claim done without evidence.\n",
};

const configSources: ConfigEditorSourceMeta[] = [
  { id: "base", label: "base", rel_path: "templates/opencode.base.json", helper: "bundled base config" },
  { id: "policy", label: "policy", rel_path: "templates/opencode.policy.json", helper: "local overrides" },
  { id: "snapshot", label: "snapshot", rel_path: "templates/opencode.json", helper: "snapshot written on install" },
];

const configStore = new Map<string, DocumentContent>([
  ["base", { id: "opencode_config:base", title: "base Config", path: "templates/opencode.base.json", section: "", source: "curated", content: "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"model\": \"anthropic/claude-sonnet-4-5\",\n  \"small_model\": \"anthropic/claude-haiku-4-5\",\n  \"autoupdate\": true\n}\n" }],
  ["policy", { id: "opencode_config:policy", title: "policy Config", path: "templates/opencode.policy.json", section: "", source: "curated", content: "{\n  \"permission\": { \"bash\": \"ask\", \"edit\": \"allow\" }\n}\n" }],
  ["snapshot", { id: "opencode_config:snapshot", title: "snapshot Config", path: "templates/opencode.json", section: "", source: "curated", content: "{\n  \"model\": \"anthropic/claude-sonnet-4-5\",\n  \"permission\": { \"bash\": \"ask\", \"edit\": \"allow\" }\n}\n" }],
]);

const BUNDLED_MODEL_SELECTION: OpenCodeModelSelection = {
  model: "anthropic/claude-sonnet-4-5",
  small_model: "anthropic/claude-haiku-4-5",
  subagent_model: "",
  critic_model: "",
  model_source: "bundled default",
  small_model_source: "bundled default",
  subagent_source: "bundled default",
  critic_source: "bundled default",
};
let modelSelection: OpenCodeModelSelection = BUNDLED_MODEL_SELECTION;
let installedModelSelection: OpenCodeModelSelection = BUNDLED_MODEL_SELECTION;
let opencodeTemplateUpdate = surfaceStates.get("open_code_config") === "update_available";

function opencodeModelDivergedKeys(): string[] {
  const keys = (["model", "small_model"] as const).filter(key => modelSelection[key] !== installedModelSelection[key]) as string[];
  for (const role of ["repo-scout", "inspector", "sentinel", "verifier", "scribe"]) {
    const expected = (role === "inspector" && modelSelection.critic_model) || modelSelection.subagent_model;
    const installed = (role === "inspector" && installedModelSelection.critic_model) || installedModelSelection.subagent_model;
    if (expected !== installed) keys.push(`agent.${role}.model`);
  }
  return keys;
}

function validatedModelId(value: string, optional = false): string {
  const id = value.trim();
  if (optional && !id) return "";
  if (!id.includes("/") || /\s|\p{Cc}/u.test(id) || id.split("/").some(segment => !segment)) {
    throw new Error("invalid model ID: must be in provider/model format");
  }
  return id;
}

/* ---- actions ---- */

function actionResult(action: string, success: boolean, stdout: string, stderr = ""): ActionResult {
  return { success, action, stdout, stderr, exit_code: success ? 0 : 1 };
}

/* ---- apply progress ---- */

const MOCK_SKILLS = ["handoff", "diagnose", "implementation-plan", "release-check"];

/** The files a surface writes, for display: a directory surface lists its files like the backend would. */
function surfaceFiles(surface: SetupSurfaceId): string[] {
  const path = SURFACE_PATHS[surface];
  if (surface.endsWith("_agents")) return agentRows.map(([filename]) => `${path}/${filename}`);
  if (surface.endsWith("_skills")) return MOCK_SKILLS.map(name => `${path}/${name}/SKILL.md`);
  return [path];
}

/**
 * Reports a task the way the backend does: an optional backup pass, then one `apply` event per file (counting the
 * files finished before it), the completed count, and `done`. Paced so the strip shows the values arriving.
 */
async function emitProgress(task: string, files: string[], options: { backup?: boolean } = {}): Promise<void> {
  const total = files.length;
  const report = (phase: ApplyProgress["phase"], done: number, file: string | null) =>
    emit("apply-progress", { task, phase, done, total, file } satisfies ApplyProgress);
  if (options.backup !== false) {
    for (const [index, file] of files.entries()) {
      await report("backup", index, file);
      await delay(45);
    }
  }
  for (const [index, file] of files.entries()) {
    await report("apply", index, file);
    await delay(110);
  }
  await report("apply", total, null);
  await report("done", total, null);
}

/* ---- effective skill loads ---- */

/** Copilot, Pi and Kilo list their folders by precedence: the first one holding a name wins. */
const SKILL_READ_FOLDERS: Record<InstallAgent, SkillReadFolder[]> = {
  claude: ["claude"],
  codex: ["agents", "codex_home"],
  opencode: ["claude", "agents", "open_code"],
  cursor: ["cursor", "agents", "claude", "dot_codex"],
  copilot: ["copilot", "agents"],
  pi: ["pi_agent", "agents"],
  kilo: ["kilo", "agents", "claude"],
};

const SKILL_FOLDER_PATHS: Record<SkillReadFolder, string> = {
  claude: "~/.claude/skills",
  agents: "~/.agents/skills",
  codex_home: "~/.codex/skills",
  dot_codex: "~/.codex/skills",
  open_code: "~/.config/opencode/skills",
  cursor: "~/.cursor/skills",
  copilot: "~/.copilot/skills",
  pi_agent: "~/.pi/agent/skills",
  kilo: "~/.kilo/skills",
};

/** The folders skills are installed into for these harnesses (default Codex home), as the backend picks them. */
function installedSkillFolders(enabled: readonly InstallAgent[]): SkillReadFolder[] {
  const on = (harness: InstallAgent) => enabled.includes(harness);
  // Copilot and Pi read ~/.agents/skills only; OpenCode, Cursor and Kilo are served by it unless Claude is on.
  const agents =
    on("codex") || on("copilot") || on("pi") || ((on("opencode") || on("cursor") || on("kilo")) && !on("claude"));
  return [...(on("claude") ? ["claude" as const] : []), ...(agents ? ["agents" as const] : [])];
}

/** A 12-digit pseudo hash: equal seeds give equal hashes. */
function fakeHash(seed: string): string {
  let h = 5381;
  for (const ch of seed) h = (h * 33 + ch.charCodeAt(0)) % 0xffffffffffff;
  return h.toString(16).padStart(12, "0");
}

type NamedCopy = SkillCopy & { name: string };

/** Copies the conflict scenario adds to the installed ones: an older app copy of `tdd` and two of the user's own skill. */
function extraSkillCopies(): NamedCopy[] {
  if (scenario !== "conflict") return [];
  const own = (folder: SkillReadFolder): NamedCopy => ({
    name: "my-deploy", folder, path: `${SKILL_FOLDER_PATHS[folder]}/my-deploy`, hash: fakeHash(`my-deploy-${folder}`), owner: "foreign", current: false,
  });
  return [
    { name: "tdd", folder: "codex_home", path: "~/.codex/skills/tdd", hash: fakeHash("tdd-older"), owner: "aw", current: false },
    own("agents"),
    own("codex_home"),
  ];
}

function skillFlags(harness: InstallAgent, copies: readonly SkillCopy[]): SkillLoadFlag[] {
  if (copies.length < 2) return [];
  if (copies.some(copy => copy.owner === "foreign")) return ["foreign_copy"];
  if (harness === "codex") return ["plain_mention_ambiguous"];
  if (harness === "cursor") return ["possible_duplicate"];
  if (harness === "opencode") return [copies.every(copy => copy.hash === copies[0].hash) ? "duplicate_identical" : "winner_nondeterministic"];
  if (isLightAgent(harness)) return [copies.every(copy => copy.hash === copies[0].hash) ? "duplicate_identical" : "shadowed_by_folder_order"];
  return [];
}

/** The copy that is loaded: the only one, or the first of a harness that ranks its folders (copies are in folder order). */
function skillWinner(harness: InstallAgent, copies: readonly SkillCopy[]): number | null {
  if (copies.length === 1) return 0;
  return isLightAgent(harness) && copies.length > 1 && copies[0].folder !== copies[1].folder ? 0 : null;
}

function effectiveSkillLoads(): EffectiveSkillLoads {
  const enabled = settings.enabled_harness_ids;
  const installed = scenario === "fresh" || scenario === "empty" ? [] : installedSkillFolders(enabled);
  const names = scenario === "empty" ? [] : skills.map(skill => skill.name);
  const extras = extraSkillCopies();
  const harnesses = enabled.map(harness => {
    const reads = SKILL_READ_FOLDERS[harness];
    const byName = new Map<string, SkillCopy[]>();
    // A copy is listed once however many folders lead to it: the literal ~/.codex/skills is Codex's folder too.
    const seen = new Set<string>();
    for (const folder of reads) {
      const found: NamedCopy[] = [
        ...installed.filter(root => root === folder).flatMap(root => names.map((name): NamedCopy => ({
          name, folder: root, path: `${SKILL_FOLDER_PATHS[root]}/${name}`, hash: fakeHash(name), owner: "aw", current: true,
        }))),
        ...extras.filter(copy => copy.folder === folder || (folder === "dot_codex" && copy.folder === "codex_home")),
      ];
      for (const { name, ...copy } of found) {
        if (seen.has(copy.path)) continue;
        seen.add(copy.path);
        byName.set(name, [...(byName.get(name) ?? []), { ...copy, folder }]);
      }
    }
    const loaded: SkillLoad[] = [...byName]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, copies]) => ({ name, copies, winner: skillWinner(harness, copies), flags: skillFlags(harness, copies) }));
    return {
      harness,
      folders: reads.map(folder => ({ folder, path: SKILL_FOLDER_PATHS[folder], exists: installed.includes(folder) || extras.some(copy => copy.folder === folder) })),
      skills: loaded,
    };
  });
  const foreign = new Map<string, { harnesses: InstallAgent[]; copies: SkillCopy[] }>();
  for (const { harness, skills: loaded } of harnesses) {
    for (const skill of loaded.filter(candidate => candidate.flags.includes("foreign_copy"))) {
      const entry = foreign.get(skill.name) ?? { harnesses: [], copies: [] };
      entry.harnesses.push(harness);
      entry.copies.push(...skill.copies.filter(copy => !entry.copies.some(known => known.path === copy.path)));
      foreign.set(skill.name, entry);
    }
  }
  return { harnesses, foreign_duplicates: [...foreign].map(([name, entry]) => ({ name, ...entry })) };
}

/* ---- dispatcher ---- */

type Args = Record<string, unknown> | undefined;

function arg<T>(args: Args, key: string): T {
  return (args ?? {})[key] as T;
}

// Callers prefix their own label ("Status error: …"), so the message carries none.
function workspaceIsValid(): boolean {
  return scenario !== "error";
}

/** Like the backend: personal docs live in the workspace folder, so they need a valid one; bundled docs do not. */
function requireWorkspaceForPersonalDoc(id: string): void {
  if (id.startsWith("custom:") && !workspaceIsValid()) throw new Error("invalid workspace path: not a valid workspace");
}

/**
 * The security posture of a harness. `default`: nothing risky; `conflict`: bypass mode on in Claude, approvals off in
 * Codex, the sandbox off in Cursor; `fresh`: no config file; `error`: the call fails.
 */
function posture(harness: InstallAgent): SecurityPosture {
  const file = {
    claude: "~/.claude/settings.json",
    codex: "~/.codex/config.toml",
    opencode: "opencode.json",
    cursor: "~/.cursor/sandbox.json",
    kilo: "kilo.jsonc",
    copilot: "",
    pi: "",
  }[harness];
  const state = scenario === "fresh" ? "missing" : "read";
  const risky = scenario === "conflict";
  const finding = (code: SecurityPosture["findings"][number]["code"], level: SecurityPosture["findings"][number]["level"], count: number | null = null) => ({
    code,
    level,
    file: null,
    count,
  });
  const configOnly = finding("config_only", "not_covered");
  switch (harness) {
    case "claude":
      return {
        harness,
        sources: [{ file, state }],
        findings: [
          risky ? finding("claude_bypass_default", "risky") : finding("claude_bypass_available", "advice"),
          finding("claude_sandbox_off", "advice"),
          finding("claude_env_read_open", "advice"),
          configOnly,
        ],
      };
    case "codex":
      return {
        harness,
        sources: [{ file, state }],
        findings: [
          finding("codex_sandbox_workspace", "enforced"),
          risky ? finding("codex_approvals_never", "risky") : finding("codex_approvals_on_request", "enforced"),
          configOnly,
        ],
      };
    case "opencode":
      return {
        harness,
        sources: [{ file, state }],
        findings: [finding("opencode_deny_rules", "enforced", 6), configOnly],
      };
    case "cursor":
      return {
        harness,
        sources: [{ file, state }],
        findings: [...(risky ? [finding("cursor_sandbox_off", "risky")] : []), finding("cursor_run_mode", "not_covered"), configOnly],
      };
    case "kilo":
      return { harness, sources: [{ file, state }], findings: [finding("kilo_no_rules", "advice"), configOnly] };
    case "copilot":
      return { harness, sources: [], findings: [finding("copilot_not_covered", "not_covered")] };
    case "pi":
      return { harness, sources: [], findings: [finding("pi_not_covered", "not_covered")] };
  }
}

function unavailable(): never {
  throw new Error("workspace invalid (mock error scenario)");
}

async function handle(cmd: string, args: Args): Promise<unknown> {
  // Like the backend: `open_doc` opens personal docs only; bundled items are read-only and never opened.
  if (cmd === "open_doc" && !arg<string>(args, "id").startsWith("custom:")) {
    throw new Error(`${arg<string>(args, "id")} is bundled with the app and read-only here`);
  }
  // Like the backend: `open_rules_file` opens the rules file of an enabled harness when there is one.
  if (cmd === "open_rules_file") {
    const surface = arg<RulesSurfaceId>(args, "surface");
    if (enabledRulesFile(surface).layout === "absent") throw new Error("no file yet: install rules from the harness page first");
  }
  if (cmd === "open_doc" || cmd === "open_rules_file" || cmd === "open_backups_folder" || cmd === "open_default_workspace_folder") {
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
    case "reset_active_workspace_path":
      settings = { ...settings, workspace_path: null, revision: (settings.revision ?? 0) + 1 };
      return settings;
    case "get_agent_targets":
      return TARGETS;
    case "get_status":
      return scenario === "error" ? unavailable() : statusData();
    case "get_workspace_diagnostics":
      return diagnostics();
    case "get_installation_status":
      await delay(120);
      return scenario === "error" ? unavailable() : installationStatus(arg<SetupSurfaceId[]>(args, "surfaces"));
    case "preview_setup":
      await delay(200);
      return setupPlan(arg<SetupSurfaceId[]>(args, "surfaces"));
    case "apply_setup": {
      const surfaces = arg<SetupSurfaceId[]>(args, "surfaces");
      const pending = surfaces.filter(surface => ["not_installed", "update_available"].includes(surfaceStates.get(surface) ?? ""));
      await emitProgress("apply_setup", pending.flatMap(surfaceFiles));
      return applyPlan(surfaces);
    }
    case "preview_rules_diff":
      await delay(150);
      return mockRulesDiff(arg<RulesSurfaceId>(args, "surface"), (arg<RulesDiffMode | undefined>(args, "mode")) ?? "update");
    case "preview_rules_conversion":
      await delay(200);
      return mockRulesConversion(arg<RulesSurfaceId>(args, "surface"));
    case "apply_rules_conversion":
      await emitProgress("apply_rules_conversion", [SURFACE_PATHS[arg<RulesSurfaceId>(args, "surface")]]);
      return applyRulesConversion(arg<RulesSurfaceId>(args, "surface"), arg<string | null>(args, "planFingerprint"), arg<string | null>(args, "previewToken"));
    case "set_rules_user_managed":
      await delay(100);
      setRulesUserManaged(arg<RulesSurfaceId>(args, "surface"), arg<boolean>(args, "userManaged"));
      return null;
    case "set_codex_config_kept":
      await delay(100);
      setCodexConfigKept(arg<boolean>(args, "kept"));
      return null;
    case "preview_codex_config_defaults":
      await delay(200);
      return mockCodexDefaults();
    case "apply_codex_config_defaults":
      await emitProgress("apply_codex_config_defaults", ["~/.codex/config.toml"]);
      return applyCodexDefaults(arg<string | null>(args, "planFingerprint"), arg<string | null>(args, "previewToken"));
    case "preview_file_diff":
      await delay(150);
      return mockFileDiff(arg<FilesSurfaceId>(args, "surface"), arg<string>(args, "unit"));
    case "set_files_kept":
      await delay(100);
      setFilesKept(arg<FilesSurfaceId>(args, "surface"), arg<string[]>(args, "units"), arg<boolean>(args, "kept"));
      return null;
    case "preview_take_bundled":
      await delay(200);
      return mockTakeBundled(arg<FilesSurfaceId>(args, "surface"), arg<string[]>(args, "units"));
    case "apply_take_bundled": {
      const surface = arg<FilesSurfaceId>(args, "surface");
      const unit = (fileUnits.get(surface) ?? []).find(candidate => candidate.key === arg<string[]>(args, "units")[0]);
      await emitProgress(
        "apply_take_bundled",
        (unit?.files ?? []).map(file => `${unit?.folder ?? ""}/${file.rel}`),
      );
      return applyTakeBundled(surface, arg<string[]>(args, "units"), arg<string | null>(args, "planFingerprint"), arg<string | null>(args, "previewToken"));
    }
    case "rollback_setup_transaction": {
      const dryRun = arg<boolean>(args, "dryRun");
      const id = arg<string>(args, "transactionId");
      if (dryRun) await delay(400);
      else await emitProgress("rollback_setup_transaction", ["~/.claude/CLAUDE.md", "~/.claude/agents/verifier.md"], { backup: false });
      if (!lastTransactionId || id !== lastTransactionId) {
        return { success: false, transaction_id: id, applied: [], failed: [id], rolled_back: [], manual_steps: [], message: `transaction ${id} not found` } satisfies SetupResult;
      }
      if (!dryRun) {
        const snapshot = rulesSnapshots.get(id);
        const replaced = takeBundledSnapshots.get(id);
        const resetKeys = codexDefaultsSnapshots.get(id);
        if (resetKeys) {
          // Your values are back, and the choice to keep them is not, like the backend.
          codexConfigKeys = { kept: codexConfigKeys.kept, differing: resetKeys };
          surfaceStates.set("codex_config", "conflict");
          codexDefaultsSnapshots.delete(id);
        } else if (replaced) {
          // Your files are back; the choice to keep them is not, like the backend.
          const units = fileUnits.get(replaced.surface) ?? [];
          fileUnits.set(replaced.surface, [...units, { ...replaced.unit, state: "conflict", files: replaced.unit.files.map(file => ({ ...file, state: "conflict", bundle_changed: false })) }]);
          if (replaced.surface === "skills") surfaceStates.set("skills", "conflict");
          takeBundledSnapshots.delete(id);
        } else if (snapshot) {
          for (const [surface, file, state] of snapshot) {
            rulesFiles.set(surface, file);
            surfaceStates.set(surface, state);
          }
          rulesSnapshots.delete(id);
        } else {
          for (const surface of ["claude_rules", "claude_agents", "skills"] as SetupSurfaceId[]) surfaceStates.set(surface, "update_available");
        }
        lastTransactionId = null;
      }
      const restored = ["~/.claude/CLAUDE.md", "~/.claude/agents/verifier.md"];
      // Like the backend: a dry run lists what would be restored under `applied`; a real run under `rolled_back`.
      return { success: true, transaction_id: id, applied: dryRun ? restored : [], failed: [], rolled_back: dryRun ? [] : restored, manual_steps: [], message: dryRun ? "Dry run: would restore 2 artifact(s); 0 already restored; 0 conflicted" : "restored 2 files" } satisfies SetupResult;
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
      await emitProgress("apply_uninstall", ["~/.claude/CLAUDE.md", "~/.codex/agents/verifier.toml", "~/.codex/agents/inspector.toml"]);
      for (const surface of ALL_SURFACES) surfaceStates.set(surface, "not_installed");
      lastTransactionId = "2026-10-06T09-00-00Z-u001";
      return { success: true, transaction_id: lastTransactionId, applied: ["~/.claude/CLAUDE.md", "~/.codex/agents"], failed: [], rolled_back: [], manual_steps: [], message: "uninstalled 2 · preserved 1 · merged 1" } satisfies SetupResult;
    case "list_backups":
      return backups;
    case "get_backup_details":
      return backupDetails(arg<string>(args, "runId"));
    case "get_codex_runtime_health":
      return codexHealth();
    case "get_opencode_runtime_health":
      return opencodeHealth();
    case "get_cursor_profile_health":
      return scenario === "error" ? unavailable() : cursorHealth();
    case "get_claude_runtime_health":
      return claudeHealth();
    case "get_light_runtime_health":
      await delay(150);
      return lightHealth(arg<LightAgent>(args, "harness"));
    case "get_security_posture":
      await delay(100);
      return scenario === "error" ? unavailable() : posture(arg<InstallAgent>(args, "harness"));
    case "list_skills":
      return skills;
    case "get_effective_skill_loads":
      await delay(120);
      return scenario === "error" ? unavailable() : effectiveSkillLoads();
    case "read_skill": {
      const id = arg<string>(args, "id");
      const skill = skills.find(s => s.id === id);
      if (!skill) throw new Error(`skill ${id} not found`);
      return { id, title: skill.name, path: skill.path, section: "workspace", source: "curated", content: skillContent(id) } satisfies DocumentContent;
    }
    case "list_docs":
      // Like the backend: bundled docs show their bundle-relative path and need no workspace; personal docs
      // show their path in the workspace folder and exist only while it is valid.
      return [...docStore.values()]
        .filter(doc => doc.source !== "custom" || workspaceIsValid())
        .map(({ id, title, path, section, source }) => ({ id, title, path: source === "custom" ? `${WORKSPACE}/${path}` : path, section, source })) satisfies DocSummary[];
    case "read_doc": {
      const id = arg<string>(args, "id");
      requireWorkspaceForPersonalDoc(id);
      const doc = docStore.get(id);
      if (!doc) throw new Error("doc not found");
      return doc;
    }
    case "save_doc": {
      const id = arg<string>(args, "id");
      // Like the backend: only personal docs are written.
      if (!id.startsWith("custom:")) throw new Error(`${id} is bundled with the app and read-only here`);
      requireWorkspaceForPersonalDoc(id);
      const doc = docStore.get(id);
      if (!doc) throw new Error("doc not found");
      docStore.set(doc.id, { ...doc, content: arg<string>(args, "content") });
      return actionResult("save_doc", true, "saved with backup");
    }
    case "create_doc": {
      const slug = arg<string>(args, "slug");
      const title = arg<string>(args, "title");
      requireWorkspaceForPersonalDoc(`custom:${slug}`);
      const doc: DocumentContent = { id: `custom:${slug}`, title, path: `docs/context/${slug}.md`, section: "Context", source: "custom", content: `# ${title}\n` };
      if (docStore.has(doc.id)) throw new Error(`doc already exists: ${doc.id}`);
      docStore.set(doc.id, doc);
      return doc;
    }
    case "list_agent_metadata":
      return agentMetadata();
    case "read_agent_source": {
      const agent = agentStore.get(arg<string>(args, "filename"));
      if (!agent) throw new Error("agent not found");
      return agent;
    }
    case "read_agent_template":
      return agentTemplate;
    case "list_rules_files":
      return RULES_SURFACES.filter(rulesSurfaceEnabled).map(rulesFileSummary) satisfies RulesFileSummary[];
    case "read_rules_file":
      return rulesFileContent(arg<RulesSurfaceId>(args, "surface"));
    case "save_rules_refinements":
      await delay(150);
      return saveRulesRefinements(arg<RulesSurfaceId>(args, "surface"), arg<string>(args, "content"), arg<string>(args, "expectedRevision"));
    case "read_config_template": {
      const targetId = arg<string>(args, "targetId");
      const target = TARGETS.find(t => t.id === targetId);
      return { id: `config-template:${targetId}`, title: `${targetId}.json`, path: target?.source_rel ?? targetId, section: "", source: "curated", content: configStore.get("base")!.content } satisfies DocumentContent;
    }
    case "list_opencode_config_editor_sources":
      return configSources;
    case "read_opencode_config_source": {
      const source = configStore.get(arg<string>(args, "sourceType"));
      if (!source) throw new Error("config source not found");
      return source;
    }
    case "read_opencode_model_selection":
      return modelSelection;
    case "list_available_opencode_models":
      return { models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-1", "openai/gpt-5"], warning: scenario === "error" ? "opencode models: provider list unavailable" : null } satisfies ListAvailableModelsResult;
    case "update_opencode_model_selection": {
      const subagent = validatedModelId(arg<string | null>(args, "subagentModel") ?? "", true);
      const critic = validatedModelId(arg<string | null>(args, "criticModel") ?? "", true);
      // Like the backend: a value equal to the bundled default is not an override.
      const model = validatedModelId(arg<string>(args, "model"));
      const small = validatedModelId(arg<string>(args, "smallModel"));
      modelSelection = {
        model,
        small_model: small,
        subagent_model: subagent,
        critic_model: critic,
        model_source: model === BUNDLED_MODEL_SELECTION.model ? "bundled default" : "override",
        small_model_source: small === BUNDLED_MODEL_SELECTION.small_model ? "bundled default" : "override",
        subagent_source: subagent ? "override" : "bundled default",
        critic_source: critic ? "override" : "bundled default",
      };
      if (opencodeModelDivergedKeys().length) surfaceStates.set("open_code_config", "update_available");
      return `Model selection saved. Run Install/Update to apply model=${modelSelection.model}.`;
    }
    case "reset_opencode_model_selection":
      modelSelection = BUNDLED_MODEL_SELECTION;
      if (opencodeModelDivergedKeys().length) surfaceStates.set("open_code_config", "update_available");
      return "Model override removed. Run Install/Update to apply the bundled defaults.";
    default:
      throw new Error(`mock backend: unhandled command "${cmd}"`);
  }
}

mockIPC((cmd, args) => handle(cmd, args as Args), { shouldMockEvents: true });

// Report as a Tauri host so the shell lays out exactly as in the app (traffic-light reserve).
(globalThis as { isTauri?: boolean }).isTauri = true;

console.info(`[mock backend] scenario=${scenario} appearance=${appearance}`);
