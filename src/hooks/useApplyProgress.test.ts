import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyProgress } from "../types";
import { APPLY_PROGRESS_EVENT, useApplyProgress } from "./useApplyProgress";

type Handler = (event: { payload: ApplyProgress }) => void;

const listenMock = vi.fn();
const unlistenMock = vi.fn();
let handlers: Handler[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

function progress(overrides: Partial<ApplyProgress> = {}): ApplyProgress {
  return { task: "apply_setup", phase: "apply", done: 1, total: 7, file: "~/.claude/CLAUDE.md", ...overrides };
}

function emit(payload: ApplyProgress) {
  act(() => {
    handlers.forEach(handler => handler({ payload }));
  });
}

beforeEach(() => {
  handlers = [];
  unlistenMock.mockReset();
  listenMock.mockReset();
  listenMock.mockImplementation(async (_event: string, handler: Handler) => {
    handlers.push(handler);
    return unlistenMock;
  });
});

describe("useApplyProgress", () => {
  it("subscribes to the apply-progress event once", async () => {
    const { rerender } = renderHook(({ running }) => useApplyProgress(running), { initialProps: { running: null as string | null } });
    await act(async () => {});
    rerender({ running: "update claude" });
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0][0]).toBe(APPLY_PROGRESS_EVENT);
  });

  it("exposes the latest progress while a task runs", async () => {
    const { result } = renderHook(() => useApplyProgress("update claude"));
    await act(async () => {});
    expect(result.current).toBeNull();

    emit(progress({ done: 1 }));
    expect(result.current).toEqual(progress({ done: 1 }));
    emit(progress({ done: 4, file: "~/.claude/skills/handoff/SKILL.md" }));
    expect(result.current?.done).toBe(4);
    expect(result.current?.file).toBe("~/.claude/skills/handoff/SKILL.md");
  });

  it("clears when the task ends and ignores late events", async () => {
    const { result, rerender } = renderHook(({ running }) => useApplyProgress(running), {
      initialProps: { running: "update claude" as string | null },
    });
    await act(async () => {});
    emit(progress({ phase: "done", done: 7 }));
    expect(result.current?.phase).toBe("done");

    rerender({ running: null });
    expect(result.current).toBeNull();
    emit(progress({ done: 3 }));
    expect(result.current).toBeNull();
  });

  it("starts the next task without the last one's progress", async () => {
    const { result, rerender } = renderHook(({ running }) => useApplyProgress(running), {
      initialProps: { running: "update claude" as string | null },
    });
    await act(async () => {});
    emit(progress({ done: 6 }));
    rerender({ running: null });
    rerender({ running: "rollback" });
    expect(result.current).toBeNull();

    emit(progress({ task: "rollback_setup_transaction", done: 0, total: 2 }));
    expect(result.current?.task).toBe("rollback_setup_transaction");
  });

  it("stops listening on unmount", async () => {
    const { unmount } = renderHook(() => useApplyProgress("update claude"));
    await act(async () => {});
    unmount();
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it("releases a subscription that resolves after unmount", async () => {
    let resolveListen: (stop: () => void) => void = () => {};
    listenMock.mockImplementationOnce(() => new Promise<() => void>(resolve => {
      resolveListen = resolve;
    }));
    const { unmount } = renderHook(() => useApplyProgress("update claude"));
    unmount();
    await act(async () => resolveListen(unlistenMock));
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it("stays empty when the backend cannot be listened to", async () => {
    listenMock.mockRejectedValueOnce(new Error("event.listen not allowed"));
    const { result } = renderHook(() => useApplyProgress("update claude"));
    await act(async () => {});
    expect(result.current).toBeNull();
  });
});
