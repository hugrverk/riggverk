import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult, FileDiffView, FilesSurfaceId, SetupResult, TakeBundledPreview, TakeBundledUnit } from "../types";
import type { RunWorkspaceTask } from "./useInstallScreen";

/**
 * The conflict review as a sub-state of a harness page:
 * `idle -> loading -> diff | bundled -> applying -> idle`.
 *
 * The diff is read-only: `preview_file_diff` compares the installed files of one skill or agent with the bundled
 * ones and writes nothing. A take-bundled preview carries the plan fingerprint and the one-time token of the files
 * as they are now; `apply` hands exactly those to `apply_take_bundled`, and a stale or expired pair is rejected by
 * the backend and shown here as an error from which the review can be opened again. There is no UI in this hook.
 */

export type FileReviewState =
  | { status: "idle" }
  | { status: "loading"; surface: FilesSurfaceId; unit: string; what: "diff" | "bundled" }
  | { status: "diff"; surface: FilesSurfaceId; unit: string; diff: FileDiffView }
  | { status: "bundled"; surface: FilesSurfaceId; unit: string; preview: TakeBundledPreview }
  | { status: "applying"; surface: FilesSurfaceId; unit: string; preview: TakeBundledPreview }
  | { status: "error"; surface: FilesSurfaceId; unit: string; what: "diff" | "bundled" | "apply"; message: string };

const IDLE: FileReviewState = { status: "idle" };

/**
 * The diff is read inline on the page (the Compare fold-out under the files cell): while it loads, while it shows and
 * when its preview failed. The take-bundled preview and its apply are a review that takes the page's place.
 */
export function isInlineFileState(state: FileReviewState): boolean {
  return state.status === "diff" || ((state.status === "loading" || state.status === "error") && state.what === "diff");
}

export interface UseFileConflictFlowOptions {
  /** The workspace task runner: action lock, output pane, minimum running time. */
  runWorkspaceTask: RunWorkspaceTask;
  /** Reload what a take bundled may have changed on disk. */
  refresh: () => void | Promise<void>;
  /** A take bundled that wrote files finished successfully (rollback candidate). */
  onApplied: (result: SetupResult) => void;
}

export interface FileConflictFlow {
  state: FileReviewState;
  /** A review (or its loading or error state) is showing, inline or in place of the page. */
  open: boolean;
  /** A diff is showing inline under the files cell: the page stays, its keys keep working. */
  inline: boolean;
  /** A review has taken the page's place (take bundled and its apply): `open` without the inline diff. */
  reviewing: boolean;
  /** Computes the diff of one unit. Asking again while one is loading replaces it; a running apply is not interrupted. */
  openDiff: (surface: FilesSurfaceId, unit: string) => Promise<void>;
  /** Computes the take-bundled preview of one unit, the same way. */
  openBundled: (surface: FilesSurfaceId, unit: string) => Promise<void>;
  /** `loading | diff | bundled | error -> idle`. A running apply cannot be cancelled. */
  close: () => void;
  /** Applies the reviewed take bundled through the workspace task runner. */
  apply: () => void;
  /** `error -> loading`: the same review again, after a stale or expired preview. */
  retry: () => Promise<void>;
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

const SHORT_FINGERPRINT = 8;

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "tdd", "tdd (2 files)": what a take bundled replaces, for the output and the review. */
export function takeBundledTitle(unit: TakeBundledUnit): string {
  const files = unit.files.length + unit.more_files;
  return files > 1 ? `${unit.name} (${plural(files, "file")})` : unit.name;
}

/** Output-pane text for a finished take bundled: the line the first word tones, then the transaction. */
export function formatTakeBundledOutput(preview: TakeBundledPreview, result: SetupResult) {
  const word = result.success ? "applied" : result.rolled_back.length > 0 ? "rolled back" : "failed";
  const pad = (text: string) => text.padEnd(13);
  const names = preview.units.map(unit => takeBundledTitle(unit)).join(", ");
  const lines = [
    `plan ${preview.plan_fingerprint.slice(0, SHORT_FINGERPRINT) || "-"} · take bundled ${names} · fingerprint verified`,
    `${pad(word)}${names}${result.success ? " · yours backed up" : ""}`,
    ...result.manual_steps.map(step => `${pad("manual")}${step}`),
    result.message,
    `applied ${result.applied.length} · failed ${result.failed.length} · rolled back ${result.rolled_back.length}`,
    result.transaction_id
      ? `transaction ${result.transaction_id} ${result.success && result.applied.length > 0 ? "recorded · rollback available" : "recorded"}`
      : "",
  ].filter(Boolean);
  const stderr = result.success ? "" : [...result.failed, ...(result.failed.length === 0 ? [result.message] : [])].join("\n");
  return { stdout: lines.join("\n"), stderr };
}

export function useFileConflictFlow({ runWorkspaceTask, refresh, onApplied }: UseFileConflictFlowOptions): FileConflictFlow {
  const [state, setState] = useState<FileReviewState>(IDLE);
  // The ref is the source of truth for gating: two keypresses can land before React re-renders.
  const stateRef = useRef<FileReviewState>(IDLE);
  const requestRef = useRef(0);
  const applyingRef = useRef(false);

  const commit = useCallback((next: FileReviewState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(
    () => () => {
      // A preview that resolves after unmount must not update state.
      requestRef.current += 1;
    },
    [],
  );

  const applying = () => stateRef.current.status === "applying";

  const openDiff = useCallback(
    async (surface: FilesSurfaceId, unit: string) => {
      if (applying()) return;
      const id = ++requestRef.current;
      commit({ status: "loading", surface, unit, what: "diff" });
      try {
        const diff = await invoke<FileDiffView>("preview_file_diff", { surface, unit });
        if (id === requestRef.current) commit({ status: "diff", surface, unit, diff });
      } catch (e) {
        if (id === requestRef.current) commit({ status: "error", surface, unit, what: "diff", message: errorText(e) });
      }
    },
    [commit],
  );

  const openBundled = useCallback(
    async (surface: FilesSurfaceId, unit: string) => {
      if (applying()) return;
      const id = ++requestRef.current;
      commit({ status: "loading", surface, unit, what: "bundled" });
      try {
        const preview = await invoke<TakeBundledPreview>("preview_take_bundled", { surface, units: [unit] });
        if (id === requestRef.current) commit({ status: "bundled", surface, unit, preview });
      } catch (e) {
        if (id === requestRef.current) commit({ status: "error", surface, unit, what: "bundled", message: errorText(e) });
      }
    },
    [commit],
  );

  const close = useCallback(() => {
    if (stateRef.current.status === "idle" || stateRef.current.status === "applying") return;
    requestRef.current += 1;
    commit(IDLE);
  }, [commit]);

  const apply = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== "bundled" || applyingRef.current) return;
    const { surface, unit, preview } = current;
    if (!preview.plan_fingerprint || !preview.preview_token) return;
    const { plan_fingerprint: planFingerprint, preview_token: previewToken } = preview;
    const title = preview.units.map(candidate => candidate.name).join(", ");
    applyingRef.current = true;
    commit({ status: "applying", surface, unit, preview });
    type Outcome = { result: SetupResult; message?: undefined } | { result: null; message: string };
    void runWorkspaceTask<Outcome>({
      label: `take bundled ${title}`,
      action: "apply_take_bundled",
      task: async (): Promise<Outcome> => {
        try {
          return { result: await invoke<SetupResult>("apply_take_bundled", { surface, units: [unit], planFingerprint, previewToken }) };
        } catch (e) {
          return { result: null, message: errorText(e) };
        }
      },
      toActionResult: (outcome): ActionResult => {
        const action = `apply_take_bundled ${title}`;
        // The backend rejects a stale fingerprint or an expired token before anything runs; the review keeps the message.
        if (!outcome.result) return { success: false, action, stdout: "", stderr: outcome.message, exit_code: null };
        return { success: outcome.result.success, action, ...formatTakeBundledOutput(preview, outcome.result), exit_code: outcome.result.success ? 0 : 1 };
      },
      refresh,
    })
      .then(outcome => {
        if (!outcome) {
          // The task runner was busy or superseded: nothing ran, the review stays as it was.
          commit({ status: "bundled", surface, unit, preview });
        } else if (!outcome.result) {
          commit({ status: "error", surface, unit, what: "apply", message: outcome.message });
        } else {
          commit(IDLE);
          if (outcome.result.success) onApplied(outcome.result);
        }
      })
      .finally(() => {
        applyingRef.current = false;
      });
  }, [commit, runWorkspaceTask, refresh, onApplied]);

  const retry = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "error") return;
    if (current.what === "diff") await openDiff(current.surface, current.unit);
    else await openBundled(current.surface, current.unit);
  }, [openDiff, openBundled]);

  const open = state.status !== "idle";
  const inline = isInlineFileState(state);
  return { state, open, inline, reviewing: open && !inline, openDiff, openBundled, close, apply, retry };
}
