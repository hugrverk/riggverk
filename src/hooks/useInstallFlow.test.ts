import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationKind, PlannedOperation, SetupPlan, SetupResult, SetupSurfaceId } from "../types";
import {
  buildInstallReview,
  classifyApplyError,
  describeInstallReview,
  useInstallFlow,
  type InstallFlowRequest,
} from "./useInstallFlow";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function op(surface: SetupSurfaceId, kind: OperationKind, summary = `${kind} ${surface}`): PlannedOperation {
  return { surface, kind, summary };
}

function plan(operations: PlannedOperation[], overrides: Partial<SetupPlan> = {}): SetupPlan {
  const pending = operations.some((o) => o.kind === "create" || o.kind === "update" || o.kind === "remove");
  return {
    operations,
    synced: [],
    conflicts: operations.filter((o) => o.kind === "conflict"),
    manual_steps: operations.filter((o) => o.kind === "manual"),
    summary: "",
    has_pending_changes: pending,
    is_blocked: operations.some((o) => o.kind === "conflict" || o.kind === "unavailable"),
    plan_fingerprint: pending ? "fp-1" : null,
    preview_token: pending ? "tok-1" : null,
    ...overrides,
  };
}

function setupResult(overrides: Partial<SetupResult> = {}): SetupResult {
  return {
    success: true,
    transaction_id: "1710000000000",
    applied: ["codex_rules"],
    failed: [],
    rolled_back: [],
    manual_steps: [],
    message: "applied",
    ...overrides,
  };
}

const request: InstallFlowRequest = {
  label: "update codex",
  surfaces: ["codex_agents", "codex_rules", "codex_skills"],
};

const mixedPlan = plan(
  [
    op("codex_rules", "update"),
    op("codex_agents", "create"),
    op("codex_skills", "conflict"),
  ],
  { synced: ["codex_config"] },
);

function setup() {
  return renderHook(() => useInstallFlow());
}

async function startAndReview(hook: ReturnType<typeof setup>, p: SetupPlan = mixedPlan, req = request) {
  invoke.mockResolvedValueOnce(p);
  await act(async () => {
    await hook.result.current.start(req);
  });
}

beforeEach(() => {
  invoke.mockReset();
});

describe("useInstallFlow state machine", () => {
  it("starts idle with nothing to show", () => {
    const { result } = setup();
    expect(result.current.status).toBe("idle");
    expect(result.current.request).toBeNull();
    expect(result.current.review).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.outcome).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("goes idle -> previewing -> review and previews exactly the requested surfaces", async () => {
    const pending = deferred<SetupPlan>();
    invoke.mockReturnValueOnce(pending.promise);
    const hook = setup();

    let started!: Promise<unknown>;
    act(() => {
      started = hook.result.current.start(request);
    });
    expect(hook.result.current.status).toBe("previewing");
    expect(hook.result.current.request).toEqual(request);
    expect(hook.result.current.review).toBeNull();
    expect(invoke.mock.calls).toEqual([
      ["preview_setup", { surfaces: ["codex_agents", "codex_rules", "codex_skills"] }],
    ]);

    await act(async () => {
      pending.resolve(mixedPlan);
      await started;
    });
    expect(hook.result.current.status).toBe("review");
    expect(hook.result.current.review?.plan).toBe(mixedPlan);
  });

  it("dedupes requested surfaces before previewing", async () => {
    const hook = setup();
    await startAndReview(hook, mixedPlan, {
      label: "update codex",
      surfaces: ["codex_rules", "codex_rules", "codex_agents"],
    });
    expect(invoke).toHaveBeenCalledWith("preview_setup", { surfaces: ["codex_rules", "codex_agents"] });
  });

  it("exposes counts per kind, conflicts, manual steps and the apply surfaces", async () => {
    const hook = setup();
    const manual = op("cursor_mcp", "manual");
    await startAndReview(
      hook,
      plan(
        [
          op("codex_rules", "update"),
          op("codex_agents", "create"),
          op("claude_skills", "remove"),
          op("codex_skills", "conflict"),
          manual,
          op("cursor_skills", "unavailable"),
        ],
        { synced: ["codex_config", "claude_rules"] },
      ),
    );
    const review = hook.result.current.review!;
    expect(review.counts).toEqual({
      create: 1,
      update: 1,
      remove: 1,
      conflict: 1,
      manual: 1,
      unavailable: 1,
      unchanged: 2,
    });
    expect(review.safeOperations.map((o) => o.surface)).toEqual(["codex_rules", "codex_agents", "claude_skills"]);
    expect(review.conflicts.map((o) => o.surface)).toEqual(["codex_skills"]);
    expect(review.manualSteps).toEqual([manual]);
    expect(review.applySurfaces).toEqual(["codex_rules", "codex_agents", "claude_skills"]);
    expect(review.canApply).toBe(true);
  });

  it("counts no_change operations as unchanged alongside synced surfaces", () => {
    const review = buildInstallReview(
      request,
      plan([op("codex_rules", "no_change")], { synced: ["codex_agents"] }),
    );
    expect(review.counts.unchanged).toBe(2);
    expect(review.canApply).toBe(false);
  });

  it("applies only the reviewed plan's fingerprint, token and pending surfaces", async () => {
    const hook = setup();
    await startAndReview(hook);
    const result = setupResult({ applied: ["codex_rules", "codex_agents"], transaction_id: "42" });
    invoke.mockResolvedValueOnce(result);

    let returned: SetupResult | null = null;
    await act(async () => {
      returned = await hook.result.current.apply();
    });

    expect(invoke.mock.calls).toEqual([
      ["preview_setup", { surfaces: ["codex_agents", "codex_rules", "codex_skills"] }],
      [
        "apply_setup",
        {
          // codex_skills is a conflict and codex_config is already synced: neither is applied.
          surfaces: ["codex_rules", "codex_agents"],
          skipManual: true,
          planFingerprint: "fp-1",
          previewToken: "tok-1",
        },
      ],
    ]);
    expect(returned).toBe(result);
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.outcome).toEqual({ request, result });
  });

  it("is in applying with the review kept while apply_setup runs", async () => {
    const hook = setup();
    await startAndReview(hook);
    const running = deferred<SetupResult>();
    invoke.mockReturnValueOnce(running.promise);

    let applied!: Promise<SetupResult | null>;
    act(() => {
      applied = hook.result.current.apply();
    });
    expect(hook.result.current.status).toBe("applying");
    expect(hook.result.current.review).not.toBeNull();

    await act(async () => {
      running.resolve(setupResult());
      await applied;
    });
    expect(hook.result.current.status).toBe("idle");
  });

  it("blocks a double apply: apply_setup is invoked once", async () => {
    const hook = setup();
    await startAndReview(hook);
    const running = deferred<SetupResult>();
    invoke.mockReturnValueOnce(running.promise);

    let first!: Promise<SetupResult | null>;
    let second!: Promise<SetupResult | null>;
    act(() => {
      // Both land in the same tick, before React re-renders.
      first = hook.result.current.apply();
      second = hook.result.current.apply();
    });
    await expect(second).resolves.toBeNull();
    await act(async () => {
      running.resolve(setupResult());
      await first;
    });

    expect(invoke.mock.calls.filter(([name]) => name === "apply_setup")).toHaveLength(1);
  });

  it("does not apply twice after a finished apply without a new preview", async () => {
    const hook = setup();
    await startAndReview(hook);
    invoke.mockResolvedValueOnce(setupResult());
    await act(async () => {
      await hook.result.current.apply();
    });

    let again: SetupResult | null = setupResult();
    await act(async () => {
      again = await hook.result.current.apply();
    });
    expect(again).toBeNull();
    expect(invoke.mock.calls.filter(([name]) => name === "apply_setup")).toHaveLength(1);
  });

  it("refuses to apply when idle", async () => {
    const hook = setup();
    let result: SetupResult | null = setupResult();
    await act(async () => {
      result = await hook.result.current.apply();
    });
    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cannot apply a plan with no safe operations", async () => {
    const hook = setup();
    await startAndReview(hook, plan([op("codex_skills", "conflict"), op("cursor_mcp", "manual")]));
    expect(hook.result.current.status).toBe("review");
    expect(hook.result.current.review?.canApply).toBe(false);
    expect(hook.result.current.review?.counts.conflict).toBe(1);

    let result: SetupResult | null = setupResult();
    await act(async () => {
      result = await hook.result.current.apply();
    });
    expect(result).toBeNull();
    expect(hook.result.current.status).toBe("review");
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["preview_setup"]);
  });

  it("cannot apply a plan that is already in sync", async () => {
    const hook = setup();
    await startAndReview(hook, plan([], { synced: ["codex_rules", "codex_agents"] }));
    expect(hook.result.current.review?.canApply).toBe(false);
    expect(hook.result.current.review?.counts.unchanged).toBe(2);
  });

  it("cannot apply a pending plan that lacks a fingerprint or token", async () => {
    const hook = setup();
    await startAndReview(hook, plan([op("codex_rules", "update")], { preview_token: null }));
    expect(hook.result.current.review?.canApply).toBe(false);
    act(() => {
      hook.result.current.cancel();
    });
    await startAndReview(hook, plan([op("codex_rules", "update")], { plan_fingerprint: undefined }));
    expect(hook.result.current.review?.canApply).toBe(false);
  });

  it("shows a read-only request but never applies it", async () => {
    const hook = setup();
    await startAndReview(hook, mixedPlan, { ...request, readOnly: true });
    expect(hook.result.current.review?.canApply).toBe(false);
    expect(hook.result.current.review?.counts.update).toBe(1);

    let result: SetupResult | null = setupResult();
    await act(async () => {
      result = await hook.result.current.apply();
    });
    expect(result).toBeNull();
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["preview_setup"]);
  });

  it("rejects an empty surface list without invoking (empty means everything to the backend)", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.start({ label: "update claude", surfaces: [] });
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toMatchObject({ kind: "no_surfaces", canRepreview: false });
  });

  it("surfaces a rejected preview and re-previews the same request", async () => {
    const hook = setup();
    invoke.mockRejectedValueOnce("Harness disabled: codex");
    await act(async () => {
      await hook.result.current.start(request);
    });
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toEqual({
      kind: "preview_failed",
      message: "Harness disabled: codex",
      canRepreview: true,
    });
    expect(hook.result.current.review).toBeNull();

    invoke.mockResolvedValueOnce(mixedPlan);
    await act(async () => {
      await hook.result.current.repreview();
    });
    expect(hook.result.current.status).toBe("review");
    expect(hook.result.current.error).toBeNull();
    expect(invoke.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ["preview_setup", { surfaces: request.surfaces }],
      ["preview_setup", { surfaces: request.surfaces }],
    ]);
  });

  it("reads the message off an Error rejection", async () => {
    const hook = setup();
    invoke.mockRejectedValueOnce(new Error("backend down"));
    await act(async () => {
      await hook.result.current.start(request);
    });
    expect(hook.result.current.error?.message).toBe("backend down");
  });
});

describe("useInstallFlow stale and expired previews", () => {
  it("surfaces a stale fingerprint as its own error and recovers through a new preview", async () => {
    const hook = setup();
    await startAndReview(hook);
    invoke.mockRejectedValueOnce(
      "Plan fingerprint mismatch: state changed after preview. Re-run preview before applying.",
    );
    let result: SetupResult | null = setupResult();
    await act(async () => {
      result = await hook.result.current.apply();
    });

    expect(result).toBeNull();
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error?.kind).toBe("stale");
    expect(hook.result.current.error?.canRepreview).toBe(true);
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.request).toEqual(request);
    expect(hook.result.current.outcome).toBeNull();

    // A fresh preview carries a new fingerprint and token, and only those reach apply_setup.
    invoke.mockResolvedValueOnce(
      plan([op("codex_rules", "update")], { plan_fingerprint: "fp-2", preview_token: "tok-2" }),
    );
    await act(async () => {
      await hook.result.current.repreview();
    });
    expect(hook.result.current.status).toBe("review");
    invoke.mockResolvedValueOnce(setupResult());
    await act(async () => {
      await hook.result.current.apply();
    });

    expect(invoke.mock.calls).toEqual([
      ["preview_setup", { surfaces: request.surfaces }],
      [
        "apply_setup",
        { surfaces: ["codex_rules", "codex_agents"], skipManual: true, planFingerprint: "fp-1", previewToken: "tok-1" },
      ],
      ["preview_setup", { surfaces: request.surfaces }],
      [
        "apply_setup",
        { surfaces: ["codex_rules"], skipManual: true, planFingerprint: "fp-2", previewToken: "tok-2" },
      ],
    ]);
    expect(hook.result.current.status).toBe("idle");
  });

  it("surfaces an expired preview token as its own error", async () => {
    const hook = setup();
    await startAndReview(hook);
    invoke.mockRejectedValueOnce("preview token expired");
    await act(async () => {
      await hook.result.current.apply();
    });
    expect(hook.result.current.error).toEqual({
      kind: "expired",
      message: "preview token expired",
      canRepreview: true,
    });
  });

  it("does not leave the flow applying after a rejected apply: a second apply is refused", async () => {
    const hook = setup();
    await startAndReview(hook);
    invoke.mockRejectedValueOnce("preview token already used");
    await act(async () => {
      await hook.result.current.apply();
    });
    let again: SetupResult | null = setupResult();
    await act(async () => {
      again = await hook.result.current.apply();
    });
    expect(again).toBeNull();
    expect(invoke.mock.calls.filter(([name]) => name === "apply_setup")).toHaveLength(1);
  });

  it("reports other apply rejections as apply_failed", async () => {
    const hook = setup();
    await startAndReview(hook);
    invoke.mockRejectedValueOnce("Setup blocked: 1 conflict(s) require review");
    await act(async () => {
      await hook.result.current.apply();
    });
    expect(hook.result.current.error).toEqual({
      kind: "apply_failed",
      message: "Setup blocked: 1 conflict(s) require review",
      canRepreview: true,
    });
  });

  it("re-previews from a review to refresh the plan", async () => {
    const hook = setup();
    await startAndReview(hook);
    invoke.mockResolvedValueOnce(
      plan([op("codex_rules", "update")], { plan_fingerprint: "fp-9", preview_token: "tok-9" }),
    );
    await act(async () => {
      await hook.result.current.repreview();
    });
    expect(hook.result.current.review?.plan.plan_fingerprint).toBe("fp-9");
  });

  it("returns a failed or rolled-back run as an outcome for the output pane", async () => {
    const hook = setup();
    await startAndReview(hook);
    const failed = setupResult({
      success: false,
      applied: [],
      failed: ["codex_agents: write failed"],
      rolled_back: ["codex_rules"],
      message: "rolled back",
    });
    invoke.mockResolvedValueOnce(failed);
    let returned: SetupResult | null = null;
    await act(async () => {
      returned = await hook.result.current.apply();
    });
    expect(returned).toBe(failed);
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.outcome?.result).toBe(failed);
  });
});

describe("useInstallFlow cancel and concurrency", () => {
  it("cancels a review back to idle and cannot apply it afterwards", async () => {
    const hook = setup();
    await startAndReview(hook);
    act(() => {
      hook.result.current.cancel();
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.request).toBeNull();

    await act(async () => {
      await hook.result.current.apply();
    });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["preview_setup"]);
  });

  it("cancels an error back to idle", async () => {
    const hook = setup();
    invoke.mockRejectedValueOnce("boom");
    await act(async () => {
      await hook.result.current.start(request);
    });
    act(() => {
      hook.result.current.cancel();
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.error).toBeNull();
  });

  it("drops a preview that resolves after cancel", async () => {
    const pending = deferred<SetupPlan>();
    invoke.mockReturnValueOnce(pending.promise);
    const hook = setup();
    let started!: Promise<unknown>;
    act(() => {
      started = hook.result.current.start(request);
    });
    act(() => {
      hook.result.current.cancel();
    });
    expect(hook.result.current.status).toBe("idle");

    await act(async () => {
      pending.resolve(mixedPlan);
      await started;
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.review).toBeNull();
  });

  it("drops a rejected preview that settles after cancel", async () => {
    const pending = deferred<SetupPlan>();
    invoke.mockReturnValueOnce(pending.promise);
    const hook = setup();
    let started!: Promise<unknown>;
    act(() => {
      started = hook.result.current.start(request);
    });
    act(() => {
      hook.result.current.cancel();
    });
    await act(async () => {
      pending.reject("late failure");
      await started;
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.error).toBeNull();
  });

  it("cannot cancel a running apply", async () => {
    const hook = setup();
    await startAndReview(hook);
    const running = deferred<SetupResult>();
    invoke.mockReturnValueOnce(running.promise);
    let applied!: Promise<SetupResult | null>;
    act(() => {
      applied = hook.result.current.apply();
    });
    act(() => {
      hook.result.current.cancel();
    });
    expect(hook.result.current.status).toBe("applying");

    await act(async () => {
      running.resolve(setupResult());
      await applied;
    });
    expect(hook.result.current.outcome).not.toBeNull();
  });

  it("ignores start while a preview or an apply is running", async () => {
    const pending = deferred<SetupPlan>();
    invoke.mockReturnValueOnce(pending.promise);
    const hook = setup();
    let first!: Promise<unknown>;
    act(() => {
      first = hook.result.current.start(request);
    });
    let ignored: unknown = "unset";
    await act(async () => {
      ignored = await hook.result.current.start({ label: "update claude", surfaces: ["claude_rules"] });
    });
    expect(ignored).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(mixedPlan);
      await first;
    });

    const running = deferred<SetupResult>();
    invoke.mockReturnValueOnce(running.promise);
    let applied!: Promise<SetupResult | null>;
    act(() => {
      applied = hook.result.current.apply();
    });
    await act(async () => {
      ignored = await hook.result.current.start({ label: "update claude", surfaces: ["claude_rules"] });
    });
    expect(ignored).toBeNull();
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["preview_setup", "apply_setup"]);
    await act(async () => {
      running.resolve(setupResult());
      await applied;
    });
  });

  it("replaces a review when a new request starts and clears the previous outcome", async () => {
    const hook = setup();
    await startAndReview(hook);
    invoke.mockResolvedValueOnce(setupResult());
    await act(async () => {
      await hook.result.current.apply();
    });
    expect(hook.result.current.outcome).not.toBeNull();

    const next: InstallFlowRequest = { label: "update claude", surfaces: ["claude_rules"] };
    invoke.mockResolvedValueOnce(plan([op("claude_rules", "create")]));
    await act(async () => {
      await hook.result.current.start(next);
    });
    expect(hook.result.current.outcome).toBeNull();
    expect(hook.result.current.request).toEqual(next);
    expect(hook.result.current.review?.applySurfaces).toEqual(["claude_rules"]);
  });

  it("ignores a preview that resolves after unmount", async () => {
    const pending = deferred<SetupPlan>();
    invoke.mockReturnValueOnce(pending.promise);
    const hook = setup();
    let started!: Promise<unknown>;
    act(() => {
      started = hook.result.current.start(request);
    });
    hook.unmount();
    pending.resolve(mixedPlan);
    await expect(started).resolves.toBeNull();
  });
});

describe("classifyApplyError", () => {
  it.each([
    ["Plan fingerprint mismatch: state changed after preview. Re-run preview before applying.", "stale"],
    ["Plan fingerprint required. Re-run preview before applying.", "stale"],
    ["Preview token required. Re-run preview before applying.", "stale"],
    ["preview token fingerprint mismatch", "stale"],
    ["preview token scope mismatch", "stale"],
    ["preview token expired", "expired"],
    ["invalid or expired preview token", "expired"],
    ["preview token already used", "expired"],
    ["Setup blocked: 2 conflict(s) require review", "apply_failed"],
    ["Unknown surface ID(s): nope", "apply_failed"],
    ["Harness disabled: codex", "apply_failed"],
  ])("%s -> %s", (message, kind) => {
    expect(classifyApplyError(message)).toBe(kind);
  });
});

describe("describeInstallReview", () => {
  const describePlan = (operations: PlannedOperation[], readOnly = false) =>
    describeInstallReview(buildInstallReview({ ...request, readOnly }, plan(operations)));

  it("states the safe changes and skipped conflicts", () => {
    expect(
      describePlan([op("codex_rules", "update"), op("codex_agents", "create"), op("codex_skills", "conflict")]),
    ).toBe("apply 2 safe changes, skip 1 conflict");
  });

  it("uses singular and omits skips when there are no conflicts", () => {
    expect(describePlan([op("codex_rules", "remove")])).toBe("apply 1 safe change");
  });

  it("reports nothing to apply", () => {
    expect(describePlan([])).toBe("nothing to apply");
    expect(describePlan([op("codex_skills", "conflict"), op("claude_skills", "conflict")])).toBe(
      "nothing safe to apply, 2 conflicts",
    );
  });
});
