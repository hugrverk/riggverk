export interface DocumentContent {
  id: string; title: string; path: string; section: string; source: string; content: string;
}

export interface DocSummary {
  id: string; title: string; path: string; section: string; source: string;
}

export interface SkillSummary {
  id: string; name: string; description: string; path: string; group: string;
  category: string; risk: string; targets: string[]; related: string[];
  /** Set on a skill from a pack: its state and why it is not active. */
  packState?: PackSkillState; packReason?: string;
}

export interface AgentMetadataEntry {
  role: string;
  summary: string;
  targets: string[];
  risk: string;
  default_skills: string[];
  safe_to_edit_runtime: boolean;
  notes: string[];
}

export interface AgentMetadataResponse {
  id: string;
  title: string;
  path: string;
  exists: boolean;
  metadata: AgentMetadataEntry | null;
}

export interface AgentMetadataListResponse {
  agents: AgentMetadataResponse[];
  warnings: string[];
}

export interface AgentSourceContent {
  id: string; title: string; path: string; content: string; exists: boolean;
}

/** The harnesses with their own setup (rules, agents, config). On by default. */
export const CENTRAL_AGENTS = ["codex", "opencode", "claude", "cursor"] as const;

/** The light tier: skills reach and runtime health. Off by default. Mirrors `light-harnesses.json`. */
export const LIGHT_AGENTS = ["copilot", "pi", "kilo"] as const;

/** Every harness, in the backend's `HarnessId::ALL` order. */
export const INSTALL_AGENTS = [...CENTRAL_AGENTS, ...LIGHT_AGENTS] as const;

export type InstallAgent = (typeof INSTALL_AGENTS)[number];

export type LightAgent = (typeof LIGHT_AGENTS)[number];

export type InstallationState = "not_installed" | "update_available" | "current" | "conflict" | "unavailable";

export interface InstallationCounts {
  create_count: number; update_count: number; remove_count: number; conflict_count: number;
  /** Skill and agent files the user keeps: not conflicts, never written by an update. */
  kept_count?: number;
}

export interface SurfaceInstallationStatus {
  surface: SetupSurfaceId;
  label: string;
  state: InstallationState;
  detail: string;
  /** Block details; present for the rules surfaces only. */
  rules?: RulesStatus;
  /** Conflicting and kept files; present for the skills and agent surfaces while there are some. */
  files?: FilesStatus;
  /** The enforced config keys the user keeps or could keep; present for the Codex config surface while there are some. */
  codex_config?: CodexConfigStatus;
  /** The data folder; present for the workspace surface only. */
  data_folder?: DataFolderStatus;
}

/** One enforced Codex config key and a value of it (the kept value, or the installed one). Not secret. */
export interface CodexConfigKey {
  key: string;
  value: string;
}

/** The Codex config's enforced keys the user keeps ("keep mine") or could keep. */
export interface CodexConfigStatus {
  /** Kept: the installed value is the kept one, so the key is not drift and an update never writes it. */
  kept: CodexConfigKey[];
  /** Installed value differs from what Riggverk writes and is not kept: `m` keeps it. */
  differing: CodexConfigKey[];
  /** What Riggverk writes for each key in `kept` and `differing` (the bundled config's value). Absent from an older backend. */
  expected?: CodexConfigKey[];
}

/** One enforced Codex config key that "use Riggverk's defaults" sets to Riggverk's value. Not secret. */
export interface CodexConfigDefaultKey {
  key: string;
  /** The installed value that is replaced (cut when very long). */
  yours: string;
  /** The bundled config's value that is written. */
  riggverk: string;
}

/** What `preview_codex_config_defaults` returns: the keys, a key-only diff, and the proof `apply_codex_config_defaults` needs. */
export interface CodexConfigDefaultsPreview {
  keys: CodexConfigDefaultKey[];
  /** A removed and an added line per key; never other text of config.toml. */
  diff: string;
  plan_fingerprint: string;
  preview_token: string;
}

/** What the workspace row tells about the data folder. Counts and a flag, never file contents. */
export interface DataFolderStatus {
  /** Personal docs in `docs/context/`; the app never removes them. */
  personal_docs: number;
  /** Whether the ownership records (`.riggverk/managed-state.json`) exist yet. */
  ownership_records: boolean;
  /** Old copies of the bundle an update leaves in place: edited, or not provably the app's. */
  left_in_place: number;
}

/** The surfaces that hold skill or agent files the user can keep. */
export type FilesSurfaceId = "skills" | "claude_agents" | "codex_agents" | "open_code_agents" | "cursor_agents";

/** `conflict`: blocks the update. `kept`: the user keeps their version; updates never write it. */
export type FileUnitState = "conflict" | "kept";

/** `edited`: the app wrote it and it changed. `unproven`: nothing proves the app wrote it. */
export type FileConflictReason = "edited" | "unproven";

export interface FileUnitFile {
  /** Path below the skill directory, or the agent file name. */
  rel: string;
  state: FileUnitState;
  reason: FileConflictReason;
  bundle_changed: boolean;
}

/** What the user acts on: the conflicting or kept files of one skill in one folder, or one agent file. */
export interface FileUnit {
  /** Opaque: `skill:<folder>:<name>` or `agent:<name>`. */
  key: string;
  kind: "skill" | "agent";
  name: string;
  /** The folder as people know it, `~/.claude/skills`. */
  folder: string;
  /** The bundle wants this unit in this folder; false for a retired skill or a folder no harness needs any more. */
  wanted: boolean;
  /** `conflict` while any file still blocks, `kept` when the user keeps every one. */
  state: FileUnitState;
  reason: FileConflictReason;
  /** A kept unit: the bundled file changed since it was kept. */
  bundle_changed: boolean;
  /** The enabled harnesses that read the folder. */
  read_by: string[];
  files: FileUnitFile[];
  /** Files beyond the 50 listed. */
  more_files: number;
}

export interface FilesStatus {
  conflicts: number;
  kept: number;
  /** Kept files whose bundled version changed since they were kept. */
  kept_updates: number;
  units: FileUnit[];
  /** Units beyond the 100 listed. */
  more: number;
}

export type FileDiffKind = "text" | "identical_text" | "binary" | "too_large" | "withheld" | "unreadable" | "bundled_missing";

export interface FileDiffSide {
  bytes: number;
  /** `sha256:` and twelve hex digits. */
  digest: string;
}

export interface FileDiffEntry {
  rel: string;
  state: FileUnitState;
  kind: FileDiffKind;
  from_label: string;
  to_label: string;
  installed: FileDiffSide | null;
  bundled: FileDiffSide | null;
  note: string | null;
  added: number;
  removed: number;
  /** The diff text was cut (per file at 64 KB, per unit at 256 KB). */
  truncated: boolean;
  /** Unified diff; empty unless `kind` is `text`. */
  diff: string;
}

/** Your files of one unit against the bundled ones (`preview_file_diff`): what a replacement would change. */
export interface FileDiffView {
  name: string;
  folder: string;
  files: FileDiffEntry[];
  /** Files of the unit beyond the 25 shown. */
  more_files: number;
  truncated: boolean;
}

/** One file a take-bundled review replaces. Digests only: the file text travels in the diff. */
export interface TakeBundledFile {
  /** Path below the skill directory, or the agent file name. */
  rel: string;
  state: FileUnitState;
  /** Where your file is backed up, below the backup folder of the transaction (`artifacts/...`). */
  backup_name: string;
  /** `sha256:` and twelve hex digits of your file as it is now, and of the bundled file that replaces it. */
  installed_digest: string;
  bundled_digest: string;
}

export interface TakeBundledUnit {
  key: string;
  name: string;
  folder: string;
  files: TakeBundledFile[];
  /** Files beyond the ones listed; they are replaced too. */
  more_files: number;
  diff: FileDiffView;
  /** `pack:<name>` when the replacing files come from a skill pack; absent for the bundle. */
  source?: string;
}

/** What replacing the files of these units by the bundled ones would do (`preview_take_bundled`), and the proof to apply it. */
export interface TakeBundledPreview {
  surface: FilesSurfaceId;
  units: TakeBundledUnit[];
  plan_fingerprint: string;
  preview_token: string;
}

/** The surfaces that hold a rules file with the managed base block. */
export type RulesSurfaceId =
  | "claude_rules"
  | "codex_rules"
  | "open_code_rules"
  | "copilot_rules"
  | "pi_rules"
  | "kilo_rules";

/** `absent` (no file), `block` (managed markers), `legacy` (no markers) or `malformed` (markers cannot be split). */
export type RulesLayout = "absent" | "block" | "legacy" | "malformed";

/**
 * Why the app leaves a rules file alone. The last two are not about the file itself: another file in its folder
 * keeps the harness from reading it (`masked_by_override`), or the harness reads another file there and a new
 * one would hide it (`peer_context_file`).
 */
export type RulesConflictReason =
  | "base_block_edited"
  | "legacy_diverged"
  | "malformed_markers"
  | "masked_by_override"
  | "peer_context_file";

export type RulesMalformedReason =
  | "not_utf8"
  | "too_large"
  | "duplicate_begin"
  | "duplicate_end"
  | "missing_end"
  | "missing_begin"
  | "end_before_begin";

export interface RulesStatus {
  layout: RulesLayout;
  /** Non-blank user lines around the block; kept on every base update. */
  refinement_lines: number;
  /** The backend omits both reasons when they do not apply. */
  conflict_reason?: RulesConflictReason;
  malformed_reason?: RulesMalformedReason;
  /** The user chose to manage this file: it is reported as base updates available, never as a conflict. */
  user_managed: boolean;
}

/**
 * A rules file in the Library (`list_rules_files`): one per enabled rules surface, without its text. Only the
 * text below the managed block is editable there, and only when `editable`; `reason` says why not.
 */
export interface RulesFileSummary {
  surface: RulesSurfaceId;
  label: string;
  /** Where the file lives, as people know it (`~/.claude/CLAUDE.md`). */
  file: string;
  layout: RulesLayout;
  conflict: RulesConflictReason | null;
  malformed: RulesMalformedReason | null;
  refinement_lines: number;
  editable: boolean;
  reason: string | null;
}

/** One rules file opened in the Library (`read_rules_file`). Text has LF line endings. */
export interface RulesFileContent extends RulesFileSummary {
  /** The read-only text above the refinements: the user's text above BEGIN and the managed block. */
  before: string;
  /** The text below the END line: what the editor holds. */
  refinements: string;
  /** Digest of the user's text; a save is refused once the file no longer has it. */
  revision: string | null;
}

/** `update`: the installed file against the update. `edits`: the closest shipped base against the installed file. */
export type RulesDiffMode = "update" | "edits";

export interface RulesDiffView {
  surface: RulesSurfaceId;
  mode: RulesDiffMode;
  from_label: string;
  to_label: string;
  /** False when a regular update would refuse this file (the diff is informational) or there is nothing to compare. */
  applicable: boolean;
  note: string | null;
  compared_base: string | null;
  added: number;
  removed: number;
  /** The diff was cut at 64 KB. */
  truncated: boolean;
  /** Unified diff; empty when both sides are equal. */
  diff: string;
}

export type RulesConversionOrigin = "legacy_file" | "edited_block";

export interface RulesConversionPreview {
  surface: RulesSurfaceId;
  /** False when there is nothing to convert or the file cannot be converted. */
  applicable: boolean;
  reason: string | null;
  origin: RulesConversionOrigin | null;
  compared_base: string | null;
  compared_base_changed_lines: number | null;
  /** Sections kept below the END marker. */
  moved_sections: string[];
  /** Base sections the file lacked; they return with the new base. */
  removed_sections: string[];
  /** The complete file apply writes. */
  result: string;
  /** Unified diff of the installed file against `result`. */
  diff: string;
  diff_truncated: boolean;
  plan_fingerprint: string | null;
  preview_token: string | null;
}

export interface InstallationStatus {
  state: InstallationState;
  summary: string;
  counts: InstallationCounts;
  conflict_details?: string[];
  surfaces: SurfaceInstallationStatus[];
}

// Effective skill loads: which copies of a skill each enabled harness reads (`get_effective_skill_loads`).

/**
 * A skills folder a harness reads; `dot_codex` is the literal `~/.codex/skills`, whatever `CODEX_HOME` says.
 * `copilot`, `pi_agent` and `kilo` are the private folders of the light harnesses (`~/.copilot/skills`,
 * `~/.pi/agent/skills`, `~/.kilo/skills`); the app never installs into them.
 */
export type SkillReadFolder =
  | "claude"
  | "agents"
  | "codex_home"
  | "dot_codex"
  | "open_code"
  | "cursor"
  | "copilot"
  | "pi_agent"
  | "kilo";

export type SkillLoadFlag =
  | "plain_mention_ambiguous"
  | "winner_nondeterministic"
  | "duplicate_identical"
  | "possible_duplicate"
  | "shadowed_by_folder_order"
  | "foreign_copy";

export interface SkillCopy {
  folder: SkillReadFolder;
  /** The skill's folder, `~/.claude/skills/tdd`. */
  path: string;
  /** First hex digits of the file's SHA-256. */
  hash: string;
  /** `aw` is a version of a bundled skill the app wrote; anything else is the user's own. */
  owner: "aw" | "foreign";
  /** The file equals the bundled `SKILL.md`. */
  current: boolean;
  /** The copy is the user's own and they chose to keep it. */
  kept?: boolean;
}

export interface SkillLoad {
  name: string;
  copies: SkillCopy[];
  /** Index into `copies` of the copy loaded when there is only one candidate. */
  winner: number | null;
  flags: SkillLoadFlag[];
}

export interface SkillFolderInfo {
  folder: SkillReadFolder;
  path: string;
  exists: boolean;
  /** Why the folder was not read completely; absent otherwise. */
  note?: string;
}

export interface HarnessSkillLoads {
  harness: InstallAgent;
  folders: SkillFolderInfo[];
  skills: SkillLoad[];
}

export interface ForeignSkillDuplicate {
  name: string;
  harnesses: InstallAgent[];
  copies: SkillCopy[];
}

export interface EffectiveSkillLoads {
  harnesses: HarnessSkillLoads[];
  foreign_duplicates: ForeignSkillDuplicate[];
}

export interface AgentTargetMeta {
  id: string; label: string; harness: InstallAgent; kind: "rules" | "agents" | "config" | "mcp"; target_rel: string; source_rel: string;
}

export interface ConfigEditorSourceMeta {
  id: string;
  label: string;
  rel_path: string;
  helper: string;
}

export interface AppSettings {
  appearance: "dark" | "light" | "system";
  app_font_size: "small" | "medium" | "large" | "extra-large";
  workspace_path: string | null;
  enabled_target_ids: string[];
  enabled_harness_ids: InstallAgent[];
  accent_color: string | null;
  background_color: string | null;
  foreground_color: string | null;
  // The backend still writes the legacy `reduce_motion` flag beside it; it is derived from `motion` there.
  motion: "full" | "subtle" | "off";
  landing_view: string;
  revision?: number;
  // Marks which enabled-target defaults the file was written under. The backend always emits it and
  // re-stamps it on every save, so UI-built drafts may omit it.
  target_defaults_version?: number;
  // App version whose "what's new" was shown. Absent or null: a fresh install (or a file that predates it).
  last_seen_version?: string | null;
}

export interface GetSettingsResponse {
  settings: AppSettings;
  load_warning: string | null;
}

export interface BackupRunSummary {
  id: string;
  timestamp: string;
  path: string;
  targets: string[];
  file_count: number;
}

export interface BackupFileSummary {
  target_id: string;
  filename: string;
  backup_path: string;
  backup_size: number;
  current_path: string;
  current_exists: boolean;
  current_status: string;
}

export interface BackupRunDetails {
  id: string;
  timestamp: string;
  path: string;
  files: BackupFileSummary[];
}

export interface WorkspaceDiagnostics {
  candidate_path: string;
  resolved_path: string | null;
  valid: boolean;
  error: string | null;
  /** Folder moves from an earlier release that were not done, and earlier folders left next to the current ones. */
  layout_notes?: string[];
  enabled_rule_targets: number;
  total_rule_targets: number;
  enabled_config_targets: number;
  total_config_targets: number;
  backup_root: string;
  backup_root_exists: boolean;
}

export interface ActionResult {
  success: boolean;
  action: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}

export interface OpenCodeRuntimeCheck {
  id: string;
  label: string;
  status: string;
  detail: string;
}

export interface OpenCodeAgentMismatch {
  filename: string;
  status: string;
  detail: string;
}

/** The installed `opencode` CLI, from `opencode --version`. */
export interface OpenCodeCliHealth {
  /** `supported` (1.x), `unsupported` (another major), `unknown` (found, no readable version) or `missing`. */
  status: string;
  version: string | null;
  major: number | null;
  detail: string;
}

/** A global config file beside `opencode.json` that sets managed keys (or cannot be read): OpenCode merges it with `opencode.json`. */
export interface OpenCodeSiblingConfig {
  /** `config.json` or `opencode.jsonc`. */
  file: string;
  /** The managed keys it sets, by name. */
  managed_keys: string[];
  /** Not valid JSONC (or unreadable), so which keys it sets is unknown. */
  invalid: boolean;
}

/** What besides the installed `opencode.json` decides the config OpenCode runs. Names only, never values. */
export interface OpenCodeConfigPrecedence {
  /** What makes `opencode.json` JSONC instead of strict JSON: `comments`, `trailing commas`, `byte order mark`. */
  installed_not_strict: string[];
  sibling_files: OpenCodeSiblingConfig[];
  /** Config variables set in the app's environment (the one it was launched with). */
  env_vars: string[];
  /** System managed config paths that exist. */
  system_managed_paths: string[];
}

export interface OpenCodeRuntimeHealth {
  status: string;
  template_config_path: string;
  installed_config_path: string;
  checks: OpenCodeRuntimeCheck[];
  default_agent: string | null;
  model: string | null;
  small_model: string | null;
  /** The shared installed subagent model, excluding inspector while a critic override is set. */
  subagent_model: string | null;
  /** The installed inspector model; null when inspector inherits the main model. */
  critic_model: string | null;
  autoupdate: string | null;
  snapshot: boolean | null;
  bundled_agent_count: number;
  installed_bundled_agent_count: number;
  extra_installed_agent_count: number;
  agent_mismatches: OpenCodeAgentMismatch[];
  warnings: string[];
  /** Null until the CLI has been probed. */
  cli: OpenCodeCliHealth | null;
  /** `opencode.json` against the bundled render: synced, diverged, missing, invalid or unknown. */
  config_status: string;
  /** Managed keys that differ: top-level names, `mcp.<server>`, `agent.<name>` and `agent.<role>.model`. */
  config_diverged_keys: string[];
  /** Global `AGENTS.md` against the bundled rules: synced, diverged, missing or unknown. */
  rules_status: string;
  /** The `@playwright/mcp` version pinned in the installed config. */
  playwright_mcp_version: string | null;
  config_precedence: OpenCodeConfigPrecedence;
  // TUI config
  template_tui_path: string;
  installed_tui_path: string;
  tui_status: string;
  /** Managed `tui.json` keys that differ from the bundled config, by name; empty when it matches or cannot be compared. */
  tui_diverged_keys: string[];
  // Generated snapshot
  generated_snapshot_base_path: string;
  generated_snapshot_policy_path: string;
  generated_snapshot_path: string;
  generated_snapshot_status: string;
  generated_snapshot_detail: string;
  // Explainers
  summary: string;
  next_action: string;
}

export interface ListAvailableModelsResult {
  models: string[];
  warning: string | null;
}

/** Where a model value comes from: the app-level override file, or the template. */
export type OpenCodeModelSource = "override" | "bundled default";

export interface OpenCodeModelSelection {
  model: string;
  small_model: string;
  /** The model the subagent roles run on; empty while they inherit `model`. */
  subagent_model: string;
  /** The inspector override; empty while it follows the subagent model or inherits `model`. */
  critic_model: string;
  /** Each value has its own source: only a value the user changed is an override. */
  model_source: OpenCodeModelSource;
  small_model_source: OpenCodeModelSource;
  /** `override` while a subagent model is set, `bundled default` while the roles inherit `model`. */
  subagent_source: OpenCodeModelSource;
  /** `override` while a critic model is set, else `bundled default` (inherit). */
  critic_source: OpenCodeModelSource;
}

export interface CodexRuntimeCheck {
  id: string;
  label: string;
  status: string;
  detail: string;
}

export interface CodexAgentMismatch {
  filename: string;
  status: string;
  detail: string;
}

export interface CodexRuntimeHealth {
  status: string;
  rules_status: string;
  rules_source_path: string;
  rules_installed_path: string;
  skills_status: string;
  skills_synced_count: number;
  skills_expected_count: number;
  skills_missing_count: number;
  skills_diverged_count: number;
  legacy_skills_path: string;
  legacy_skills_migratable_count: number;
  legacy_skills_conflict_count: number;
  agents_status: string;
  bundled_agent_count: number;
  installed_bundled_agent_count: number;
  extra_installed_agent_count: number;
  agent_mismatches: CodexAgentMismatch[];
  config_status: string;
  /** Names of the enforced keys the user keeps; they count as matching while the installed value is the kept one. */
  config_kept?: string[];
  template_config_path: string;
  installed_config_path: string;
  approval_policy: string | null;
  sandbox_mode: string | null;
  checks: CodexRuntimeCheck[];
  warnings: string[];
  summary: string;
  next_action: string;
}

export interface CursorProfileHealth {
  status: "synced" | "diverged" | "missing" | "partial" | "unsafe" | "stale" | "unknown" | string;
  profile_root: string;
  profile_root_source: "default" | string;
  workspace_resources_status: "current" | "stale" | "missing" | "unreadable" | string;
  manifest_status: string;
  user_rules_status: "manual" | "template-missing" | "unknown" | string;
  global_agents_status: string;
  global_agents_count: number;
  expected_global_agents_count: number;
  global_skills_status: string;
  global_skills_count: number;
  expected_global_skills_count: number;
  mcp_status: string;
  legacy_permission_cleanup_status: string;
  warnings: string[];
  next_action: string;
}

export interface ClaudeRuntimeHealth {
  rules_synced: boolean;
  agents_synced: boolean;
  skills_synced: boolean;
  expected_agent_count: number;
  installed_agent_count: number;
  claude_cli_available: boolean;
  summary: string;
}

/** The CLI of a light harness, from `<cli> --version` only. */
export interface LightCliHealth {
  /** `found` (a version was read), `unknown` (found, no version in time) or `missing`. */
  status: "found" | "unknown" | "missing" | string;
  version: string | null;
  /** `path`, or `nvm` when only a Node version folder of nvm has the program. */
  source: "path" | "nvm" | string | null;
  detail: string;
}

export interface LightSkillsHealth {
  /** `synced`, `partial`, `missing`, `diverged`, `unserved` (no folder is installed for the harness) or `unknown`. */
  status: string;
  synced: number;
  expected: number;
  /** The installed folders the harness reads, as people know them (`~/.agents/skills`). */
  roots: string[];
}

export interface LightRulesHealth {
  /** `synced`, `stale` (a base update waits), `missing`, `diverged` (a conflict), `off` (target switched off) or `unknown`. */
  status: string;
  /** The rules file as people know it (`~/.pi/agent/AGENTS.md`). */
  path: string;
  /** Non-blank lines of the user's own around the block; kept on every update. */
  refinement_lines: number;
  user_managed: boolean;
  conflict_reason?: RulesConflictReason | null;
  /** The surface's status line: counts and reasons, never file text. */
  detail: string;
}

/** The managed Playwright entry in the MCP file of a light harness. */
export interface LightMcpHealth {
  /**
   * `synced`, `missing` (no file or no entry yet), `stale` (an update of the entry waits), `diverged` (an entry of the
   * user's own under the managed key), `invalid` (a file the app does not edit: comments, a trailing comma, ...),
   * `off` (target switched off) or `unknown`.
   */
  status: string;
  /** The MCP file as people know it (`~/.copilot/mcp-config.json`). */
  path: string;
  /** The Playwright version the installed entry pins, when it names one. */
  playwright_version: string | null;
  /** The status line: counts and fixed phrases, never file text. */
  detail: string;
}

/** Runtime health of Copilot, Pi and Kilo (`get_light_runtime_health`). */
export interface LightRuntimeHealth {
  harness: LightAgent;
  /** The skills status; once the skills are fine, the rules status, then the MCP status (each unless its target is off). */
  status: string;
  cli: LightCliHealth;
  rules: LightRulesHealth;
  mcp: LightMcpHealth;
  skills: LightSkillsHealth;
  warnings: string[];
  next_action: string;
}

/** How a posture finding is shown. `enforced` means set in the config file read, never "safe". */
export type PostureLevel = "risky" | "enforced" | "advice" | "not_covered";

/** What happened to one config file the posture check looks at. */
export type SourceState = "read" | "missing" | "unreadable" | "not_checked";

/** Every finding the backend can report (`security_posture.rs`); the phrase of each is in `securityPostureRows.ts`. */
export type FindingCode =
  | "claude_bypass_disabled"
  | "claude_bypass_default"
  | "claude_bypass_available"
  | "claude_sandbox_on"
  | "claude_sandbox_off"
  | "claude_env_read_denied"
  | "claude_env_read_open"
  | "claude_config_dir_set"
  | "codex_no_sandbox"
  | "codex_sandbox_workspace"
  | "codex_sandbox_read_only"
  | "codex_sandbox_unset"
  | "codex_approvals_never"
  | "codex_approvals_on_request"
  | "codex_network_on"
  | "codex_trusted_projects"
  | "opencode_allow_all"
  | "opencode_bash_allow"
  | "opencode_deny_rules"
  | "opencode_deny_rules_missing"
  | "cursor_sandbox_off"
  | "cursor_network_open"
  | "cursor_run_mode"
  | "kilo_allow_all"
  | "kilo_bash_allow"
  | "kilo_no_rules"
  | "copilot_not_covered"
  | "pi_not_covered"
  | "config_only";

export interface PostureFinding {
  code: FindingCode;
  level: PostureLevel;
  /** The config file the finding comes from, where it matters (OpenCode, Kilo). */
  file: string | null;
  count: number | null;
}

export interface PostureSource {
  /** The config file as people know it (`~/.claude/settings.json`). */
  file: string;
  state: SourceState;
}

/** Read-only security posture of one harness (`get_security_posture`): codes, levels and counts, never file text. */
export interface SecurityPosture {
  harness: InstallAgent;
  sources: PostureSource[];
  findings: PostureFinding[];
}

// Unified managed installation types.

/**
 * `skills` is one surface for every harness: it installs the skills into the folders the enabled
 * harnesses read. The per-harness skill surfaces of older versions (`claude_skills`,
 * `open_code_skills`, `codex_skills`, `cursor_skills`) are gone from the app; the backend still
 * parses them in old transaction manifests and records.
 */
export type SetupSurfaceId =
  | "open_code_config"
  | "open_code_agents"
  | "open_code_rules"
  | "codex_config"
  | "codex_agents"
  | "codex_rules"
  | "claude_rules"
  | "claude_agents"
  | "claude_config"
  | "skills"
  | "cursor_agents"
  | "cursor_mcp"
  | "copilot_rules"
  | "pi_rules"
  | "kilo_rules"
  | "copilot_mcp"
  | "pi_mcp"
  | "kilo_mcp"
  | "workspace_bundle";

export type OperationKind =
  | "no_change"
  | "create"
  | "update"
  | "remove"
  | "conflict"
  | "manual"
  | "unavailable";

export interface PlannedOperation {
  surface: SetupSurfaceId;
  kind: OperationKind;
  summary: string;
  // The backend omits these keys when empty (serde skip_serializing_if), so they are `undefined` on the wire.
  details?: string[];
  conflict_description?: string | null;
  manual_step?: string | null;
}

export interface SetupPlan {
  operations: PlannedOperation[];
  synced: SetupSurfaceId[];
  conflicts: PlannedOperation[];
  manual_steps: PlannedOperation[];
  summary: string;
  has_pending_changes: boolean;
  is_blocked: boolean;
  // Omitted by the backend when nothing is pending.
  plan_fingerprint?: string | null;
  preview_token?: string | null;
}

export interface UninstallItem {
  label: string;
  path: string;
}

export interface UninstallPlanView {
  removable: UninstallItem[];
  preserved: UninstallItem[];
  merged: UninstallItem[];
  summary: string;
  plan_fingerprint: string | null;
  preview_token: string | null;
}

/**
 * What the backend reports while an apply, uninstall, rollback or rules conversion runs (the `apply-progress` event).
 * `done` counts finished items and `file` is the one in progress (`~/...`), null between items. `total` is null
 * only when the backend cannot tell. "done" ends the stream, whether the task succeeded or not; the outcome is
 * the task's own result.
 */
export interface ApplyProgress {
  /** The backend command (`apply_setup`, `apply_uninstall`, `apply_rules_conversion`, `apply_take_bundled`, `apply_codex_config_defaults`, `rollback_setup_transaction`). */
  task: string;
  phase: "backup" | "apply" | "done";
  done: number;
  total: number | null;
  file: string | null;
}

export interface SetupResult {
  success: boolean;
  transaction_id: string;
  applied: string[];
  failed: string[];
  rolled_back: string[];
  manual_steps: string[];
  message: string;
}

/** A pack skill: `active` is in the catalog, `shadowed` loses to a bundled skill of its name, `error` is invalid or ambiguous, `missing` is installed while its pack cannot be read. */
export type PackSkillState = "active" | "shadowed" | "error" | "missing";

export interface PackSkillEntry {
  id: string; name: string; description: string; pack: string;
  state: PackSkillState; reason: string; path: string;
}

export interface PackEntry {
  name: string;
  /** `ok`, `refused`, or `missing` (skills of it are installed, its folder is gone). */
  state: "ok" | "refused" | "missing";
  reason: string;
  /** "Forget pack" applies: its installed skills are held and it provides none. */
  forgettable: boolean;
}

export interface PackLibrary {
  /** Why `pack-skills.json` cannot be used; set, installed pack skills are kept as they are. */
  record_problem?: string | null;
  folder: string;
  packs: PackEntry[];
  skills: PackSkillEntry[];
  ignored: { name: string; reason: string }[];
}

/** Persisted plan facts. A null history receipt means these facts were not recorded. */
export interface SetupReceipt {
  synced: SetupSurfaceId[];
  left_for_you: { surface: SetupSurfaceId; reason: "conflict" | "manual" }[];
}

/** Read-only transaction history for the active workspace (`list_setup_history`). */
export interface SetupHistoryEntry {
  transaction_id: string;
  /** Unix nanoseconds as decimal strings. Older manifests have no finish time. */
  created_at: string;
  finished_at: string | null;
  status: "applied" | "rolled_back" | "failed";
  surfaces: SetupSurfaceId[];
  /** Harness-specific surfaces; shared skills remain one surface. */
  harnesses: InstallAgent[];
  changes: {
    surface: SetupSurfaceId;
    kind: "create" | "update" | "remove";
    /** Existing `~/...` display label, or a short label outside the home folder. */
    path: string;
    applied: boolean;
    restored: boolean;
  }[];
  operation_counts: { create: number; update: number; remove: number };
  backup_files: number;
  is_newest_completed: boolean;
  /** Offer only; always dry-run and confirm before calling rollback. */
  undoable: boolean;
  receipt: SetupReceipt | null;
}

/** A bundled skill copied into the personal pack, ready for the next Update. */
export interface PackSkillCopy {
  id: string;
  name: string;
  pack: string;
  /** Display path of SKILL.md (`~/...`, or `<data>/...` outside home). */
  path: string;
}
