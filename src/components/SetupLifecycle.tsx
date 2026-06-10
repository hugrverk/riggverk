import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SetupPlan, SetupResult, OperationKind, SetupSurfaceId } from "../types";

// ── Helpers ──

function opLabel(kind: OperationKind): string {
  switch (kind) {
    case "no_change": return "synced";
    case "create": return "create";
    case "update": return "update";
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
    deprecated_skill_cleanup: "Deprecated Skills",
  };
  return map[id] ?? id;
}

function setupResultToTerminal(result: SetupResult, action: string) {
  return {
    success: result.success,
    action,
    stdout: result.message,
    stderr: result.failed.length > 0 ? result.failed.join("; ") : "",
    exit_code: result.success ? 0 : 1,
  };
}

// ── Component ──

export interface SetupLifecycleProps {
  wsRunning: string | null;
  runSetupTask: <T>(opts: {
    label: string;
    action: string;
    task: () => Promise<T>;
    toActionResult: (result: T) => ReturnType<typeof setupResultToTerminal>;
    refresh?: () => void | Promise<void>;
  }) => Promise<T | null>;
}

export function SetupLifecycle({ wsRunning, runSetupTask }: SetupLifecycleProps) {
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [result, setResult] = useState<SetupResult | null>(null);
  const genRef = useRef(0);
  const rollbackTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);

  const globalMutationBusy = wsRunning !== null;
  const mutationLabel = wsRunning ?? "";

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    setPreviewLoading(true);
    try {
      const p = await invoke<SetupPlan>("preview_setup", { surfaces: [] });
      if (gen !== genRef.current) return;
      setPlan(p);
    } catch {
      if (gen !== genRef.current) return;
      setPlan(null);
    } finally {
      if (gen === genRef.current) setPreviewLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!confirmRollback) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmRollback(false);
        rollbackTriggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmRollback]);

  const applyPlan = useCallback(async () => {
    if (!plan?.plan_fingerprint) return;
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
      }),
      toActionResult: (res) => setupResultToTerminal(res, "apply_setup"),
      refresh: async () => { await refresh(); },
    });
    if (r) setResult(r);
  }, [plan, runSetupTask, refresh]);

  const repair = useCallback(async () => {
    const r = await runSetupTask({
      label: "setup repair",
      action: "repair_setup_command",
      task: () => invoke<SetupResult>("repair_setup_command", { skipManual: true }),
      toActionResult: (res) => setupResultToTerminal(res, "repair_setup_command"),
      refresh: async () => { await refresh(); },
    });
    if (r) setResult(r);
  }, [runSetupTask, refresh]);

  const rollbackTxn = useCallback(async () => {
    if (!result?.transaction_id) return;
    const r = await runSetupTask({
      label: "setup rollback",
      action: "rollback_setup_transaction",
      task: () => invoke<SetupResult>("rollback_setup_transaction", {
        transactionId: result.transaction_id,
        dryRun: false,
      }),
      toActionResult: (res) => setupResultToTerminal(res, "rollback_setup_transaction"),
      refresh: async () => { await refresh(); },
    });
    if (r) {
      setResult(r);
      setConfirmRollback(false);
      rollbackTriggerRef.current?.focus();
    }
  }, [result, runSetupTask, refresh]);

  const needsApply = plan?.operations.some(op => op.kind === "create" || op.kind === "update") ?? false;
  const isBlocked = plan?.is_blocked ?? false;
  const hasResult = result !== null;
  const canApply = Boolean(plan?.plan_fingerprint) && needsApply && !isBlocked;

  return (
    <div className="ws-panel" role="region" aria-label="Unified setup lifecycle">
      <div className="ws-panel-header">
        <span className="ws-panel-title">SETUP LIFECYCLE</span>
        {previewLoading && <span className="ws-status-dim" role="status">detecting\u2026</span>}
        {plan && !previewLoading && (
          <span className="ws-status-chip ws-status-valid">{plan.summary}</span>
        )}
      </div>

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

      <div className="ws-action-row start-workspace-actions">
        <button
          className="btn btn-sm"
          onClick={refresh}
          disabled={globalMutationBusy}
          aria-label="Refresh setup detection"
        >
          {previewLoading ? "detecting\u2026" : "refresh"}
        </button>

        <button
          className="btn btn-sm btn-primary"
          onClick={applyPlan}
          disabled={globalMutationBusy || !canApply || !plan}
          title={isBlocked ? "Resolve conflicts before applying" : needsApply ? "Apply pending changes" : "All surfaces synced"}
        >
          {mutationLabel === "setup apply" ? "applying\u2026" : "apply"}
        </button>

        <button
          className="btn btn-sm"
          onClick={repair}
          disabled={globalMutationBusy || !plan}
        >
          {mutationLabel === "setup repair" ? "repairing\u2026" : "repair"}
        </button>

        <button
          ref={rollbackTriggerRef}
          className="btn btn-sm btn-warn"
          onClick={() => setConfirmRollback(true)}
          disabled={globalMutationBusy || !hasResult || !result?.transaction_id}
          title={
            result?.transaction_id
              ? `Rollback transaction ${result.transaction_id.slice(0, 8)}`
              : "No transaction to roll back"
          }
        >
          rollback
        </button>
      </div>

      {confirmRollback && result && (
        <div className="ws-repair-box" role="alertdialog" aria-label="Confirm rollback">
          <div className="ws-repair-title">Rollback transaction?</div>
          <p className="ws-repair-hint">
            This will restore the previous state of {result.applied.length} artifact(s).
            Transaction: {result.transaction_id.slice(0, 12)}\u2026
          </p>
          <div className="ws-repair-actions">
            <button
              className="btn btn-sm btn-warn"
              onClick={rollbackTxn}
              disabled={globalMutationBusy}
              autoFocus
            >
              {mutationLabel === "setup rollback" ? "rolling back\u2026" : "confirm rollback"}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                setConfirmRollback(false);
                rollbackTriggerRef.current?.focus();
              }}
              disabled={globalMutationBusy}
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="ws-repair-box" role="status" aria-live="polite">
          <div className="ws-panel-title-row">
            <span className={`ws-status-chip ${result.success ? "ws-status-valid" : "ws-status-invalid"}`}>
              {result.success ? "SUCCESS" : "FAILED"}
            </span>
          </div>
          <p>{result.message}</p>
          {result.applied.length > 0 && (
            <p className="ws-repair-hint">Applied: {result.applied.join(", ")}</p>
          )}
          {result.failed.length > 0 && (
            <p className="ws-repair-hint" role="alert">Failed: {result.failed.join("; ")}</p>
          )}
          {result.rolled_back.length > 0 && (
            <p className="ws-repair-hint">Rolled back: {result.rolled_back.join(", ")}</p>
          )}
          {result.manual_steps.length > 0 && (
            <p className="ws-repair-hint">Manual steps: {result.manual_steps.join("; ")}</p>
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
