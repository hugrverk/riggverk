import { useState } from "react";
import { WorkspaceVerify } from "../components/WorkspaceVerify";
import type { ActionResult } from "../components/TerminalOutput";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import { DEFAULT_WORKSPACE_PATH } from "../lib/settingsDraft";
import type {
  AppSettings,
  CreateWorkspacePlan,
  CreateWorkspaceResult,
  InitializeWorkspaceResult,
  StatusData,
  WorkspaceDiagnostics,
  WorkspaceSetupEvaluation,
} from "../types";

const NO_WORKSPACE_SELECTED = "no workspace selected";

interface StartViewProps {
  appSettings: AppSettings | null;
  pathDraft: string;
  onPathDraftChange: (value: string) => void;
  onCheckPath: () => void;
  onUseDefaultWorkspace: () => void;
  onChooseWorkspaceFolder: () => void;
  onClearActiveWorkspace: () => void;
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  workspaceSetup: WorkspaceSetupEvaluation | null;
  setupEvaluating: boolean;
  onRefreshDiagnostics: () => void;
  createPlan: CreateWorkspacePlan | null;
  createPlanRunning: boolean;
  onPlanCreate: () => void;
  createResult: CreateWorkspaceResult | null;
  createRunning: boolean;
  onCreateWorkspace: () => void;
  initResult: InitializeWorkspaceResult | null;
  initRunning: boolean;
  onInitializeWorkspace: () => void;
  onActivateWorkspace: () => void;
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

function PlannedFilesList({ files, label }: { files: string[]; label: string }) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;

  return (
    <div className="ws-setup-files">
      <button type="button" className="ws-setup-files-toggle btn btn-sm" onClick={() => setOpen(v => !v)}>
        {open ? "hide" : "show"} {label} ({files.length})
      </button>
      {open && (
        <ul className="ws-setup-files-list" aria-label={label}>
          {files.map(file => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SetupFlowPanel({
  setupPhase,
  createPlan,
  createPlanRunning,
  createResult,
  createRunning,
  initResult,
  initRunning,
  missingFilesToAdd,
  onPlanCreate,
  onCreateWorkspace,
  onInitializeWorkspace,
  onActivateWorkspace,
}: {
  setupPhase: string | null;
  createPlan: CreateWorkspacePlan | null;
  createPlanRunning: boolean;
  createResult: CreateWorkspaceResult | null;
  createRunning: boolean;
  initResult: InitializeWorkspaceResult | null;
  initRunning: boolean;
  missingFilesToAdd: string[];
  onPlanCreate: () => void;
  onCreateWorkspace: () => void;
  onInitializeWorkspace: () => void;
  onActivateWorkspace: () => void;
}) {
  const [confirmNonEmpty, setConfirmNonEmpty] = useState(false);
  const createPlanEligible =
    createPlan && (createPlan.status === "missing_directory" || createPlan.status === "empty_existing_directory");
  const filesForCreate = createPlan?.planned_files ?? [];
  const filesToAdd = missingFilesToAdd.length > 0 ? missingFilesToAdd : filesForCreate;

  return (
    <div className="ws-setup-actions">
      {!createPlan && !createResult && !initResult && (
        <div className="ws-setup-action-row">
          <button className="btn btn-sm btn-primary" onClick={onPlanCreate} disabled={createPlanRunning}>
            {createPlanRunning ? "checking\u2026" : "check path"}
          </button>
          <span className="ws-setup-hint">validate the selected path before activating or initializing</span>
        </div>
      )}

      {createPlan && (
        <div className="ws-setup-plan">
          <div className={`ws-cmd-row ${createPlan.ok ? "ws-color-ok" : "ws-color-fail"}`}>
            <span className="ws-cmd-prompt">{setupPhase === "blocked_non_empty" ? "blocked" : createPlan.ok ? "ready" : "blocked"}</span>
            <span>{createPlan.status}</span>
          </div>
          <div className="ws-cmd-row ws-color-dim">selected: {createPlan.target_path || "(empty)"}</div>
          <div className="ws-cmd-row">{createPlan.reason}</div>
          {createPlan.warnings.map((w, i) => (
            <div key={i} className="ws-cmd-row ws-color-fail">{w}</div>
          ))}

          {setupPhase === "blocked_non_empty" && (
            <div className="ws-setup-blocked-note" role="note">
              <p>
                This folder already contains files and is missing workspace markers. Initialization adds only
                missing bundled files and does not overwrite existing files.
              </p>
              <PlannedFilesList files={filesToAdd} label="files to add" />
              <label className="ws-setup-confirm">
                <input
                  type="checkbox"
                  checked={confirmNonEmpty}
                  onChange={(e) => setConfirmNonEmpty(e.target.checked)}
                />
                I understand {filesToAdd.length} missing file(s) may be added here
              </label>
              <div className="ws-setup-create-action">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={onInitializeWorkspace}
                  disabled={!confirmNonEmpty || initRunning}
                >
                  {initRunning ? "initializing\u2026" : "initialize workspace"}
                </button>
                <span className="ws-tag">no overwrite</span>
                <span className="ws-tag">explicit only</span>
              </div>
            </div>
          )}

          {setupPhase === "valid_existing" && (
            <div className="ws-setup-create-action">
              <button className="btn btn-sm btn-primary" onClick={onActivateWorkspace}>
                use this workspace
              </button>
              <span className="ws-setup-hint">path is already a valid workspace</span>
            </div>
          )}

          {setupPhase === "ready_create" && (
            <>
              <PlannedFilesList files={filesForCreate} label="planned files" />
              {createPlanEligible && (
                <div className="ws-setup-create-action">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={onCreateWorkspace}
                    disabled={createRunning}
                  >
                    {createRunning ? "creating\u2026" : "create workspace"}
                  </button>
                  <span className="ws-tag">{filesForCreate.length} files</span>
                  <span className="ws-tag">no overwrite</span>
                  <span className="ws-tag">no scripts</span>
                </div>
              )}
            </>
          )}

          {setupPhase === "blocked" && (
            <p className="ws-setup-hint">Choose another folder or enter a different path, then check again.</p>
          )}
        </div>
      )}

      {(createResult || initResult) && (
        <div className="ws-setup-result">
          {(() => {
            const result = initResult ?? createResult;
            if (!result) return null;
            return (
              <>
                <div className={`ws-cmd-row ${result.success ? "ws-color-ok" : "ws-color-fail"}`}>
                  <span className="ws-cmd-prompt">{result.success ? "ok" : "fail"}</span>
                  <span>{"message" in result ? result.message : ""}</span>
                </div>
                <div className="ws-cmd-row ws-color-dim">status: {result.status} | target: {result.target_path}</div>
                {result.copied_files.length > 0 && (
                  <div className="ws-cmd-row ws-color-dim">copied {result.copied_files.length} file(s)</div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

export function StartView({
  appSettings,
  pathDraft,
  onPathDraftChange,
  onCheckPath,
  onUseDefaultWorkspace,
  onChooseWorkspaceFolder,
  onClearActiveWorkspace,
  workspaceDiagnostics,
  workspaceSetup,
  setupEvaluating,
  onRefreshDiagnostics,
  createPlan,
  createPlanRunning,
  onPlanCreate,
  createResult,
  createRunning,
  onCreateWorkspace,
  initResult,
  initRunning,
  onInitializeWorkspace,
  onActivateWorkspace,
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
  const noActiveWorkspace = diag?.error === NO_WORKSPACE_SELECTED;
  const activePath = workspaceValid ? appSettings?.workspace_path ?? null : null;
  const selectedPath = workspaceSetup?.candidate_path ?? (pathDraft.trim() || null);
  const setupPhase = workspaceSetup?.setup_phase ?? null;
  const pathCheckDisabled = !pathDraft.trim() || setupEvaluating;

  const statusText = !diag
    ? "LOADING"
    : workspaceValid
      ? "VALID"
      : noActiveWorkspace
        ? "SETUP"
        : "PENDING";

  const statusClass = !diag
    ? "ws-status-dim"
    : workspaceValid
      ? "ws-status-valid"
      : noActiveWorkspace
        ? "ws-status-dim"
        : "ws-status-invalid";

  const statusDetail = !diag
    ? "loading"
    : workspaceValid
      ? "valid"
      : noActiveWorkspace
        ? "choose or create a workspace"
        : setupPhase === "blocked_non_empty"
          ? "blocked — confirm initialization or choose another folder"
          : "check path and initialize";

  const showSetupPanel = !workspaceValid;

  return (
    <section className="ws-layout ws-layout-start">
      <div className="ws-shell">
        <div className="ws-left start-left" role="region" aria-label="Workspace start">
          <div className="start-overview" role="region" aria-label="About Agent Workspace">
            <h1 className="start-overview-title">Agent Workspace</h1>
            <div className="start-overview-body">
              <p className="start-overview-copy">
                A local control panel for your AI-agent workspace. Keeps rules, skills, configs, docs, and
                install/sync scripts in one versioned folder, then lets you preview and apply changes to Codex,
                OpenCode, Cursor, Auggie, and Claude. Does not run agents for you. Writes are explicit; sync,
                install, and release actions run scripts from the selected workspace.
              </p>
            </div>
          </div>

          <div className="start-workspace-card ws-panel">
            <div className="start-workspace-card-head">
              <div className="start-workspace-card-title">
                <span className="ws-panel-title">WORKSPACE</span>
                <span className={`ws-status-chip ${statusClass}`}>{statusText}</span>
              </div>
            </div>

            {activePath && (
              <div className="start-workspace-path-row ws-path-row">
                <span className="ws-path-label">active path</span>
                <code className="start-workspace-path-value" title={activePath}>{activePath}</code>
              </div>
            )}

            <div className="start-workspace-path-editor ws-path-row" role="group" aria-label="Workspace path setup">
              <label className="ws-path-label" htmlFor="workspace-path-input">
                {activePath ? "new path" : "selected path"}
              </label>
              <input
                id="workspace-path-input"
                className="ws-path-input"
                type="text"
                spellCheck={false}
                autoComplete="off"
                placeholder={DEFAULT_WORKSPACE_PATH}
                value={pathDraft}
                onChange={(e) => onPathDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !pathCheckDisabled) onCheckPath();
                }}
              />
              <button
                className="btn btn-sm btn-primary"
                onClick={onCheckPath}
                disabled={pathCheckDisabled}
                title="Validate this path without making it active"
              >
                {setupEvaluating ? "checking\u2026" : "check path"}
              </button>
            </div>

            {selectedPath && selectedPath !== activePath && (
              <div className="start-workspace-path-row ws-path-row">
                <span className="ws-path-label">candidate</span>
                <code className="start-workspace-path-value" title={selectedPath}>{selectedPath}</code>
                {setupPhase && <span className="ws-setup-phase-tag">{setupPhase.replaceAll("_", " ")}</span>}
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
              <button className="btn btn-sm" onClick={onChooseWorkspaceFolder}>
                choose folder
              </button>
              <button
                className="btn btn-sm"
                onClick={onUseDefaultWorkspace}
                disabled={createPlanRunning || createRunning || initRunning}
              >
                use default
              </button>
              {activePath && (
                <button className="btn btn-sm" onClick={onClearActiveWorkspace}>
                  clear active
                </button>
              )}
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
                  <span className="start-workspace-status-sep" aria-hidden="true">|</span>
                  <span>{status.enabled_rule_target_ids.length} rule targets</span>
                </div>
              ) : (
                <span className="ws-panel-meta-context">waiting for status</span>
              )}
            </div>

            {showSetupPanel && (
              <div className="ws-path-status-detail start-workspace-status-detail">{statusDetail}</div>
            )}
          </div>

          {showSetupPanel && (
            <div className="ws-setup" role="region" aria-label="Workspace setup">
              <div className="ws-setup-heading">Workspace Setup</div>
              <div className="ws-setup-body">
                {noActiveWorkspace && !workspaceSetup && (
                  <p className="ws-setup-hint">
                    Enter a path, click <strong>check path</strong>, choose a folder, or use <strong>use default</strong>{" "}
                    ({DEFAULT_WORKSPACE_PATH}). The path becomes active only after it validates or you create/initialize
                    it.
                  </p>
                )}
                <SetupFlowPanel
                  setupPhase={setupPhase}
                  createPlan={createPlan}
                  createPlanRunning={createPlanRunning}
                  createResult={createResult}
                  createRunning={createRunning}
                  initResult={initResult}
                  initRunning={initRunning}
                  missingFilesToAdd={workspaceSetup?.missing_files_to_add ?? []}
                  onPlanCreate={onPlanCreate}
                  onCreateWorkspace={onCreateWorkspace}
                  onInitializeWorkspace={onInitializeWorkspace}
                  onActivateWorkspace={onActivateWorkspace}
                />
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
                Skills install moved to target pages. Open a harness page to preview and install skills for that tool only.
              </p>
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
