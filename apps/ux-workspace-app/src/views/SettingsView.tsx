import type { AgentTargetMeta, AppSettings, CreateWorkspacePlan, CreateWorkspaceResult, DefaultWorkspaceSummary, TargetProfileMeta, WorkspaceDiagnostics } from "../types";

interface SettingsMessage {
  ok: boolean;
  text: string;
}

interface SettingsViewProps {
  appSettings: AppSettings | null;
  settingsMsg: SettingsMessage | null;
  agentTargets: AgentTargetMeta[];
  targetProfiles: TargetProfileMeta[];
  activeProfileId: string | null;
  onSetAppearance: (appearance: AppSettings["appearance"]) => void;
  onSetWorkspacePath: (value: string | null) => void;
  onChooseWorkspaceFolder: () => void;
  onToggleTarget: (id: string) => void;
  onApplyProfile: (profileId: string) => void;
  onSave: () => void;
  onReset: () => void;
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

export function SettingsView({
  appSettings,
  settingsMsg,
  agentTargets,
  targetProfiles,
  activeProfileId,
  onSetAppearance,
  onSetWorkspacePath,
  onChooseWorkspaceFolder,
  onToggleTarget,
  onApplyProfile,
  onSave,
  onReset,
  workspaceDiagnostics,
  onRefreshDiagnostics,
  defaultWorkspaceSummary,
  createPlan,
  createPlanRunning,
  onPlanCreate,
  createResult,
  createRunning,
  onCreateWorkspace,
}: SettingsViewProps) {
  const diag = workspaceDiagnostics;
  const missingMarkers = diag?.markers.filter(m => !m.exists) ?? [];
  return (
    <section className="terminal terminal-view">
      <div className="terminal-topline">
        <span className="terminal-title">SETTINGS</span>
      </div>
      {appSettings && (
        <div className="settings-form">
          <div className="settings-group">
            <span className="cell-label">APPEARANCE</span>
            <div className="settings-options">
              {(["dark", "light", "system"] as const).map(m => (
                <button key={m} className={`btn btn-sm ${appSettings.appearance === m ? "btn-active" : ""}`}
                  onClick={() => onSetAppearance(m)}>{m}</button>
              ))}
            </div>
          </div>
          <div className="settings-group">
            <span className="cell-label">WORKSPACE PATH</span>
            <input className="settings-input" type="text"
              placeholder="default (env or repo default)"
              value={appSettings.workspace_path ?? ""}
              onChange={e => onSetWorkspacePath(e.target.value || null)} />
            <button className="btn btn-sm settings-path-button" onClick={onChooseWorkspaceFolder}>choose folder</button>
            <button className="btn btn-sm settings-path-button" onClick={() => onSetWorkspacePath(null)}>use default</button>
          </div>
          <div className="settings-path-hint">
            Use the specific workspace folder. For a new workspace, enter the child folder to create, not only a broad parent folder.
          </div>

          <div className="workspace-diagnostics">
            {!diag ? (
              <div className="workspace-diagnostics-row workspace-valid">loading diagnostics…</div>
            ) : (
              <>
                <div className={`workspace-diagnostics-row settings-diag-validity ${diag.valid ? "workspace-valid" : "workspace-invalid"}`}>
                  {diag.valid ? "valid workspace" : "invalid workspace"}
                </div>
                <div className="workspace-diagnostics-row">
                  <span className="cell-label-sm">candidate</span>
                  <span className="cell-value-trunc">{diag.candidate_path}</span>
                </div>
                {diag.resolved_path && diag.resolved_path !== diag.candidate_path && (
                  <div className="workspace-diagnostics-row">
                    <span className="cell-label-sm">resolved</span>
                    <span className="cell-value-trunc">{diag.resolved_path}</span>
                  </div>
                )}
                {diag.error && (
                  <div className="workspace-diagnostics-row workspace-invalid">{diag.error}</div>
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
                  <div className="workspace-diagnostics-row workspace-valid">all markers present</div>
                )}
                {!diag.valid && (
                  <div className="workspace-diagnostics-row settings-diag-help">
                    set this path to an existing workspace folder, or create a new one below.
                  </div>
                )}
                <div className="workspace-diagnostics-row">
                  <button className="btn btn-sm" onClick={onRefreshDiagnostics}>refresh</button>
                </div>
              </>
            )}
          </div>

          <div className={`create-plan-section ${diag && !diag.valid ? "create-plan-section-attention" : ""}`}>
            <div className="create-plan-header">
              <button
                className="btn btn-sm"
                onClick={onPlanCreate}
                disabled={!appSettings || createPlanRunning}
              >
                {createPlanRunning ? "planning..." : "dry-run create workspace"}
              </button>
              <span className="create-plan-badge">read-only</span>
              <span className="create-plan-badge">no overwrite</span>
              <span className="create-plan-badge">no scripts</span>
            </div>
            <div className="create-plan-row create-plan-muted">
              Dry-run checks the current workspace path. Creation is only enabled for a missing folder with an existing parent, or an empty existing folder.
            </div>
            {!appSettings && (
              <div className="create-plan-row create-plan-muted">settings not loaded</div>
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
                    {createRunning ? "creating..." : "create workspace"}
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

          {defaultWorkspaceSummary && (
            <div className="defaults-preview">
              <div className="defaults-preview-header">
                <span className="cell-label">BUNDLED STARTER</span>
                <span className="defaults-preview-badge">read-only</span>
              </div>
              <div className="defaults-preview-desc">{defaultWorkspaceSummary.description}</div>
              <div className="defaults-summary-row">
                {defaultWorkspaceSummary.categories.map((cat, ci) => (
                  <span key={ci} className={`defaults-summary-chip ${cat.label === "Skills" && cat.count > 0 ? "defaults-summary-chip-good" : ""}`}>
                    {cat.label} {cat.count}/{cat.files.length}
                  </span>
                ))}
              </div>
              <div className="defaults-preview-categories">
                {defaultWorkspaceSummary.categories.map((cat, ci) => (
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

          {targetProfiles.length > 0 && (
            <div className="settings-group settings-group-top">
              <span className="cell-label">TARGET PROFILES</span>
              <div className="settings-profile-list">
                {targetProfiles.map(p => (
                  <div key={p.id} className="settings-profile-row">
                    <button
                      className={`btn btn-sm settings-profile-button ${activeProfileId === p.id ? "settings-profile-active" : ""}`}
                      onClick={() => onApplyProfile(p.id)}
                    >
                      {p.label}
                    </button>
                    <span className={`settings-profile-description ${activeProfileId === p.id ? "settings-profile-desc-active" : ""}`}>
                      {p.description}
                    </span>
                  </div>
                ))}
                {activeProfileId === null && (
                  <div className="settings-profile-custom">
                    <span className="settings-profile-description">custom selection</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="settings-group settings-group-top">
            <span className="cell-label">AGENT RULE TARGETS</span>
            <div className="settings-target-list">
              {agentTargets.filter(t => t.kind === "rules").map(t => (
                <label key={t.id} className="settings-target-row" onClick={() => onToggleTarget(t.id)}>
                  <span className={`install-checkbox ${appSettings.enabled_target_ids.includes(t.id) ? "install-checkbox-on" : ""}`}>
                    {appSettings.enabled_target_ids.includes(t.id) ? "x" : ""}
                  </span>
                  <span className="cell-value">{t.label}</span>
                  <span className="settings-target-path">{t.target_rel}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="settings-group settings-group-top">
            <span className="cell-label">CONFIG TARGETS</span>
            <div className="settings-target-list">
              {agentTargets.filter(t => t.kind === "config").map(t => (
                <label key={t.id} className="settings-target-row" onClick={() => onToggleTarget(t.id)}>
                  <span className={`install-checkbox ${appSettings.enabled_target_ids.includes(t.id) ? "install-checkbox-on" : ""}`}>
                    {appSettings.enabled_target_ids.includes(t.id) ? "x" : ""}
                  </span>
                  <span className="cell-value">{t.label}</span>
                  <span className="settings-target-path">{t.target_rel}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={onSave}>save</button>
            <button className="btn" onClick={onReset}>reset defaults</button>
          </div>
          {settingsMsg && (
            <div className={`settings-msg ${settingsMsg.ok ? "log-ok" : "log-fail"}`}>
              <span className="log-prompt">$</span> {settingsMsg.text}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
