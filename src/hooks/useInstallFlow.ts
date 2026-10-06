import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { surfacesNeedingApply } from "../lib/harnessInstallation";
import type { PlannedOperation, SetupPlan, SetupResult, SetupSurfaceId } from "../types";

/**
 * Install/update flow: `idle -> previewing -> review -> applying -> idle | error`.
 *
 * The backend plan is all-or-nothing per fingerprint: `apply_setup` only ever receives the
 * fingerprint, preview token and pending surfaces of the plan the user reviewed. A stale
 * fingerprint or an expired token is rejected by the backend and surfaced here as its own
 * error kind, from which `repreview()` starts over. There is no UI in this hook.
 */

export type InstallFlowStatus = "idle" | "previewing" | "review" | "applying" | "error";

export interface InstallFlowRequest {
  /** Output-pane label, e.g. "update claude". */
  label: string;
  /**
   * Target-filtered surfaces to preview (see `enabledSurfacesForHarness`). Must not be empty:
   * an empty list means "everything" to the backend, so it is rejected before any invoke.
   */
  surfaces: SetupSurfaceId[];
  /** Show the plan but never apply it (`:preview`). */
  readOnly?: boolean;
}

/** Surface-level operation counts (`+ ~ − !` and unchanged). */
export interface InstallPlanCounts {
  create: number;
  update: number;
  remove: number;
  conflict: number;
  manual: number;
  unavailable: number;
  /** Surfaces already in sync (`plan.synced`, plus any `no_change` operation). */
  unchanged: number;
}

export interface InstallReview {
  request: InstallFlowRequest;
  plan: SetupPlan;
  counts: InstallPlanCounts;
  /** Operations apply would write: create, update, remove. */
  safeOperations: PlannedOperation[];
  /** Conflicting operations; apply skips them and preserves the installed file. */
  conflicts: PlannedOperation[];
  /** Operations that need a manual step; apply never touches them. */
  manualSteps: PlannedOperation[];
  /** The surfaces `apply_setup` receives: `surfacesNeedingApply(plan)`. */
  applySurfaces: SetupSurfaceId[];
  /** False for read-only requests, plans with no safe operation, and plans without a fingerprint/token. */
  canApply: boolean;
}

export type InstallFlowErrorKind =
  /** The request had no surfaces; nothing was invoked. */
  | "no_surfaces"
  /** `preview_setup` rejected. */
  | "preview_failed"
  /** Installed state changed after the preview (fingerprint mismatch). Re-preview. */
  | "stale"
  /** The preview token expired (TTL 600 s) or was already used. Re-preview. */
  | "expired"
  /** `apply_setup` rejected before running (e.g. blocked plan). No transaction exists. */
  | "apply_failed";

export interface InstallFlowError {
  kind: InstallFlowErrorKind;
  message: string;
  /** True when `repreview()` can recover; false only for `no_surfaces`. */
  canRepreview: boolean;
}

/** A completed `apply_setup` run, successful or not (failures include `failed` and `rolled_back`). */
export interface InstallFlowOutcome {
  request: InstallFlowRequest;
  result: SetupResult;
}

export interface InstallFlow {
  status: InstallFlowStatus;
  /** The request being previewed, reviewed, applied, or that failed. Null when idle. */
  request: InstallFlowRequest | null;
  /** Set while `review` and `applying`. */
  review: InstallReview | null;
  /** Set while `error`. */
  error: InstallFlowError | null;
  /** The last finished apply run. Survives `idle`; cleared when the next `start` begins. */
  outcome: InstallFlowOutcome | null;
  /** `idle | review | error -> previewing`. Ignored (null) while previewing or applying. */
  start: (request: InstallFlowRequest) => Promise<InstallReview | null>;
  /**
   * `review -> applying -> idle`. Calls `apply_setup` once, with only the reviewed plan's
   * fingerprint, token and pending surfaces. Returns null when not in a reviewable state, when the
   * plan cannot be applied, on a repeat call, or when the backend rejects (status becomes `error`).
   */
  apply: () => Promise<SetupResult | null>;
  /** `previewing | review | error -> idle`. A running apply cannot be cancelled. */
  cancel: () => void;
  /** Preview the same request again (`review | error -> previewing`); the recovery for stale/expired. */
  repreview: () => Promise<InstallReview | null>;
}

type FlowState =
  | { status: "idle" }
  | { status: "previewing"; request: InstallFlowRequest }
  | { status: "review"; request: InstallFlowRequest; review: InstallReview }
  | { status: "applying"; request: InstallFlowRequest; review: InstallReview }
  | { status: "error"; request: InstallFlowRequest | null; error: InstallFlowError };

const IDLE: FlowState = { status: "idle" };

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Maps a backend rejection of `apply_setup` to `stale` / `expired` when it asks for a new preview. */
export function classifyApplyError(message: string): InstallFlowErrorKind {
  if (/expired|already used/i.test(message)) return "expired";
  if (/re-run preview|fingerprint|scope mismatch|workspace mismatch|purpose mismatch/i.test(message)) {
    return "stale";
  }
  return "apply_failed";
}

export function buildInstallReview(request: InstallFlowRequest, plan: SetupPlan): InstallReview {
  const counts: InstallPlanCounts = {
    create: 0,
    update: 0,
    remove: 0,
    conflict: 0,
    manual: 0,
    unavailable: 0,
    unchanged: plan.synced.length,
  };
  const safeOperations: PlannedOperation[] = [];
  const conflicts: PlannedOperation[] = [];
  const manualSteps: PlannedOperation[] = [];
  for (const op of plan.operations) {
    switch (op.kind) {
      case "create":
      case "update":
      case "remove":
        counts[op.kind] += 1;
        safeOperations.push(op);
        break;
      case "conflict":
        counts.conflict += 1;
        conflicts.push(op);
        break;
      case "manual":
        counts.manual += 1;
        manualSteps.push(op);
        break;
      case "unavailable":
        counts.unavailable += 1;
        break;
      case "no_change":
        counts.unchanged += 1;
        break;
    }
  }
  const applySurfaces = surfacesNeedingApply(plan);
  const canApply = !request.readOnly
    && applySurfaces.length > 0
    && !!plan.plan_fingerprint
    && !!plan.preview_token;
  return { request, plan, counts, safeOperations, conflicts, manualSteps, applySurfaces, canApply };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** One-line prompt for the review, e.g. "apply 7 safe changes, skip 1 conflict". */
export function describeInstallReview(review: InstallReview): string {
  const safe = review.safeOperations.length;
  const conflicts = review.conflicts.length;
  if (safe === 0) {
    return conflicts > 0 ? `nothing safe to apply, ${plural(conflicts, "conflict")}` : "nothing to apply";
  }
  const skip = conflicts > 0 ? `, skip ${plural(conflicts, "conflict")}` : "";
  return `apply ${plural(safe, "safe change")}${skip}`;
}

export function useInstallFlow(): InstallFlow {
  const [flow, setFlow] = useState<FlowState>(IDLE);
  const [outcome, setOutcome] = useState<InstallFlowOutcome | null>(null);
  // The ref is the source of truth for gating: two keypresses can land before React re-renders.
  const flowRef = useRef<FlowState>(IDLE);
  const previewIdRef = useRef(0);
  const applyingRef = useRef(false);

  const commit = useCallback((next: FlowState) => {
    flowRef.current = next;
    setFlow(next);
  }, []);

  useEffect(() => () => {
    // A preview that resolves after unmount must not update state.
    previewIdRef.current += 1;
  }, []);

  const runPreview = useCallback(async (request: InstallFlowRequest): Promise<InstallReview | null> => {
    const surfaces = [...new Set(request.surfaces)];
    if (surfaces.length === 0) {
      commit({
        status: "error",
        request,
        error: { kind: "no_surfaces", message: "No surfaces to preview.", canRepreview: false },
      });
      return null;
    }
    const id = ++previewIdRef.current;
    commit({ status: "previewing", request });
    try {
      const plan = await invoke<SetupPlan>("preview_setup", { surfaces });
      if (id !== previewIdRef.current) return null;
      const review = buildInstallReview(request, plan);
      commit({ status: "review", request, review });
      return review;
    } catch (e) {
      if (id !== previewIdRef.current) return null;
      commit({
        status: "error",
        request,
        error: { kind: "preview_failed", message: errorText(e), canRepreview: true },
      });
      return null;
    }
  }, [commit]);

  const start = useCallback(async (request: InstallFlowRequest): Promise<InstallReview | null> => {
    const status = flowRef.current.status;
    if (status === "previewing" || status === "applying") return null;
    setOutcome(null);
    return runPreview(request);
  }, [runPreview]);

  const repreview = useCallback(async (): Promise<InstallReview | null> => {
    const current = flowRef.current;
    if (current.status !== "review" && current.status !== "error") return null;
    if (!current.request) return null;
    return runPreview(current.request);
  }, [runPreview]);

  const cancel = useCallback(() => {
    const status = flowRef.current.status;
    if (status === "idle" || status === "applying") return;
    previewIdRef.current += 1;
    commit(IDLE);
  }, [commit]);

  const apply = useCallback(async (): Promise<SetupResult | null> => {
    const current = flowRef.current;
    if (current.status !== "review" || applyingRef.current) return null;
    const { request, review } = current;
    if (!review.canApply) return null;
    applyingRef.current = true;
    commit({ status: "applying", request, review });
    try {
      const result = await invoke<SetupResult>("apply_setup", {
        surfaces: review.applySurfaces,
        skipManual: true,
        planFingerprint: review.plan.plan_fingerprint,
        previewToken: review.plan.preview_token,
      });
      setOutcome({ request, result });
      commit(IDLE);
      return result;
    } catch (e) {
      const message = errorText(e);
      const kind = classifyApplyError(message);
      commit({ status: "error", request, error: { kind, message, canRepreview: true } });
      return null;
    } finally {
      applyingRef.current = false;
    }
  }, [commit]);

  return {
    status: flow.status,
    request: flow.status === "idle" ? null : flow.request,
    review: flow.status === "review" || flow.status === "applying" ? flow.review : null,
    error: flow.status === "error" ? flow.error : null,
    outcome,
    start,
    apply,
    cancel,
    repreview,
  };
}
