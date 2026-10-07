import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import type { ApplyProgress } from "../types";

/** The backend's event name (`apply_progress::APPLY_PROGRESS_EVENT`). */
export const APPLY_PROGRESS_EVENT = "apply-progress";

/**
 * The latest progress the backend reported for the workspace task in flight. `running` is the task label
 * (`wsRunning`): progress exists only while it is set, starts empty with every task and is gone when the task ends,
 * so a late event of the last task never shows up in the next one.
 *
 * Without a backend, or without permission to listen, the hook stays null and the strip falls back to its
 * indeterminate state.
 */
export function useApplyProgress(running: string | null): ApplyProgress | null {
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  const active = running !== null;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<ApplyProgress>(APPLY_PROGRESS_EVENT, event => {
      if (!disposed && activeRef.current) setProgress(event.payload);
    })
      .then(stop => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    setProgress(null);
  }, [active]);

  return active ? progress : null;
}
