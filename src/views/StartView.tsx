import { SetupLifecycle, type SetupLifecycleProps } from "../components/SetupLifecycle";
import { WorkspaceVerify } from "../components/WorkspaceVerify";
import type { ActionResult } from "../components/TerminalOutput";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import { DEFAULT_WORKSPACE_PATH } from "../lib/settingsDraft";
import type { BundledResourcesStatus, StatusData, WorkspaceDiagnostics } from "../types";

export type InstalledWorkspaceChip = "CHECKING" | "INSTALLED" | "MISSING" | "NEEDS REPAIR";

interface StartViewProps {
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  installState: InstalledWorkspaceChip;
  installRunning: boolean;
  repairRunning: boolean;
  onRefreshDiagnostics: () => void;
  onInstall: () => void;
  onRepair: () => void;
  onUpdateResources: () => void;
  onOpenFolder: () => void;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  wsRunning: string | null;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  canRunReleaseCheck: boolean;
  onRefreshStatus: () => void;
  onReleaseCheck: () => void;
  backupCount: number;
  onRefreshBackups: () => void;
  onOpenBackupsFolder: () => void;
  runSetupTask: SetupLifecycleProps["runSetupTask"];
}

function chipClass(state: InstalledWorkspaceChip): string {
  switch (state) {
    case "INSTALLED":
      return "ws-status-valid";
    case "MISSING":
      return "ws-status-invalid";
    case "NEEDS REPAIR":
      return "ws-status-invalid";
    default:
      return "ws-status-dim";
  }
}

function statusCopy(state: InstalledWorkspaceChip): string {
  switch (state) {
    case "INSTALLED":
      return "Local runtime workspace is ready.";
    case "MISSING":
      return `Install bundled workspace resources to ${DEFAULT_WORKSPACE_PATH}.`;
    case "NEEDS REPAIR":
      return "Workspace exists but required files are missing.";
    default:
      return "Checking installed workspace\u2026";
  }
}

export function deriveInstallState(diag: WorkspaceDiagnostics | null): InstalledWorkspaceChip {
  if (!diag) return "CHECKING";
  if (diag.valid) return "INSTALLED";
  if (!diag.resolved_path) return "MISSING";
  return "NEEDS REPAIR";
}

export function needsBundledResourcesUpdate(diag: WorkspaceDiagnostics | null): boolean {
  return diag?.valid === true && diag.bundled_resources_status === "missing";
}

export function workspaceStatusDetail(
  installState: InstalledWorkspaceChip,
  diag: WorkspaceDiagnostics | null,
): string {
  if (needsBundledResourcesUpdate(diag)) {
    const count = diag?.missing_bundled_count ?? 0;
    const sample = diag?.missing_bundled_sample ?? [];
    const sampleHint =
      sample.length > 0 ? ` Missing examples: ${sample.slice(0, 3).join(", ")}.` : "";
    return (
      `Workspace is installed. ${count} bundled file(s) from this app are not in the workspace yet` +
      " (for example Library prompt templates)." +
      " Update resources copies only missing bundled files; existing files are kept." +
      sampleHint
    );
  }
  return statusCopy(installState);
}

function formatBundledMeta(status: BundledResourcesStatus, count: number): string | null {
  if (status === "current") return null;
  return count === 1 ? "1 bundled file missing" : `${count} bundled files missing`;
}

export function runStartViewBundledSelfTests(): void {
  const base: WorkspaceDiagnostics = {
    candidate_path: DEFAULT_WORKSPACE_PATH,
    resolved_path: DEFAULT_WORKSPACE_PATH,
    valid: true,
    error: null,
    markers: [],
    enabled_rule_targets: 0,
    total_rule_targets: 0,
    enabled_config_targets: 0,
    total_config_targets: 0,
    backup_root: "",
    backup_root_exists: false,
    release_check_available: false,
    bundled_resources_status: "current",
    missing_bundled_count: 0,
    missing_bundled_sample: [],
  };

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  assert(deriveInstallState(base) === "INSTALLED", "valid workspace stays INSTALLED");
  assert(
    deriveInstallState({ ...base, valid: true, bundled_resources_status: "missing", missing_bundled_count: 2 }) === "INSTALLED",
    "missing bundled files must not flip install state to NEEDS REPAIR",
  );
  assert(!needsBundledResourcesUpdate(base), "current bundled status needs no update");
  assert(
    needsBundledResourcesUpdate({ ...base, bundled_resources_status: "missing", missing_bundled_count: 1 }),
    "missing bundled on valid workspace needs update",
  );
  assert(
    !needsBundledResourcesUpdate({ ...base, valid: false, bundled_resources_status: "missing", missing_bundled_count: 1 }),
    "invalid workspace must not offer update resources",
  );
  assert(
    workspaceStatusDetail("INSTALLED", { ...base, bundled_resources_status: "missing", missing_bundled_count: 3 }).includes("Update resources"),
    "stale detail must mention update resources",
  );
}

export function StartView({
  workspaceDiagnostics,
  installState,
  installRunning,
  repairRunning,
  onRefreshDiagnostics,
  onInstall,
  onRepair,
  onUpdateResources,
  onOpenFolder,
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  activityIndex,
  activityCellClass,
  status,
  workspaceValid,
  gitAvailable,
  canRunReleaseCheck,
  onRefreshStatus,
  onReleaseCheck,
  backupCount,
  onRefreshBackups,
  onOpenBackupsFolder,
  runSetupTask,
}: StartViewProps) {
  const resolvedPath = workspaceDiagnostics?.resolved_path ?? workspaceDiagnostics?.candidate_path ?? null;
  const showUpdateResources = needsBundledResourcesUpdate(workspaceDiagnostics);
  const statusDetail = workspaceStatusDetail(installState, workspaceDiagnostics);
  const bundledMeta = workspaceDiagnostics
    ? formatBundledMeta(workspaceDiagnostics.bundled_resources_status, workspaceDiagnostics.missing_bundled_count)
    : null;
  const showInstall = installState === "MISSING";
  const showRepair = installState === "NEEDS REPAIR";
  const canOpenFolder = Boolean(resolvedPath) && installState !== "MISSING";
  const actionBusy = installRunning || repairRunning;

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
                OpenCode, Cursor, and Claude. Does not run agents for you. Writes are explicit; sync,
                install, and release actions run scripts from the installed workspace.
              </p>
            </div>
          </div>

          <div className="start-workspace-card ws-panel">
            <div className="start-workspace-card-head">
              <div className="start-workspace-card-title">
                <span className="ws-panel-title">WORKSPACE</span>
                <span className={`ws-status-chip ${chipClass(installState)}`}>{installState}</span>
              </div>
            </div>

            <div className="start-workspace-path-block">
              <div className="start-workspace-path-entry">
                <span className="start-workspace-path-label">installed path</span>
                <code className="start-workspace-path-value" title={DEFAULT_WORKSPACE_PATH}>
                  {DEFAULT_WORKSPACE_PATH}
                </code>
              </div>
              {resolvedPath && resolvedPath !== DEFAULT_WORKSPACE_PATH && (
                <div className="start-workspace-path-entry start-workspace-path-entry-resolved">
                  <span className="start-workspace-path-label">resolved</span>
                  <code className="start-workspace-path-resolved-value" title={resolvedPath}>
                    {resolvedPath}
                  </code>
                </div>
              )}
            </div>

            <p className="start-workspace-status-detail ws-path-status-detail" role="status">
              {statusDetail}
            </p>

            {bundledMeta && (
              <div className="start-workspace-status-row" role="status" aria-live="polite">
                <div className="start-workspace-status-meta">
                  <span className="start-workspace-status-sep" aria-hidden="true">
                    ·
                  </span>
                  <span>{bundledMeta}</span>
                </div>
              </div>
            )}

            <div className="ws-action-row start-workspace-actions">
              <button
                className="btn btn-sm"
                onClick={() => {
                  onRefreshDiagnostics();
                  onRefreshStatus();
                }}
                disabled={actionBusy}
              >
                refresh
              </button>
              {showInstall && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={onInstall}
                  disabled={actionBusy}
                >
                  {installRunning ? "installing\u2026" : "install"}
                </button>
              )}
              {showRepair && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={onRepair}
                  disabled={actionBusy}
                  aria-busy={repairRunning || undefined}
                >
                  {repairRunning ? "repairing\u2026" : "repair"}
                </button>
              )}
              {showUpdateResources && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={onUpdateResources}
                  disabled={actionBusy}
                  aria-busy={repairRunning || undefined}
                >
                  {repairRunning ? "updating\u2026" : "update resources"}
                </button>
              )}
              <button
                className="btn btn-sm"
                onClick={onOpenFolder}
                disabled={!canOpenFolder || actionBusy}
              >
                open folder
              </button>
            </div>
          </div>

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

          {workspaceValid && (
            <SetupLifecycle
              workspacePath={status?.repo_path ?? null}
              wsRunning={wsRunning}
              runSetupTask={runSetupTask}
            />
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
