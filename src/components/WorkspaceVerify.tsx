interface WorkspaceVerifyProps {
  workspaceValid: boolean;
  wsRunning: string | null;
  canRunReleaseCheck: boolean;
  backupCount: number;
  onReleaseCheck: () => void;
  onRefreshBackups: () => void;
  onOpenBackupsFolder: () => void;
}

export function WorkspaceVerify({
  workspaceValid,
  wsRunning,
  canRunReleaseCheck,
  backupCount,
  onReleaseCheck,
  onRefreshBackups,
  onOpenBackupsFolder,
}: WorkspaceVerifyProps) {
  if (!workspaceValid) return null;

  return (
    <div className="ws-section" role="region" aria-label="Verification and backups">
      <div className="ws-section-header">
        <span className="ws-section-title">VERIFY</span>
      </div>
      <div className="ws-section-actions">
        <button
          className="btn btn-sm btn-primary"
          disabled={!canRunReleaseCheck || wsRunning !== null}
          onClick={onReleaseCheck}
        >
          release-check
        </button>
        <button className="btn btn-sm" disabled={wsRunning !== null} onClick={onRefreshBackups}>
          refresh
        </button>
        <button className="btn btn-sm" disabled={wsRunning !== null} onClick={onOpenBackupsFolder}>
          open folder
        </button>
      </div>
      <div className="ws-section-context">
        {backupCount > 0 ? <span>{backupCount} backup runs</span> : <span>no backups</span>}
      </div>
    </div>
  );
}
