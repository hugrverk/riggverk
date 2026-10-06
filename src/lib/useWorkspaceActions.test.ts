import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "../components/TerminalOutput";
import { useWorkspaceActions } from "./useWorkspaceActions";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const okResult: ActionResult = { success: true, action: "demo", stdout: "done", stderr: "", exit_code: 0 };

describe("useWorkspaceActions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-render its owner on an animation tick while a task runs", async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useWorkspaceActions({
        fetchStatus: async () => {},
        isInvalidWorkspaceError: () => false,
        workspaceDiagnostics: null,
        setError: () => {},
      });
    });

    let release: (value: ActionResult) => void = () => {};
    let taskHandle: Promise<ActionResult | null>;
    await act(async () => {
      taskHandle = result.current.runWsTask({
        label: "demo",
        action: "demo",
        task: () => new Promise<ActionResult>(resolve => {
          release = resolve;
        }),
        toActionResult: r => r,
      });
    });
    expect(result.current.wsRunning).toBe("demo");

    const rendersWhileRunning = renders;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(renders).toBe(rendersWhileRunning);

    await act(async () => {
      release(okResult);
      await vi.advanceTimersByTimeAsync(1000);
      await taskHandle;
    });
    expect(result.current.wsRunning).toBeNull();
    expect(result.current.wsLog).toEqual(okResult);
  });
});
