import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupHistoryEntry } from "../types";
import { useLastUpdate } from "./useLastUpdate";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function entry(id: string, status: SetupHistoryEntry["status"]): SetupHistoryEntry {
  return {
    transaction_id: id,
    created_at: id,
    finished_at: null,
    status,
    surfaces: [],
    harnesses: [],
    changes: [],
    operation_counts: { create: 0, update: 0, remove: 0 },
    backup_files: 0,
    is_newest_completed: false,
    undoable: false,
    receipt: null,
  };
}

beforeEach(() => invokeMock.mockReset());

describe("useLastUpdate", () => {
  it("reads the newest entry that is not a failed run", async () => {
    invokeMock.mockResolvedValue([entry("3", "failed"), entry("2", "applied"), entry("1", "applied")]);
    const { result } = renderHook(() => useLastUpdate({ enabled: true, refreshKey: 0 }));
    await waitFor(() => expect(result.current?.transaction_id).toBe("2"));
    expect(invokeMock).toHaveBeenCalledWith("list_setup_history", { limit: 8 });
  });

  it("reads again when the refresh key changes", async () => {
    invokeMock.mockResolvedValueOnce([entry("1", "applied")]).mockResolvedValueOnce([entry("2", "applied")]);
    const { result, rerender } = renderHook(({ key }) => useLastUpdate({ enabled: true, refreshKey: key }), { initialProps: { key: 0 } });
    await waitFor(() => expect(result.current?.transaction_id).toBe("1"));
    rerender({ key: 1 });
    await waitFor(() => expect(result.current?.transaction_id).toBe("2"));
  });

  it("leaves no entry on a failure, an answer of another shape, or while disabled", async () => {
    invokeMock.mockRejectedValue(new Error("no history"));
    const failing = renderHook(() => useLastUpdate({ enabled: true, refreshKey: 0 }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(failing.result.current).toBeNull();

    invokeMock.mockReset().mockResolvedValue({ not: "a list" });
    const odd = renderHook(() => useLastUpdate({ enabled: true, refreshKey: 0 }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(odd.result.current).toBeNull();

    invokeMock.mockReset();
    const off = renderHook(() => useLastUpdate({ enabled: false, refreshKey: 0 }));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(off.result.current).toBeNull();
  });

  it("drops an answer that arrives after a newer read started", async () => {
    let resolveFirst: (value: SetupHistoryEntry[]) => void = () => {};
    invokeMock
      .mockImplementationOnce(() => new Promise<SetupHistoryEntry[]>(resolve => (resolveFirst = resolve)))
      .mockResolvedValueOnce([entry("2", "applied")]);
    const { result, rerender } = renderHook(({ key }) => useLastUpdate({ enabled: true, refreshKey: key }), { initialProps: { key: 0 } });
    rerender({ key: 1 });
    await waitFor(() => expect(result.current?.transaction_id).toBe("2"));
    resolveFirst([entry("1", "applied")]);
    await Promise.resolve();
    expect(result.current?.transaction_id).toBe("2");
  });
});
