import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SetupHistoryEntry } from "../types";
import { isHistory } from "./useLastUpdate";

/** How many runs the History page reads. The list is read from disk, newest first. */
export const HISTORY_PAGE_LIMIT = 50;

export type HistoryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; entries: SetupHistoryEntry[] };

/**
 * The setup history (`list_setup_history`) for the History page: every run of this workspace on disk, newest first,
 * so it is complete after a restart. Read when `enabled` turns on and whenever `refreshKey` changes (an apply, an
 * uninstall or a rollback finished). The last answer stays on screen while the next one loads; an answer of another
 * shape or a failure is an error state, never an empty list.
 */
export function useHistory({ enabled, refreshKey }: { enabled: boolean; refreshKey: string | number }): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!enabled) {
      setState({ status: "loading" });
      return;
    }
    const settle = (next: HistoryState) => {
      if (generation === generationRef.current) setState(next);
    };
    void Promise.resolve()
      .then(() => invoke<SetupHistoryEntry[]>("list_setup_history", { limit: HISTORY_PAGE_LIMIT }))
      .then(
        history => settle(isHistory(history) ? { status: "ready", entries: history } : { status: "error" }),
        () => settle({ status: "error" }),
      );
  }, [enabled, refreshKey]);

  return state;
}
