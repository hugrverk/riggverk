import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult, CodexConfigDefaultsPreview, SetupResult } from "../types";
import type { RunWorkspaceTask } from "./useInstallScreen";

/**
 * "Use Riggverk defaults" for the Codex config as a sub-state of the Codex page:
 * `idle -> loading -> preview -> applying -> idle`.
 *
 * `preview_codex_config_defaults` writes nothing; it returns the differing keys with Riggverk's values, a key-only
 * diff, the plan fingerprint and a one-time token of the config as it is now. `apply` hands exactly those to
 * `apply_codex_config_defaults`, and a stale or expired pair is rejected by the backend and shown here as an error
 * from which the review can be opened again. There is no UI in this hook.
 */

export type CodexDefaultsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "preview"; preview: CodexConfigDefaultsPreview }
  | { status: "applying"; preview: CodexConfigDefaultsPreview }
  | { status: "error"; what: "preview" | "apply"; message: string };

const IDLE: CodexDefaultsState = { status: "idle" };

export interface UseCodexDefaultsFlowOptions {
  /** The workspace task runner: action lock, run panel, minimum running time. */
  runWorkspaceTask: RunWorkspaceTask;
  /** Reload what the reset may have changed on disk. */
  refresh: () => void | Promise<void>;
  /** A reset that wrote the config finished successfully (rollback candidate). */
  onApplied: (result: SetupResult) => void;
}

export interface CodexDefaultsFlow {
  state: CodexDefaultsState;
  /** The review (or its loading or error state) is showing. */
  open: boolean;
  /** Computes the preview. Asking again while one is loading replaces it; a running apply is not interrupted. */
  openPreview: () => Promise<void>;
  /** `loading | preview | error -> idle`. A running apply cannot be cancelled. */
  close: () => void;
  /** Applies the reviewed reset through the workspace task runner. */
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

/** "approvals_reviewer, sandbox_mode": the keys a reset sets, for the output and the review. */
export function defaultsKeyList(preview: CodexConfigDefaultsPreview): string {
  return preview.keys.map(item => item.key).join(", ");
}

/** Output-pane text for a finished reset: the line the first word tones, then the transaction. */
export function formatCodexDefaultsOutput(preview: CodexConfigDefaultsPreview, result: SetupResult) {
  const word = result.success ? "applied" : result.rolled_back.length > 0 ? "rolled back" : "failed";
  const pad = (text: string) => text.padEnd(13);
  const keys = defaultsKeyList(preview);
  const lines = [
    `plan ${preview.plan_fingerprint.slice(0, SHORT_FINGERPRINT) || "-"} · use Riggverk defaults ${keys} · fingerprint verified`,
    `${pad(word)}Codex config${result.success ? " · yours backed up" : ""}`,
    ...preview.keys.map(item => `${pad("set")}${item.key} = ${item.riggverk}`),
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

export function useCodexDefaultsFlow({ runWorkspaceTask, refresh, onApplied }: UseCodexDefaultsFlowOptions): CodexDefaultsFlow {
  const [state, setState] = useState<CodexDefaultsState>(IDLE);
  // The ref is the source of truth for gating: two keypresses can land before React re-renders.
  const stateRef = useRef<CodexDefaultsState>(IDLE);
  const requestRef = useRef(0);
  const applyingRef = useRef(false);

  const commit = useCallback((next: CodexDefaultsState) => {
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

  const openPreview = useCallback(async () => {
    if (stateRef.current.status === "applying") return;
    const id = ++requestRef.current;
    commit({ status: "loading" });
    try {
      const preview = await invoke<CodexConfigDefaultsPreview>("preview_codex_config_defaults");
      if (id === requestRef.current) commit({ status: "preview", preview });
    } catch (e) {
      if (id === requestRef.current) commit({ status: "error", what: "preview", message: errorText(e) });
    }
  }, [commit]);

  const close = useCallback(() => {
    if (stateRef.current.status === "idle" || stateRef.current.status === "applying") return;
    requestRef.current += 1;
    commit(IDLE);
  }, [commit]);

  const apply = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== "preview" || applyingRef.current) return;
    const { preview } = current;
    if (!preview.plan_fingerprint || !preview.preview_token) return;
    const { plan_fingerprint: planFingerprint, preview_token: previewToken } = preview;
    applyingRef.current = true;
    commit({ status: "applying", preview });
    type Outcome = { result: SetupResult; message?: undefined } | { result: null; message: string };
    void runWorkspaceTask<Outcome>({
      label: "use Riggverk defaults",
      action: "apply_codex_config_defaults",
      task: async (): Promise<Outcome> => {
        try {
          return { result: await invoke<SetupResult>("apply_codex_config_defaults", { planFingerprint, previewToken }) };
        } catch (e) {
          return { result: null, message: errorText(e) };
        }
      },
      toActionResult: (outcome): ActionResult => {
        const action = "apply_codex_config_defaults";
        // The backend rejects a stale fingerprint or an expired token before anything runs; the review keeps the message.
        if (!outcome.result) return { success: false, action, stdout: "", stderr: outcome.message, exit_code: null };
        return { success: outcome.result.success, action, ...formatCodexDefaultsOutput(preview, outcome.result), exit_code: outcome.result.success ? 0 : 1 };
      },
      refresh,
    })
      .then(outcome => {
        if (!outcome) {
          // The task runner was busy or superseded: nothing ran, the review stays as it was.
          commit({ status: "preview", preview });
        } else if (!outcome.result) {
          commit({ status: "error", what: "apply", message: outcome.message });
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
    if (stateRef.current.status !== "error") return;
    await openPreview();
  }, [openPreview]);

  return { state, open: state.status !== "idle", openPreview, close, apply, retry };
}
