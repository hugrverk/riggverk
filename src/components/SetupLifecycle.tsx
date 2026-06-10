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
    opencode_config: "OpenCode Config",
    opencode_agents: "OpenCode Agents",
    opencode_rules: "OpenCode Rules",
    codex_config: "Codex Config",
    codex_agents: "Codex Agents",
    codex_rules: "Codex Rules",
    claude_rules: "Claude Rules",
    claude_agents: "Claude Agents",
    claude_skills: "Claude Skills",
    cursor_setup: "Cursor Setup",
    opencode_skills: "OpenCode Skills",
    codex_skills: "Codex Skills",
    cursor_skills: "Cursor Skills",
    deprecated_skill_cleanup: "Deprecated Skills",
  };
  return map[id] ?? id;
}

// ── Component ──

export interface SetupLifecycleProps {
  onError: (msg: string) => void;
  onLog: (msg: string) => void;
}

export function SetupLifecycle({ onError, onLog }: SetupLifecycleProps) {
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const genRef = useRef(0);

  // Refresh detection
  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    setPlan(null);
    setResult(null);
    try {
      const p = await invoke<SetupPlan>("preview_setup", { surfaces: [] });
      if (gen !== genRef.current) return;
      setPlan(p);
      onLog("Setup detection refreshed");
    } catch (e) {
      if (gen !== genRef.current) return;
      onError(`Preview failed: ${e}`);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [onError, onLog]);

  // Refresh on mount
  useEffect(() => { refresh(); }, [refresh]);

  // Apply setup plan
  const applyPlan = useCallback(async () => {
    if (!plan) return;
    
    // Preview must be fresh
    const gen = ++genRef.current;
    setBusy("Applying\u2026");
    setResult(null);
    
    // Collect surfaces that need apply
    const surfaces = plan.operations
      .filter(op => op.kind === "create" || op.kind === "update")
      .map(op => op.surface);

    if (surfaces.length === 0) {
      setBusy(null);
      onLog("Nothing to apply");
      return;
    }

    try {
      const r = await invoke<SetupResult>("apply_setup", {
        surfaces,
        skipManual: true,
      });
      if (gen !== genRef.current) return;
      setResult(r);
      onLog(`Apply result: ${r.message}`);
      // Re-preview after apply
      await refresh();
    } catch (e) {
      if (gen !== genRef.current) return;
      onError(`Apply failed: ${e}`);
    } finally {
      if (gen === genRef.current) setBusy(null);
    }
  }, [plan, onError, onLog, refresh]);

  // Repair missing resources
  const repair = useCallback(async () => {
    const gen = ++genRef.current;
    setBusy("Repairing\u2026");
    setResult(null);
    try {
      const r = await invoke<SetupResult>("repair_setup_command", { skipManual: true });
      if (gen !== genRef.current) return;
      setResult(r);
      onLog(`Repair result: ${r.message}`);
      await refresh();
    } catch (e) {
      if (gen !== genRef.current) return;
      onError(`Repair failed: ${e}`);
    } finally {
      if (gen === genRef.current) setBusy(null);
    }
  }, [onError, onLog, refresh]);

  // Rollback last transaction
  const [confirmRollback, setConfirmRollback] = useState(false);
  const rollbackTxn = useCallback(async () => {
    if (!result?.transaction_id) return;
    const gen = ++genRef.current;
    setBusy("Rolling back\u2026");
    try {
      const r = await invoke<SetupResult>("rollback_setup_transaction", {
        transactionId: result.transaction_id,
        dryRun: false,
      });
      if (gen !== genRef.current) return;
      setResult(r);
      setConfirmRollback(false);
      onLog(`Rollback result: ${r.message}`);
      await refresh();
    } catch (e) {
      if (gen !== genRef.current) return;
      onError(`Rollback failed: ${e}`);
    } finally {
      if (gen === genRef.current) setBusy(null);
    }
  }, [result, onError, onLog, refresh]);

  const actionDisabled = busy !== null;
  const needsApply = plan?.operations.some(op => op.kind === "create" || op.kind === "update") ?? false;
  const isBlocked = plan?.is_blocked ?? false;
  const hasResult = result !== null;

  return (
    <div className="ws-panel" role="region" aria-label="Unified setup lifecycle">
      <div className="ws-panel-header">
        <span className="ws-panel-title">SETUP LIFECYCLE</span>
        {loading && <span className="ws-status-dim" role="status">detecting\u2026</span>}
        {plan && !loading && (
          <span className="ws-status-chip ws-status-valid">{plan.summary}</span>
        )}
      </div>

      {/* Detection results */}
      {plan && !loading && (
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
                <span className="ws-path-status-detail">
                  {op.manual_step}
                </span>
              )}
            </div>
          ))}

          {/* Synced surfaces */}
          {plan.synced.length > 0 && (
            <div className="start-workspace-path-entry">
              <span className="start-workspace-path-label">
                {plan.synced.length} synced surface(s)
              </span>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="ws-action-row start-workspace-actions">
        <button
          className="btn btn-sm"
          onClick={refresh}
          disabled={actionDisabled}
          aria-label="Refresh setup detection"
        >
          {loading ? "detecting\u2026" : "refresh"}
        </button>

        <button
          className="btn btn-sm btn-primary"
          onClick={applyPlan}
          disabled={actionDisabled || !needsApply || isBlocked || !plan}
          title={isBlocked ? "Resolve conflicts before applying" : needsApply ? "Apply pending changes" : "All surfaces synced"}
        >
          {busy === "Applying\u2026" ? "applying\u2026" : "apply"}
        </button>

        <button
          className="btn btn-sm"
          onClick={repair}
          disabled={actionDisabled || !plan}
        >
          {busy === "Repairing\u2026" ? "repairing\u2026" : "repair"}
        </button>

        <button
          className="btn btn-sm btn-warn"
          onClick={() => setConfirmRollback(true)}
          disabled={actionDisabled || !hasResult || !result?.transaction_id}
          title={
            result?.transaction_id
              ? `Rollback transaction ${result.transaction_id.slice(0, 8)}`
              : "No transaction to roll back"
          }
        >
          rollback
        </button>
      </div>

      {/* Rollback confirmation */}
      {confirmRollback && result && (
        <div className="ws-repair-box" role="alertdialog" aria-label="Confirm rollback">
          <div className="ws-repair-title">Rollback transaction?</div>
          <p className="ws-repair-hint">
            This will restore the previous state of {result.applied.length} surface(s).
            Transaction: {result.transaction_id.slice(0, 12)}\u2026
          </p>
          <div className="ws-repair-actions">
            <button
              className="btn btn-sm btn-warn"
              onClick={rollbackTxn}
              disabled={actionDisabled}
              autoFocus
            >
              {busy === "Rolling back\u2026" ? "rolling back\u2026" : "confirm rollback"}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setConfirmRollback(false)}
              disabled={actionDisabled}
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {/* Result display */}
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

      {/* Error when blocked */}
      {isBlocked && plan && (
        <p className="ws-path-status-detail" role="alert">
          Conflicts or unavailable surfaces block apply. Resolve them or refresh.
        </p>
      )}
    </div>
  );
}
