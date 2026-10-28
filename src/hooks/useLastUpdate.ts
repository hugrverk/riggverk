import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { lastUpdateEntry } from "../lib/lastUpdate";
import type { SetupHistoryEntry } from "../types";

/** How many entries to read: enough to get past runs that failed before writing anything. */
const HISTORY_LIMIT = 8;

/** The answer has the shape of a history list (shared with the History page). */
export function isHistory(value: unknown): value is SetupHistoryEntry[] {
  return Array.isArray(value) && value.every(entry => !!entry && typeof entry === "object" && typeof entry.transaction_id === "string");
}

/**
 * The newest update in the setup history (`list_setup_history`), read from disk, so it survives a restart. Read when
 * `enabled` turns on and whenever `refreshKey` changes (an apply, an uninstall or a rollback finished). A failure or an
 * answer of another shape leaves no entry: the Overview then shows no "Last update" cell. The last answer stays while
 * the next one loads. `undoable` is the backend's offer only; the Undo it enables still goes through a dry run and a confirm.
 */
export function useLastUpdate({ enabled, refreshKey }: { enabled: boolean; refreshKey: string | number }): SetupHistoryEntry | null {
  const [entry, setEntry] = useState<SetupHistoryEntry | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!enabled) {
      setEntry(null);
      return;
    }
    const settle = (next: SetupHistoryEntry | null) => {
      if (generation === generationRef.current) setEntry(next);
    };
    void Promise.resolve()
      .then(() => invoke<SetupHistoryEntry[]>("list_setup_history", { limit: HISTORY_LIMIT }))
      .then(history => settle(isHistory(history) ? lastUpdateEntry(history) : null), () => settle(null));
  }, [enabled, refreshKey]);

  return entry;
}
