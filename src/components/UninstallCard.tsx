import { useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HarnessActionCard, HarnessActionGrid } from "./HarnessActionCard";
import type { UninstallPlanView } from "../types";

interface UninstallCardProps {
  workspaceValid: boolean;
  busy: boolean;
  onApply: (planFingerprint: string, previewToken: string) => void;
}

/**
 * Workspace lifecycle exit: previews exactly which installed files are
 * app-owned (removable), which user-modified copies are preserved, and which
 * merged configs stay, then applies the removal as a rollback-capable
 * transaction after explicit confirmation.
 */
export function UninstallCard({ workspaceValid, busy, onApply }: UninstallCardProps) {
  const [plan, setPlan] = useState<UninstallPlanView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const loadPreview = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<UninstallPlanView>("preview_uninstall");
      setPlan(next);
      dialogRef.current?.showModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const confirm = () => {
    dialogRef.current?.close();
    if (plan?.plan_fingerprint && plan.preview_token) {
      onApply(plan.plan_fingerprint, plan.preview_token);
    }
  };

  if (!workspaceValid) return null;

  return (
    <>
      <HarnessActionCard
        title="Uninstall"
        ariaLabel="Uninstall"
        description="Remove every app-installed rule, agent, skill, and workspace file. Modified and user-created files are preserved; removals are backed up and rollback-capable."
        warning={error ?? undefined}
      >
        <HarnessActionGrid>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy || loading}
            onClick={loadPreview}
          >
            {loading ? "computing…" : "preview uninstall"}
          </button>
        </HarnessActionGrid>
      </HarnessActionCard>
      <dialog ref={dialogRef} aria-labelledby={titleId} className="uninstall-dialog">
        <div className="ws-panel">
          <h2 id={titleId}>Uninstall everything?</h2>
          {plan && (
            <>
              <p className="uninstall-summary">{plan.summary}</p>
              {plan.removable.length > 0 && (
                <details className="uninstall-detail">
                  <summary>{plan.removable.length} file(s) to remove</summary>
                  <ul className="uninstall-list">
                    {plan.removable.map((item) => (
                      <li key={item.path}><code>{item.path}</code></li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.preserved.length > 0 && (
                <details className="uninstall-detail">
                  <summary>{plan.preserved.length} modified file(s) preserved</summary>
                  <ul className="uninstall-list">
                    {plan.preserved.map((item) => (
                      <li key={item.path}><code>{item.path}</code></li>
                    ))}
                  </ul>
                </details>
              )}
              {plan.merged.length > 0 && (
                <details className="uninstall-detail">
                  <summary>{plan.merged.length} merged config(s) left in place</summary>
                  <ul className="uninstall-list">
                    {plan.merged.map((item) => (
                      <li key={item.path}><code>{item.path}</code></li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          <div className="uninstall-dialog-actions">
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
        </div>
      </dialog>
    </>
  );
}
