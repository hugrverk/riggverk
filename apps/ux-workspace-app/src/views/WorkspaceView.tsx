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

          {/* ── Workspace map ── */}
          <div className="workspace-map">
            {!diag && <div className="workspace-map-scanning" />}
            <div className="workspace-map-track">
              {mapNodes.map((node, i) => (
                <span key={node.id}>
                  {i > 0 && <span className="workspace-map-line" />}
                  <span className={mapNodeClass(mapNodeStatus(diag, summary, node.id))}>
                    <span className="workspace-map-dot" />
                    <span className="workspace-map-label">{node.label}</span>
                  </span>
                </span>
              ))}
            </div>
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

          {/* ── Create workspace panel ── */}
          <div className={`workspace-action-panel ${diag && !diag.valid ? "workspace-action-panel-attention" : ""}`}>
            <div className="console-section-label">create workspace</div>
            <div className="workspace-action-header">
              <button
                className="btn btn-sm"
                onClick={onPlanCreate}
                disabled={!appSettings || createPlanRunning}
              >
                {createPlanRunning ? "planning\u2026" : "dry-run create"}
              </button>
              <span className="create-plan-badge">read-only</span>
              <span className="create-plan-badge">no overwrite</span>
              <span className="create-plan-badge">no scripts</span>
            </div>
            <div className="workspace-action-desc">
              Evaluates whether the workspace path is safe for initialization. Create is only enabled for a missing folder with an existing parent, or an empty existing folder.
            </div>
            {!appSettings && (
              <div className="workspace-action-desc">settings not loaded</div>
            )}
            {createPlan && (
              <div className="create-plan-result">
                <div className={`create-plan-row ${createPlan.ok ? "create-plan-ok" : "create-plan-warn"}`}>
                  <span className="create-plan-status">{createPlan.ok ? "ok" : "warn"}</span>
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
            )}
            {createPlan && (createPlan.status === "missing_directory" || createPlan.status === "empty_existing_directory") && (
              <div className="create-action-section">
                <div className="create-action-header">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={onCreateWorkspace}
                    disabled={createRunning}
                  >
                    {createRunning ? "creating\u2026" : "create workspace"}
                  </button>
                </div>
                <div className="create-action-warnings">
                  <div className="create-plan-row create-plan-muted">
                    creates files from bundled starter
                  </div>
                  <div className="create-plan-row create-plan-muted">
                    does not overwrite existing files
                  </div>
                  <div className="create-plan-row create-plan-muted">
                    does not run scripts
                  </div>
                </div>
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
