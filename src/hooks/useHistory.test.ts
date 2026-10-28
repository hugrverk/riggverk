import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupHistoryEntry } from "../types";
import { useHistory } from "./useHistory";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function entry(id: string): SetupHistoryEntry {
  return {
    transaction_id: id,
    created_at: id,
    finished_at: null,
    status: "applied",
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

describe("useHistory", () => {
  it("reads the list from disk and keeps its order", async () => {
    invokeMock.mockResolvedValue([entry("2"), entry("1")]);
    const { result } = renderHook(() => useHistory({ enabled: true, refreshKey: 0 }));
    expect(result.current).toEqual({ status: "loading" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.status === "ready" && result.current.entries.map(item => item.transaction_id)).toEqual(["2", "1"]);
    expect(invokeMock).toHaveBeenCalledWith("list_setup_history", { limit: 50 });
  });

  it("reads again when the refresh key changes and keeps the last answer meanwhile", async () => {
    let resolveSecond: (value: SetupHistoryEntry[]) => void = () => {};
    invokeMock
      .mockResolvedValueOnce([entry("1")])
      .mockImplementationOnce(() => new Promise<SetupHistoryEntry[]>(resolve => (resolveSecond = resolve)));
    const { result, rerender } = renderHook(({ key }) => useHistory({ enabled: true, refreshKey: key }), { initialProps: { key: 0 } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ key: 1 });
    expect(result.current.status).toBe("ready");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    resolveSecond([entry("2"), entry("1")]);
    await waitFor(() => expect(result.current.status === "ready" && result.current.entries).toHaveLength(2));
  });

  it("reports an error, not an empty list, for a failure or an answer of another shape", async () => {
    invokeMock.mockRejectedValue(new Error("no history"));
    const failing = renderHook(() => useHistory({ enabled: true, refreshKey: 0 }));
    await waitFor(() => expect(failing.result.current.status).toBe("error"));

    invokeMock.mockReset().mockResolvedValue({ not: "a list" });
    const odd = renderHook(() => useHistory({ enabled: true, refreshKey: 0 }));
    await waitFor(() => expect(odd.result.current.status).toBe("error"));
  });

  it("does not read while disabled", () => {
    const { result } = renderHook(() => useHistory({ enabled: false, refreshKey: 0 }));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ status: "loading" });
  });
});
