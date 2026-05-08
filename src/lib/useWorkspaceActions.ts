import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ActionResult } from "../components/TerminalOutput";
import type { InstallSkillsRequest, WorkspaceDiagnostics } from "../types";
import { wait } from "./timing";

const MIN_RUNNING_MS = 700;

interface UseWorkspaceActionsOptions {
  fetchStatus: (generation?: number) => Promise<void>;
  isInvalidWorkspaceError: (e: unknown) => boolean;
  workspaceDiagnostics: WorkspaceDiagnostics | null;
  installAgents: Set<string>;
  installScope: "global" | "project";
  installTarget: string;
  selectedSkills: Set<string>;
  setError: (msg: string | null) => void;
}

export function useWorkspaceActions(opts: UseWorkspaceActionsOptions) {
  const {
    fetchStatus,
    isInvalidWorkspaceError,
    workspaceDiagnostics,
    installAgents,
    installScope,
    installTarget,
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
    const requestId = workspaceActionRequestIdRef.current + 1;
    workspaceActionRequestIdRef.current = requestId;
    const isCurrentAction = () => workspaceActionRequestIdRef.current === requestId;
    const startedAt = performance.now();
    setWsRunning(label); setError(null);
    try {
      if (action === "release_check" && workspaceDiagnostics && !workspaceDiagnostics.valid) {
        if (isCurrentAction()) {
          setWsLog({ success: false, action, stdout: "", stderr: "No valid workspace selected. Set path above or create one.", exit_code: null });
        }
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
        setWsLog({ success: false, action, stdout: "", stderr: "No valid workspace selected. Set path above or create one.", exit_code: null });
      } else {
        setError(`${action}: ${e}`);
      }
    }
    finally {
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      if (isCurrentAction()) setWsRunning(null);
      workspaceActionLockRef.current = false;
    }
  }, [fetchStatus, workspaceDiagnostics, isInvalidWorkspaceError, setError]);

  const runWsInstall = useCallback(async (dry: boolean) => {
    if (installScope === "project" && installTarget.trim() === "") return;
    if (workspaceActionLockRef.current) return;
    workspaceActionLockRef.current = true;
    const requestId = workspaceActionRequestIdRef.current + 1;
    workspaceActionRequestIdRef.current = requestId;
    const isCurrentAction = () => workspaceActionRequestIdRef.current === requestId;
    const label = dry ? "install skills dry-run" : "install skills";
    const startedAt = performance.now();
    setWsRunning(label); setError(null);
    try {
      const req: InstallSkillsRequest = {
        agents: Array.from(installAgents),
        scope: installScope,
        target: installScope === "project" ? installTarget : undefined,
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
      setWsLog({ success: false, action: dry ? "install_skills:dry-run" : "install_skills", stdout: "", stderr: String(e), exit_code: null });
      setError(`Install: ${e}`);
    }
    finally {
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      if (isCurrentAction()) setWsRunning(null);
      workspaceActionLockRef.current = false;
    }
  }, [installAgents, installScope, installTarget, selectedSkills, fetchStatus, setError]);

  return {
    wsRunning,
    wsLog,
    wsLogCompletedAt,
    activityIndex,
    activityCellClass,
    runWsAction,
    runWsInstall,
    workspaceActionRequestIdRef,
    resetTerminalOutput,
  };
}
