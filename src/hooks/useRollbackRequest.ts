import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import type { ConfirmConfig } from "../components/ConfirmDialog";
import type { SetupResult } from "../types";

export interface UseRollbackRequestOptions {
  /** The transaction the last install or uninstall left, or null when there is nothing to roll back. */
  transactionId: string | null;
  confirm: (config: ConfirmConfig | string) => Promise<boolean>;
  /** Marks a confirm as open so the status bar shows CONFIRM; returns the release function. */
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
}: UseRollbackRequestOptions): () => Promise<void> {
  return useCallback(async () => {
    if (!transactionId) return;
    let dryRun: SetupResult;
    try {
      dryRun = await invoke<SetupResult>("rollback_setup_transaction", { transactionId, dryRun: true });
    } catch (e) {
      setError(`rollback: ${e}`);
      return;
    }
    if (!dryRun.success || dryRun.applied.length === 0) {
      setError(`rollback: nothing can be restored for transaction ${transactionId} (${dryRun.message})`);
      return;
    }
    const release = beginConfirm();
    let approved = false;
    try {
      approved = await confirm({
        title: "Roll back",
        message: `Restore the files of transaction ${transactionId} from its backup? ${dryRun.message}`,
        confirmLabel: "roll back",
      });
    } finally {
      release();
    }
    if (approved) await runRollback(transactionId);
  }, [transactionId, confirm, beginConfirm, runRollback, setError]);
}
