export interface StatusData {
  repo_path: string; git_available: boolean; branch: string; dirty: boolean; latest_commit: string;
  rules_codex: string; rules_opencode: string; rules_auggie: string;
  rules_claude: string;
  opencode_config: string;
  opencode_agents: string;
  claude_agents: string;
  auggie_agents: string;
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
  id: string; name: string; description: string; path: string;
  category: string; risk: string; targets: string[]; related: string[];
}

export interface AgentSourceSummary {
  id: string; title: string; path: string; exists: boolean;
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

export const INSTALL_AGENTS = ["codex", "opencode", "claude", "auggie", "cursor"] as const;

export type InstallAgent = (typeof INSTALL_AGENTS)[number];

export interface InstallSkillsRequest {
  agents: string[]; skills: string[]; dry_run: boolean;
}

export interface AgentTargetMeta {
  id: string; label: string; kind: "rules" | "agents" | "config"; target_rel: string; source_rel: string;
}

export interface ConfigEditorSourceMeta {
  id: string;
  label: string;
  rel_path: string;
  editable: boolean;
  helper: string;
}

export interface TargetProfileMeta {
  id: string;
  label: string;
  description: string;
  target_ids: string[];
}

export interface AppSettings {
  appearance: "dark" | "light" | "system";
  app_font_size: "small" | "medium" | "large";
  workspace_path: string | null;
  enabled_target_ids: string[];
  accent_color: string | null;
  background_color: string | null;
  foreground_color: string | null;
  repo_dashboard_entries?: RepoDashboardEntry[];
  active_repo_dashboard_id?: string | null;
}

export interface RepoDashboardEntry {
  id: string;
  label: string;
  path: string;
  default_branch?: string | null;
}

/** Safe git-derived metadata for Prompt Loops (no local paths or raw remotes). */
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

export interface RepoDashboardWorkItem {
  source: "docs" | "issue";
  path: string;
  line?: number;
  text: string;
  type: RepoDashboardWorkType;
  status: RepoDashboardWorkStatus;
  needsPlan: boolean;
  url?: string;
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
  content: string;
  error?: string | null;
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
  changed_files: RepoChangedFile[];
  docs: RepoDocFile[];
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

export interface DefaultWorkspaceFile {
  path: string;
  exists: boolean;
}

export interface DefaultWorkspaceCategory {
  label: string;
  count: number;
  files: DefaultWorkspaceFile[];
}

export interface DefaultWorkspaceSummary {
  root_label: string;
  description: string;
  categories: DefaultWorkspaceCategory[];
}

export interface CreateWorkspacePlan {
  ok: boolean;
  status: string;
  target_path: string;
  reason: string;
  warnings: string[];
  planned_files: string[];
}

export interface WorkspaceSetupEvaluation {
  candidate_path: string;
  setup_phase: string;
  plan: CreateWorkspacePlan;
  missing_files_to_add: string[];
}

export interface InitializeWorkspaceResult {
  success: boolean;
  status: string;
  target_path: string;
  message: string;
  copied_files: string[];
  warnings: string[];
}

export interface CreateWorkspaceResult {
  success: boolean;
  status: string;
  target_path: string;
  created_dirs: string[];
  copied_files: string[];
  skipped_files: string[];
  warnings: string[];
  message: string;
}

export interface ActionResult {
  success: boolean;
  action: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}

export interface ContractCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface WorkspaceContractResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
  checks: ContractCheck[];
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
  qwen_context: number | null;
  qwen_output: number | null;
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

export interface RepairWorkspaceResult {
  ok: boolean;
  dry_run: boolean;
  target_path: string;
  copied_files: string[];
  refreshed_files: string[];
  skipped_files: string[];
  errors: string[];
  warnings: string[];
  message: string;
}

export interface BrainSetupSeedResult {
  status: string;
  source: string;
  content: string;
}

export interface CursorProfileHealth {
  status: "synced" | "diverged" | "missing" | "partial" | "unsafe" | "stale" | "unknown" | string;
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
  permissions_status: string;
  shell_posture_status: string;
  legacy_sandbox_status: string;
  warnings: string[];
  next_action: string;
}
