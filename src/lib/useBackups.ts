import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeOpen } from "./invokeOpen";
import type { BackupRunDetails, BackupRunSummary } from "../types";

export function useBackups(setError: (msg: string) => void) {
  const [backups, setBackups] = useState<BackupRunSummary[]>([]);
  const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null);
  const [backupDetails, setBackupDetails] = useState<BackupRunDetails | null>(null);
  const selectedBackupIdRef = useRef<string | null>(null);
  selectedBackupIdRef.current = selectedBackupId;

  const loadBackups = useCallback(async () => {
    try {
      const list = await invoke<BackupRunSummary[]>("list_backups");
      setBackups(list);
      const currentId = selectedBackupIdRef.current;
      if (currentId) {
        if (list.some(r => r.id === currentId)) {
          try {
            setBackupDetails(await invoke<BackupRunDetails>("get_backup_details", { runId: currentId }));
          } catch { setBackupDetails(null); }
        } else {
          setSelectedBackupId(null);
          setBackupDetails(null);
        }
      }
    } catch (e) { setError(`Backups: ${e}`); }
  }, [setError]);

  const loadBackupDetails = useCallback(async (runId: string) => {
    setSelectedBackupId(runId);
    try { setBackupDetails(await invoke<BackupRunDetails>("get_backup_details", { runId })); } catch (e) { setError(`Backup details: ${e}`); }
  }, [setError]);

  const openBackupsFolder = useCallback(() => {
    void invokeOpen("open_backups_folder", undefined, "Open backups", setError);
  }, [setError]);

  return { backups, selectedBackupId, backupDetails, loadBackups, loadBackupDetails, openBackupsFolder };
}
