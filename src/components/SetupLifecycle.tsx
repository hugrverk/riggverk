import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SetupPlan, SetupResult, OperationKind, SetupSurfaceId } from "../types";

interface RepairPreview {
  missing_artifacts: string[];
  skipped_updates: number;
  skipped_conflicts: number;
  skipped_unavailable: number;
  repair_fingerprint: string | null;
  repair_preview_token: string | null;
  message: string;
}

// ── Helpers ──

function opLabel(kind: OperationKind): string {
  switch (kind) {
    case "no_change": return "synced";
    case "create": return "create";
    case "update": return "update";
    case "remove": return "remove";
    case "conflict": return "conflict";
    case "manual": return "manual";
    case "unavailable": return "unavailable";
  }
}

function opClass(kind: OperationKind): string {
  switch (kind) {
    case "no_change": return "ws-status-valid";
    case "create": return "";
    case "update": return "btn-warn";
    case "remove": return "btn-warn";
    case "conflict": return "ws-status-invalid";
    case "manual": return "ws-status-dim";
    case "unavailable": return "ws-status-invalid";
  }
}

function surfaceLabel(id: SetupSurfaceId): string {
  const map: Record<string, string> = {
    open_code_config: "OpenCode Config",
    open_code_agents: "OpenCode Agents",
    open_code_rules: "OpenCode Rules",
    codex_config: "Codex Config",
    codex_agents: "Codex Agents",
    codex_rules: "Codex Rules",
    claude_rules: "Claude Rules",
    claude_agents: "Claude Agents",
    claude_skills: "Claude Skills",
    cursor_agents: "Cursor Agents",
    open_code_skills: "OpenCode Skills",
    codex_skills: "Codex Skills",
    cursor_skills: "Cursor Skills",
    cursor_mcp: "Cursor MCP",
    workspace_bundle: "Workspace Resources",
  };
  return map[id] ?? id;
}

function setupResultToTerminal(result: SetupResult, action: string) {
  const stderrParts = [...result.failed];
  if (!result.success && result.transaction_id && result.rolled_back.length > 0) {
    stderrParts.push("automatic rollback completed; explicit rollback retry may be available");
  }
  return {
    success: result.success,
    action,
    stdout: result.message,
    stderr: stderrParts.length > 0 ? stderrParts.join("; ") : "",
    exit_code: result.success ? 0 : 1,
  };
}

function acceptMutationTransaction(
  result: SetupResult,
  transactionRef: MutableRefObject<SetupResult | null>,
  onSuccess: () => void,
) {
  if (!result.transaction_id) return;
  if (result.success) {
    transactionRef.current = result;
    onSuccess();
    return;
  }
  transactionRef.current = result;
}

function sanitizePreviewError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.length > 240) return `${raw.slice(0, 240)}…`;
  return raw;
}

// ── Component ──

export interface SetupLifecycleProps {
  workspacePath: string | null;
  wsRunning: string | null;
  runSetupTask: <T>(opts: {
    label: string;
    action: string;
    task: () => Promise<T>;
    toActionResult: (result: T) => ReturnType<typeof setupResultToTerminal>;
    refresh?: () => void | Promise<void>;
  }) => Promise<T | null>;
}

export function SetupLifecycle({ workspacePath, wsRunning, runSetupTask }: SetupLifecycleProps) {
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyResult, setApplyResult] = useState<SetupResult | null>(null);
  const [repairResult, setRepairResult] = useState<SetupResult | null>(null);
  const [rollbackResult, setRollbackResult] = useState<SetupResult | null>(null);
  const [repairPreview, setRepairPreview] = useState<RepairPreview | null>(null);
  const [repairPreviewLoading, setRepairPreviewLoading] = useState(false);
  const [rollbackDryRun, setRollbackDryRun] = useState<SetupResult | null>(null);
  const [rollbackEligible, setRollbackEligible] = useState(false);
  const previewGenRef = useRef(0);
  const repairGenRef = useRef(0);
  const rollbackTriggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const lastCompletedApplyRef = useRef<SetupResult | null>(null);
  const transactionWorkspaceRef = useRef<string | null>(null);

  const globalMutationBusy = wsRunning !== null;
  const mutationLabel = wsRunning ?? "";
  const activeApplyTransaction = lastCompletedApplyRef.current;

  useEffect(() => {
    if (workspacePath === transactionWorkspaceRef.current) return;
    transactionWorkspaceRef.current = workspacePath;
    lastCompletedApplyRef.current = null;
    setApplyResult(null);
    setRepairResult(null);
    setRollbackResult(null);
    setRollbackDryRun(null);
    setRollbackEligible(false);
    setConfirmRollback(false);
  }, [workspacePath]);

  useEffect(() => {
    const txn = lastCompletedApplyRef.current;
    const alreadyRolledBack =
      rollbackResult?.success === true &&
      rollbackResult.transaction_id === txn?.transaction_id &&
      rollbackResult.rolled_back.length > 0;
    if (!txn?.transaction_id || alreadyRolledBack) {
      setRollbackEligible(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const dry = await invoke<SetupResult>("rollback_setup_transaction", {
          transactionId: txn.transaction_id,
          dryRun: true,
        });
        if (!cancelled) {
          setRollbackEligible(dry.success && dry.rolled_back.length > 0);
        }
      } catch {
        if (!cancelled) setRollbackEligible(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyResult, repairResult, rollbackResult, workspacePath]);

  const refresh = useCallback(async () => {
    const gen = ++previewGenRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const p = await invoke<SetupPlan>("preview_setup", { surfaces: [] });
      if (gen !== previewGenRef.current) return;
      setPlan(p);
    } catch (err) {
      if (gen !== previewGenRef.current) return;
      setPreviewError(sanitizePreviewError(err));
    } finally {
      if (gen === previewGenRef.current) setPreviewLoading(false);
    }
  }, []);

  const loadRepairPreview = useCallback(async () => {
    const gen = ++repairGenRef.current;
    setRepairPreviewLoading(true);
    try {
      const preview = await invoke<RepairPreview>("preview_repair_setup");
      if (gen !== repairGenRef.current) return;
      setRepairPreview(preview);
    } catch (err) {
      if (gen !== repairGenRef.current) return;
      setPreviewError(sanitizePreviewError(err));
    } finally {
      if (gen === repairGenRef.current) setRepairPreviewLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { loadRepairPreview(); }, [loadRepairPreview]);

  useEffect(() => {
    if (!confirmRollback) return;
    const dialog = confirmDialogRef.current;
    const focusable = dialog?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable?.[0];
    const last = focusable?.[focusable.length - 1];
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmRollback(false);
        setRollbackDryRun(null);
        rollbackTriggerRef.current?.focus();
        return;
      }
      if (e.key === "Tab" && focusable && focusable.length > 0) {
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmRollback]);

  const applyPlan = useCallback(async () => {
    if (!plan?.plan_fingerprint || !plan.preview_token) return;
    const surfaces = plan.operations
      .filter(op => op.kind === "create" || op.kind === "update")
      .map(op => op.surface);
    if (surfaces.length === 0) return;

    const r = await runSetupTask({
      label: "setup apply",
      action: "apply_setup",
      task: () => invoke<SetupResult>("apply_setup", {
        surfaces,
        skipManual: true,
        planFingerprint: plan.plan_fingerprint,
        previewToken: plan.preview_token,
      }),
      toActionResult: (res) => setupResultToTerminal(res, "apply_setup"),
      refresh: async () => { await refresh(); await loadRepairPreview(); },
    });
    if (r) {
      setApplyResult(r);
      acceptMutationTransaction(r, lastCompletedApplyRef, () => setRollbackResult(null));
    }
  }, [plan, runSetupTask, refresh, loadRepairPreview]);

  const repair = useCallback(async () => {
    if (!repairPreview?.repair_fingerprint || !repairPreview.repair_preview_token) return;
    const r = await runSetupTask({
      label: "setup repair",
      action: "repair_setup_command",
      task: () => invoke<SetupResult>("repair_setup_command", {
        skipManual: true,
        repairFingerprint: repairPreview.repair_fingerprint,
        repairPreviewToken: repairPreview.repair_preview_token,
      }),
      toActionResult: (res) => setupResultToTerminal(res, "repair_setup_command"),
      refresh: async () => { await refresh(); await loadRepairPreview(); },
    });
    if (r) {
      setRepairResult(r);
      acceptMutationTransaction(r, lastCompletedApplyRef, () => setRollbackResult(null));
    }
  }, [repairPreview, runSetupTask, refresh, loadRepairPreview]);

  const openRollbackConfirm = useCallback(async () => {
    if (!activeApplyTransaction?.transaction_id) return;
    setConfirmRollback(true);
    setRollbackDryRun(null);
    try {
      const dry = await invoke<SetupResult>("rollback_setup_transaction", {
        transactionId: activeApplyTransaction.transaction_id,
        dryRun: true,
      });
      setRollbackDryRun(dry);
    } catch (err) {
      setPreviewError(sanitizePreviewError(err));
      setConfirmRollback(false);
    }
  }, [activeApplyTransaction]);

  const rollbackTxn = useCallback(async () => {
    if (!activeApplyTransaction?.transaction_id) return;
    const txnId = activeApplyTransaction.transaction_id;
    const r = await runSetupTask({
      label: "setup rollback",
      action: "rollback_setup_transaction",
      task: () => invoke<SetupResult>("rollback_setup_transaction", {
        transactionId: txnId,
        dryRun: false,
      }),
      toActionResult: (res) => setupResultToTerminal(res, "rollback_setup_transaction"),
      refresh: async () => { await refresh(); await loadRepairPreview(); },
    });
    if (r) {
      setRollbackResult(r);
      if (!r.success) {
        // Preserve original apply transaction for retry.
        lastCompletedApplyRef.current = activeApplyTransaction;
      }
      setConfirmRollback(false);
      setRollbackDryRun(null);
      rollbackTriggerRef.current?.focus();
    }
  }, [activeApplyTransaction, runSetupTask, refresh, loadRepairPreview]);

  const needsApply = plan?.operations.some(op => op.kind === "create" || op.kind === "update") ?? false;
  const isBlocked = plan?.is_blocked ?? false;
  const canApply = Boolean(plan?.plan_fingerprint && plan.preview_token) && needsApply && !isBlocked;
  const canRepair = Boolean(
    repairPreview?.repair_fingerprint && repairPreview.repair_preview_token
  ) && !repairPreviewLoading;
  const rollbackSucceeded =
    rollbackResult?.success === true &&
    rollbackResult.transaction_id === activeApplyTransaction?.transaction_id &&
    rollbackResult.rolled_back.length > 0;
  const canRollback =
    Boolean(activeApplyTransaction?.transaction_id) &&
    rollbackEligible &&
    !rollbackSucceeded;

  const applyBusy = mutationLabel === "setup apply";
  const repairBusy = mutationLabel === "setup repair";
  const rollbackBusy = mutationLabel === "setup rollback";

  const statusResult = rollbackResult ?? applyResult ?? repairResult;

  return (
    <div className="ws-panel" role="region" aria-label="Unified setup lifecycle" aria-busy={globalMutationBusy}>
      <div className="ws-panel-header">
        <span className="ws-panel-title">SETUP LIFECYCLE</span>
        {previewLoading && (
          <span className="ws-status-dim" role="status" aria-live="polite">detecting…</span>
        )}
        {plan && !previewLoading && (
          <span className="ws-status-chip ws-status-valid">{plan.summary}</span>
        )}
      </div>

      {previewError && (
        <p className="ws-path-status-detail ws-status-invalid" role="alert" aria-live="assertive">
          Preview error: {previewError}
        </p>
      )}

      {plan && !previewLoading && (
        <div className="start-workspace-path-block">
          {plan.operations.map((op, i) => (
            <div key={i} className="start-workspace-path-entry">
              <span className="start-workspace-path-label">{surfaceLabel(op.surface)}</span>
              <span className={`ws-status-chip ${opClass(op.kind)}`}>
                {opLabel(op.kind)}
              </span>
              {op.conflict_description && (
                <span className="ws-path-status-detail" role="alert">
                  Conflict: {op.conflict_description}
                </span>
              )}
              {op.manual_step && (
                <span className="ws-path-status-detail">{op.manual_step}</span>
              )}
            </div>
          ))}
          {plan.synced.length > 0 && (
            <div className="start-workspace-path-entry">
              <span className="start-workspace-path-label">
                {plan.synced.length} synced surface(s)
              </span>
            </div>
          )}
        </div>
      )}

      {repairPreview && repairPreview.missing_artifacts.length > 0 && (
        <div className="ws-repair-box" role="status" aria-live="polite">
          <div className="ws-repair-title">Repair preview</div>
          <p className="ws-repair-hint">{repairPreview.message}</p>
          <p className="ws-repair-hint">
            Missing: {repairPreview.missing_artifacts.slice(0, 6).join(", ")}
            {repairPreview.missing_artifacts.length > 6 ? "…" : ""}
          </p>
        </div>
      )}

      <div className="ws-action-row start-workspace-actions">
        <button
          className="btn btn-sm"
          onClick={refresh}
          disabled={globalMutationBusy}
          aria-label="Refresh setup detection"
          aria-busy={previewLoading}
        >
          {previewLoading ? "detecting…" : "refresh"}
        </button>

        <button
          className="btn btn-sm btn-primary"
          onClick={applyPlan}
          disabled={globalMutationBusy || !canApply || !plan}
          aria-busy={applyBusy}
          title={isBlocked ? "Resolve conflicts before applying" : needsApply ? "Apply pending changes" : "All surfaces synced"}
        >
          {applyBusy ? "applying…" : "apply"}
        </button>

        <button
          className="btn btn-sm"
          onClick={repair}
          disabled={globalMutationBusy || !canRepair}
          aria-busy={repairBusy || repairPreviewLoading}
          title={canRepair ? "Create missing artifacts only" : "No repair preview or nothing to repair"}
        >
          {repairBusy ? "repairing…" : "repair"}
        </button>

        <button
          ref={rollbackTriggerRef}
          className="btn btn-sm btn-warn"
          onClick={openRollbackConfirm}
          disabled={globalMutationBusy || !canRollback}
          aria-busy={rollbackBusy}
          title={
            canRollback
              ? `Rollback transaction ${activeApplyTransaction?.transaction_id.slice(0, 8)}`
              : rollbackSucceeded
                ? "Transaction already rolled back"
                : "No rollbackable transaction"
          }
        >
          rollback
        </button>
      </div>

      {confirmRollback && activeApplyTransaction && (
        <div
          ref={confirmDialogRef}
          className="ws-repair-box"
          role="alertdialog"
          aria-modal="true"
          aria-label="Confirm rollback"
        >
          <div className="ws-repair-title">Rollback transaction?</div>
          <p className="ws-repair-hint">
            Transaction: {activeApplyTransaction.transaction_id.slice(0, 12)}…
          </p>
          {rollbackDryRun && (
            <p className="ws-repair-hint" role="status" aria-live="polite">
              Dry run: would restore {rollbackDryRun.rolled_back.length} artifact(s)
              {rollbackDryRun.rolled_back.length > 0
                ? `: ${rollbackDryRun.rolled_back.slice(0, 4).join(", ")}`
                : ""}
            </p>
          )}
          <div className="ws-repair-actions">
            <button
              className="btn btn-sm btn-warn"
              onClick={rollbackTxn}
              disabled={globalMutationBusy || !rollbackDryRun?.success}
              aria-busy={rollbackBusy}
            >
              {rollbackBusy ? "rolling back…" : "confirm rollback"}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                setConfirmRollback(false);
                setRollbackDryRun(null);
                rollbackTriggerRef.current?.focus();
              }}
              disabled={globalMutationBusy}
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {statusResult && (
        <div className="ws-repair-box" role="status" aria-live="polite">
          <div className="ws-panel-title-row">
            <span className={`ws-status-chip ${statusResult.success ? "ws-status-valid" : "ws-status-invalid"}`}>
              {statusResult.success ? "SUCCESS" : "FAILED"}
            </span>
          </div>
          <p>{statusResult.message}</p>
          {statusResult.applied.length > 0 && (
            <p className="ws-repair-hint">Applied: {statusResult.applied.join(", ")}</p>
          )}
          {statusResult.failed.length > 0 && (
            <p className="ws-repair-hint" role="alert">Failed: {statusResult.failed.join("; ")}</p>
          )}
          {statusResult.rolled_back.length > 0 && (
            <p className="ws-repair-hint">Rolled back: {statusResult.rolled_back.join(", ")}</p>
          )}
          {statusResult.manual_steps.length > 0 && (
            <p className="ws-repair-hint">Manual steps: {statusResult.manual_steps.join("; ")}</p>
          )}
          {rollbackResult && !rollbackResult.success && activeApplyTransaction && canRollback && (
            <p className="ws-repair-hint" role="alert">
              Rollback failed for transaction {activeApplyTransaction.transaction_id.slice(0, 12)}… — retry is available.
            </p>
          )}
          {applyResult && !applyResult.success && activeApplyTransaction && canRollback && (
            <p className="ws-repair-hint" role="alert">
              Apply failed for transaction {activeApplyTransaction.transaction_id.slice(0, 12)}… — rollback retry is available.
            </p>
          )}
          {repairResult && !repairResult.success && activeApplyTransaction && canRollback && (
            <p className="ws-repair-hint" role="alert">
              Repair failed for transaction {activeApplyTransaction.transaction_id.slice(0, 12)}… — rollback retry is available.
            </p>
          )}
        </div>
      )}

      {isBlocked && plan && (
        <p className="ws-path-status-detail" role="alert">
          Conflicts or unavailable surfaces block apply. Resolve them or refresh.
        </p>
      )}
    </div>
  );
}
