import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { surfaceTitle } from "../lib/installPlan";
import type {
  ActionResult,
  RulesConversionPreview,
  RulesDiffMode,
  RulesDiffView,
  RulesSurfaceId,
  SetupResult,
} from "../types";
import type { RunWorkspaceTask } from "./useInstallScreen";

/**
 * The rules review as a sub-state of a harness page: `idle -> loading -> diff | conversion -> applying -> idle`.
 *
 * A diff is read-only. A conversion preview carries the plan fingerprint and the one-time token of the file as it
 * is now; `apply` hands exactly those to `apply_rules_conversion`, and a stale or expired pair is rejected by the
 * backend and shown here as an error from which the review can be opened again. There is no UI in this hook.
 */

export type RulesReviewState =
  | { status: "idle" }
  | { status: "loading"; surface: RulesSurfaceId; what: "diff" | "conversion" }
  | { status: "diff"; surface: RulesSurfaceId; diff: RulesDiffView }
  | { status: "conversion"; surface: RulesSurfaceId; preview: RulesConversionPreview }
  | { status: "applying"; surface: RulesSurfaceId; preview: RulesConversionPreview }
  | { status: "error"; surface: RulesSurfaceId; what: "diff" | "conversion" | "apply"; message: string };

const IDLE: RulesReviewState = { status: "idle" };

/**
 * The diff is read inline on the page (the Compare fold-out under the rules cell): while it loads, while it shows and
 * when its preview failed. Everything else (the conversion, its apply, a failed conversion) is a review that takes the
 * page's place.
 */
export function isInlineRulesState(state: RulesReviewState): boolean {
  return state.status === "diff" || ((state.status === "loading" || state.status === "error") && state.what === "diff");
}

export interface UseRulesFlowOptions {
  /** The workspace task runner: action lock, output pane, minimum running time. */
  runWorkspaceTask: RunWorkspaceTask;
  /** Reload what a conversion may have changed on disk. */
  refresh: () => void | Promise<void>;
  /** A conversion that wrote files finished successfully (rollback candidate). */
  onApplied: (result: SetupResult) => void;
}

export interface RulesFlow {
  state: RulesReviewState;
  /** A review (or its loading or error state) is showing, inline or in place of the page. */
  open: boolean;
  /** The diff is showing inline under the rules cell: the page stays, its keys keep working. */
  inline: boolean;
  /** A review has taken the page's place (the conversion and its apply): `open` without the inline diff. */
  reviewing: boolean;
  openDiff: (surface: RulesSurfaceId, mode: RulesDiffMode) => Promise<void>;
  openConversion: (surface: RulesSurfaceId) => Promise<void>;
  /** The diff of the open surface in the other mode. */
  switchDiffMode: () => Promise<void>;
  /** `loading | diff | conversion | error -> idle`. A running apply cannot be cancelled. */
  close: () => void;
  /** Applies the reviewed conversion through the workspace task runner. */
  apply: () => void;
  /** `error -> loading`: the same review again after a stale or expired preview. */
  retry: () => Promise<void>;
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

const SHORT_FINGERPRINT = 8;

/** Output-pane text for a finished conversion: the surface line the first word tones, then the transaction. */
export function formatConversionOutput(preview: RulesConversionPreview, result: SetupResult) {
  const title = surfaceTitle(preview.surface);
  const word = result.success ? "applied" : result.rolled_back.length > 0 ? "rolled back" : "failed";
  const pad = (text: string) => text.padEnd(13);
  const moved = preview.moved_sections.length;
  const lines = [
    `plan ${(preview.plan_fingerprint ?? "").slice(0, SHORT_FINGERPRINT) || "-"} · convert ${title} · fingerprint verified`,
    `${pad(word)}${title}`,
    ...(result.success && moved > 0
      ? [`${pad("kept")}${moved} section${moved === 1 ? "" : "s"} below the END marker: ${preview.moved_sections.join(", ")}`]
      : []),
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

export function useRulesFlow({ runWorkspaceTask, refresh, onApplied }: UseRulesFlowOptions): RulesFlow {
  const [state, setState] = useState<RulesReviewState>(IDLE);
  // The ref is the source of truth for gating: two keypresses can land before React re-renders.
  const stateRef = useRef<RulesReviewState>(IDLE);
  const requestRef = useRef(0);
  const applyingRef = useRef(false);
  const diffModeRef = useRef<RulesDiffMode>("update");

  const commit = useCallback((next: RulesReviewState) => {
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

  const busy = () => stateRef.current.status === "loading" || stateRef.current.status === "applying";

  const openDiff = useCallback(
    async (surface: RulesSurfaceId, mode: RulesDiffMode) => {
      if (busy()) return;
      const id = ++requestRef.current;
      diffModeRef.current = mode;
      commit({ status: "loading", surface, what: "diff" });
      try {
        const diff = await invoke<RulesDiffView>("preview_rules_diff", { surface, mode });
        if (id === requestRef.current) commit({ status: "diff", surface, diff });
      } catch (e) {
        if (id === requestRef.current) commit({ status: "error", surface, what: "diff", message: errorText(e) });
      }
    },
    [commit],
  );

  const openConversion = useCallback(
    async (surface: RulesSurfaceId) => {
      if (busy()) return;
      const id = ++requestRef.current;
      commit({ status: "loading", surface, what: "conversion" });
      try {
        const preview = await invoke<RulesConversionPreview>("preview_rules_conversion", { surface });
        if (id === requestRef.current) commit({ status: "conversion", surface, preview });
      } catch (e) {
        if (id === requestRef.current) commit({ status: "error", surface, what: "conversion", message: errorText(e) });
      }
    },
    [commit],
  );

  const switchDiffMode = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "diff") return;
    await openDiff(current.surface, current.diff.mode === "edits" ? "update" : "edits");
  }, [openDiff]);

  const close = useCallback(() => {
    if (stateRef.current.status === "idle" || stateRef.current.status === "applying") return;
    requestRef.current += 1;
    commit(IDLE);
  }, [commit]);

  const apply = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== "conversion" || applyingRef.current) return;
    const { surface, preview } = current;
    if (!preview.applicable || !preview.plan_fingerprint || !preview.preview_token) return;
    const { plan_fingerprint: planFingerprint, preview_token: previewToken } = preview;
    applyingRef.current = true;
    commit({ status: "applying", surface, preview });
    type Outcome = { result: SetupResult; message?: undefined } | { result: null; message: string };
    void runWorkspaceTask<Outcome>({
      label: `convert ${surfaceTitle(surface)}`,
      action: "apply_rules_conversion",
      task: async (): Promise<Outcome> => {
        try {
          return { result: await invoke<SetupResult>("apply_rules_conversion", { surface, planFingerprint, previewToken }) };
        } catch (e) {
          return { result: null, message: errorText(e) };
        }
      },
      toActionResult: (outcome): ActionResult => {
        const action = `apply_rules_conversion ${surfaceTitle(surface)}`;
        // The backend rejects a stale fingerprint or an expired token before anything runs; the review keeps the message.
        if (!outcome.result) return { success: false, action, stdout: "", stderr: outcome.message, exit_code: null };
        return { success: outcome.result.success, action, ...formatConversionOutput(preview, outcome.result), exit_code: outcome.result.success ? 0 : 1 };
      },
      refresh,
    })
      .then(outcome => {
        if (!outcome) {
          // The task runner was busy or superseded: nothing ran, the review stays as it was.
          commit({ status: "conversion", surface, preview });
        } else if (!outcome.result) {
          commit({ status: "error", surface, what: "apply", message: outcome.message });
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
    if (current.what === "diff") await openDiff(current.surface, diffModeRef.current);
    else await openConversion(current.surface);
  }, [openDiff, openConversion]);

  const open = state.status !== "idle";
  const inline = isInlineRulesState(state);
  return { state, open, inline, reviewing: open && !inline, openDiff, openConversion, switchDiffMode, close, apply, retry };
}
