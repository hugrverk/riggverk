import { TerminalState, type ActionResult } from "../components/TerminalOutput";
import type { BackupRunDetails, BackupRunSummary, WorkspaceDiagnostics } from "../types";

interface HealthViewProps {
  healthLog: ActionResult | null;
  healthRunning: string | null;
  onRunHealthCheck: () => void;
  canRunHealthCheck: boolean;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  backups: BackupRunSummary[];
  onRefreshBackups: () => void;
  onOpenBackupsFolder: () => void;
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  selectedBackupId: string | null;
  backupDetails: BackupRunDetails | null;
  onSelectBackup: (runId: string) => void;
}

function statusClass(status: string): string {
  switch (status) {
    case "matches": return "backup-status-matches";
    case "differs": return "backup-status-differs";
    case "missing": return "backup-status-missing";
    default: return "backup-status-unknown";
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1048576).toFixed(1)}M`;
}

export function HealthView({
  healthLog,
  healthRunning,
  onRunHealthCheck,
  canRunHealthCheck,
  activityIndex,
  activityCellClass,
  backups,
  onRefreshBackups,
  onOpenBackupsFolder,
  workspaceDiagnostics,
  selectedBackupId,
  backupDetails,
  onSelectBackup,
}: HealthViewProps) {
  const diag = workspaceDiagnostics;
  return (
    <section className="configs-frame">
      <header className="configs-frame-header">
        <div className="configs-frame-title">
          <span className="terminal-title">HEALTH</span>
          <span className="cell-value cell-value-muted">release-check</span>
        </div>
        <div className="configs-frame-actions">
          <span className={`configs-frame-status ${healthRunning ? "sync-text" : healthLog ? (healthLog.success ? "sync-text sync-text-ok" : "sync-text sync-text-fail") : "sync-text"}`}>
            {healthRunning ? "running" : healthLog ? (healthLog.success ? "pass" : "fail") : "ready"}
          </span>
          <button className="btn btn-sm btn-primary" disabled={healthRunning !== null || !canRunHealthCheck} onClick={onRunHealthCheck}>run check</button>
        </div>
      </header>
      <div className="configs-frame-body health-frame-body">
        <main className="health-output-pane">
          <div className="terminal-grid" aria-hidden="true" />
          <TerminalState
            runningLabel={healthRunning}
            result={healthLog}
            readyLabel="health ready"
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
          />
        </main>
        <aside className="health-info-pane">
          <div className="console-section-label">checks</div>
          <div className="health-check-list">
            {!diag ? null : !diag.valid ? (
              <span className="workspace-invalid">No valid workspace selected. Use the Workspace tab.</span>
            ) : !canRunHealthCheck ? (
              <span className="workspace-invalid">Release check is available only in an app development checkout.</span>
            ) : null}
            <span>script syntax</span>
            <span>forbidden operational scans</span>
            <span>safe dry-runs</span>
            <span>app build</span>
            <span>cargo fmt/check/clippy/test</span>
            <span>manual GUI smoke still required</span>
          </div>

          <div className="backup-history">
            <div className="console-section-label">backups</div>
            <div className="backup-history-actions">
              <button className="btn btn-sm" onClick={onOpenBackupsFolder}>open backups</button>
              <button className="btn btn-sm" onClick={onRefreshBackups}>refresh</button>
            </div>
            {backups.length === 0 ? (
              <div className="backup-empty">no backups found</div>
            ) : (
              backups.map((run) => (
                <div
                  key={run.id}
                  className={`backup-run${selectedBackupId === run.id ? " backup-run-selected" : ""}`}
                  onClick={() => onSelectBackup(run.id)}
                >
                  <div className="backup-run-meta">
                    <span>{run.timestamp}</span>
                    <span>{run.file_count} {run.file_count === 1 ? "file" : "files"}</span>
                  </div>
                  <div className="backup-run-targets">{run.targets.join(", ")}</div>
                </div>
              ))
            )}

            <div className="backup-details">
              {!selectedBackupId ? (
                <div className="backup-empty">select a backup run</div>
              ) : !backupDetails ? (
                <div className="backup-empty">loading backup details…</div>
              ) : (
                <>
                  <div className="console-section-label">details</div>
                  <div className="backup-details-header">
                    <span className="cell-value">{backupDetails.timestamp}</span>
                  </div>
                  {backupDetails.files.length === 0 ? (
                    <div className="backup-empty">no backup files</div>
                  ) : (
                    backupDetails.files.map((f, i) => (
                      <div key={i} className="backup-file-row">
                        <div className="backup-file-meta">
                          <span>{f.target_id}</span>
                          <span>{f.filename}</span>
                          <span>{formatSize(f.backup_size)}</span>
                        </div>
                        <div className={`backup-file-status ${statusClass(f.current_status)}`}>
                          {f.current_status}
                        </div>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
