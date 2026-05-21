import { WorkspaceVerify } from "../components/WorkspaceVerify";
import type { ActionResult } from "../components/TerminalOutput";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { AppSettings, CreateWorkspacePlan, CreateWorkspaceResult, StatusData, WorkspaceDiagnostics } from "../types";

interface StartViewProps {
  appSettings: AppSettings | null;
  onApplyWorkspacePath: (value: string | null) => void;
  onChooseWorkspaceFolder: () => void;
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  onRefreshDiagnostics: () => void;
  createPlan: CreateWorkspacePlan | null;
  createPlanRunning: boolean;
  onPlanCreate: () => void;
  createResult: CreateWorkspaceResult | null;
  createRunning: boolean;
  onCreateWorkspace: () => void;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  wsRunning: string | null;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  canRunReleaseCheck: boolean;
  onPull: () => void;
  onRefreshStatus: () => void;
  onReleaseCheck: () => void;
  backupCount: number;
  onRefreshBackups: () => void;
  onOpenBackupsFolder: () => void;
}

export function StartView({
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
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  activityIndex,
  activityCellClass,
  status,
  workspaceValid,
  gitAvailable,
  canRunReleaseCheck,
  onPull,
  onRefreshStatus,
  onReleaseCheck,
  backupCount,
  onRefreshBackups,
  onOpenBackupsFolder,
}: StartViewProps) {
  const diag = workspaceDiagnostics;
  const missingMarkers = diag?.markers.filter(m => !m.exists) ?? [];
  const defaultLabel = "~/Agent Workspace";
  const displayPath = appSettings?.workspace_path ?? defaultLabel;
  const diagnosticsPath = diag?.resolved_path ?? diag?.candidate_path ?? "\u2014";

  const createPlanEligible = createPlan && (createPlan.status === "missing_directory" || createPlan.status === "empty_existing_directory");

  const statusText = !diag
    ? "LOADING"
    : diag.valid
      ? "VALID"
      : "INVALID";

  const statusClass = !diag
    ? "ws-status-dim"
    : diag.valid
      ? "ws-status-valid"
      : "ws-status-invalid";

  const statusDetail = !diag
    ? "loading"
    : diag.valid
      ? "valid"
      : "setup needed";

  return (
    <section className="ws-layout ws-layout-start">
      <div className="ws-shell">
        <div className="ws-left start-left" role="region" aria-label="Workspace start">
          <div className="start-overview" role="region" aria-label="About Agent Workspace">
            <div className="start-overview-header">
              <p className="start-overview-eyebrow">local control panel</p>
              <h1 className="start-overview-title">Agent Workspace</h1>
            </div>
            <div className="start-overview-body">
              <p className="start-overview-copy">
                A local control panel for your AI-agent workspace. Keeps rules, skills, configs, docs, and
                install/sync scripts in one versioned folder, then lets you preview and apply changes to Codex,
                OpenCode, Cursor, Auggie, and Claude. Does not run agents for you. Writes are explicit; sync,
                install, and release actions run scripts from the selected workspace.
              </p>
              <dl className="start-overview-facts">
                <div className="start-overview-fact">
                  <dt>scope</dt>
                  <dd>rules, skills, configs, docs, scripts</dd>
                </div>
                <div className="start-overview-fact">
                  <dt>storage</dt>
                  <dd>versioned workspace folder</dd>
                </div>
                <div className="start-overview-fact">
                  <dt>targets</dt>
                  <dd>Codex, OpenCode, Cursor, Auggie, Claude</dd>
                </div>
                <div className="start-overview-fact">
                  <dt>agents</dt>
                  <dd>does not run agents</dd>
                </div>
                <div className="start-overview-fact">
                  <dt>writes</dt>
                  <dd>explicit only</dd>
                </div>
                <div className="start-overview-fact">
                  <dt>scripts</dt>
                  <dd>from selected workspace</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="start-workspace-card ws-panel">
            <div className="start-workspace-card-head">
              <div className="start-workspace-card-title">
                <span className="ws-panel-title">WORKSPACE</span>
                <span className={`ws-status-chip ${statusClass}`}>{statusText}</span>
              </div>
              <div className="start-workspace-path-block">
                <span className="start-workspace-path-label">path</span>
                <code className="start-workspace-path-value" title={displayPath}>
                  {displayPath}
                </code>
              </div>
            </div>
            {diag && diagnosticsPath !== displayPath && diagnosticsPath !== "\u2014" && (
              <div className="start-workspace-path-resolved" title={`resolved: ${diagnosticsPath}`}>
                <span className="start-workspace-path-label">resolved</span>
                <span className="start-workspace-path-resolved-value">{diagnosticsPath}</span>
              </div>
            )}
            <div className="ws-action-row start-workspace-actions">
              <button
                className="btn btn-sm"
                onClick={() => {
                  onRefreshDiagnostics();
                  onRefreshStatus();
                }}
              >
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
            <div className="start-workspace-status-row ws-panel-meta-row">
              <button
                className="btn btn-sm btn-primary"
                disabled={!workspaceValid || !gitAvailable || wsRunning !== null}
                onClick={onPull}
              >
                pull
              </button>
              {status ? (
                <div className="start-workspace-status-meta" aria-label="Workspace git and targets">
                  <span>branch {status.branch}</span>
                  <span className="start-workspace-status-sep" aria-hidden="true">
                    |
                  </span>
                  <span>{status.enabled_rule_target_ids.length} rule targets</span>
                  <span className="start-workspace-status-sep" aria-hidden="true">
                    |
                  </span>
                  <span>{status.enabled_config_target_ids.length} config targets</span>
                </div>
              ) : (
                <span className="ws-panel-meta-context">waiting for status</span>
              )}
            </div>
            <div className="start-trust-note" role="note">
              <span className="start-trust-note-label">Trust boundary</span>
              <span className="start-trust-note-copy">
                Sync, install, and release actions run scripts from the selected workspace. Use workspaces you
                control.
              </span>
            </div>
            {diag && !diag.valid && (
              <div className="ws-path-status-detail start-workspace-status-detail">{statusDetail}</div>
            )}
          </div>

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

          {workspaceValid && (
            <div className="start-block start-skills ws-section" role="region" aria-label="Skills install location">
              <div className="ws-section-header start-block-header">
                <span className="ws-section-title">SKILLS</span>
                <span className="start-block-badge">on target pages</span>
              </div>
              <p className="start-block-copy">
                Skills install moved to target pages. Open a harness page to preview and install skills for that
                tool only.
              </p>
              <div className="start-destination-chips" aria-label="Skills install destinations">
                <span className="start-destination-chip">Codex</span>
                <span className="start-destination-chip">OpenCode</span>
                <span className="start-destination-chip">Cursor</span>
                <span className="start-destination-chip">Misc</span>
              </div>
            </div>
          )}

          <WorkspaceVerify
            workspaceValid={workspaceValid}
            wsRunning={wsRunning}
            canRunReleaseCheck={canRunReleaseCheck}
            backupCount={backupCount}
            onReleaseCheck={onReleaseCheck}
            onRefreshBackups={onRefreshBackups}
            onOpenBackupsFolder={onOpenBackupsFolder}
          />

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
        </div>

        <WorkspaceTerminal
          wsRunning={wsRunning}
          wsLog={wsLog}
          wsLogCompletedAt={wsLogCompletedAt}
          activityIndex={activityIndex}
          activityCellClass={activityCellClass}
          status={status}
          workspaceValid={workspaceValid}
          gitAvailable={gitAvailable}
          canRunReleaseCheck={canRunReleaseCheck}
          statusText={statusDetail}
        />
      </div>
    </section>
  );
}
