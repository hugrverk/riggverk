export interface StatusData {
  repo_path: string; git_available: boolean; branch: string; dirty: boolean; latest_commit: string;
  rules_codex: string; rules_opencode: string;
  rules_claude: string;
  opencode_config: string;
  opencode_agents: string;
  claude_agents: string;
  config_statuses: Record<string, string>;
  agents_statuses: Record<string, string>;
  host_name: string;
  enabled_rule_target_ids: string[];
  enabled_config_target_ids: string[];
  enabled_agent_target_ids: string[];
  enabled_target_ids: string[];
}

export interface DocumentContent {
  id: string; title: string; path: string; section: string; source: string; content: string;
}

export interface DocSummary {
  id: string; title: string; path: string; section: string; source: string;
}

export interface DocsHealth {
  missing_count: number;
  missing_prompt_template_docs: boolean;
  missing_sample: string[];
}

export interface SkillSummary {
  id: string; name: string; description: string; path: string; group: string;
  category: string; risk: string; targets: string[]; related: string[];
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

export const INSTALL_AGENTS = ["codex", "opencode", "claude", "cursor"] as const;

export type InstallAgent = (typeof INSTALL_AGENTS)[number];

export type InstallationState = "not_installed" | "update_available" | "current" | "conflict" | "unavailable";

export interface InstallationCounts {
  create_count: number; update_count: number; remove_count: number; conflict_count: number;
}

export interface SurfaceInstallationStatus {
  surface: SetupSurfaceId;
  label: string;
  state: InstallationState;
  detail: string;
  /** Block details; present for the rules surfaces only. */
  rules?: RulesStatus;
}

/** The surfaces that hold a rules file with the managed base block. */
export type RulesSurfaceId = "claude_rules" | "codex_rules" | "open_code_rules";

/** `absent` (no file), `block` (managed markers), `legacy` (no markers) or `malformed` (markers cannot be split). */
export type RulesLayout = "absent" | "block" | "legacy" | "malformed";

/** Why the app leaves a rules file alone. */
export type RulesConflictReason = "base_block_edited" | "legacy_diverged" | "malformed_markers";

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

export interface AgentTargetMeta {
  id: string; label: string; harness: InstallAgent; kind: "rules" | "agents" | "config"; target_rel: string; source_rel: string;
}

export interface ConfigEditorSourceMeta {
  id: string;
  label: string;
  rel_path: string;
  editable: boolean;
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
  reduce_motion: boolean;
  landing_view: string;
  repo_dashboard_entries?: RepoDashboardEntry[];
  active_repo_dashboard_id?: string | null;
  revision?: number;
  // Marks which enabled-target defaults the file was written under. The backend always emits it and
  // re-stamps it on every save, so UI-built drafts may omit it.
  target_defaults_version?: number;
}

export interface GetSettingsResponse {
  settings: AppSettings;
  load_warning: string | null;
}

export interface RepoDashboardEntry {
  id: string;
  label: string;
  path: string;
  default_branch?: string | null;
}

/** Local git checkout found by bounded Repo Dashboard discovery (not persisted until import). */
export interface DiscoveredLocalGitRepo {
  label: string;
  path: string;
  default_branch?: string | null;
  repo_slug?: string | null;
  warnings?: string[];
}

export interface DiscoverLocalGitReposResult {
  repos: DiscoveredLocalGitRepo[];
  warnings?: string[];
}

/** Safe git-derived metadata for Prompt Builder (no local paths or raw remotes). */
export interface RepoPromptContext {
  repo_slug: string | null;
  current_branch: string | null;
  default_branch: string | null;
  is_repo: boolean;
  warnings: string[];
}

export type RepoDashboardWorkType =
  | "roadmap"
  | "feature"
  | "gap"
  | "todo"
  | "fix"
  | "note";

export type RepoDashboardWorkStatus = "open" | "started" | "done";

export type RepoDashboardWorkConfidence = "high" | "medium" | "low";

export type RepoDashboardWorkClassification = "bug" | "verify" | "enhancement" | "other";

export type RepoDashboardCanonicalSource = "backlog" | "audit" | "github";

export interface RepoDashboardWorkItem {
  source: "docs" | "issue";
  path: string;
  line?: number;
  text: string;
  type: RepoDashboardWorkType;
  status: RepoDashboardWorkStatus;
  needsPlan: boolean;
  url?: string;
  section?: string;
  confidence?: RepoDashboardWorkConfidence;
  /** Canonical queue identifier from documentation tables */
  workId?: string;
  classification?: RepoDashboardWorkClassification;
  priority?: string;
  area?: string;
  nextAction?: string;
  verification?: string;
  ownerFiles?: string;
  docRole?: string;
  canonicalSource?: RepoDashboardCanonicalSource;
}

export interface RepoCommitEntry {
  sha: string;
  short_sha: string;
  author_name: string;
  author_email: string;
  authored_at: number;
  subject: string;
  is_merge: boolean;
}

export interface RepoChangedFile {
  path: string;
  status: string;
}

export interface RepoDocFile {
  path: string;
  found: boolean;
  readable: boolean;
  truncated: boolean;
  content: string;
  read_error?: string | null;
}

export interface RepoGhPullRequest {
  number: number;
  title: string;
  merged_at: string;
  author: string;
  body?: string | null;
}

export interface RepoGhIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
}

export interface RepoGhEnhancement {
  available: boolean;
  authenticated: boolean;
  message?: string | null;
  merged_prs: RepoGhPullRequest[];
  open_issues: RepoGhIssue[];
}

export type RepoDocsSource = "remote" | "cached-remote" | "local-fallback";

export interface RepoDashboardSnapshot {
  repo_path: string;
  git_available: boolean;
  is_repo: boolean;
  branch: string;
  default_branch: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  latest_commit: RepoCommitEntry | null;
  commits: RepoCommitEntry[];
  commits_truncated: boolean;
  changed_files: RepoChangedFile[];
  docs: RepoDocFile[];
  docs_source: RepoDocsSource;
  docs_ref: string;
  docs_stale: boolean;
  gh: RepoGhEnhancement;
  warnings: string[];
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

export interface WorkspaceMarkerStatus {
  kind: "file" | "dir";
  path: string;
  exists: boolean;
}

export type BundledResourcesStatus = "current" | "missing";

export interface WorkspaceDiagnostics {
  candidate_path: string;
  resolved_path: string | null;
  valid: boolean;
  error: string | null;
  markers: WorkspaceMarkerStatus[];
  enabled_rule_targets: number;
  total_rule_targets: number;
  enabled_config_targets: number;
  total_config_targets: number;
  backup_root: string;
  backup_root_exists: boolean;
  release_check_available: boolean;
  bundled_resources_status: BundledResourcesStatus;
  missing_bundled_count: number;
  missing_bundled_sample: string[];
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

export interface OpenCodeRuntimeHealth {
  status: string;
  template_config_path: string;
  installed_config_path: string;
  checks: OpenCodeRuntimeCheck[];
  default_agent: string | null;
  model: string | null;
  small_model: string | null;
  autoupdate: string | null;
  snapshot: boolean | null;
  bundled_agent_count: number;
  installed_bundled_agent_count: number;
  extra_installed_agent_count: number;
  agent_mismatches: OpenCodeAgentMismatch[];
  warnings: string[];
  // TUI config
  template_tui_path: string;
  installed_tui_path: string;
  tui_status: string;
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

export interface OpenCodeModelSelection {
  model: string;
  small_model: string;
}

export interface BrainSetupSeedResult {
  status: string;
  source: string;
  content: string;
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

// Unified managed installation types.

export type SetupSurfaceId =
  | "open_code_config"
  | "open_code_agents"
  | "open_code_rules"
  | "codex_config"
  | "codex_agents"
  | "codex_rules"
  | "claude_rules"
  | "claude_agents"
  | "claude_skills"
  | "open_code_skills"
  | "codex_skills"
  | "cursor_agents"
  | "cursor_skills"
  | "cursor_mcp"
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

export interface SetupResult {
  success: boolean;
  transaction_id: string;
  applied: string[];
  failed: string[];
  rolled_back: string[];
  manual_steps: string[];
  message: string;
}
