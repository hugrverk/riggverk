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

  const backupAvailable = backupCount > 0;

  return (
    <div className="start-block start-verify ws-section" role="region" aria-label="Verification and backups">
      <div className="ws-section-header start-block-header">
        <span className="ws-section-title">VERIFY</span>
        <span
          className={`start-verify-backup-chip ${backupAvailable ? "start-verify-backup-chip-ok" : "start-verify-backup-chip-muted"}`}
        >
          {backupAvailable ? `${backupCount} backup runs` : "no backups"}
        </span>
      </div>
      <p className="start-block-copy start-verify-copy">
        Run release-check before sync or install. Refresh to update backup inventory, or open the backups folder.
      </p>
      <div className="ws-section-actions start-verify-actions">
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
    </div>
  );
}
