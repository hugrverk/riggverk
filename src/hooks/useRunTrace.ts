import { useEffect, useRef, useState } from "react";
import { EMPTY_TRACE, traceStep, type HarnessHomes, type RunTrace } from "../lib/flowModel";
import type { ApplyProgress, InstallAgent } from "../types";

export interface RunAgents {
  trace: RunTrace;
  /** The agents that were waiting for an update when the task started. */
  startAgents: InstallAgent[];
}

/**
 * Which agent a running task is writing: each progress report (`wsProgress`) names the file in progress, and the folder
 * it lives in says whose it is (`homes`). The trace starts empty with every task and is gone when the task ends.
 * `waiting` is read once, when the task starts, as the agents the run is expected to reach.
 */
export function useRunTrace(running: string | null, progress: ApplyProgress | null, homes: HarnessHomes, waiting: readonly InstallAgent[]): RunAgents {
  const [trace, setTrace] = useState<RunTrace>(EMPTY_TRACE);
  const [startAgents, setStartAgents] = useState<InstallAgent[]>([]);
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  const active = running !== null;

  useEffect(() => {
    setTrace(EMPTY_TRACE);
    setStartAgents(active ? [...waitingRef.current] : []);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    setTrace(previous => traceStep(previous, progress, homes));
  }, [active, progress, homes]);

  return { trace: active ? trace : EMPTY_TRACE, startAgents: active ? startAgents : [] };
}
