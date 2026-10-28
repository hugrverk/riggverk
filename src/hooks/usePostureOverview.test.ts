import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLEAN_CODEX, RISKY_CLAUDE } from "../test/pageFixtures";
import type { InstallAgent } from "../types";
import { usePostureOverview } from "./usePostureOverview";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (_command: string, args: { harness: InstallAgent }) => {
    if (args.harness === "claude") return RISKY_CLAUDE;
    if (args.harness === "codex") return CLEAN_CODEX;
    throw new Error("could not read");
  });
});

describe("usePostureOverview", () => {
  it("reads one posture per enabled agent and leaves out an agent whose read fails", async () => {
    const { result } = renderHook(() => usePostureOverview(["codex", "claude", "cursor"], 0));
    await waitFor(() => expect(Object.keys(result.current).sort()).toEqual(["claude", "codex"]));
    expect(invokeMock).toHaveBeenCalledWith("get_security_posture", { harness: "cursor" });
    expect(result.current.claude).toBe(RISKY_CLAUDE);
  });

  it("ignores an answer that is for another agent or has the wrong shape", async () => {
    invokeMock.mockImplementation(async () => CLEAN_CODEX);
    const { result } = renderHook(() => usePostureOverview(["claude"], 0));
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current).toEqual({});
    invokeMock.mockImplementation(async () => undefined);
    const odd = renderHook(() => usePostureOverview(["codex"], 0));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(odd.result.current).toEqual({});
  });

  it("reads again when the refresh key changes", async () => {
    const { rerender } = renderHook(({ key }) => usePostureOverview(["codex"], key), { initialProps: { key: 0 } });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    rerender({ key: 1 });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
  });
});
