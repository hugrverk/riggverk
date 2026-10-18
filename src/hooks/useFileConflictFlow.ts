import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileDiffView, FilesSurfaceId } from "../types";

/**
 * The conflict review as a sub-state of a harness page: `idle -> loading -> diff -> idle`.
 *
 * The diff is read-only: `preview_file_diff` compares the installed files of one skill or agent with the bundled
 * ones and writes nothing. Nothing in this flow ever writes a skill or agent file. There is no UI in this hook.
 */

export type FileReviewState =
  | { status: "idle" }
  | { status: "loading"; surface: FilesSurfaceId; unit: string }
  | { status: "diff"; surface: FilesSurfaceId; unit: string; diff: FileDiffView }
  | { status: "error"; surface: FilesSurfaceId; unit: string; message: string };

const IDLE: FileReviewState = { status: "idle" };

export interface FileConflictFlow {
  state: FileReviewState;
  /** A review (or its loading or error state) is showing. */
  open: boolean;
  /** Computes the diff of one unit. Asking again while one is loading replaces it. */
  openDiff: (surface: FilesSurfaceId, unit: string) => Promise<void>;
  /** `loading | diff | error -> idle`. */
  close: () => void;
  /** `error -> loading`: the same diff again. */
  retry: () => Promise<void>;
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function useFileConflictFlow(): FileConflictFlow {
  const [state, setState] = useState<FileReviewState>(IDLE);
  // The ref is the source of truth for gating: two keypresses can land before React re-renders.
  const stateRef = useRef<FileReviewState>(IDLE);
  const requestRef = useRef(0);

  const commit = useCallback((next: FileReviewState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(
    () => () => {
      // A diff that resolves after unmount must not update state.
      requestRef.current += 1;
    },
    [],
  );

  const openDiff = useCallback(
    async (surface: FilesSurfaceId, unit: string) => {
      const id = ++requestRef.current;
      commit({ status: "loading", surface, unit });
      try {
        const diff = await invoke<FileDiffView>("preview_file_diff", { surface, unit });
        if (id === requestRef.current) commit({ status: "diff", surface, unit, diff });
      } catch (e) {
        if (id === requestRef.current) commit({ status: "error", surface, unit, message: errorText(e) });
      }
    },
    [commit],
  );

  const close = useCallback(() => {
    if (stateRef.current.status === "idle") return;
    requestRef.current += 1;
    commit(IDLE);
  }, [commit]);

  const retry = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "error") return;
    await openDiff(current.surface, current.unit);
  }, [openDiff]);

  return { state, open: state.status !== "idle", openDiff, close, retry };
}
