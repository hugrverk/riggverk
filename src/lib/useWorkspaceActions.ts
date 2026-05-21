import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ActionResult } from "../components/TerminalOutput";
import type { InstallAgent, InstallSkillsRequest, WorkspaceDiagnostics } from "../types";
import { INSTALL_AGENTS } from "../types";
import { wait } from "./timing";

const MIN_RUNNING_MS = 700;

interface UseWorkspaceActionsOptions {
  fetchStatus: (generation?: number) => Promise<void>;
  isInvalidWorkspaceError: (e: unknown) => boolean;
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  installAgents: Set<string>;
  selectedSkills: Set<string>;
  setError: (msg: string | null) => void;
}

export function useWorkspaceActions(opts: UseWorkspaceActionsOptions) {
  const {
    fetchStatus,
    isInvalidWorkspaceError,
    workspaceDiagnostics,
    installAgents,
    selectedSkills,
    setError,
  } = opts;

  const workspaceActionLockRef = useRef(false);
  const workspaceActionRequestIdRef = useRef(0);

  const resetTerminalOutput = useCallback(() => {
    setWsLog(null);
    setWsLogCompletedAt(null);
    setWsRunning(null);
  }, []);

  const [wsLog, setWsLog] = useState<ActionResult | null>(null);
  const [wsRunning, setWsRunning] = useState<string | null>(null);
  const [wsLogCompletedAt, setWsLogCompletedAt] = useState<number | null>(null);

  const [activityIndex, setActivityIndex] = useState(0);

  useEffect(() => {
    if (!wsRunning) return;
    setActivityIndex(0);
    const id = window.setInterval(() => setActivityIndex(i => (i + 1) % 8), 110);
    return () => window.clearInterval(id);
  }, [wsRunning]);

  function activityCellClass(index: number): string {
    const distance = (index - activityIndex + 8) % 8;
    if (distance === 0) return "terminal-activity-cell terminal-activity-cell-active";
    if (distance === 1 || distance === 7) return "terminal-activity-cell terminal-activity-cell-mid";
    if (distance === 2 || distance === 6) return "terminal-activity-cell terminal-activity-cell-low";
    return "terminal-activity-cell";
  }

  const runWsAction = useCallback(async (action: string, label: string) => {
    if (workspaceActionLockRef.current) return;
    workspaceActionLockRef.current = true;
    const requestId = ++workspaceActionRequestIdRef.current;
    const isCurrentAction = () => workspaceActionRequestIdRef.current === requestId;
    const startedAt = performance.now();
    setWsRunning(label); setError(null);
    try {
      if (action === "release_check" && workspaceDiagnostics && !workspaceDiagnostics.valid) {
        if (isCurrentAction()) {
          setWsLog({ success: false, action, stdout: "", stderr: "No valid workspace installed. Use install or repair on the Workspace page.", exit_code: null });
        }
        setWsLogCompletedAt(Date.now());
        return;
      }
      const result = await invoke<ActionResult>("run_action", { action });
      if (!isCurrentAction()) return;
      setWsLog(result);
      setWsLogCompletedAt(Date.now());
      if (!action.startsWith("open_")) fetchStatus();
    } catch (e) {
      if (!isCurrentAction()) return;
      if (isInvalidWorkspaceError(e)) {
        setWsLog({ success: false, action, stdout: "", stderr: "No valid workspace installed. Use install or repair on the Workspace page.", exit_code: null });
      } else {
        setError(`${action}: ${e}`);
      }
      setWsLogCompletedAt(Date.now());
    }
    finally {
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      if (isCurrentAction()) setWsRunning(null);
      workspaceActionLockRef.current = false;
    }
  }, [fetchStatus, workspaceDiagnostics, isInvalidWorkspaceError, setError]);

  const runWsInstallForAgents = useCallback(async (
    dry: boolean,
    agents: InstallAgent[],
    label?: string,
  ) => {
    if (workspaceActionLockRef.current) return;
    const allowed = new Set<string>(INSTALL_AGENTS);
    const normalized = agents.filter((a): a is InstallAgent => allowed.has(a));
    if (normalized.length === 0) return;

    workspaceActionLockRef.current = true;
    const requestId = workspaceActionRequestIdRef.current + 1;
    workspaceActionRequestIdRef.current = requestId;
    const isCurrentAction = () => workspaceActionRequestIdRef.current === requestId;
    const runningLabel = label ?? (dry ? "install skills dry-run" : "install skills");
    const startedAt = performance.now();
    setWsRunning(runningLabel);
    setError(null);
    try {
      const req: InstallSkillsRequest = {
        agents: normalized,
        skills: Array.from(selectedSkills),
        dry_run: dry,
      };
      const result = await invoke<ActionResult>("install_skills", { request: req });
      if (!isCurrentAction()) return;
      setWsLog(result);
      setWsLogCompletedAt(Date.now());
      if (!dry && result.success) fetchStatus();
    } catch (e) {
      if (!isCurrentAction()) return;
      setWsLog({
        success: false,
        action: dry ? "install_skills:dry-run" : "install_skills",
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
      setError(`Install: ${e}`);
    } finally {
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      if (isCurrentAction()) setWsRunning(null);
      workspaceActionLockRef.current = false;
    }
  }, [selectedSkills, fetchStatus, setError]);

  const runWsInstall = useCallback(
    (dry: boolean) => runWsInstallForAgents(dry, Array.from(installAgents) as InstallAgent[]),
    [installAgents, runWsInstallForAgents],
  );

  /** Generic terminal task runner. Wraps an async task with action lock,
   *  request cancellation, min-running delay, wsRunning/wsLog/wsLogCompletedAt.
   *  Stable reference via useCallback with empty deps (uses refs and setStates). */
  const runWsTask = useCallback(async <T,>(opts: {
    label: string;
    action: string;
    task: () => Promise<T>;
    toActionResult: (result: T) => ActionResult;
    refresh?: () => void | Promise<void>;
  }): Promise<T | null> => {
    if (workspaceActionLockRef.current) return null;
    workspaceActionLockRef.current = true;
    const requestId = ++workspaceActionRequestIdRef.current;
    const isCurrent = () => workspaceActionRequestIdRef.current === requestId;
    const startedAt = performance.now();
    setWsRunning(opts.label);
    setError(null);
    try {
      const result = await opts.task();
      if (!isCurrent()) {
        return null;
      }
      const actionResult = opts.toActionResult(result);
      setWsLog(actionResult);
      setWsLogCompletedAt(Date.now());
      if (opts.refresh) await opts.refresh();
      return result;
    } catch (e: unknown) {
      if (!isCurrent()) return null;
      const errStr = String(e);
      setWsLog({
        success: false,
        action: opts.action,
        stdout: "",
        stderr: errStr.slice(0, 500),
        exit_code: null,
      });
      setWsLogCompletedAt(Date.now());
      return null;
    } finally {
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      if (isCurrent()) setWsRunning(null);
      workspaceActionLockRef.current = false;
    }
  }, []);

  return {
    wsRunning,
    wsLog,
    wsLogCompletedAt,
    activityIndex,
    activityCellClass,
    runWsAction,
    runWsInstall,
    runWsInstallForAgents,
    runWsTask,
    workspaceActionRequestIdRef,
    resetTerminalOutput,
  };
}
