import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useConfirmMode } from "../shell/ShellState";
import { Kv, type KvItem } from "../ui/Kv";
import { Kbd } from "../ui/Kbd";
import type { SetupResult } from "../types";

interface UninstallRecoveryCardProps {
  transactionId: string | null;
  busy: boolean;
  onRollback: () => Promise<boolean>;
}

function rollbackDryRunReady(result: SetupResult | null): boolean {
  return Boolean(result?.success && result.applied.length > 0);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function UninstallRecoveryCard({
  transactionId,
  busy,
  onRollback,
}: UninstallRecoveryCardProps) {
  const [dryRunResult, setDryRunResult] = useState<SetupResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  useConfirmMode(dialogOpen);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const confirmTitleId = useId();

  useEffect(() => {
    setDryRunResult(null);
    setPreviewError(null);
  }, [transactionId]);

  const runDryRun = async () => {
    if (!transactionId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await invoke<SetupResult>("rollback_setup_transaction", {
        transactionId,
        dryRun: true,
      });
      setDryRunResult(result);
    } catch (err) {
      setDryRunResult(null);
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  const openConfirm = () => {
    if (!rollbackDryRunReady(dryRunResult)) return;
    dialogRef.current?.showModal();
    setDialogOpen(true);
  };

  const closeConfirm = () => {
    dialogRef.current?.close();
    restoreButtonRef.current?.focus();
  };

  const confirmRestore = async () => {
    dialogRef.current?.close();
    await onRollback();
    restoreButtonRef.current?.focus();
  };

  if (!transactionId) return null;

  const canRestore = rollbackDryRunReady(dryRunResult);
  const details: KvItem[] | null = dryRunResult
    ? [
        { label: "to restore", value: String(dryRunResult.applied.length), tone: dryRunResult.applied.length > 0 ? "warn" : "dim" },
        { label: "already restored", value: String(dryRunResult.rolled_back.length), tone: dryRunResult.rolled_back.length > 0 ? "ok" : "dim" },
        { label: "conflicts", value: String(dryRunResult.failed.length), tone: dryRunResult.failed.length > 0 ? "fail" : "dim" },
      ]
    : null;

  return (
    <>
      <div className="lifecycle" role="region" aria-label="Recover previous uninstall">
        <p className="c-dim">
          The last uninstall was recorded as a rollback-capable transaction. Preview what can be restored from its
          backup, then confirm to bring app-owned files back.
        </p>
        {details && <Kv items={details} className="lifecycle-kv" />}
        {previewError && (
          <p className="c-fail" role="status">
            {previewError}
          </p>
        )}
        <p
          className={dryRunResult && !dryRunResult.success ? "c-fail" : "c-warn"}
          role="status"
        >
          {dryRunResult ? dryRunResult.message : "Run a recovery preview before restoring anything."}
        </p>
        <div className="lifecycle-actions">
          <button
            type="button"
            className="action-key"
            disabled={busy || previewLoading}
            onClick={runDryRun}
          >
            {previewLoading ? "previewing…" : "preview recovery"}
          </button>
          <button
            ref={restoreButtonRef}
            type="button"
            className="action-key"
            disabled={busy || previewLoading || !canRestore}
            onClick={openConfirm}
          >
            <Kbd>:rollback</Kbd> restore workspace
          </button>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby={confirmTitleId}
        className="app-modal"
        onClose={() => {
          setDialogOpen(false);
          restoreButtonRef.current?.focus();
        }}
      >
        <div className="app-modal-header">
          <h2 id={confirmTitleId} className="app-modal-title">Restore workspace from uninstall backup?</h2>
        </div>
        <div className="app-modal-body">
          <p className="uninstall-summary">
            This restores app-owned files removed by the previous uninstall using the transaction
            backup. User-modified or conflicting files are not overwritten.
          </p>
          {dryRunResult && (
            <p className="uninstall-summary">
              Preview: {count(dryRunResult.applied.length, "file")} to restore
              {dryRunResult.failed.length > 0 ? `; ${count(dryRunResult.failed.length, "conflict")} reported` : ""}.
            </p>
          )}
        </div>
        <div className="app-modal-footer">
          <form method="dialog">
            <button type="submit" className="btn btn-sm" autoFocus onClick={closeConfirm}>
              cancel
            </button>
          </form>
          <button
            type="button"
            className="btn btn-sm btn-warn"
            disabled={!canRestore}
            onClick={confirmRestore}
          >
            confirm restore
          </button>
        </div>
      </dialog>
    </>
  );
}
