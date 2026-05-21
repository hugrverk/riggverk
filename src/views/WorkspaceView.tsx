import { useState, useMemo } from "react";
import { TerminalState, type ActionResult } from "../components/TerminalOutput";
import type { AppSettings, CreateWorkspacePlan, CreateWorkspaceResult, CursorProfileHealth, DefaultWorkspaceSummary, DesignMdCatalogStatus, DesignMdContent, DesignMdEntry, DesignMdInstallPlan, DesignMdInstallResult, DesignMdInstallStatus, DesignMdSyncResult, InstallAgent, OpenCodeRuntimeHealth, SkillSummary, StatusData, WorkspaceContractResult, WorkspaceDiagnostics } from "../types";
import { designMdDisplayTitle, designMdSearchText } from "../lib/designMdDisplay";
import { INSTALL_AGENTS } from "../types";

interface WorkspaceViewProps {
  appSettings: AppSettings | null;
  onSetWorkspacePath: (value: string | null) => void;
  onApplyWorkspacePath: (value: string | null) => void;
  onChooseWorkspaceFolder: () => void;
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  onRefreshDiagnostics: () => void;
  defaultWorkspaceSummary: DefaultWorkspaceSummary | null;
  createPlan: CreateWorkspacePlan | null;
  createPlanRunning: boolean;
  onPlanCreate: () => void;
  createResult: CreateWorkspaceResult | null;
  createRunning: boolean;
  onCreateWorkspace: () => void;
  // operations
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  wsRunning: string | null;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  ruleTargetsEnabled: boolean;
  configEnabled: boolean;
  canRunReleaseCheck: boolean;
  onPull: () => void;
  onDiffRules: () => void;
  onSyncRules: () => void;
  onDiffConfigs: () => void;
  onSyncConfigs: () => void;
  onReleaseCheck: () => void;
  onRefreshStatus: () => void;
  // opencode runtime
  opencodeRuntimeHealth: OpenCodeRuntimeHealth | null;
  onRefreshOpenCodeRuntimeHealth: () => void;
  onGenerateOpenCodeConfig: () => void;
  // workspace repair
  onPlanWorkspaceRepair: () => void;
  onApplyWorkspaceRepair: () => void;
  // cursor profile
  cursorProfileHealth: CursorProfileHealth | null;
  cursorProjectTarget: string;
  onSetCursorProjectTarget: (value: string) => void;
  onRefreshCursorProfile: () => void;
  onCursorDiffGlobal: () => void;
  onCursorSyncGlobal: () => void;
  onCursorShowUserRules: () => void;
  onCursorCopyUserRules: () => void;
  onCursorOpenSettings: () => void;
  onCursorDiffProject: () => void;
  onCursorSyncProject: () => void;
  onCursorValidateProfile: () => void;
  // skills compact
  skills: SkillSummary[];
  skillsLoaded: boolean;
  selectedSkills: Set<string>;
  skillSearch: string;
  installAgents: string[];
  installScope: string;
  installTarget: string;
  skillsCanInstall: boolean;
  onDryRunSkills: () => void;
  onInstallSkills: () => void;
  onToggleSkill: (name: string) => void;
  onSelectAllSkills: () => void;
  onClearSelectionSkills: () => void;
  onToggleInstallAgent: (agent: InstallAgent) => void;
  onSetInstallScope: (scope: "global" | "project") => void;
  onSetInstallTarget: (value: string) => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
  // backups
  backupCount: number;
  onRefreshBackups: () => void;
  onOpenBackupsFolder: () => void;
  // contract
  contractResult: WorkspaceContractResult | null;
  onRefreshContract: () => void;
  // Design MD
  designMdCatalogStatus: DesignMdCatalogStatus | null;
  designMdEntries: DesignMdEntry[];
  activeDesignMdSlug: string | null;
  activeDesignMdContent: DesignMdContent | null;
  designMdSearch: string;
  onSetDesignMdSearch: (value: string) => void;
  designMdSyncResult: DesignMdSyncResult | null;
  onSyncDesignMdCatalog: () => void;
  onSelectDesignMdEntry: (slug: string) => void;
  designMdInstallTarget: string;
  designMdInstallPlan: DesignMdInstallPlan | null;
  designMdInstallResult: DesignMdInstallResult | null;
  designMdInstallStatus: DesignMdInstallStatus | null;
  onChooseDesignMdInstallTarget: () => void;
  onPlanDesignMdInstall: () => void;
  onInstallDesignMd: () => void;
  onOpenDesignMdTargetFolder: () => void;
  onOpenInstalledDesignMd: () => void;
}

// Shared helpers for standardized panels
function SectionChip({ label, tone }: { label: string; tone: "ok" | "warn" | "fail" | "muted" }) {
  return <span className={`ws-section-chip ws-section-chip-${tone}`}>{label}</span>;
}

function runtimeChipTone(status: string): "ok" | "warn" | "fail" | "muted" {
  switch (status) {
    case "synced": return "ok";
    case "diverged": return "warn";
    case "partial": return "warn";
    case "missing": return "fail";
    case "invalid": return "fail";
    default: return "muted";
  }
}

function runtimeChipLabel(status: string): string {
  switch (status) {
    case "synced": return "Synced";
    case "diverged": return "Diverged";
    case "partial": return "Partial";
    case "missing": return "Missing";
    case "invalid": return "Invalid";
    default: return "Unknown";
  }
}

export function WorkspaceView({
  appSettings,
  onApplyWorkspacePath,
  onChooseWorkspaceFolder,
  workspaceDiagnostics,
  onRefreshDiagnostics,
  createPlan,
  createPlanRunning,
  onPlanCreate,
  createResult,
  createRunning,
  onCreateWorkspace,
  // operations
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  activityIndex,
  activityCellClass,
  status,
  workspaceValid,
  gitAvailable,
  ruleTargetsEnabled,
  configEnabled,
  canRunReleaseCheck,
  onPull,
  onDiffRules,
  onSyncRules,
  onDiffConfigs,
  onSyncConfigs,
  onReleaseCheck,
  onRefreshStatus,
  // opencode runtime
  opencodeRuntimeHealth,
  onRefreshOpenCodeRuntimeHealth,
  onGenerateOpenCodeConfig,
  onPlanWorkspaceRepair,
  onApplyWorkspaceRepair,
  cursorProfileHealth,
  cursorProjectTarget,
  onSetCursorProjectTarget,
  onRefreshCursorProfile,
  onCursorDiffGlobal,
  onCursorSyncGlobal,
  onCursorShowUserRules,
  onCursorCopyUserRules,
  onCursorOpenSettings,
  onCursorDiffProject,
  onCursorSyncProject,
  onCursorValidateProfile,
  // skills
  skills,
  skillsLoaded,
  selectedSkills,
  skillSearch,
  installAgents,
  installScope,
  installTarget,
  skillsCanInstall,
  onDryRunSkills,
  onInstallSkills,
  onToggleSkill,
  onSelectAllSkills,
  onClearSelectionSkills,
  onToggleInstallAgent,
  onSetInstallScope,
  onSetInstallTarget,
  onSetSkillSearch,
  onOpenInstallScript,
  // backups
  backupCount,
  onRefreshBackups,
  onOpenBackupsFolder,
  // Design MD
    designMdCatalogStatus,
    designMdEntries,
    activeDesignMdSlug,
    activeDesignMdContent: _activeDesignMdContent,
    designMdSearch,
    onSetDesignMdSearch,
    designMdSyncResult: _designMdSyncResult,
    onSyncDesignMdCatalog,
    onSelectDesignMdEntry,
    designMdInstallTarget,
    designMdInstallPlan,
    designMdInstallResult,
    designMdInstallStatus,
    onChooseDesignMdInstallTarget,
    onPlanDesignMdInstall,
    onInstallDesignMd,
    onOpenDesignMdTargetFolder,
    onOpenInstalledDesignMd,
  }: WorkspaceViewProps) {
  const [showSkillSelector, setShowSkillSelector] = useState(false);
  const [showDesignPicker, setShowDesignPicker] = useState(false);

  const skillsCount = skills.length;
  const selectedSkillsCount = selectedSkills.size;

  const filteredSkills = useMemo(() => {
    if (!skillSearch.trim()) return skills;
    const q = skillSearch.toLowerCase().trim();
    return skills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    );
  }, [skills, skillSearch]);

  const diag = workspaceDiagnostics;
  const missingMarkers = diag?.markers.filter(m => !m.exists) ?? [];
  const defaultLabel = "~/Agent Workspace";
  const displayPath = appSettings?.workspace_path ?? defaultLabel;
  const diagnosticsPath = diag?.resolved_path ?? diag?.candidate_path ?? "\u2014";

  const createPlanEligible = createPlan && (createPlan.status === "missing_directory" || createPlan.status === "empty_existing_directory");

  const statusText = !diag
    ? "loading"
    : diag.valid
      ? "valid"
      : "setup needed";

  const statusClass = !diag
    ? "ws-status-dim"
    : diag.valid
      ? "ws-status-valid"
      : "ws-status-invalid";

  const terminalStatusText = wsRunning
    ? "running"
    : wsLog
      ? "completed"
      : "ready";

  return (
    <section className="ws-layout">
      <div className="ws-shell">
        {/* ---- Left column: controls ---- */}
        <div className="ws-left" role="region" aria-label="Workspace controls">
          {/* ---- Workspace panel ---- */}
          <div className="ws-panel">
            <div className="ws-panel-header">
              <div className="ws-panel-title-row">
                <span className="ws-panel-title">WORKSPACE</span>
                <span className={`ws-status-chip ${statusClass}`}>{statusText}</span>
              </div>
              <span className="ws-path-value" title={displayPath}>{displayPath}</span>
            </div>
            {diag && diagnosticsPath !== displayPath && diagnosticsPath !== "\u2014" && (
              <div className="ws-path-resolved" title={`resolved: ${diagnosticsPath}`}>
                {diagnosticsPath}
              </div>
            )}
            <div className="ws-action-row">
              <button className="btn btn-sm" onClick={() => { onRefreshDiagnostics(); onRefreshStatus(); onRefreshOpenCodeRuntimeHealth(); onRefreshCursorProfile(); }}>
                refresh
              </button>
              {diag && !diag.valid ? (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={onPlanCreate}
                  disabled={createPlanRunning}
                >
                  {createPlanRunning ? "planning\u2026" : "dry-run create"}
                </button>
              ) : null}
              <button className="btn btn-sm" onClick={onChooseWorkspaceFolder}>
                choose folder
              </button>
              <button className="btn btn-sm" onClick={() => onApplyWorkspacePath(null)}>
                use default
              </button>
            </div>
            {/* Git action + context row */}
            <div className="ws-panel-meta-row">
              <button className="btn btn-sm btn-primary" disabled={!workspaceValid || !gitAvailable || wsRunning !== null} onClick={onPull}>
                pull
              </button>
              {status && (
                <span className="ws-panel-meta-context">
                  branch {status.branch} | {status.enabled_rule_target_ids.length} rule targets | {status.enabled_config_target_ids.length} config targets
                </span>
              )}
            </div>
            <div className="ws-path-trust-note">
              Trust boundary: sync/install/release actions run scripts from the selected workspace. Use workspaces you control.
            </div>
          </div>

          {/* ---- Workspace Setup (visible when invalid) ---- */}
          {diag && !diag.valid && (
            <div className="ws-setup" role="region" aria-label="Workspace setup">
              <div className="ws-setup-heading">Workspace Setup</div>
              <div className="ws-setup-body">
                <div className="ws-setup-path">
                  <span className="ws-setup-label">candidate path:</span>
                  <span className="ws-setup-value">{displayPath}</span>
                </div>
                {diag.error && (
                  <div className="ws-setup-error">diagnostics: {diag.error}</div>
                )}
                {missingMarkers.length > 0 && (
                  <div className="ws-setup-error">
                    {missingMarkers.length} required marker(s) missing
                  </div>
                )}

                <div className="ws-setup-actions">
                  {!createPlan && !createResult && (
                    <div className="ws-setup-action-row">
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={onPlanCreate}
                        disabled={createPlanRunning}
                      >
                        {createPlanRunning ? "planning\u2026" : "dry-run create"}
                      </button>
                      <span className="ws-setup-hint">
                        evaluate if the path is safe for workspace initialization
                      </span>
                    </div>
                  )}

                  {createPlan && (
                    <div className="ws-setup-plan">
                      <div className={`ws-cmd-row ${createPlan.ok ? "ws-color-ok" : "ws-color-fail"}`}>
                        <span className="ws-cmd-prompt">{createPlan.ok ? "safe" : "blocked"}</span>
                        <span>{createPlan.status}</span>
                      </div>
                      <div className="ws-cmd-row ws-color-dim">
                        target: {createPlan.target_path || "(empty)"}
                      </div>
                      <div className="ws-cmd-row">{createPlan.reason}</div>
                      {createPlan.warnings.length > 0 && (
                        <div className="ws-cmd-warnings">
                          {createPlan.warnings.map((w, i) => (
                            <div key={i} className="ws-cmd-row ws-color-fail">{w}</div>
                          ))}
                        </div>
                      )}
                      {createPlan.planned_files.length > 0 && (
                        <div className="ws-cmd-row ws-color-dim">
                          {createPlan.planned_files.length} files planned
                        </div>
                      )}

                      {createPlanEligible && (
                        <div className="ws-setup-create-action">
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={onCreateWorkspace}
                            disabled={createRunning}
                          >
                            {createRunning ? "creating\u2026" : "create workspace"}
                          </button>
                          <span className="ws-tag">{createPlan.planned_files.length} files</span>
                          <span className="ws-tag">no overwrite</span>
                          <span className="ws-tag">no scripts</span>
                        </div>
                      )}
                    </div>
                  )}

                  {createResult && (
                    <div className="ws-setup-result">
                      <div className={`ws-cmd-row ${createResult.success ? "ws-color-ok" : "ws-color-fail"}`}>
                        <span className="ws-cmd-prompt">{createResult.success ? "ok" : "fail"}</span>
                        <span>{createResult.message}</span>
                      </div>
                      <div className="ws-cmd-row ws-color-dim">
                        status: {createResult.status} | target: {createResult.target_path}
                      </div>
                      {createResult.copied_files.length > 0 && (
                        <div className="ws-cmd-row ws-color-dim">
                          copied {createResult.copied_files.length} file(s)
                        </div>
                      )}
                      {createResult.warnings.length > 0 && (
                        <div className="ws-cmd-warnings">
                          {createResult.warnings.map((w, i) => (
                            <div key={i} className="ws-cmd-row ws-color-fail">{w}</div>
                          ))}
                        </div>
                      )}
                      {createResult.success && (
                        <div className="ws-setup-hint-row">
                          <div className="ws-setup-hint">
                            Next: open <strong>Library &gt; Start Here</strong>
                          </div>
                          <div className="ws-setup-hint ws-setup-hint-dim">
                            Optional: initialize Git in the workspace (see GIT_VERSIONING.md)
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ---- First Run Guide (visible when no valid workspace) ---- */}
          {!workspaceValid && (
            <div className="ws-guide" role="region" aria-label="First run guide">
              <div className="ws-guide-heading">First Run</div>
              <div className="ws-guide-body">
                <p className="ws-guide-intro">
                  Agent Workspace manages agent rules, skills, and configs.
                  It <strong>never</strong> writes files automatically — all writes are explicit.
                </p>
                <ol className="ws-guide-steps">
                  <li><span className="ws-guide-step-label">Choose or use default workspace path</span>
                    <span className="ws-guide-step-hint">— the app needs a workspace folder to operate</span>
                  </li>
                  <li><span className="ws-guide-step-label">Dry-run create</span>
                    <span className="ws-guide-step-hint">— preview what would happen before writing files</span>
                  </li>
                  <li><span className="ws-guide-step-label">Create workspace</span>
                    <span className="ws-guide-step-hint">— copies starter files only (no scripts execute)</span>
                  </li>
                  <li><span className="ws-guide-step-label">Open Library tab</span>
                    <span className="ws-guide-step-hint">— browse the Start Here guide, Concepts, and reference docs</span>
                  </li>
                  <li><span className="ws-guide-step-label">Run dry-run sync before apply</span>
                    <span className="ws-guide-step-hint">— preview rule/config changes before writing to your tools</span>
                  </li>
                </ol>
                <div className="ws-guide-footer">
                  <div className="ws-guide-hint">
                    Tip: The workspace is plain text. Version it with Git (see <em>GIT_VERSIONING.md</em>).
                    Never store secrets or tokens in workspace files.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ---- Rules section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Rules sync">
              <div className="ws-section-header">
                <span className="ws-section-title">RULES</span>
                {diag && (() => {
                  const e = diag.enabled_rule_targets;
                  const t = diag.total_rule_targets;
                  const tone: "ok" | "warn" | "fail" | "muted" = t === 0 ? "muted" : e === t ? "ok" : e > 0 ? "warn" : "fail";
                  return <SectionChip label={`${e}/${t} enabled`} tone={tone} />;
                })()}
              </div>
              <div className="ws-section-actions">
                <button className="btn btn-sm" disabled={!workspaceValid || !ruleTargetsEnabled || wsRunning !== null} onClick={onDiffRules}>diff</button>
                <button className="btn btn-sm btn-primary" disabled={!workspaceValid || !ruleTargetsEnabled || wsRunning !== null} onClick={onSyncRules}>sync</button>
              </div>
            </div>
          )}

          {/* ---- OpenCode Runtime section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="OpenCode Runtime health">
              <div className="ws-section-header">
                <span className="ws-section-title">OPENCODE RUNTIME</span>
                {opencodeRuntimeHealth ? (
                  <SectionChip label={runtimeChipLabel(opencodeRuntimeHealth.status)} tone={runtimeChipTone(opencodeRuntimeHealth.status)} />
                ) : (
                  <span className="ws-section-chip ws-section-chip-muted">loading</span>
                )}
              </div>

              {opencodeRuntimeHealth && (
                <>
                  {/* Summary line */}
                  <div className="ws-runtime-summary" aria-live="polite">
                    {opencodeRuntimeHealth.summary}
                  </div>

                  {/* Runtime detail rows */}
                  <div className="ws-runtime-rows">
                    {/* Config row */}
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Config</span>
                      <span className={`ws-dot ${opencodeRuntimeHealth.checks.find(c => c.id === "configs_match")?.status === "pass" ? "ws-color-ok" : opencodeRuntimeHealth.checks.find(c => c.id === "configs_match")?.status === "warn" ? "ws-color-warn" : "ws-color-dim"}`}>
                        {"\u25CF"}
                      </span>
                      <span className="ws-runtime-row-value">
                        {runtimeChipLabel(opencodeRuntimeHealth.status).toLowerCase()}
                      </span>
                    </div>

                    {/* TUI row */}
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">TUI</span>
                      <span className={`ws-dot ${opencodeRuntimeHealth.tui_status === "synced" ? "ws-color-ok" : opencodeRuntimeHealth.tui_status === "diverged" ? "ws-color-warn" : opencodeRuntimeHealth.tui_status === "missing" ? "ws-color-fail" : "ws-color-dim"}`}>
                        {"\u25CF"}
                      </span>
                      <span className="ws-runtime-row-value">
                        {runtimeChipLabel(opencodeRuntimeHealth.tui_status).toLowerCase()}
                      </span>
                    </div>

                    {/* Agents row */}
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Agents</span>
                      <span className={`ws-dot ${opencodeRuntimeHealth.agent_mismatches.length === 0 ? "ws-color-ok" : "ws-color-warn"}`}>
                        {"\u25CF"}
                      </span>
                      <span className="ws-runtime-row-value">
                        {opencodeRuntimeHealth.installed_bundled_agent_count}/{opencodeRuntimeHealth.bundled_agent_count} bundled
                        {opencodeRuntimeHealth.agent_mismatches.length > 0
                          ? ` (${opencodeRuntimeHealth.agent_mismatches.length} diverged)`
                          : ""}
                        {opencodeRuntimeHealth.extra_installed_agent_count > 0
                          ? ` (+${opencodeRuntimeHealth.extra_installed_agent_count} extra)`
                          : ""}
                      </span>
                    </div>

                    {/* Generated snapshot row */}
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Generated</span>
                      <span className={`ws-dot ${
                        opencodeRuntimeHealth.generated_snapshot_status === "current" ? "ws-color-ok"
                        : opencodeRuntimeHealth.generated_snapshot_status === "valid" ? "ws-color-ok"
                        : opencodeRuntimeHealth.generated_snapshot_status === "stale" ? "ws-color-fail"
                        : opencodeRuntimeHealth.generated_snapshot_status === "missing" ? "ws-color-fail"
                        : "ws-color-dim"
                      }`}>
                        {"\u25CF"}
                      </span>
                      <span className="ws-runtime-row-value">
                        {opencodeRuntimeHealth.generated_snapshot_status}
                        {opencodeRuntimeHealth.generated_snapshot_status === "stale" && (
                          <span className="ws-runtime-row-detail"> — Regenerate before sync</span>
                        )}
                      </span>
                    </div>
                  </div>

                  {/* Stale generated snapshot warning */}
                  {opencodeRuntimeHealth.generated_snapshot_status === "stale" && (
                    <div className="ws-runtime-next-action ws-runtime-next-action-fail">
                      {opencodeRuntimeHealth.generated_snapshot_detail || "Regenerate opencode.json before sync"}
                    </div>
                  )}

                  {/* Warnings for agent mismatches */}
                  {opencodeRuntimeHealth.agent_mismatches.length > 0 && (
                    <div className="ws-runtime-next-action ws-runtime-next-action-warn">
                      {opencodeRuntimeHealth.agent_mismatches.length} agent(s) diverged or missing.
                    </div>
                  )}

                  {/* Warnings for extra agents */}
                  {opencodeRuntimeHealth.warnings.length > 0 && opencodeRuntimeHealth.agent_mismatches.length === 0 && (
                    <div className="ws-runtime-next-action ws-runtime-next-action-warn">
                      {opencodeRuntimeHealth.warnings[0]}
                      {opencodeRuntimeHealth.warnings.length > 1 && (
                        <> (+{opencodeRuntimeHealth.warnings.length - 1} more)</>
                      )}
                    </div>
                  )}

                  {/* Next action */}
                  <div className={`ws-runtime-next-action ws-runtime-next-action-${opencodeRuntimeHealth.status === "synced" ? "ok" : opencodeRuntimeHealth.status === "diverged" ? "warn" : opencodeRuntimeHealth.status === "missing" ? "fail" : "ok"}`}>
                    {opencodeRuntimeHealth.next_action}
                  </div>

                  <div className="ws-section-actions">
                    <button className="btn btn-sm" onClick={onRefreshOpenCodeRuntimeHealth} aria-label="Refresh OpenCode runtime health">
                      refresh
                    </button>
                    <button className="btn btn-sm" disabled={!workspaceValid || !configEnabled || wsRunning !== null} onClick={onDiffConfigs}>
                      diff
                    </button>
                    <button
                      className={`btn btn-sm ${opencodeRuntimeHealth.generated_snapshot_status === "stale" ? "btn-warn" : ""}`}
                      disabled={!workspaceValid || wsRunning !== null}
                      onClick={onGenerateOpenCodeConfig}
                      title="Generate opencode.json from Base and Policy."
                    >
                      generate
                    </button>
                    <button className="btn btn-sm btn-primary" disabled={!workspaceValid || !configEnabled || wsRunning !== null || opencodeRuntimeHealth.generated_snapshot_status === "stale"} onClick={onSyncConfigs} title={opencodeRuntimeHealth.generated_snapshot_status === "stale" ? "Regenerate opencode.json snapshot before sync" : undefined}>
                      sync
                    </button>
                  </div>

                  {/* Workspace repair affordance */}
                  {(opencodeRuntimeHealth.generated_snapshot_status === "valid" || opencodeRuntimeHealth.generated_snapshot_status === "missing" || opencodeRuntimeHealth.warnings.some(w => w.includes("Repair"))) && (
                    <div className="ws-section-box" style={{marginTop:"8px",padding:"8px",border:"1px solid var(--color-border)",borderRadius:"6px"}}>
                      <div style={{fontSize:"12px",fontWeight:600,marginBottom:"4px"}}>Workspace Repair</div>
                      <div style={{fontSize:"11px",color:"var(--color-dim)",marginBottom:"6px"}}>
                        Missing bundled scripts or templates can be repaired.
                      </div>
                      <div style={{display:"flex",gap:"6px"}}>
                        <button className="btn btn-sm" disabled={wsRunning !== null} onClick={onPlanWorkspaceRepair}>
                          check
                        </button>
                        <button className="btn btn-sm btn-primary" disabled={wsRunning !== null} onClick={onApplyWorkspaceRepair}>
                          repair
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ---- Cursor Profile section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Cursor Profile health">
              <div className="ws-section-header">
                <span className="ws-section-title">CURSOR PROFILE</span>
                {cursorProfileHealth ? (
                  <SectionChip label={runtimeChipLabel(cursorProfileHealth.status)} tone={runtimeChipTone(cursorProfileHealth.status)} />
                ) : (
                  <span className="ws-section-chip ws-section-chip-muted">loading</span>
                )}
              </div>

              {cursorProfileHealth && (
                <>
                  <div className="ws-runtime-summary" aria-live="polite">
                    manifest {cursorProfileHealth.manifest_status} | user rules {cursorProfileHealth.user_rules_status}
                  </div>

                  <div className="ws-runtime-rows">
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Global agents</span>
                      <span className={`ws-dot ${cursorProfileHealth.global_agents_status === "synced" ? "ws-color-ok" : cursorProfileHealth.global_agents_status === "missing" ? "ws-color-fail" : "ws-color-warn"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">
                        {cursorProfileHealth.global_agents_count}/{cursorProfileHealth.expected_global_agents_count} {cursorProfileHealth.global_agents_status}
                      </span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Project</span>
                      <span className={`ws-dot ${cursorProfileHealth.project_agents_status === "synced" && cursorProfileHealth.project_rules_status === "synced" ? "ws-color-ok" : cursorProfileHealth.project_agents_status === "unknown" ? "ws-color-dim" : "ws-color-warn"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">
                        agents {cursorProfileHealth.project_agents_status} | rules {cursorProfileHealth.project_rules_status} | skills {cursorProfileHealth.project_skills_status}
                      </span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">MCP</span>
                      <span className={`ws-dot ${cursorProfileHealth.mcp_status.includes("unsafe") || cursorProfileHealth.mcp_status.includes("invalid") ? "ws-color-fail" : cursorProfileHealth.mcp_status.includes("present") ? "ws-color-warn" : "ws-color-dim"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">{cursorProfileHealth.mcp_status}</span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Sandbox</span>
                      <span className={`ws-dot ${cursorProfileHealth.sandbox_status.includes("unsafe") || cursorProfileHealth.sandbox_status.includes("invalid") ? "ws-color-fail" : cursorProfileHealth.sandbox_status === "templates" ? "ws-color-ok" : "ws-color-warn"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">
                        {cursorProfileHealth.sandbox_profiles_count} templates | {cursorProfileHealth.sandbox_status}
                      </span>
                    </div>
                  </div>

                  {cursorProfileHealth.warnings.length > 0 && (
                    <div className="ws-runtime-next-action ws-runtime-next-action-warn">
                      {cursorProfileHealth.warnings[0]}
                      {cursorProfileHealth.warnings.length > 1 && <> (+{cursorProfileHealth.warnings.length - 1} more)</>}
                    </div>
                  )}

                  <div className={`ws-runtime-next-action ws-runtime-next-action-${cursorProfileHealth.status === "synced" ? "ok" : cursorProfileHealth.status === "missing" ? "fail" : "warn"}`}>
                    {cursorProfileHealth.next_action}
                  </div>

                  <div className="ws-card-project-target">
                    <input
                      className="install-target-input"
                      type="text"
                      placeholder="/path/to/project"
                      value={cursorProjectTarget}
                      onChange={e => onSetCursorProjectTarget(e.target.value)}
                      aria-label="Cursor project target path"
                    />
                  </div>

                  <div className="ws-section-actions">
                    <button className="btn btn-sm" onClick={onRefreshCursorProfile} disabled={wsRunning !== null}>refresh</button>
                    <button className="btn btn-sm" onClick={onCursorDiffGlobal} disabled={wsRunning !== null}>diff global</button>
                    <button className="btn btn-sm btn-primary" onClick={onCursorSyncGlobal} disabled={wsRunning !== null}>sync global</button>
                    <button className="btn btn-sm" onClick={onCursorShowUserRules} disabled={wsRunning !== null}>show rules</button>
                    <button className="btn btn-sm" onClick={onCursorCopyUserRules} disabled={wsRunning !== null}>copy rules</button>
                    <button className="btn btn-sm" onClick={onCursorOpenSettings} disabled={wsRunning !== null}>open settings</button>
                    <button className="btn btn-sm" onClick={onCursorDiffProject} disabled={wsRunning !== null || !cursorProjectTarget.trim()}>dry-run project</button>
                    <button className="btn btn-sm btn-primary" onClick={onCursorSyncProject} disabled={wsRunning !== null || !cursorProjectTarget.trim()}>sync project</button>
                    <button className="btn btn-sm" onClick={onCursorValidateProfile} disabled={wsRunning !== null}>validate</button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---- Skills section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Skills install">
              <div className="ws-section-header">
                <span className="ws-section-title">SKILLS</span>
                {skillsCount > 0 && (() => {
                  const tone: "ok" | "warn" | "fail" | "muted" = selectedSkillsCount === skillsCount ? "ok" : selectedSkillsCount > 0 ? "warn" : "muted";
                  return <SectionChip label={`${selectedSkillsCount}/${skillsCount} selected`} tone={tone} />;
                })()}
              </div>
              <div className="ws-section-actions">
                <button className="btn btn-sm" disabled={!workspaceValid || !skillsCanInstall || wsRunning !== null} onClick={onDryRunSkills}>dry run</button>
                <button className="btn btn-sm btn-primary" disabled={!workspaceValid || !skillsCanInstall || wsRunning !== null} onClick={onInstallSkills}>install</button>
                {skillsLoaded && skillsCount > 0 && (
                  <button
                    className="btn btn-sm"
                    onClick={() => setShowSkillSelector(prev => !prev)}
                    aria-expanded={showSkillSelector}
                  >
                    {showSkillSelector ? "hide selector" : "select skills"}
                  </button>
                )}
                <button className="btn btn-sm" onClick={onOpenInstallScript}>open script</button>
              </div>
              <div className="ws-card-targets">
                <span className="ws-card-targets-label">target</span>
                <div className="ws-card-target-buttons">
                  {INSTALL_AGENTS.map(a => (
                    <button
                      key={a}
                      className={`btn btn-sm ${installAgents.includes(a) ? "btn-active" : ""}`}
                      onClick={() => onToggleInstallAgent(a)}
                      aria-pressed={installAgents.includes(a)}
                    >{a}</button>
                  ))}
                  <span className="ws-card-target-sep">|</span>
                  {(["global", "project"] as const).map(s => (
                    <button
                      key={s}
                      className={`btn btn-sm ${installScope === s ? "btn-active" : ""}`}
                      onClick={() => onSetInstallScope(s)}
                      aria-pressed={installScope === s}
                    >{s}</button>
                  ))}
                </div>
              </div>
              {installScope === "project" && (
                <div className="ws-card-project-target">
                  <input
                    className="install-target-input"
                    type="text"
                    placeholder="/path/to/project"
                    value={installTarget}
                    onChange={e => onSetInstallTarget(e.target.value)}
                    aria-label="Project install target path"
                  />
                </div>
              )}
              {workspaceValid && !skillsLoaded && !wsRunning && (
                <div className="ws-card-warn">Loading skills...</div>
              )}
              {workspaceValid && skillsLoaded && !skillsCanInstall && !wsRunning && (
                <div className="ws-card-warn">
                  {skills.length === 0
                    ? "No skills found in workspace."
                    : selectedSkillsCount === 0
                      ? "No skills selected."
                      : installAgents.length === 0
                        ? "No agents selected."
                        : installScope === "project" && !installTarget.trim()
                          ? "Project scope needs a target path."
                          : null}
                </div>
              )}

              {/* Expandable skills selector */}
              {showSkillSelector && (
                <div className="ws-skill-selector" role="region" aria-label="Skill selection">
                  <div className="ws-skill-selector-controls">
                    <input
                      className="skills-search"
                      type="text"
                      placeholder="search skills..."
                      value={skillSearch}
                      onChange={e => onSetSkillSearch(e.target.value)}
                      aria-label="Search workspace skills"
                    />
                    {skillSearch && (
                      <button className="btn btn-sm btn-clear-search" onClick={() => onSetSkillSearch("")} aria-label="Clear workspace skills search">clear</button>
                    )}
                    <button className="btn btn-sm" onClick={onSelectAllSkills}>all</button>
                    <button className="btn btn-sm" onClick={onClearSelectionSkills}>clear</button>
                  </div>
                  <div className="ws-skill-selector-list">
                    {filteredSkills.length === 0 ? (
                      <div className="ws-skill-selector-empty">
                        {skillSearch ? "No matching skills" : "No skills found"}
                      </div>
                    ) : (
                      filteredSkills.map(s => {
                        const isSelected = selectedSkills.has(s.name);
                        return (
                          <div key={s.id} className={`ws-skill-selector-row ${isSelected ? "ws-skill-selector-row-on" : ""}`}>
                            <button
                              className={`skills-row-check-button ${isSelected ? "skills-row-check-button-on" : ""}`}
                              onClick={() => onToggleSkill(s.name)}
                              aria-pressed={isSelected}
                              aria-label={`${isSelected ? "Deselect" : "Select"} skill ${s.name}`}
                            >
                              {isSelected ? "x" : ""}
                            </button>
                            <span className="ws-skill-selector-name">{s.name}</span>
                            <span className="ws-skill-selector-desc">{s.description}</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---- Design MD section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Design MD install">
              <div className="ws-section-header">
                <span className="ws-section-title">DESIGN MD</span>
                {designMdCatalogStatus?.exists ? (
                  <span className="ws-section-chip ws-section-chip-ok">
                    {designMdCatalogStatus.entry_count} entries
                  </span>
                ) : (
                  <span className="ws-section-chip ws-section-chip-muted">not synced</span>
                )}
              </div>

              {/* Catalog status and sync */}
              {!designMdCatalogStatus?.exists ? (
                <div className="ws-section-actions">
                  <button className="btn btn-sm btn-primary" onClick={onSyncDesignMdCatalog} disabled={wsRunning !== null}>
                    {wsRunning === "sync design-md" ? "syncing..." : "sync catalog"}
                  </button>
                </div>
              ) : (
                <>
                  {/* Selected design */}
                  <div className="design-md-ws-row">
                    <span className="design-md-ws-label">Design</span>
                    <span className="design-md-ws-value design-md-ws-path">
                      {activeDesignMdSlug ? activeDesignMdSlug : "none selected"}
                    </span>
                    <button className="btn btn-sm" onClick={() => setShowDesignPicker(prev => !prev)}>
                      {showDesignPicker ? "hide" : "select design"}
                    </button>
                  </div>

                  {/* Design picker */}
                  {showDesignPicker && (
                    <div className="design-md-ws-picker">
                      <div className="design-md-ws-picker-search">
                        <input
                          className="skills-search"
                          type="text"
                          placeholder="search entries..."
                          value={designMdSearch}
                          onChange={(e) => onSetDesignMdSearch(e.target.value)}
                          aria-label="Search Design MD entries"
                        />
                        {designMdSearch && (
                          <button className="btn btn-sm btn-clear-search" onClick={() => onSetDesignMdSearch("")} aria-label="Clear search">clear</button>
                        )}
                      </div>
                      <div className="design-md-ws-picker-list">
                        {designMdEntries.length === 0 ? (
                          <div className="ws-card-warn">No entries found</div>
                        ) : (() => {
                          const q = designMdSearch.toLowerCase().trim();
                          const filtered = q
                            ? designMdEntries.filter(e => designMdSearchText(e).includes(q))
                            : designMdEntries;
                          if (filtered.length === 0) {
                            return <div className="ws-card-warn">No matches</div>;
                          }
                          return filtered.map(e => (
                            <button
                              key={e.slug}
                              className={`design-md-ws-entry ${activeDesignMdSlug === e.slug ? "design-md-ws-entry-active" : ""}`}
                              onClick={() => { onSelectDesignMdEntry(e.slug); }}
                              aria-current={activeDesignMdSlug === e.slug ? "true" : undefined}
                            >
                              <span className="design-md-ws-entry-title">{designMdDisplayTitle(e.slug)}</span>
                              <span className="design-md-ws-entry-desc">{e.description || e.slug}</span>
                            </button>
                          ));
                        })()}
                      </div>
                    </div>
                  )}

                  {/* Target project */}
                  <div className="design-md-ws-row">
                    <span className="design-md-ws-label">Project</span>
                    <span className={`design-md-ws-value design-md-ws-path ${!designMdInstallTarget ? "design-md-ws-path-empty" : ""}`} title={designMdInstallTarget || undefined}>
                      {designMdInstallTarget || "not selected"}
                    </span>
                    <button className="btn btn-sm" onClick={onChooseDesignMdInstallTarget} aria-label="Choose project folder">choose</button>
                    {designMdInstallTarget && (
                      <button className="btn btn-sm" onClick={onOpenDesignMdTargetFolder} disabled={wsRunning !== null} title="Open project folder" aria-label="Open project folder">open</button>
                    )}
                  </div>

                  {/* Install status */}
                  {designMdInstallStatus && (
                    <div className="design-md-ws-row">
                      <span className="design-md-ws-label">Status</span>
                      <span className={`design-md-ws-status design-md-ws-status-${designMdInstallStatus.status}`}>
                        {designMdInstallStatus.status === "no_target" ? "no project"
                         : designMdInstallStatus.status === "missing" ? "not installed"
                         : designMdInstallStatus.status === "installed" ? "installed"
                         : designMdInstallStatus.status === "different" ? "different"
                         : designMdInstallStatus.status === "blocked" ? "blocked"
                         : designMdInstallStatus.status}
                      </span>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="ws-section-actions">
                    <button className="btn btn-sm" onClick={onSyncDesignMdCatalog} disabled={wsRunning !== null} title="Re-sync catalog">
                      sync
                    </button>
                    <button className="btn btn-sm" onClick={onPlanDesignMdInstall} disabled={!activeDesignMdSlug || !designMdInstallTarget || wsRunning !== null}>
                      dry run
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={onInstallDesignMd} disabled={!(designMdInstallPlan?.ok) || wsRunning !== null}>
                      {wsRunning === "install design.md" ? "installing..." : "install"}
                    </button>
                    {designMdInstallStatus?.exists && (
                      <button className="btn btn-sm" onClick={onOpenInstalledDesignMd} disabled={wsRunning !== null} title="Open installed DESIGN.md" aria-label="Open installed DESIGN.md">
                        open
                      </button>
                    )}
                  </div>

                  {/* Plan summary */}
                  {designMdInstallPlan && (
                    <div className={`design-md-ws-plan ${designMdInstallPlan.ok ? "design-md-ws-plan-ok" : "design-md-ws-plan-blocked"}`}>
                      <span className={`design-md-ws-plan-action design-md-ws-plan-action-${designMdInstallPlan.action}`}>
                        {designMdInstallPlan.action === "create" ? "create"
                         : designMdInstallPlan.action === "replace_with_backup" ? "backup + replace"
                         : "blocked"}
                      </span>
                      <span className="design-md-ws-plan-path">{designMdInstallPlan.target_file}</span>
                      {designMdInstallPlan.backup_path && (
                        <span className="design-md-ws-plan-backup">backup: {designMdInstallPlan.backup_path}</span>
                      )}
                    </div>
                  )}

                  {/* Install result */}
                  {designMdInstallResult && (
                    <div className={`design-md-ws-result ${designMdInstallResult.success ? "design-md-ws-result-ok" : "design-md-ws-result-fail"}`}>
                      <span>{designMdInstallResult.message}</span>
                      {designMdInstallResult.backup_path && (
                        <span className="design-md-ws-result-backup">backup: {designMdInstallResult.backup_path}</span>
                      )}
                    </div>
                  )}

                  {/* Hints */}
                  {!designMdInstallPlan && designMdInstallTarget && activeDesignMdSlug && (
                    <div className="design-md-ws-hint">dry run required</div>
                  )}
                  {!designMdInstallTarget && (
                    <div className="design-md-ws-hint">choose a project and run dry run</div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ---- Verify section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Verification and backups">
              <div className="ws-section-header">
                <span className="ws-section-title">VERIFY</span>
              </div>
              <div className="ws-section-actions">
                <button className="btn btn-sm btn-primary" disabled={!canRunReleaseCheck || wsRunning !== null} onClick={onReleaseCheck}>release-check</button>
                <button className="btn btn-sm" disabled={wsRunning !== null} onClick={onRefreshBackups}>refresh</button>
                <button className="btn btn-sm" disabled={wsRunning !== null} onClick={onOpenBackupsFolder}>open folder</button>
              </div>
              <div className="ws-section-context">
                {backupCount > 0 ? <span>{backupCount} backup runs</span> : <span>no backups</span>}
              </div>
            </div>
          )}


        </div>

        {/* ---- Right column: terminal ---- */}
        <div className="ws-right" role="region" aria-label="Terminal output">
          <div className="ws-terminal-panel">
            <div className="ws-terminal-header">
              <span className="ws-terminal-title">Terminal</span>
              <span className="ws-terminal-status">
                {wsRunning ? (
                  <>{terminalStatusText}: {wsRunning}</>
                ) : wsLog ? (
                  <>{terminalStatusText} &middot; {wsLog.action}: {wsLog.success ? "OK" : "FAILED"}</>
                ) : (
                  <>{terminalStatusText} &middot; {statusText}</>
                )}
              </span>
            </div>
            <div className="ws-terminal-body">
              <TerminalState
                runningLabel={wsRunning}
                result={wsLog}
                completedAt={wsLogCompletedAt ?? undefined}
                readyLabel="operations ready"
                activityIndex={activityIndex}
                activityCellClass={activityCellClass}
                idleContent={
                  <div className="log-empty">
                    <div><span className="log-prompt">$</span> operations ready</div>
                    {status ? (
                      <div className="ws-idle-context">
                        <span>workspace: {workspaceValid ? "valid" : "invalid"}</span>
                        {gitAvailable && <span>branch: {status.branch}</span>}
                        <span>targets: {status.enabled_rule_target_ids.length} rules, {status.enabled_config_target_ids.length} configs</span>
                        <span className="ws-idle-hint">
                          {canRunReleaseCheck
                            ? "try: pull, diff rules, sync configs, release-check"
                            : "try: pull, diff rules, sync configs"}
                        </span>
                      </div>
                    ) : (
                      <div className="ws-idle-context">
                        <span>waiting for workspace status...</span>
                      </div>
                    )}
                  </div>
                }
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
