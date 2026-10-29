import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import type { ConfirmConfig } from "../components/ConfirmDialog";
import type { SetupResult } from "../types";

export interface UseRollbackRequestOptions {
  /** The transaction the last install or uninstall left, or null when there is nothing to roll back. */
  transactionId: string | null;
  confirm: (config: ConfirmConfig | string) => Promise<boolean>;
  /** Marks a confirm as open so the shell mode is CONFIRM; returns the release function. */
  beginConfirm: () => () => void;
  /** The existing rollback path (`rollback_setup_transaction` with `dryRun: false`). */
  runRollback: (transactionId: string) => Promise<unknown>;
  setError: (message: string | null) => void;
}

/**
 * `z` and `:rollback`: a dry run first, so the confirm shows what would be restored, then the existing
 * confirm dialog, then the rollback itself. A dry run that finds nothing to restore, or conflicts, never
 * reaches the confirm.
 */
export function useRollbackRequest({
  transactionId,
  confirm,
  beginConfirm,
  runRollback,
  setError,
}: UseRollbackRequestOptions): (undoTransactionId?: string) => Promise<void> {
  return useCallback(async (undoTransactionId?: string) => {
    // `z` and `:rollback` undo the transaction of this session; the Overview's Undo names the newest one on disk.
    const target = typeof undoTransactionId === "string" ? undoTransactionId : transactionId;
    if (!target) return;
    let dryRun: SetupResult;
    try {
      dryRun = await invoke<SetupResult>("rollback_setup_transaction", { transactionId: target, dryRun: true });
    } catch (e) {
      setError(`rollback: ${e}`);
      return;
    }
    if (!dryRun.success || dryRun.applied.length === 0) {
      setError(`rollback: nothing can be restored for transaction ${target} (${dryRun.message})`);
      return;
    }
    const release = beginConfirm();
    let approved = false;
    try {
      approved = await confirm({
        title: "Roll back",
        message: `Restore the files of transaction ${target} from its backup? ${dryRun.message}`,
        confirmLabel: "roll back",
      });
    } finally {
      release();
    }
    if (approved) await runRollback(target);
  }, [transactionId, confirm, beginConfirm, runRollback, setError]);
}
