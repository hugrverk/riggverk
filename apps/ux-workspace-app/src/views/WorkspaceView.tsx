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
    { id: "configs", label: "configs" },
    { id: "skills", label: "skills" },
    { id: "docs", label: "docs" },
    { id: "scripts", label: "scripts" },
  ];

  const skillsCat = findCat(summary, "Skills");
  const docsCat = findCat(summary, "Docs");
  const scriptsCat = findCat(summary, "Scripts");
  const templatesCat = findCat(summary, "Templates");

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

  const renderNodeDetails = (nodeId: string) => {
    switch (nodeId) {
      case "workspace":
        return (
          <div className="ws-detail-body">
            {diag ? (
              <>
                <div className="ws-detail-row">
                  <span className="ws-detail-key">path</span>
                  <span className="ws-detail-val">{resolvedPath}</span>
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
    { key: "docs", value: docsCat ? String(docsCat.count) : "\u2014", cat: docsCat },
    { key: "scripts", value: scriptsCat ? String(scriptsCat.count) : "\u2014", cat: scriptsCat },
    { key: "templates", value: templatesCat ? String(templatesCat.count) : "\u2014", cat: templatesCat },
  ];

  return (
    <section className="terminal terminal-view">
      {/* ── Command strip ── */}
      <div className="ws-cmd-strip">
        <div className="ws-cmd-title">WORKSPACE</div>
        <div className="ws-cmd-status">
          <span className="ws-cmd-status-key">workspace:</span>
          <span className={`ws-cmd-status-val ${statusClass}`}>{statusText}</span>
          <span className="ws-cmd-sep">|</span>
          <span className="ws-cmd-status-key">path:</span>
          <span className="ws-cmd-path">{resolvedPath}</span>
        </div>
        <div className="ws-cmd-actions">
          <button className="btn btn-sm" onClick={onRefreshDiagnostics}>
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
          <button className="btn btn-sm" onClick={() => onSetWorkspacePath(null)}>
            use default
          </button>
        </div>
      </div>

      {/* ── Main cockpit grid ── */}
      {appSettings && (
        <div className="ws-cockpit">
          {/* ── Left pane: status console + create flow ── */}
          <div className="ws-left">
            {/* Status console */}
            <div className="ws-pane">
              <div className="ws-pane-label">STATUS</div>
              <div className="ws-status-list">
                {statusRows.length > 0 ? (
                  statusRows.map(row => (
                    <div key={row.key} className="ws-status-row">
                      <span className="ws-status-key">{row.key}</span>
                      <span className={`ws-status-val ${row.ok ? "ws-color-ok" : row.warn ? "ws-color-warn" : "ws-color-dim"}`}>
                        {row.value}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="ws-status-row ws-color-dim">waiting for diagnostics</div>
                )}
                {summary && (
                  resourceRows.map(row => (
                    <div key={row.key} className="ws-status-row">
                      <span className="ws-status-key">{row.key}</span>
                      <span className={`ws-status-val ${row.cat && row.cat.count > 0 ? "ws-color-ok" : "ws-color-dim"}`}>
                        {row.value}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Path input */}
            <div className="ws-pane">
              <div className="ws-pane-label">PATH</div>
              <div className="ws-path-row">
                <input
                  className="settings-input ws-path-input"
                  type="text"
                  placeholder="default (env or repo default)"
                  value={appSettings.workspace_path ?? ""}
                  onChange={e => onSetWorkspacePath(e.target.value || null)}
                />
              </div>
            </div>

            {/* Diagnotic details */}
            {diag && (
              <div className="ws-pane">
                <div className="ws-pane-label">DIAGNOSTICS</div>
                <div className="ws-diag-list">
                  {diag.resolved_path && diag.resolved_path !== diag.candidate_path && (
                    <div className="ws-diag-row">
                      <span className="ws-diag-key">candidate</span>
                      <span className="ws-diag-val">{diag.candidate_path}</span>
                    </div>
                  )}
                  {diag.error && (
                    <div className="ws-diag-row ws-color-fail">{diag.error}</div>
                  )}
                  {missingMarkers.length > 0 && (
                    <div className="ws-missing-list">
                      {missingMarkers.map((m, i) => (
                        <div key={i} className="ws-diag-row ws-color-fail">
                          missing {m.kind}: {m.path}
                        </div>
                      ))}
                    </div>
                  )}
                  {diag.valid && missingMarkers.length === 0 && (
                    <div className="ws-diag-row ws-color-ok">all markers present</div>
                  )}
                </div>
              </div>
            )}

            {/* Create workspace command flow */}
            <div className="ws-pane">
              <div className="ws-pane-label">CREATE</div>

              {/* No plan */}
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

              {/* Plan warning */}
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

              {/* Plan ok */}
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

              {/* Create result */}
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

          {/* ── Right pane: system map + resources + create eligibility ── */}
          <div className="ws-right">
            {/* System map */}
            <div className="ws-pane">
              <div className="ws-pane-label">SYSTEM MAP</div>
              <div className="ws-map">
                {!diag && <div className="ws-map-scan" />}
                <div className="ws-map-grid">
                  {/* Row 0: workspace spans full width */}
                  <div className="ws-map-row ws-map-row-top">
                    {mapNodes.filter(n => n.id === "workspace").map(node => {
                      const status = mapNodeStatus(diag, summary, node.id);
                      const isExpanded = expandedNode === node.id;
                      return (
                        <button
                          key={node.id}
                          className={`ws-map-btn ${isExpanded ? "ws-map-btn-expanded" : ""}`}
                          onClick={() => setExpandedNode(isExpanded ? null : node.id)}
                          aria-expanded={isExpanded}
                          aria-label={`${node.label} system node`}
                        >
                          <span className={mapNodeClass(status)}>
                            <span className="ws-map-dot" />
                            <span className="ws-map-label">{node.label}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {/* Row 1: rules, scripts, docs */}
                  <div className="ws-map-row ws-map-row-mid">
                    {mapNodes.filter(n => n.id === "rules" || n.id === "scripts" || n.id === "docs").map(node => {
                      const status = mapNodeStatus(diag, summary, node.id);
                      const isExpanded = expandedNode === node.id;
                      return (
                        <button
                          key={node.id}
                          className={`ws-map-btn ${isExpanded ? "ws-map-btn-expanded" : ""}`}
                          onClick={() => setExpandedNode(isExpanded ? null : node.id)}
                          aria-expanded={isExpanded}
                          aria-label={`${node.label} system node`}
                        >
                          <span className={mapNodeClass(status)}>
                            <span className="ws-map-dot" />
                            <span className="ws-map-label">{node.label}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {/* Row 2: configs, skills */}
                  <div className="ws-map-row ws-map-row-bot">
                    {mapNodes.filter(n => n.id === "configs" || n.id === "skills").map(node => {
                      const status = mapNodeStatus(diag, summary, node.id);
                      const isExpanded = expandedNode === node.id;
                      return (
                        <button
                          key={node.id}
                          className={`ws-map-btn ${isExpanded ? "ws-map-btn-expanded" : ""}`}
                          onClick={() => setExpandedNode(isExpanded ? null : node.id)}
                          aria-expanded={isExpanded}
                          aria-label={`${node.label} system node`}
                        >
                          <span className={mapNodeClass(status)}>
                            <span className="ws-map-dot" />
                            <span className="ws-map-label">{node.label}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Node detail pane */}
            {expandedNode && (
              <div className="ws-pane" role="region" aria-label={`${mapNodes.find(n => n.id === expandedNode)?.label} details`}>
                <div className="ws-pane-label">
                  {mapNodes.find(n => n.id === expandedNode)?.label ?? ""} DETAIL
                </div>
                {renderNodeDetails(expandedNode)}
              </div>
            )}

            {/* Bundled starter resources */}
            {summary && (
              <div className="ws-pane">
                <div className="ws-pane-label">RESOURCES</div>
                <div className="ws-resource-strip">
                  {summary.categories.map((cat) => (
                    <span key={cat.label} className={`ws-resource-chip ${cat.label === "Skills" && cat.count > 0 ? "ws-resource-chip-ok" : ""}`}>
                      {cat.label.toLowerCase()} {cat.count}/{cat.files.length}
                    </span>
                  ))}
                </div>
                <div className="ws-resource-details">
                  <div className="ws-resource-desc">{summary.description}</div>
                  {summary.categories.map((cat) => (
                    <details key={cat.label} className="ws-resource-cat" open={cat.label === "Skills"}>
                      <summary className="ws-resource-header">
                        <span className="ws-resource-name">{cat.label}</span>
                        <span className="ws-resource-count">{cat.count}/{cat.files.length}</span>
                      </summary>
                      <div className="ws-resource-files">
                        {cat.files.map((f, fi) => (
                          <div key={fi} className={`ws-file-row ${f.exists ? "" : "ws-file-missing"}`}>
                            <span className={`ws-dot ${f.exists ? "ws-dot-ok" : "ws-dot-fail"}`}>&#x25CF;</span>
                            <span className="ws-file-path">{f.path}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
