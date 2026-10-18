import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveSkillLoads, InstallAgent } from "../types";
import { useEffectiveSkillLoads, type UseEffectiveSkillLoadsOptions } from "./useEffectiveSkillLoads";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const LOADS: EffectiveSkillLoads = {
  harnesses: [{ harness: "claude", folders: [{ folder: "claude", path: "~/.claude/skills", exists: true }], skills: [] }],
  foreign_duplicates: [],
};

const HARNESSES: InstallAgent[] = ["codex", "opencode", "cursor", "claude"];

function options(overrides: Partial<UseEffectiveSkillLoadsOptions> = {}): UseEffectiveSkillLoadsOptions {
  return { workspaceValid: true, busy: false, enabledHarnessIds: HARNESSES, ...overrides };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(LOADS);
});

describe("useEffectiveSkillLoads", () => {
  it("reads the loads once the workspace is valid, with no arguments", async () => {
    const { result } = renderHook(() => useEffectiveSkillLoads(options()));
    await waitFor(() => expect(result.current.loads).toEqual(LOADS));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("get_effective_skill_loads");
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("reads nothing without a valid workspace or without an enabled harness", async () => {
    const { result, rerender } = renderHook((props: UseEffectiveSkillLoadsOptions) => useEffectiveSkillLoads(props), {
      initialProps: options({ workspaceValid: false }),
    });
    rerender(options({ workspaceValid: false }));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.loads).toBeNull();
    rerender(options({ enabledHarnessIds: [] }));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("waits for a running workspace task and reads again when it ends", async () => {
    const { result, rerender } = renderHook((props: UseEffectiveSkillLoadsOptions) => useEffectiveSkillLoads(props), {
      initialProps: options({ busy: true }),
    });
    expect(invokeMock).not.toHaveBeenCalled();
    rerender(options({ busy: false }));
    await waitFor(() => expect(result.current.loads).toEqual(LOADS));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    rerender(options({ busy: true }));
    rerender(options({ busy: false }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
  });

  it("reads again when the set of enabled harnesses changes, but not for a new array with the same harnesses", async () => {
    const { result, rerender } = renderHook((props: UseEffectiveSkillLoadsOptions) => useEffectiveSkillLoads(props), {
      initialProps: options(),
    });
    await waitFor(() => expect(result.current.loads).toEqual(LOADS));
    rerender(options({ enabledHarnessIds: [...HARNESSES].reverse() }));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    rerender(options({ enabledHarnessIds: ["claude", "codex"] }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
  });

  it("reads again when asked to refresh or when the refresh key changes", async () => {
    const { result, rerender } = renderHook((props: UseEffectiveSkillLoadsOptions) => useEffectiveSkillLoads(props), {
      initialProps: options({ refreshKey: 0 }),
    });
    await waitFor(() => expect(result.current.loads).toEqual(LOADS));
    await act(async () => result.current.refresh());
    expect(invokeMock).toHaveBeenCalledTimes(2);
    rerender(options({ refreshKey: 1 }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3));
  });

  it("keeps the failure in the state, drops the old loads, and recovers on the next read", async () => {
    const { result } = renderHook(() => useEffectiveSkillLoads(options()));
    await waitFor(() => expect(result.current.loads).toEqual(LOADS));
    invokeMock.mockRejectedValueOnce("settings unreadable");
    await act(async () => result.current.refresh());
    expect(result.current.loads).toBeNull();
    expect(result.current.error).toBe("settings unreadable");
    await act(async () => result.current.refresh());
    expect(result.current.loads).toEqual(LOADS);
    expect(result.current.error).toBeNull();
  });

  it("ignores a read that a newer one has overtaken", async () => {
    let releaseFirst: (value: EffectiveSkillLoads) => void = () => {};
    const stale: EffectiveSkillLoads = { harnesses: [], foreign_duplicates: [] };
    invokeMock.mockReset();
    invokeMock.mockImplementationOnce(() => new Promise<EffectiveSkillLoads>((resolve) => { releaseFirst = resolve; }));
    invokeMock.mockResolvedValue(LOADS);
    const { result } = renderHook(() => useEffectiveSkillLoads(options()));
    await act(async () => result.current.refresh());
    expect(result.current.loads).toEqual(LOADS);
    await act(async () => releaseFirst(stale));
    expect(result.current.loads).toEqual(LOADS);
  });
});
