import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import type { ConfirmConfig } from "../components/ConfirmDialog";
import { runTitle, updateTimeText } from "../lib/lastUpdate";
import type { SetupHistoryEntry, SetupResult } from "../types";

/** How far back the history is searched for the run being undone; the newest completed one is always near the top. */
const HISTORY_LOOKUP_LIMIT = 50;

/** The run in the history, or undefined when the history cannot be read or does not list it. */
async function findRun(transactionId: string): Promise<SetupHistoryEntry | undefined> {
  try {
    const history = await invoke<SetupHistoryEntry[]>("list_setup_history", { limit: HISTORY_LOOKUP_LIMIT });
    return Array.isArray(history) ? history.find(candidate => candidate.transaction_id === transactionId) : undefined;
  } catch {
    // The dialog still works without the name.
    return undefined;
  }
}

/** "Updated Claude (22 Oct, 12:00)" from the run in the history; "the update" when the history cannot name it. */
function describeRun(entry: SetupHistoryEntry | undefined): string {
  if (!entry) return "the update";
  const time = updateTimeText(entry);
  return time ? `${runTitle(entry)} (${time})` : runTitle(entry);
}

function items(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What the undo does to the `count` items of the dry run: files the run created are removed, the rest come back from
 * the backup. Without the run's recorded changes every item counts as restored.
 */
function undoEffect(count: number, entry: SetupHistoryEntry | undefined): string {
  const created = entry
    ? Math.min(count, entry.changes.filter(change => change.applied && !change.restored && change.kind === "create").length)
    : 0;
  const restored = count - created;
  if (created === 0) return `This restores ${items(restored, "item")} from the backup.`;
  if (restored === 0) return `This removes the ${items(created, "file")} it created.`;
  return `This removes the ${items(created, "file")} it created and restores ${items(restored, "item")} from the backup.`;
}

export interface UseRollbackRequestOptions {
  /** The transaction the last install or uninstall left, or null when there is nothing to roll back. */
  transactionId: string | null;
  confirm: (config: ConfirmConfig | string) => Promise<boolean>;
  /** The existing rollback path (`rollback_setup_transaction` with `dryRun: false`). */
  runRollback: (transactionId: string) => Promise<unknown>;
  setError: (message: string | null) => void;
}

/**
 * `z` and `:rollback`: a dry run first, so the confirm shows what would be restored (named by the run's title and
 * time from the history, never by its id), then the existing confirm dialog, then the rollback itself. A dry run that finds nothing to restore, or conflicts, never
 * reaches the confirm.
 */
export function useRollbackRequest({
  transactionId,
  confirm,
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
    const entry = await findRun(target);
    const approved = await confirm({
      title: "Roll back",
      message: `Undo ${describeRun(entry)}? ${undoEffect(dryRun.applied.length, entry)}`,
      confirmLabel: "roll back",
    });
    if (approved) await runRollback(target);
  }, [transactionId, confirm, runRollback, setError]);
}
