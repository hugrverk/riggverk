import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HarnessActionCard, HarnessActionGrid } from "./HarnessActionCard";
import type { SetupResult } from "../types";

interface UninstallRecoveryCardProps {
  transactionId: string | null;
  busy: boolean;
  onRollback: () => Promise<boolean>;
}

function rollbackDryRunReady(result: SetupResult | null): boolean {
  return Boolean(result?.success && result.applied.length > 0);
}

export function UninstallRecoveryCard({
  transactionId,
  busy,
  onRollback,
}: UninstallRecoveryCardProps) {
  const [dryRunResult, setDryRunResult] = useState<SetupResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
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
  const warning = previewError ?? undefined;

  return (
    <>
      <HarnessActionCard
        title="Recover previous uninstall"
        ariaLabel="Recover previous uninstall"
        description="The last uninstall was recorded as a rollback-capable transaction. Preview what can be restored from its backup, then confirm to bring app-owned files back."
        warning={warning}
        details={
          dryRunResult
            ? [
                {
                  label: "to restore",
                  value: String(dryRunResult.applied.length),
                  tone: dryRunResult.applied.length > 0 ? "warn" : "muted",
                },
                {
                  label: "already restored",
                  value: String(dryRunResult.rolled_back.length),
                  tone: dryRunResult.rolled_back.length > 0 ? "ok" : "muted",
                },
                {
                  label: "conflicts",
                  value: String(dryRunResult.failed.length),
                  tone: dryRunResult.failed.length > 0 ? "fail" : "muted",
                },
              ]
            : undefined
        }
        nextAction={
          dryRunResult
            ? dryRunResult.message
            : "Run a recovery preview before restoring anything."
        }
        nextActionTone={dryRunResult && !dryRunResult.success ? "fail" : "warn"}
      >
        <HarnessActionGrid>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || previewLoading}
            onClick={runDryRun}
          >
            {previewLoading ? "previewing…" : "preview recovery"}
          </button>
          <button
            ref={restoreButtonRef}
            type="button"
            className="btn btn-sm btn-warn"
            disabled={busy || previewLoading || !canRestore}
            onClick={openConfirm}
          >
            restore workspace
          </button>
        </HarnessActionGrid>
      </HarnessActionCard>

      <dialog
        ref={dialogRef}
        aria-labelledby={confirmTitleId}
        className="uninstall-dialog recovery-dialog"
        onClose={() => restoreButtonRef.current?.focus()}
      >
        <div className="ws-panel">
          <h2 id={confirmTitleId}>Restore workspace from uninstall backup?</h2>
          <p className="uninstall-summary">
            This restores app-owned files removed by the previous uninstall using the transaction
            backup. User-modified or conflicting files are not overwritten.
          </p>
          {dryRunResult && (
            <p className="uninstall-summary">
              Preview: {dryRunResult.applied.length} file(s) to restore
              {dryRunResult.failed.length > 0
                ? `; ${dryRunResult.failed.length} conflict(s) reported`
                : ""}
              .
            </p>
          )}
          <div className="uninstall-dialog-actions">
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
        </div>
      </dialog>
    </>
  );
}
