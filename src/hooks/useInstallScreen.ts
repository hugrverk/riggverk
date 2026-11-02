import { useCallback, useEffect, useRef, useState } from "react";
import type { AppView } from "../shell/views";
import {
  formatApplyOutput,
  installRequestFor,
  scopeForTarget,
  type InstallScope,
  type InstallTarget,
} from "../lib/installPlan";
import type { ActionResult, AppSettings, SetupResult } from "../types";
import { useInstallFlow, type InstallFlow, type InstallReview } from "./useInstallFlow";

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/** The workspace task runner (`useWorkspaceActions().runWsTask`): action lock, run panel, min-running time. */
export type RunWorkspaceTask = <T>(options: {
  label: string;
  action: string;
  task: () => Promise<T>;
  toActionResult: (result: T) => ActionResult;
  refresh?: () => void | Promise<void>;
}) => Promise<T | null>;

export interface UseInstallScreenOptions {
  /** The active view. */
  view: AppView;
  /** The view that is current right now, updated synchronously by `switchView`. */
  getView: () => AppView;
  switchView: (view: AppView) => void | Promise<void>;
  settings: EnabledSettings | null;
  runWorkspaceTask: RunWorkspaceTask;
  /** Reload diagnostics, library data and health after an apply. */
  refresh: () => void | Promise<void>;
  /** A run that wrote files finished successfully (rollback candidate, stale recovery cleanup). */
  onApplied: (result: SetupResult) => void;
  /** The workspace task in flight (`wsRunning`): another task starting (an Undo) closes the done card. */
  running?: string | null;
}

/** A successful apply, kept on its page as the review's done state until it is dismissed. */
export interface InstallDone {
  review: InstallReview;
  result: SetupResult;
  /** When the apply returned (ms). */
  at: number;
  /** The corresponding run-panel outcome. */
  actionResult: ActionResult;
}

export interface InstallOpenOptions {
  readOnly?: boolean;
  scope?: InstallScope;
}

export interface InstallScreen {
  flow: InstallFlow;
  /** The page the review is anchored to, or null before the first one. */
  scope: InstallScope | null;
  /** The review (or its preview/error state) is showing on this page. */
  isOpenOn: (view: AppView) => boolean;
  /**
   * Opens the review for `target`: switches to its page first (the harness page, or the Overview for the
   * workspace and `all`), then previews. `scope` keeps the review on the page that asked for it.
   * `readOnly` shows the plan without an apply path. Ignored while a preview or an apply is running.
   */
  open: (target: InstallTarget, options?: InstallOpenOptions) => Promise<void>;
  /** Applies the reviewed plan through the workspace task runner so the run panel shows the run. */
  apply: () => void;
  /**
   * The apply that just succeeded: the review stays on its page in its done state (the map in sync, the receipt, Undo)
   * until it is dismissed, the page is left, another review opens or another workspace task starts.
   */
  done: InstallDone | null;
  dismiss: () => void;
}

/**
 * The install review as a sub-state of the Start and harness pages: one `useInstallFlow` for the app, the
 * page it belongs to, and the apply wrapper that reports into the run panel. Leaving the page cancels a
 * review that has not been applied, and closes the done state of one that was.
 */
export function useInstallScreen({
  view,
  getView,
  switchView,
  settings,
  runWorkspaceTask,
  refresh,
  onApplied,
  running = null,
}: UseInstallScreenOptions): InstallScreen {
  const flow = useInstallFlow();
  const [scope, setScope] = useState<InstallScope | null>(null);
  const [done, setDone] = useState<InstallDone | null>(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;

  useEffect(() => {
    if (scope === null || view === scope) return;
    const { status, cancel } = flowRef.current;
    if (status === "previewing" || status === "review" || status === "error") cancel();
    setDone(null);
  }, [view, scope, flow.status]);

  // The apply's own task is running before its done state exists; a task that starts after it (Undo) ends it.
  const wasRunning = useRef(running !== null);
  useEffect(() => {
    if (running !== null && !wasRunning.current) setDone(null);
    wasRunning.current = running !== null;
  }, [running]);

  const dismiss = useCallback(() => setDone(null), []);

  const open = useCallback(
    async (target: InstallTarget, { readOnly, scope: requestedScope }: InstallOpenOptions = {}) => {
      if (!settings) return;
      const status = flowRef.current.status;
      if (status === "previewing" || status === "applying") return;
      const nextScope = requestedScope ?? scopeForTarget(target);
      if (getView() !== nextScope) {
        await switchView(nextScope);
        // A dirty-library confirm may have kept the user where they were.
        if (getView() !== nextScope) return;
      }
      setScope(nextScope);
      setDone(null);
      await flowRef.current.start(installRequestFor(target, settings, { readOnly }));
    },
    [settings, getView, switchView],
  );

  const apply = useCallback(() => {
    const current = flowRef.current;
    const review = current.review;
    if (current.status !== "review" || !review?.canApply) return;
    void runWorkspaceTask<{ review: InstallReview; result: SetupResult | null }>({
      label: review.request.label,
      action: "apply_setup",
      task: async () => {
        const result = await flowRef.current.apply();
        return { review, result };
      },
      toActionResult: ({ review: reviewed, result }) => {
        const action = `apply_setup ${reviewed.request.label}`;
        // The flow keeps the rejection (stale fingerprint, expired token) and shows it in the plan pane.
        if (!result) {
          return {
            success: false,
            action,
            stdout: "",
            stderr: "apply was rejected before it ran; see the plan pane",
            exit_code: null,
          };
        }
        const actionResult = { success: result.success, action, ...formatApplyOutput(reviewed, result), exit_code: result.success ? 0 : 1 };
        if (result.success) setDone({ review: reviewed, result, at: Date.now(), actionResult });
        return actionResult;
      },
      refresh,
    }).then(outcome => {
      if (outcome?.result?.success) onApplied(outcome.result);
    });
  }, [runWorkspaceTask, refresh, onApplied]);

  const isOpenOn = useCallback(
    (page: AppView) => scope === page && (flow.status !== "idle" || done !== null),
    [scope, flow.status, done],
  );

  return { flow, scope, isOpenOn, open, apply, done, dismiss };
}
