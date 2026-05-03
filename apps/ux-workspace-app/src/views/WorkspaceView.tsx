import { useState } from "react";
import type { AppSettings, CreateWorkspacePlan, CreateWorkspaceResult, DefaultWorkspaceSummary, WorkspaceDiagnostics } from "../types";

interface WorkspaceViewProps {
  appSettings: AppSettings | null;
  onSetWorkspacePath: (value: string | null) => void;
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
}

const findCat = (summary: DefaultWorkspaceSummary | null, label: string) =>
  summary?.categories.find(c => c.label === label);

function mapNodeClass(condition: "valid" | "invalid" | "partial" | "dim"): string {
  switch (condition) {
    case "valid": return "workspace-map-node workspace-map-node-valid";
    case "invalid": return "workspace-map-node workspace-map-node-invalid";
    case "partial": return "workspace-map-node workspace-map-node-partial";
    case "dim": return "workspace-map-node workspace-map-node-dim";
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

export function WorkspaceView({
  appSettings,
  onSetWorkspacePath,
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
}: WorkspaceViewProps) {
  const [expandedNode, setExpandedNode] = useState<string | null>(null);

  const diag = workspaceDiagnostics;
  const missingMarkers = diag?.markers.filter(m => !m.exists) ?? [];
  const resolvedPath = diag?.resolved_path ?? diag?.candidate_path ?? "\u2014";
  const summary = defaultWorkspaceSummary;

  const mapNodes: { id: string; label: string }[] = [
    { id: "workspace", label: "workspace" },
    { id: "rules", label: "rules" },
    { id: "skills", label: "skills" },
    { id: "configs", label: "configs" },
    { id: "docs", label: "docs" },
    { id: "scripts", label: "scripts" },
  ];

  const skillsCat = findCat(summary, "Skills");
  const docsCat = findCat(summary, "Docs");
  const scriptsCat = findCat(summary, "Scripts");
  const templatesCat = findCat(summary, "Templates");

  const createPlanEligible = createPlan && (createPlan.status === "missing_directory" || createPlan.status === "empty_existing_directory");

  const renderNodeDetails = (nodeId: string) => {
    switch (nodeId) {
      case "workspace":
        return (
          <div className="workspace-node-details-inner">
            {diag ? (
              <>
                <div className="workspace-node-detail-row">
                  <span className="workspace-node-detail-label">path</span>
                  <span className="workspace-node-detail-value">{resolvedPath}</span>
                </div>
                <div className="workspace-node-detail-row">
                  <span className="workspace-node-detail-label">markers missing</span>
                  <span className={`workspace-node-detail-value ${missingMarkers.length > 0 ? "workspace-invalid" : "workspace-valid"}`}>
                    {missingMarkers.length}
                  </span>
                </div>
              </>
            ) : (
              <div className="workspace-node-detail-row workspace-node-detail-dim">waiting for diagnostics</div>
            )}
          </div>
        );
      case "rules":
        return (
          <div className="workspace-node-details-inner">
            {diag ? (
              <div className="workspace-node-detail-row">
                <span className="workspace-node-detail-label">enabled</span>
                <span className={`workspace-node-detail-value ${diag.enabled_rule_targets > 0 ? "workspace-valid" : ""}`}>
                  {diag.enabled_rule_targets}/{diag.total_rule_targets}
                </span>
              </div>
            ) : (
              <div className="workspace-node-detail-row workspace-node-detail-dim">waiting for diagnostics</div>
            )}
          </div>
        );
      case "configs":
        return (
          <div className="workspace-node-details-inner">
            {diag ? (
              <div className="workspace-node-detail-row">
                <span className="workspace-node-detail-label">enabled</span>
                <span className={`workspace-node-detail-value ${diag.enabled_config_targets > 0 ? "workspace-valid" : ""}`}>
                  {diag.enabled_config_targets}/{diag.total_config_targets}
                </span>
              </div>
            ) : (
              <div className="workspace-node-detail-row workspace-node-detail-dim">waiting for diagnostics</div>
            )}
          </div>
        );
      case "skills": {
        const cat = findCat(summary, "Skills");
        return (
          <div className="workspace-node-details-inner">
            {cat ? (
              <div className="workspace-node-detail-row">
                <span className="workspace-node-detail-label">bundled</span>
                <span className={`workspace-node-detail-value ${cat.count > 0 ? "workspace-valid" : ""}`}>
                  {cat.count} skills
                </span>
              </div>
            ) : (
              <div className="workspace-node-detail-row workspace-node-detail-dim">no starter summary</div>
            )}
          </div>
        );
      }
      case "docs": {
        const cat = findCat(summary, "Docs");
        return (
          <div className="workspace-node-details-inner">
            {cat ? (
              <div className="workspace-node-detail-row">
                <span className="workspace-node-detail-label">bundled</span>
                <span className={`workspace-node-detail-value ${cat.count > 0 ? "workspace-valid" : ""}`}>
                  {cat.count} docs
                </span>
              </div>
            ) : (
              <div className="workspace-node-detail-row workspace-node-detail-dim">no starter summary</div>
            )}
          </div>
        );
      }
      case "scripts": {
        const cat = findCat(summary, "Scripts");
        return (
          <div className="workspace-node-details-inner">
            {cat ? (
              <div className="workspace-node-detail-row">
                <span className="workspace-node-detail-label">bundled</span>
                <span className={`workspace-node-detail-value ${cat.count > 0 ? "workspace-valid" : ""}`}>
                  {cat.count} scripts
                </span>
              </div>
            ) : (
              <div className="workspace-node-detail-row workspace-node-detail-dim">no starter summary</div>
            )}
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <section className="terminal terminal-view">
      <div className="terminal-topline">
        <span className="terminal-title">WORKSPACE</span>
      </div>
      {appSettings && (
        <div className="workspace-landing">
          {/* ── Hero ── */}
          <div className="workspace-hero">
            <div className="workspace-hero-main">
              <h1 className="workspace-hero-title">Agent Workspace</h1>
              <p className="workspace-hero-subtitle">
                Local control panel for agent rules, skills, configs, and workspace scripts.
              </p>
            </div>
            <div className="workspace-hero-meta">
              <span
                className={`workspace-status-badge ${
                  !diag
                    ? "workspace-status-loading"
                    : diag.valid
                      ? "workspace-status-valid"
                      : "workspace-status-invalid"
                }`}
              >
                {!diag ? "loading\u2026" : diag.valid ? "valid workspace" : "setup needed"}
              </span>
              <code className="workspace-path-console">{resolvedPath}</code>
              <div className="workspace-hero-actions">
                {diag && !diag.valid ? (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={onPlanCreate}
                    disabled={createPlanRunning}
                  >
                    {createPlanRunning ? "planning\u2026" : "dry-run create"}
                  </button>
                ) : (
                  <button className="btn btn-sm" onClick={onRefreshDiagnostics}>
                    refresh
                  </button>
                )}
                <button className="btn btn-sm" onClick={onChooseWorkspaceFolder}>
                  choose folder
                </button>
                <button className="btn btn-sm" onClick={() => onSetWorkspacePath(null)}>
                  use default
                </button>
              </div>
            </div>
          </div>

          {/* ── Path input ── */}
          <div className="workspace-path-panel">
            <input
              className="settings-input workspace-path-input"
              type="text"
              placeholder="default (env or repo default)"
              value={appSettings.workspace_path ?? ""}
              onChange={e => onSetWorkspacePath(e.target.value || null)}
            />
            <span className="workspace-path-hint">
              Enter workspace folder path. For a new workspace, enter the child folder to create.
            </span>
          </div>

          {/* ── Metrics ── */}
          {diag && (
            <div className="workspace-metrics">
              <div className={`workspace-metric ${missingMarkers.length === 0 ? "workspace-metric-ok" : "workspace-metric-warn"}`}>
                <span className="workspace-metric-value">
                  {missingMarkers.length === 0 ? "\u2713" : missingMarkers.length}
                </span>
                <span className="workspace-metric-label">markers</span>
              </div>
              <div className={`workspace-metric ${diag.enabled_rule_targets > 0 ? "workspace-metric-ok" : "workspace-metric-dim"}`}>
                <span className="workspace-metric-value">
                  {diag.enabled_rule_targets}/{diag.total_rule_targets}
                </span>
                <span className="workspace-metric-label">rule targets</span>
              </div>
              <div className={`workspace-metric ${diag.enabled_config_targets > 0 ? "workspace-metric-ok" : "workspace-metric-dim"}`}>
                <span className="workspace-metric-value">
                  {diag.enabled_config_targets}/{diag.total_config_targets}
                </span>
                <span className="workspace-metric-label">config targets</span>
              </div>
              {skillsCat && (
                <div className={`workspace-metric ${skillsCat.count > 0 ? "workspace-metric-ok" : "workspace-metric-dim"}`}>
                  <span className="workspace-metric-value">{skillsCat.count}</span>
                  <span className="workspace-metric-label">starter skills</span>
                </div>
              )}
              {docsCat && (
                <div className={`workspace-metric ${docsCat.count > 0 ? "workspace-metric-ok" : "workspace-metric-dim"}`}>
                  <span className="workspace-metric-value">{docsCat.count}</span>
                  <span className="workspace-metric-label">starter docs</span>
                </div>
              )}
              {scriptsCat && (
                <div className={`workspace-metric ${scriptsCat.count > 0 ? "workspace-metric-ok" : "workspace-metric-dim"}`}>
                  <span className="workspace-metric-value">{scriptsCat.count}</span>
                  <span className="workspace-metric-label">starter scripts</span>
                </div>
              )}
              {templatesCat && (
                <div className={`workspace-metric ${templatesCat.count > 0 ? "workspace-metric-ok" : "workspace-metric-dim"}`}>
                  <span className="workspace-metric-value">{templatesCat.count}</span>
                  <span className="workspace-metric-label">starter templates</span>
                </div>
              )}
            </div>
          )}

          {/* ── Interactive system map ── */}
          <div className="workspace-map">
            {!diag && <div className="workspace-map-scanning" />}
            <div className="workspace-map-track">
              {mapNodes.map((node, i) => {
                const status = mapNodeStatus(diag, summary, node.id);
                const isExpanded = expandedNode === node.id;
                return (
                  <span key={node.id} className="workspace-system-node-group">
                    {i > 0 && <span className="workspace-map-line" />}
                    <button
                      className={`workspace-system-node ${isExpanded ? "workspace-system-node-expanded" : ""}`}
                      onClick={() => setExpandedNode(isExpanded ? null : node.id)}
                      aria-expanded={isExpanded}
                      aria-label={`${node.label} system node`}
                    >
                      <span className={mapNodeClass(status)}>
                        <span className="workspace-map-dot" />
                        <span className="workspace-map-label">{node.label}</span>
                      </span>
                    </button>
                  </span>
                );
              })}
            </div>
            {expandedNode && (
              <div className="workspace-node-details" role="region" aria-label={`${mapNodes.find(n => n.id === expandedNode)?.label} details`}>
                {renderNodeDetails(expandedNode)}
              </div>
            )}
          </div>

          {/* ── Diagnostics details ── */}
          {diag && (
            <div className="workspace-diag-detail">
              {diag.resolved_path && diag.resolved_path !== diag.candidate_path && (
                <div className="workspace-diag-row">
                  <span className="cell-label-sm">candidate</span>
                  <span className="cell-value-trunc">{diag.candidate_path}</span>
                </div>
              )}
              {diag.error && (
                <div className="workspace-diag-row workspace-invalid">{diag.error}</div>
              )}
              {missingMarkers.length > 0 && (
                <div className="workspace-marker-list">
                  {missingMarkers.map((m, i) => (
                    <div key={i} className="workspace-marker-missing">
                      missing {m.kind}: {m.path}
                    </div>
                  ))}
                </div>
              )}
              {diag.valid && missingMarkers.length === 0 && (
                <div className="workspace-diag-row workspace-valid">all markers present</div>
              )}
            </div>
          )}

          {/* ── Create workspace next-step ── */}
          <div className={`workspace-next-step ${diag && !diag.valid ? "workspace-next-step-attention" : ""} ${createPlanEligible ? "workspace-next-step-ready" : ""}`}>
            <div className="console-section-label">create workspace</div>

            {/* No plan state */}
            {!createPlan && (
              <div className="workspace-next-step-body">
                <div className="workspace-next-step-guide">
                  <span className="workspace-next-step-icon">\u25B8</span>
                  <span>Run a dry-run first to evaluate whether the workspace path is safe for initialization.</span>
                </div>
                <div className="workspace-next-step-badges">
                  <span className="create-plan-badge">read-only</span>
                  <span className="create-plan-badge">no overwrite</span>
                  <span className="create-plan-badge">no scripts</span>
                </div>
                <div className="workspace-next-step-actions">
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

            {/* Plan warning state */}
            {createPlan && !createPlan.ok && (
              <div className="workspace-next-step-body">
                <div className="create-plan-result">
                  <div className="create-plan-row create-plan-warn">
                    <span className="create-plan-status">warn</span>
                    <span>{createPlan.status}</span>
                  </div>
                  <div className="create-plan-row create-plan-muted">
                    target: {createPlan.target_path || "(empty)"}
                  </div>
                  <div className="create-plan-row">
                    {createPlan.reason}
                  </div>
                  {createPlan.warnings.length > 0 && (
                    <div className="create-plan-warnings">
                      {createPlan.warnings.map((w, i) => (
                        <div key={i} className="create-plan-row workspace-invalid">{w}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Plan ok state */}
            {createPlan && createPlan.ok && (
              <div className="workspace-next-step-body">
                <div className="create-plan-result">
                  <div className="create-plan-row create-plan-ok">
                    <span className="create-plan-status">ok</span>
                    <span>{createPlan.status}</span>
                  </div>
                  <div className="create-plan-row create-plan-muted">
                    target: {createPlan.target_path || "(empty)"}
                  </div>
                  <div className="create-plan-row">
                    {createPlan.reason}
                  </div>
                  {createPlan.warnings.length > 0 && (
                    <div className="create-plan-warnings">
                      {createPlan.warnings.map((w, i) => (
                        <div key={i} className="create-plan-row workspace-invalid">{w}</div>
                      ))}
                    </div>
                  )}
                  {createPlan.planned_files.length > 0 && (
                    <div className="create-plan-files">
                      <div className="create-plan-row cell-label-sm">planned files ({createPlan.planned_files.length})</div>
                      <div className="create-plan-file-list">
                        {createPlan.planned_files.map((f, i) => (
                          <div key={i} className="create-plan-file-row">
                            <span className="workspace-marker-dot workspace-valid">&#x25CF;</span>
                            <span className="defaults-file-path">{f}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {createPlanEligible && (
                  <div className="workspace-next-step-create-section">
                    <div className="workspace-next-step-guide">
                      <span className="workspace-next-step-icon">\u25B8</span>
                      <span>Path is safe. Copy bundled starter files into the target directory.</span>
                    </div>
                    <div className="workspace-next-step-actions">
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={onCreateWorkspace}
                        disabled={createRunning}
                      >
                        {createRunning ? "creating\u2026" : "create workspace"}
                      </button>
                    </div>
                    <div className="workspace-next-step-badges">
                      <span className="create-plan-badge">
                        {createPlan.planned_files.length} files
                      </span>
                      <span className="create-plan-badge">no overwrite</span>
                      <span className="create-plan-badge">no scripts</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Create result */}
            {createResult && (
              <div className="create-result">
                <div className={`create-plan-row ${createResult.success ? "create-plan-ok" : "create-plan-warn"}`}>
                  <span className="create-plan-status">{createResult.success ? "ok" : "fail"}</span>
                  <span>{createResult.message}</span>
                </div>
                <div className="create-plan-row create-plan-muted">
                  status: {createResult.status} | target: {createResult.target_path}
                </div>
                {createResult.copied_files.length > 0 && (
                  <div className="create-plan-files">
                    <div className="create-plan-row cell-label-sm">copied ({createResult.copied_files.length})</div>
                    <div className="create-plan-file-list">
                      {createResult.copied_files.map((f, i) => (
                        <div key={i} className="create-plan-file-row">
                          <span className="workspace-marker-dot workspace-valid">&#x25CF;</span>
                          <span className="defaults-file-path">{f}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {createResult.skipped_files.length > 0 && (
                  <div className="create-plan-files">
                    <div className="create-plan-row cell-label-sm">skipped ({createResult.skipped_files.length})</div>
                    <div className="create-plan-file-list">
                      {createResult.skipped_files.map((f, i) => (
                        <div key={i} className="create-plan-file-row">
                          <span className="workspace-marker-dot workspace-invalid">&#x25CF;</span>
                          <span className="defaults-file-path">{f}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {createResult.warnings.length > 0 && (
                  <div className="create-plan-warnings">
                    {createResult.warnings.map((w, i) => (
                      <div key={i} className="create-plan-row workspace-invalid">{w}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Bundled starter preview ── */}
          {summary && (
            <div className="workspace-resource-panel">
              <div className="defaults-preview-header">
                <span className="cell-label">BUNDLED STARTER</span>
                <span className="defaults-preview-badge">read-only</span>
              </div>
              <div className="defaults-preview-desc">{summary.description}</div>
              <div className="defaults-summary-row">
                {summary.categories.map((cat, ci) => (
                  <span key={ci} className={`defaults-summary-chip ${cat.label === "Skills" && cat.count > 0 ? "defaults-summary-chip-good" : ""}`}>
                    {cat.label} {cat.count}/{cat.files.length}
                  </span>
                ))}
              </div>
              <div className="defaults-preview-categories">
                {summary.categories.map((cat, ci) => (
                  <details key={ci} className="defaults-category" open={cat.label === "Skills" || cat.label === "Docs"}>
                    <summary className="defaults-category-header">
                      <span className="cell-label-sm">{cat.label}</span>
                      <span className="defaults-category-count">{cat.count}/{cat.files.length}</span>
                    </summary>
                    <div className="defaults-category-files">
                      {cat.files.map((f, fi) => (
                        <div key={fi} className={`defaults-file ${f.exists ? "" : "defaults-file-missing"}`}>
                          <span className={`workspace-marker-dot ${f.exists ? "workspace-valid" : "workspace-invalid"}`}>&#x25CF;</span>
                          <span className="defaults-file-path">{f.path}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
