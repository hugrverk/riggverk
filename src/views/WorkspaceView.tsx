import { useState, useMemo } from "react";
import { TerminalState, type ActionResult } from "../components/TerminalOutput";
import type { AppSettings, CreateWorkspacePlan, CreateWorkspaceResult, DefaultWorkspaceSummary, DesignMdCatalogStatus, DesignMdContent, DesignMdEntry, DesignMdInstallPlan, DesignMdInstallResult, DesignMdInstallStatus, DesignMdSyncResult, InstallAgent, OpenCodeRuntimeHealth, SkillSummary, StatusData, WorkspaceContractResult, WorkspaceDiagnostics } from "../types";
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

const findCat = (summary: DefaultWorkspaceSummary | null, label: string) =>
  summary?.categories.find(c => c.label === label);

function skillDisplayName(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  const skillsIdx = parts.indexOf("skills");
  if (skillsIdx !== -1 && skillsIdx + 1 < parts.length) {
    return parts[skillsIdx + 1];
  }
  return parts[parts.length - 2] ?? parts[parts.length - 1] ?? filePath;
}

function mapNodeClass(condition: "valid" | "invalid" | "partial" | "dim"): string {
  switch (condition) {
    case "valid": return "ws-node ws-node-valid";
    case "invalid": return "ws-node ws-node-invalid";
    case "partial": return "ws-node ws-node-partial";
    case "dim": return "ws-node ws-node-dim";
  }
}

function mapNodeStatus(
  diag: WorkspaceDiagnostics | null,
  summary: DefaultWorkspaceSummary | null,
  node: string,
): "valid" | "invalid" | "partial" | "dim" {
  if (node === "workspace") {
    if (!diag) return "dim";
    return diag.valid ? "valid" : "invalid";
  }
  if (node === "rules") {
    if (!diag) return "dim";
    const e = diag.enabled_rule_targets;
    const t = diag.total_rule_targets;
    if (t === 0) return "dim";
    if (e === t) return "valid";
    if (e > 0) return "partial";
    return "invalid";
  }
  if (node === "configs") {
    if (!diag) return "dim";
    const e = diag.enabled_config_targets;
    const t = diag.total_config_targets;
    if (t === 0) return "dim";
    if (e === t) return "valid";
    if (e > 0) return "partial";
    return "invalid";
  }
  if (node === "skills") {
    if (!summary) return "dim";
    const c = findCat(summary, "Skills");
    if (!c || c.count === 0) return "dim";
    return "valid";
  }
  if (node === "agents") {
    if (!summary) return "dim";
    const c = findCat(summary, "Agents");
    if (!c || c.count === 0) return "dim";
    return "valid";
  }
  if (node === "docs") {
    if (!summary) return "dim";
    const c = findCat(summary, "Docs");
    if (!c || c.count === 0) return "dim";
    return c.count > 0 ? "valid" : "dim";
  }
  if (node === "scripts") {
    if (!summary) return "dim";
    const c = findCat(summary, "Scripts");
    if (!c || c.count === 0) return "dim";
    return c.count > 0 ? "valid" : "dim";
  }
  return "dim";
}

// Shared helpers for standardized panels
function SectionChip({ label, tone }: { label: string; tone: "ok" | "warn" | "fail" | "muted" }) {
  return <span className={`ws-section-chip ws-section-chip-${tone}`}>{label}</span>;
}

function runtimeChipTone(status: string): "ok" | "warn" | "fail" | "muted" {
  switch (status) {
    case "synced": return "ok";
    case "diverged": return "warn";
    case "missing": return "fail";
    case "invalid": return "fail";
    default: return "muted";
  }
}

function runtimeChipLabel(status: string): string {
  switch (status) {
    case "synced": return "Synced";
    case "diverged": return "Diverged";
    case "missing": return "Missing";
    case "invalid": return "Invalid";
    default: return "Unknown";
  }
}

export function WorkspaceView({
  appSettings,
  onSetWorkspacePath,
  onApplyWorkspacePath,
  onChooseWorkspaceFolder,
  workspaceDiagnostics,
  onRefreshDiagnostics,
  defaultWorkspaceSummary,
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
  // contract
    contractResult,
    onRefreshContract,
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
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const [showSkillSelector, setShowSkillSelector] = useState(false);
  const [showDesignPicker, setShowDesignPicker] = useState(false);
  const [showInventory, setShowInventory] = useState(false);

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
  const summary = defaultWorkspaceSummary;

  const mapNodes: { id: string; label: string }[] = [
    { id: "workspace", label: "workspace" },
    { id: "rules", label: "rules" },
    { id: "configs", label: "configs" },
    { id: "agents", label: "agents" },
    { id: "skills", label: "skills" },
    { id: "docs", label: "docs" },
    { id: "scripts", label: "scripts" },
  ];

  const skillsCat = findCat(summary, "Skills");
  const docsCat = findCat(summary, "Docs");
  const scriptsCat = findCat(summary, "Scripts");
  const templatesCat = findCat(summary, "Templates");
  const agentsCat = findCat(summary, "Agents");

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

  const renderNodeDetails = (nodeId: string) => {
    switch (nodeId) {
      case "workspace":
        return (
          <div className="ws-detail-body">
            {diag ? (
              <>
                <div className="ws-detail-row">
                  <span className="ws-detail-key">path</span>
                  <span className="ws-detail-val">{diagnosticsPath}</span>
                </div>
                <div className="ws-detail-row">
                  <span className="ws-detail-key">markers missing</span>
                  <span className={`ws-detail-val ${missingMarkers.length > 0 ? "ws-color-fail" : "ws-color-ok"}`}>
                    {missingMarkers.length}
                  </span>
                </div>
              </>
            ) : (
              <div className="ws-detail-row ws-detail-dim">waiting for diagnostics</div>
            )}
          </div>
        );
      case "rules":
        return (
          <div className="ws-detail-body">
            {diag ? (
              <div className="ws-detail-row">
                <span className="ws-detail-key">enabled</span>
                <span className={`ws-detail-val ${diag.enabled_rule_targets > 0 ? "ws-color-ok" : ""}`}>
                  {diag.enabled_rule_targets}/{diag.total_rule_targets}
                </span>
              </div>
            ) : (
              <div className="ws-detail-row ws-detail-dim">waiting for diagnostics</div>
            )}
          </div>
        );
      case "configs":
        return (
          <div className="ws-detail-body">
            {diag ? (
              <div className="ws-detail-row">
                <span className="ws-detail-key">enabled</span>
                <span className={`ws-detail-val ${diag.enabled_config_targets > 0 ? "ws-color-ok" : ""}`}>
                  {diag.enabled_config_targets}/{diag.total_config_targets}
                </span>
              </div>
            ) : (
              <div className="ws-detail-row ws-detail-dim">waiting for diagnostics</div>
            )}
          </div>
        );
      case "skills": {
        const cat = findCat(summary, "Skills");
        return (
          <div className="ws-detail-body">
            {cat ? (
              <div className="ws-detail-row">
                <span className="ws-detail-key">bundled</span>
                <span className={`ws-detail-val ${cat.count > 0 ? "ws-color-ok" : ""}`}>
                  {cat.count} skills
                </span>
              </div>
            ) : (
              <div className="ws-detail-row ws-detail-dim">no starter summary</div>
            )}
          </div>
        );
      }
      case "agents": {
        const cat = findCat(summary, "Agents");
        return (
          <div className="ws-detail-body">
            {cat ? (
              <div className="ws-detail-row">
                <span className="ws-detail-key">bundled</span>
                <span className={`ws-detail-val ${cat.count > 0 ? "ws-color-ok" : ""}`}>
                  {cat.count} agents
                </span>
              </div>
            ) : (
              <div className="ws-detail-row ws-detail-dim">no starter summary</div>
            )}
          </div>
        );
      }
      case "docs": {
        const cat = findCat(summary, "Docs");
        return (
          <div className="ws-detail-body">
            {cat ? (
              <div className="ws-detail-row">
                <span className="ws-detail-key">bundled</span>
                <span className={`ws-detail-val ${cat.count > 0 ? "ws-color-ok" : ""}`}>
                  {cat.count} docs
                </span>
              </div>
            ) : (
              <div className="ws-detail-row ws-detail-dim">no starter summary</div>
            )}
          </div>
        );
      }
      case "scripts": {
        const cat = findCat(summary, "Scripts");
        return (
          <div className="ws-detail-body">
            {cat ? (
              <div className="ws-detail-row">
                <span className="ws-detail-key">bundled</span>
                <span className={`ws-detail-val ${cat.count > 0 ? "ws-color-ok" : ""}`}>
                  {cat.count} scripts
                </span>
              </div>
            ) : (
              <div className="ws-detail-row ws-detail-dim">no starter summary</div>
            )}
          </div>
        );
      }
      default:
        return null;
    }
  };

  const statusRows: { key: string; value: string; ok: boolean; warn: boolean }[] = [];
  if (diag) {
    statusRows.push({
      key: "markers",
      value: missingMarkers.length === 0 ? "\u2713 0" : String(missingMarkers.length),
      ok: missingMarkers.length === 0,
      warn: missingMarkers.length > 0,
    });
    statusRows.push({
      key: "rule targets",
      value: `${diag.enabled_rule_targets}/${diag.total_rule_targets}`,
      ok: diag.enabled_rule_targets > 0,
      warn: false,
    });
    statusRows.push({
      key: "config targets",
      value: `${diag.enabled_config_targets}/${diag.total_config_targets}`,
      ok: diag.enabled_config_targets > 0,
      warn: false,
    });
  }
  const resourceRows: { key: string; value: string; cat: typeof skillsCat }[] = [
    { key: "skills", value: skillsCat ? String(skillsCat.count) : "\u2014", cat: skillsCat },
    { key: "agents", value: agentsCat ? String(agentsCat.count) : "\u2014", cat: agentsCat },
    { key: "docs", value: docsCat ? String(docsCat.count) : "\u2014", cat: docsCat },
    { key: "scripts", value: scriptsCat ? String(scriptsCat.count) : "\u2014", cat: scriptsCat },
    { key: "templates", value: templatesCat ? String(templatesCat.count) : "\u2014", cat: templatesCat },
  ];

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
              <button className="btn btn-sm" onClick={() => { onRefreshDiagnostics(); onRefreshStatus(); onRefreshOpenCodeRuntimeHealth(); }}>
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
                  <div className="ws-runtime-metrics">
                    <span className="ws-runtime-metric">
                      <span className="ws-runtime-metric-label">Config</span>
                      <span className="ws-runtime-metric-value">{runtimeChipLabel(opencodeRuntimeHealth.status).toLowerCase()}</span>
                    </span>
                    <span className="ws-runtime-metric">
                      <span className="ws-runtime-metric-label">Agents</span>
                      <span className="ws-runtime-metric-value">{opencodeRuntimeHealth.installed_bundled_agent_count}/{opencodeRuntimeHealth.bundled_agent_count} bundled</span>
                    </span>
                    {opencodeRuntimeHealth.extra_installed_agent_count > 0 && (
                      <span className="ws-runtime-metric ws-runtime-metric-extra">
                        <span className="ws-runtime-metric-value">+{opencodeRuntimeHealth.extra_installed_agent_count} extra</span>
                      </span>
                    )}
                  </div>

                  {opencodeRuntimeHealth.agent_mismatches.length > 0 && (
                    <div className="ws-runtime-warning">
                      {opencodeRuntimeHealth.agent_mismatches[0].detail}
                      {opencodeRuntimeHealth.agent_mismatches.length > 1 && (
                        <> +{opencodeRuntimeHealth.agent_mismatches.length - 1} more</>
                      )}
                    </div>
                  )}
                  {opencodeRuntimeHealth.warnings.length > 0 && opencodeRuntimeHealth.agent_mismatches.length === 0 && (
                    <div className="ws-runtime-warning">
                      {opencodeRuntimeHealth.warnings[0]}
                      {opencodeRuntimeHealth.warnings.length > 1 && (
                        <> +{opencodeRuntimeHealth.warnings.length - 1} more</>
                      )}
                    </div>
                  )}

                  <div className="ws-section-actions">
                    <button className="btn btn-sm" onClick={onRefreshOpenCodeRuntimeHealth} aria-label="Refresh OpenCode runtime health">
                      refresh
                    </button>
                    <button className="btn btn-sm" disabled={!workspaceValid || !configEnabled || wsRunning !== null} onClick={onDiffConfigs}>
                      diff
                    </button>
                    <button className="btn btn-sm btn-primary" disabled={!workspaceValid || !configEnabled || wsRunning !== null} onClick={onSyncConfigs}>
                      sync
                    </button>
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

          {/* ---- Secondary: Workspace Inventory (collapsed by default when valid) ---- */}
          {appSettings && (
            <div className="ws-inventory">
              <button
                className="ws-inventory-toggle"
                onClick={() => setShowInventory(prev => !prev)}
                aria-expanded={showInventory}
                aria-label={showInventory ? "Collapse workspace inventory" : "Expand workspace inventory"}
              >
                <span className="ws-inventory-toggle-label">INVENTORY</span>
                {!showInventory && statusRows.length > 0 && (
                  <span className="ws-inventory-toggle-summary">
                    {statusRows.map(row => (
                      <span key={row.key} className={`ws-inv-chip ${row.ok ? "ws-inv-chip-ok" : row.warn ? "ws-inv-chip-warn" : "ws-inv-chip-dim"}`}>
                        {row.key} {row.value}
                      </span>
                    ))}
                    {summary && resourceRows.slice(0, 3).map(row => (
                      <span key={row.key} className={`ws-inv-chip ${row.cat && row.cat.count > 0 ? "ws-inv-chip-ok" : "ws-inv-chip-dim"}`}>
                        {row.key} {row.value}
                      </span>
                    ))}
                  </span>
                )}
                <span className="ws-inventory-toggle-icon">{showInventory ? "\u25bc" : "\u25b6"}</span>
              </button>

              {showInventory && (
                <div className="ws-inventory-body">
                  {/* Status summary — compact row */}
                  <div className="ws-inv-row">
                    <div className="ws-inv-row-label">STATUS</div>
                    <div className="ws-inv-row-items">
                      {statusRows.map(row => (
                        <span key={row.key} className={`ws-inv-chip ${row.ok ? "ws-inv-chip-ok" : row.warn ? "ws-inv-chip-warn" : "ws-inv-chip-dim"}`}>
                          {row.key} {row.value}
                        </span>
                      ))}
                      {summary && resourceRows.map(row => (
                        <span key={row.key} className={`ws-inv-chip ${row.cat && row.cat.count > 0 ? "ws-inv-chip-ok" : "ws-inv-chip-dim"}`}>
                          {row.key} {row.value}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Path input */}
                  <div className="ws-inv-row">
                    <div className="ws-inv-row-label">PATH</div>
                    <div className="ws-inv-row-input">
                      <input
                        className="settings-input ws-path-input"
                        type="text"
                        placeholder="default (env or repo default)"
                        value={appSettings.workspace_path ?? ""}
                        onChange={e => onSetWorkspacePath(e.target.value || null)}
                        aria-label="Workspace path"
                      />
                    </div>
                  </div>

                  {/* System map — compact horizontal */}
                  <div className="ws-inv-row">
                    <div className="ws-inv-row-label">SYSTEM MAP</div>
                    <div className="ws-inv-map">
                      {!diag && <div className="ws-map-scan" />}
                      <div className="ws-inv-map-items">
                        {mapNodes.map(node => {
                          const nodeStatus = mapNodeStatus(diag, summary, node.id);
                          const isExpanded = expandedNode === node.id;
                          return (
                            <button
                              key={node.id}
                              className={`ws-inv-map-btn ${isExpanded ? "ws-inv-map-btn-expanded" : ""}`}
                              onClick={() => setExpandedNode(isExpanded ? null : node.id)}
                              aria-expanded={isExpanded}
                              aria-label={`${node.label} system node`}
                            >
                              <span className={mapNodeClass(nodeStatus)}>
                                <span className="ws-map-dot" />
                                <span className="ws-map-label">{node.label}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Node detail */}
                  {expandedNode && (
                    <div className="ws-inv-row" role="region" aria-label={`${mapNodes.find(n => n.id === expandedNode)?.label} details`}>
                      <div className="ws-inv-row-label">
                        {mapNodes.find(n => n.id === expandedNode)?.label ?? ""} DETAIL
                      </div>
                      {renderNodeDetails(expandedNode)}
                    </div>
                  )}

                  {/* Diagnostics */}
                  {diag && (
                    <div className="ws-inv-row">
                      <div className="ws-inv-row-label">DIAGNOSTICS</div>
                      <div className="ws-inv-row-items">
                        {diag.resolved_path && diag.resolved_path !== diag.candidate_path && (
                          <span className="ws-inv-chip ws-inv-chip-dim">
                            candidate: {diag.candidate_path}
                          </span>
                        )}
                        {diag.error && (
                          <span className="ws-inv-chip ws-inv-chip-warn">{diag.error}</span>
                        )}
                        {diag.valid && missingMarkers.length === 0 && (
                          <span className="ws-inv-chip ws-inv-chip-ok">all markers present</span>
                        )}
                      </div>
                      {missingMarkers.length > 0 && (
                        <div className="ws-missing-list">
                          {missingMarkers.map((m, i) => (
                            <div key={i} className="ws-diag-row ws-color-fail">
                              missing {m.kind}: {m.path}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Workspace Contract */}
                  <div className="ws-inv-row">
                    <div className="ws-inv-row-label">CONTRACT</div>
                    <div className="ws-contract-body">
                      {!contractResult ? (
                        <div className="ws-contract-empty">
                          <span className="ws-detail-dim">Not validated</span>
                          <button className="btn btn-sm" onClick={onRefreshContract}>
                            validate
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="ws-contract-summary">
                            <span className={`ws-contract-status ${contractResult.valid ? "ws-contract-status-valid" : "ws-contract-status-invalid"}`}>
                              {contractResult.valid ? "valid" : "failed"}
                            </span>
                            {contractResult.checks.filter(c => c.status === "fail").length > 0 && (
                              <span className="ws-inv-chip ws-inv-chip-warn">
                                {contractResult.checks.filter(c => c.status === "fail").length} fail
                              </span>
                            )}
                            {contractResult.checks.filter(c => c.status === "warn").length > 0 && (
                              <span className="ws-inv-chip ws-inv-chip-dim">
                                {contractResult.checks.filter(c => c.status === "warn").length} warn
                              </span>
                            )}
                            <span className="ws-inv-chip ws-inv-chip-ok">
                              {contractResult.checks.filter(c => c.status === "pass").length} pass
                            </span>
                            <button className="btn btn-sm" onClick={onRefreshContract} aria-label="Refresh workspace contract validation">
                              refresh
                            </button>
                          </div>
                          <details className="ws-contract-details">
                            <summary className="ws-contract-details-summary">
                              {contractResult.checks.length} checks
                            </summary>
                            <div className="ws-contract-checks-list">
                              {contractResult.checks.map(check => {
                                const statusLabel = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
                                const statusClass = check.status === "pass" ? "ws-contract-check-pass" : check.status === "warn" ? "ws-contract-check-warn" : "ws-contract-check-fail";
                                return (
                                  <div key={check.id} className="ws-contract-check-row">
                                    <span className={`ws-contract-check-status ${statusClass}`} aria-label={`Status ${statusLabel}`}>
                                      {statusLabel}
                                    </span>
                                    <span className="ws-contract-check-label">{check.label}</span>
                                    <span className="ws-contract-check-detail ws-detail-dim">{check.detail}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Resources — compact summary + expandable */}
                  {summary && (
                    <div className="ws-inv-row">
                      <div className="ws-inv-row-label">RESOURCES</div>
                      <div className="ws-resource-details">
                        {summary.categories.map((cat) => (
                          <details key={cat.label} className="ws-resource-cat" open={cat.label === "Skills"}>
                            <summary className="ws-resource-header">
                              <span className="ws-resource-name">{cat.label}</span>
                              <span className="ws-resource-count">{cat.count}/{cat.files.length}</span>
                            </summary>
                            {cat.label === "Skills" ? (
                              <div className="ws-skill-grid">
                                {cat.files.map((f, fi) => {
                                  const name = skillDisplayName(f.path);
                                  return (
                                    <div key={fi} className={`ws-skill-item ${f.exists ? "" : "ws-skill-item-missing"}`}>
                                      <span className={`ws-dot ${f.exists ? "ws-dot-ok" : "ws-dot-fail"}`}>&#x25CF;</span>
                                      <span className="ws-skill-name">{name}</span>
                                      <span className="ws-skill-path">{f.path}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="ws-resource-files">
                                {cat.files.map((f, fi) => (
                                  <div key={fi} className={`ws-file-row ${f.exists ? "" : "ws-file-missing"}`}>
                                    <span className={`ws-dot ${f.exists ? "ws-dot-ok" : "ws-dot-fail"}`}>&#x25CF;</span>
                                    <span className="ws-file-path">{f.path}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </details>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Create workspace */}
                  <div className="ws-inv-row">
                    <div className="ws-inv-row-label">CREATE</div>
                    <div className="ws-create-body">
                      {!createPlan && (
                        <div className="ws-create-body">
                          <div className="ws-cmd-row">
                            <span className="ws-cmd-prompt">$</span>
                            <span>dry-run create</span>
                          </div>
                          <div className="ws-cmd-tags">
                            <span className="ws-tag">read-only</span>
                            <span className="ws-tag">no overwrite</span>
                            <span className="ws-tag">no scripts</span>
                          </div>
                          <div className="ws-cmd-action">
                            <button
                              className="btn btn-sm btn-primary"
                              onClick={onPlanCreate}
                              disabled={createPlanRunning}
                            >
                              {createPlanRunning ? "planning\u2026" : "dry-run create"}
                            </button>
                          </div>
                        </div>
                      )}

                      {createPlan && !createPlan.ok && (
                        <div className="ws-create-body">
                          <div className="ws-cmd-result">
                            <div className="ws-cmd-row ws-color-warn">
                              <span className="ws-cmd-prompt">warn</span>
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
                          </div>
                        </div>
                      )}

                      {createPlan && createPlan.ok && (
                        <div className="ws-create-body">
                          <div className="ws-cmd-result">
                            <div className="ws-cmd-row ws-color-ok">
                              <span className="ws-cmd-prompt">ok</span>
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
                              <div className="ws-cmd-files">
                                <div className="ws-cmd-row ws-color-dim">
                                  planned ({createPlan.planned_files.length})
                                </div>
                                <div className="ws-file-list">
                                  {createPlan.planned_files.map((f, i) => (
                                    <div key={i} className="ws-file-row">
                                      <span className="ws-dot ws-dot-ok">&#x25CF;</span>
                                      <span className="ws-file-path">{f}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                          {createPlanEligible && (
                            <div className="ws-create-action">
                              <div className="ws-cmd-row">
                                <span className="ws-cmd-prompt ws-color-ok">$</span>
                                <span>create workspace &mdash; path is safe</span>
                              </div>
                              <button
                                className="btn btn-sm btn-primary"
                                onClick={onCreateWorkspace}
                                disabled={createRunning}
                              >
                                {createRunning ? "creating\u2026" : "create workspace"}
                              </button>
                              <div className="ws-cmd-tags">
                                <span className="ws-tag">{createPlan.planned_files.length} files</span>
                                <span className="ws-tag">no overwrite</span>
                                <span className="ws-tag">no scripts</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {createResult && (
                        <div className="ws-create-body">
                          <div className={`ws-cmd-row ${createResult.success ? "ws-color-ok" : "ws-color-fail"}`}>
                            <span className="ws-cmd-prompt">{createResult.success ? "ok" : "fail"}</span>
                            <span>{createResult.message}</span>
                          </div>
                          <div className="ws-cmd-row ws-color-dim">
                            status: {createResult.status} | target: {createResult.target_path}
                          </div>
                          {createResult.copied_files.length > 0 && (
                            <div className="ws-cmd-files">
                              <div className="ws-cmd-row ws-color-dim">
                                copied ({createResult.copied_files.length})
                              </div>
                              <div className="ws-file-list">
                                {createResult.copied_files.map((f, i) => (
                                  <div key={i} className="ws-file-row">
                                    <span className="ws-dot ws-dot-ok">&#x25CF;</span>
                                    <span className="ws-file-path">{f}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {createResult.skipped_files.length > 0 && (
                            <div className="ws-cmd-files">
                              <div className="ws-cmd-row ws-color-dim">
                                skipped ({createResult.skipped_files.length})
                              </div>
                              <div className="ws-file-list">
                                {createResult.skipped_files.map((f, i) => (
                                  <div key={i} className="ws-file-row">
                                    <span className="ws-dot ws-dot-fail">&#x25CF;</span>
                                    <span className="ws-file-path">{f}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {createResult.warnings.length > 0 && (
                            <div className="ws-cmd-warnings">
                              {createResult.warnings.map((w, i) => (
                                <div key={i} className="ws-cmd-row ws-color-fail">{w}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
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
