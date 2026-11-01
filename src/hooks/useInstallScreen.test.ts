import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppView } from "../shell/views";
import type { ActionResult, PlannedOperation, SetupPlan, SetupResult, SetupSurfaceId } from "../types";
import { useInstallScreen, type RunWorkspaceTask, type UseInstallScreenOptions } from "./useInstallScreen";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function op(surface: SetupSurfaceId, kind: PlannedOperation["kind"]): PlannedOperation {
  return { surface, kind, summary: `${kind} ${surface}` };
}

function planOf(operations: PlannedOperation[]): SetupPlan {
  const pending = operations.some(o => o.kind === "create" || o.kind === "update" || o.kind === "remove");
  return {
    operations,
    synced: [],
    conflicts: operations.filter(o => o.kind === "conflict"),
    manual_steps: [],
    summary: "",
    has_pending_changes: pending,
    is_blocked: false,
    plan_fingerprint: pending ? "fp-1" : null,
    preview_token: pending ? "tok-1" : null,
  };
}

const RESULT: SetupResult = {
  success: true,
  transaction_id: "1710000000000",
  applied: ["ClaudeRules"],
  failed: [],
  rolled_back: [],
  manual_steps: [],
  message: "Successfully applied 1 artifact(s)",
};

// codex_config is off, as it is by default.
const SETTINGS = {
  enabled_harness_ids: ["codex", "claude"] as ("codex" | "claude")[],
  enabled_target_ids: ["codex_rules", "codex_agents", "claude_rules", "claude_agents"],
};

interface Harness {
  options: UseInstallScreenOptions;
  results: ActionResult[];
  views: { current: AppView };
  runWorkspaceTask: ReturnType<typeof vi.fn>;
}

function harness(initial: AppView = "start", overrides: Partial<UseInstallScreenOptions> = {}): Harness {
  const views = { current: initial };
  const results: ActionResult[] = [];
  const runWorkspaceTask = vi.fn(async (task: Parameters<RunWorkspaceTask>[0]) => {
    const value = await task.task();
    results.push(task.toActionResult(value as never));
    await task.refresh?.();
    return value;
  });
  const options: UseInstallScreenOptions = {
    // The app renders with the view `switchView` set; reading it live gives the hook the same.
    get view() {
      return views.current;
    },
    getView: () => views.current,
    switchView: vi.fn(async (next: AppView) => {
      views.current = next;
    }),
    settings: SETTINGS,
    runWorkspaceTask: runWorkspaceTask as unknown as RunWorkspaceTask,
    refresh: vi.fn(async () => {}),
    onApplied: vi.fn(),
    ...overrides,
  };
  return { options, results, views, runWorkspaceTask };
}

function mockBackend(plan: SetupPlan, applyResult: SetupResult | Error = RESULT) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "preview_setup") return plan;
    if (command === "apply_setup") {
      if (applyResult instanceof Error) throw applyResult;
      return applyResult;
    }
    throw new Error(`unexpected ${command}`);
  });
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("useInstallScreen", () => {
  it("opens the review on the page of the target after switching to it, previewing only enabled surfaces", async () => {
    mockBackend(planOf([op("codex_rules", "update")]));
    const h = harness("start");
    const { result } = renderHook(() => useInstallScreen(h.options));

    await act(async () => {
      await result.current.open("codex");
    });

    expect(h.options.switchView).toHaveBeenCalledWith("codex");
    expect(invokeMock).toHaveBeenCalledWith("preview_setup", { surfaces: ["codex_agents", "codex_rules", "skills"] });
    expect(result.current.flow.status).toBe("review");
    expect(result.current.scope).toBe("codex");
  });

  it("does not switch when the page is already open, and shows workspace updates on the Overview", async () => {
    mockBackend(planOf([op("workspace_bundle", "update")]));
    const h = harness("start");
    const { result } = renderHook(() => useInstallScreen(h.options));
    await act(async () => {
      await result.current.open("workspace");
    });
    expect(h.options.switchView).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("preview_setup", { surfaces: ["workspace_bundle"] });
    expect(result.current.isOpenOn("start")).toBe(true);
    expect(result.current.isOpenOn("codex")).toBe(false);
  });

  it("keeps a review on the page that asked for it when given a scope", async () => {
    mockBackend(planOf([op("claude_rules", "update")]));
    const h = harness("start");
    const { result } = renderHook(() => useInstallScreen(h.options));
    await act(async () => {
      await result.current.open("claude", { scope: "start" });
    });
    expect(h.options.switchView).not.toHaveBeenCalled();
    expect(result.current.scope).toBe("start");
    expect(result.current.isOpenOn("start")).toBe(true);
    expect(result.current.flow.request).toMatchObject({ label: "update claude", surfaces: ["claude_rules", "claude_agents", "skills"] });
  });

  it("opens a read-only review for previews", async () => {
    mockBackend(planOf([op("claude_rules", "update")]));
    const h = harness("claude");
    const { result } = renderHook(() => useInstallScreen(h.options));
    await act(async () => {
      await result.current.open("claude", { readOnly: true });
    });
    expect(result.current.flow.request).toMatchObject({ label: "preview claude", readOnly: true });
    expect(result.current.flow.review?.canApply).toBe(false);
    await act(async () => {
      result.current.apply();
    });
    expect(h.runWorkspaceTask).not.toHaveBeenCalled();
  });

  it("stays put when the page switch was refused", async () => {
    mockBackend(planOf([op("claude_rules", "update")]));
    const h = harness("library", { switchView: vi.fn(async () => {}) });
    const { result } = renderHook(() => useInstallScreen(h.options));
    await act(async () => {
      await result.current.open("claude");
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.flow.status).toBe("idle");
  });

  it("ignores a second request while a preview is running", async () => {
    let release: (plan: SetupPlan) => void = () => {};
    invokeMock.mockImplementation(() => new Promise<SetupPlan>(resolve => { release = resolve; }));
    const h = harness("claude");
    const { result } = renderHook(() => useInstallScreen(h.options));
    act(() => {
      void result.current.open("claude");
    });
    await waitFor(() => expect(result.current.flow.status).toBe("previewing"));
    await act(async () => {
      await result.current.open("workspace");
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(h.options.switchView).not.toHaveBeenCalled();
    await act(async () => {
      release(planOf([op("claude_rules", "update")]));
    });
  });

  it("applies the reviewed plan through the workspace task runner and reports the run", async () => {
    mockBackend(planOf([op("claude_rules", "update"), op("skills", "conflict")]));
    const h = harness("claude");
    const { result } = renderHook(() => useInstallScreen(h.options));
    await act(async () => {
      await result.current.open("claude");
    });

    await act(async () => {
      result.current.apply();
    });
    await waitFor(() => expect(h.options.onApplied).toHaveBeenCalledWith(RESULT));

    expect(h.runWorkspaceTask).toHaveBeenCalledWith(expect.objectContaining({ label: "update claude", action: "apply_setup" }));
    expect(invokeMock).toHaveBeenCalledWith("apply_setup", {
      surfaces: ["claude_rules"],
      skipManual: true,
      planFingerprint: "fp-1",
      previewToken: "tok-1",
    });
    expect(h.options.refresh).toHaveBeenCalled();
    expect(h.results[0]).toMatchObject({ success: true, action: "apply_setup update claude", exit_code: 0 });
    expect(h.results[0]!.stdout).toContain("applied      claude rules");
    expect(h.results[0]!.stdout).toContain("transaction 1710000000000 recorded · rollback available");
    expect(result.current.flow.status).toBe("idle");
  });

  it("keeps a successful apply on its page as the done state until it is dismissed, the page is left or another task starts", async () => {
    mockBackend(planOf([op("claude_rules", "update")]));
    const h = harness("claude");
    let running: string | null = null;
    const { result, rerender } = renderHook(() => useInstallScreen({ ...h.options, running }));
    const applyOnce = async () => {
      await act(async () => {
        await result.current.open("claude");
      });
      await act(async () => {
        result.current.apply();
      });
      await waitFor(() => expect(result.current.done).not.toBeNull());
    };

    await applyOnce();
    expect(result.current.flow.status).toBe("idle");
    expect(result.current.done!.result).toEqual(RESULT);
    expect(result.current.done!.review.request.label).toBe("update claude");
    expect(result.current.isOpenOn("claude")).toBe(true);
    act(() => result.current.dismiss());
    expect(result.current.isOpenOn("claude")).toBe(false);

    // An Undo (any task that starts after it) closes it.
    await applyOnce();
    running = "rollback";
    rerender();
    expect(result.current.done).toBeNull();
    running = null;
    rerender();

    // So does leaving the page.
    await applyOnce();
    h.views.current = "start";
    rerender();
    expect(result.current.done).toBeNull();
  });

  it("has no done state after a failed apply: the review closes and the run panel reports it", async () => {
    mockBackend(planOf([op("claude_rules", "update")]), { ...RESULT, success: false, applied: [], failed: ["write failed"], rolled_back: ["ClaudeRules"] });
    const h = harness("claude");
    const { result } = renderHook(() => useInstallScreen(h.options));
    await act(async () => {
      await result.current.open("claude");
    });
    await act(async () => {
      result.current.apply();
    });
    await waitFor(() => expect(h.results).toHaveLength(1));
    expect(result.current.done).toBeNull();
    expect(result.current.isOpenOn("claude")).toBe(false);
  });

  it("does nothing when the plan has nothing safe to apply", async () => {
    mockBackend(planOf([op("skills", "conflict")]));
    const h = harness("claude");
    const { result } = renderHook(() => useInstallScreen(h.options));
    await act(async () => {
      await result.current.open("claude");
    });
    await act(async () => {
      result.current.apply();
    });
    expect(h.runWorkspaceTask).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(call => call[0] === "apply_setup")).toBe(false);
  });

  it("keeps a rejected apply in the review and logs it without reporting success", async () => {
    mockBackend(planOf([op("claude_rules", "update")]), new Error("Plan fingerprint mismatch; re-run preview"));
    const h = harness("claude");
    const { result } = renderHook(() => useInstallScreen(h.options));
    await act(async () => {
      await result.current.open("claude");
    });
    await act(async () => {
      result.current.apply();
    });
    await waitFor(() => expect(result.current.flow.status).toBe("error"));
    expect(result.current.flow.error?.kind).toBe("stale");
    expect(h.options.onApplied).not.toHaveBeenCalled();
    expect(h.results[0]).toMatchObject({ success: false, exit_code: null });
    expect(h.results[0]!.stderr).toContain("plan pane");
  });

  it("does not report a run that failed on the backend as applied", async () => {
    mockBackend(planOf([op("claude_rules", "update")]), { ...RESULT, success: false, applied: [], failed: ["write failed"], rolled_back: ["ClaudeRules"] });
    const h = harness("claude");
    const { result } = renderHook(() => useInstallScreen(h.options));
    await act(async () => {
      await result.current.open("claude");
    });
    await act(async () => {
      result.current.apply();
    });
    await waitFor(() => expect(h.results).toHaveLength(1));
    expect(h.results[0]).toMatchObject({ success: false, exit_code: 1, stderr: "write failed" });
    expect(h.results[0]!.stdout).toContain("rolled back  claude rules");
    expect(h.options.onApplied).not.toHaveBeenCalled();
  });

  it("cancels a review that has not been applied when the user leaves its page", async () => {
    mockBackend(planOf([op("claude_rules", "update")]));
    const h = harness("claude");
    const { result, rerender } = renderHook((props: UseInstallScreenOptions) => useInstallScreen(props), { initialProps: h.options });
    await act(async () => {
      await result.current.open("claude");
    });
    expect(result.current.flow.status).toBe("review");

    h.views.current = "library";
    rerender(h.options);
    await waitFor(() => expect(result.current.flow.status).toBe("idle"));
  });
});
