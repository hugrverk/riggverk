import { HarnessInstallationCard } from "../components/HarnessInstallationCard";
import { InstalledStateMap } from "../components/InstalledStateMap";
import { UninstallCard } from "../components/UninstallCard";
import { UninstallRecoveryCard } from "../components/UninstallRecoveryCard";
import { WorkspaceVerify } from "../components/WorkspaceVerify";
import type { ActionResult } from "../components/TerminalOutput";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import { WORKSPACE_SURFACES } from "../lib/harnessInstallation";
import { DEFAULT_WORKSPACE_PATH } from "../lib/settingsDraft";
import type { InstallAgent, StatusData, WorkspaceDiagnostics } from "../types";

interface StartViewProps {
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  onManagedUpdate: (surfaces: string[], label: string) => void;
  onUninstall: (planFingerprint: string, previewToken: string) => void;
  uninstallRecoveryTransactionId: string | null;
  onUninstallRollback: () => Promise<boolean>;
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
  onReleaseCheck: () => void;
  backupCount: number;
  onRefreshBackups: () => void;
  onOpenBackupsFolder: () => void;
  enabledHarnessIds: InstallAgent[];
}

export function StartView({
  workspaceDiagnostics,
  onManagedUpdate,
  onUninstall,
  uninstallRecoveryTransactionId,
  onUninstallRollback,
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
  onReleaseCheck,
  backupCount,
  onRefreshBackups,
  onOpenBackupsFolder,
  enabledHarnessIds,
}: StartViewProps) {
  const resolvedPath =
    workspaceDiagnostics?.resolved_path
    ?? workspaceDiagnostics?.candidate_path
    ?? DEFAULT_WORKSPACE_PATH;
  const busy = wsRunning !== null;

  return (
    <section className="ws-layout ws-layout-start">
      <div className="ws-shell">
        <div className="ws-left start-left" role="region" aria-label="Workspace start">
          <div className="start-overview" role="region" aria-label="About Agent Workspace">
            <h1 className="start-overview-title">Agent Workspace</h1>
            <div className="start-overview-body">
              <p className="start-overview-copy">
                Install and update one local workspace for rules, skills, agents, configs, and
                documentation. Unknown or modified files are preserved for review.
              </p>
            </div>
          </div>

          <HarnessInstallationCard
            surfaces={WORKSPACE_SURFACES}
            title="Workspace installation"
            description="Installs or updates the managed runtime workspace from this application bundle."
            workspaceValid
            busy={busy}
            onUpdate={onManagedUpdate}
            path={resolvedPath}
            secondaryAction={{
              label: "open folder",
              onClick: onOpenFolder,
              disabled: !workspaceValid || busy,
            }}
          />

          <WorkspaceVerify
            workspaceValid={workspaceValid}
            wsRunning={wsRunning}
            canRunReleaseCheck={canRunReleaseCheck}
            backupCount={backupCount}
            onReleaseCheck={onReleaseCheck}
            onRefreshBackups={onRefreshBackups}
            onOpenBackupsFolder={onOpenBackupsFolder}
          />

          <InstalledStateMap
            workspaceValid={workspaceValid}
            busy={busy}
            refreshToken={wsLogCompletedAt}
            enabledHarnessIds={enabledHarnessIds}
          />

          <UninstallCard
            workspaceValid={workspaceValid}
            busy={busy}
            onApply={onUninstall}
          />

          <UninstallRecoveryCard
            transactionId={uninstallRecoveryTransactionId}
            busy={busy}
            onRollback={onUninstallRollback}
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
          statusText={workspaceValid ? "current workspace available" : "workspace installation required"}
        />
      </div>
    </section>
  );
}
