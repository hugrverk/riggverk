import { useState, useCallback, useRef } from "react";
import type { ActionResult } from "../components/TerminalOutput";
import { wait } from "./timing";

const MIN_RUNNING_MS = 700;

interface UseWorkspaceActionsOptions {
  setError: (msg: string | null) => void;
}

export function useWorkspaceActions(opts: UseWorkspaceActionsOptions) {
  const { setError } = opts;

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
      if (actionResult.success) setError(null);
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
    runWsTask,
    workspaceActionRequestIdRef,
    resetTerminalOutput,
  };
}
