import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useConfirmMode } from "../shell/ShellState";
import { Kbd } from "../ui/Kbd";
import { Kv } from "../ui/Kv";
import type { UninstallPlanView } from "../types";

interface UninstallCardProps {
  dataFolderOk: boolean;
  busy: boolean;
  onApply: (planFingerprint: string, previewToken: string) => void;
  /** `:uninstall` asks for the preview dialog; the card reports back once it has taken the request. */
  previewRequested?: boolean;
  onPreviewRequestHandled?: () => void;
}

/**
 * Workspace lifecycle exit: previews exactly which installed files are
 * app-owned (removable), which user-modified copies are preserved, and which
 * merged configs stay, then applies the removal as a rollback-capable
 * transaction after explicit confirmation.
 */
export function UninstallCard({
  dataFolderOk,
  busy,
  onApply,
  previewRequested = false,
  onPreviewRequestHandled,
}: UninstallCardProps) {
  const [plan, setPlan] = useState<UninstallPlanView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  useConfirmMode(dialogOpen);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const loadPreview = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<UninstallPlanView>("preview_uninstall");
      setPlan(next);
      dialogRef.current?.showModal();
      setDialogOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!previewRequested) return;
    onPreviewRequestHandled?.();
    if (dataFolderOk && !busy && !loading) void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRequested]);

  const confirm = () => {
    dialogRef.current?.close();
    if (plan?.plan_fingerprint && plan.preview_token) {
      onApply(plan.plan_fingerprint, plan.preview_token);
    }
  };

  if (!dataFolderOk) return null;

  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

  return (
    <>
      <div className="lifecycle" role="region" aria-label="Uninstall">
        <Kv
          className="lifecycle-kv"
          items={[{ label: "uninstall", value: "previews first · backed up, rollback-capable", tone: "dim", wrap: true }]}
        />
        <div className="lifecycle-actions">
          <button
            type="button"
            className="action-key"
            disabled={busy || loading}
            onClick={loadPreview}
          >
            <Kbd>:uninstall</Kbd> {loading ? "computing…" : "preview uninstall"}
          </button>
        </div>
        {error && (
          <p className="c-fail" role="status">
            {error}
          </p>
        )}
      </div>
      <dialog ref={dialogRef} aria-labelledby={titleId} className="app-modal" onClose={() => setDialogOpen(false)}>
        <div className="app-modal-header">
          <h2 id={titleId} className="app-modal-title">Uninstall everything?</h2>
        </div>
        <div className="app-modal-body">
          {plan && (
            <>
              <p className="uninstall-summary">{plan.summary}</p>
              {plan.removable.length > 0 && (
                <details className="uninstall-detail">
                  <summary>{count(plan.removable.length, "file")} to remove</summary>
                  <ul className="uninstall-list">
                    {plan.removable.map((item) => (
                      <li key={item.path}><code>{item.path}</code></li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.preserved.length > 0 && (
                <details className="uninstall-detail">
                  <summary>{count(plan.preserved.length, "modified file")} preserved</summary>
                  <ul className="uninstall-list">
                    {plan.preserved.map((item) => (
                      <li key={item.path}><code>{item.path}</code></li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.merged.length > 0 && (
                <details className="uninstall-detail">
                  <summary>{count(plan.merged.length, "merged config")} left in place</summary>
                  <ul className="uninstall-list">
                    {plan.merged.map((item) => (
                      <li key={item.path}><code>{item.path}</code></li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
        <div className="app-modal-footer">
          <form method="dialog">
            <button type="submit" className="btn btn-sm" autoFocus>cancel</button>
          </form>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={!plan?.plan_fingerprint || plan.removable.length === 0}
            onClick={confirm}
          >
            uninstall everything
          </button>
        </div>
      </dialog>
    </>
  );
}
