import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallationState, InstallationStatus, InstallAgent } from "../types";
import {
  describeUpdate,
  safeOperationCount,
  surfacesForOverview,
  useInstallationOverview,
  type InstallationOverview,
  type OverviewId,
  type UseInstallationOverviewOptions,
} from "./useInstallationOverview";

const invokeMock = vi.fn();

function overviewState(overview: InstallationOverview, id: OverviewId): InstallationState | null {
  return overview.entries[id]?.status?.state ?? null;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function status(state: InstallationState, counts: Partial<InstallationStatus["counts"]> = {}): InstallationStatus {
  return {
    state,
    summary: state,
    counts: { create_count: 0, update_count: 0, remove_count: 0, conflict_count: 0, ...counts },
    surfaces: [],
  };
}

function backend(statuses: Partial<Record<string, InstallationStatus | Error>>) {
  invokeMock.mockImplementation(async (command: string, args?: { surfaces: string[] }) => {
    if (command !== "get_installation_status") throw new Error(`unexpected command ${command}`);
    const first = args?.surfaces[0] ?? "";
    const key = first === "workspace_bundle" ? "workspace" : first.split("_")[0] === "open" ? "opencode" : first.split("_")[0]!;
    const result = statuses[key];
    if (!result) return status("current");
    if (result instanceof Error) throw result;
    return result;
  });
}

const HARNESSES: InstallAgent[] = ["codex", "opencode", "cursor", "claude"];

function options(overrides: Partial<UseInstallationOverviewOptions> = {}): UseInstallationOverviewOptions {
  return { dataFolderOk: true, busy: false, enabledHarnessIds: HARNESSES, ...overrides };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("useInstallationOverview", () => {
  it("fetches the workspace and every enabled harness with the surfaces the install cards use", async () => {
    backend({ codex: status("update_available", { update_count: 2 }), claude: status("conflict", { conflict_count: 1 }) });
    const { result } = renderHook(() => useInstallationOverview(options()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(invokeMock).toHaveBeenCalledTimes(5);
    const requested = invokeMock.mock.calls.map(call => (call[1] as { surfaces: string[] }).surfaces);
    expect(requested).toContainEqual(surfacesForOverview("workspace"));
    for (const harness of HARNESSES) expect(requested).toContainEqual(surfacesForOverview(harness));
    expect(overviewState(result.current, "codex")).toBe("update_available");
    expect(overviewState(result.current, "claude")).toBe("conflict");
    expect(overviewState(result.current, "workspace")).toBe("current");
  });

  it("does not request surfaces whose target toggle is off when the toggles are given", async () => {
    backend({});
    const enabledTargetIds = ["codex_rules", "claude_rules"];
    const { result } = renderHook(() => useInstallationOverview(options({ enabledTargetIds })));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const requested = invokeMock.mock.calls.map(call => (call[1] as { surfaces: string[] }).surfaces);
    expect(requested).toContainEqual(["codex_rules", "skills"]);
    expect(requested).toContainEqual(["claude_rules", "skills"]);
    expect(requested).toContainEqual(["skills"]);
    expect(requested.flat()).not.toContain("codex_config");
    expect(requested.flat()).not.toContain("claude_agents");
    expect(requested.flat()).not.toContain("cursor_mcp");
    expect(requested).toContainEqual(["workspace_bundle"]);
  });

  it("re-fetches when a target toggle changes, but not for a new array with the same toggles", async () => {
    backend({});
    const { result, rerender } = renderHook((props: UseInstallationOverviewOptions) => useInstallationOverview(props), {
      initialProps: options({ enabledTargetIds: ["codex_rules"] }),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    invokeMock.mockClear();
    rerender(options({ enabledTargetIds: ["codex_rules"] }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(invokeMock).not.toHaveBeenCalled();
    rerender(options({ enabledTargetIds: ["codex_rules", "codex_agents"] }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(5));
    expect(invokeMock.mock.calls.map(call => (call[1] as { surfaces: string[] }).surfaces)).toContainEqual([
      "codex_agents",
      "codex_rules",
      "skills",
    ]);
  });

  it("skips disabled harnesses", async () => {
    backend({});
    const { result } = renderHook(() => useInstallationOverview(options({ enabledHarnessIds: ["codex"] })));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(result.current.entries).sort()).toEqual(["codex", "workspace"]);
  });

  it("fetches nothing and clears entries without a valid workspace", async () => {
    backend({});
    const { result, rerender } = renderHook((props: UseInstallationOverviewOptions) => useInstallationOverview(props), {
      initialProps: options(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    invokeMock.mockClear();
    rerender(options({ dataFolderOk: false }));
    await waitFor(() => expect(result.current.entries).toEqual({}));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps a per-target error instead of throwing, and leaves the other targets intact", async () => {
    backend({ cursor: new Error("hash failed") });
    const { result } = renderHook(() => useInstallationOverview(options()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries.cursor).toMatchObject({ status: null, error: "hash failed" });
    expect(overviewState(result.current, "cursor")).toBeNull();
    expect(overviewState(result.current, "codex")).toBe("current");
  });

  it("re-fetches when a workspace task finishes, not while it runs", async () => {
    backend({});
    const { result, rerender } = renderHook((props: UseInstallationOverviewOptions) => useInstallationOverview(props), {
      initialProps: options(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    invokeMock.mockClear();
    rerender(options({ busy: true }));
    expect(invokeMock).not.toHaveBeenCalled();
    backend({ codex: status("update_available") });
    rerender(options({ busy: false }));
    await waitFor(() => expect(overviewState(result.current, "codex")).toBe("update_available"));
  });

  it("re-fetches when refreshKey changes and on manual refresh", async () => {
    backend({});
    const { result, rerender } = renderHook((props: UseInstallationOverviewOptions) => useInstallationOverview(props), {
      initialProps: options({ refreshKey: 0 }),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    invokeMock.mockClear();
    rerender(options({ refreshKey: 1 }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(5));
    invokeMock.mockClear();
    await act(async () => {
      await result.current.refresh();
    });
    expect(invokeMock).toHaveBeenCalledTimes(5);
  });

  it("ignores a stale response when a newer fetch has started", async () => {
    let releaseFirst: (value: InstallationStatus) => void = () => {};
    let calls = 0;
    invokeMock.mockImplementation((_command: string, args?: { surfaces: string[] }) => {
      if (args?.surfaces[0] === "workspace_bundle") {
        calls++;
        if (calls === 1) return new Promise<InstallationStatus>(resolve => { releaseFirst = resolve; });
        return Promise.resolve(status("update_available"));
      }
      return Promise.resolve(status("current"));
    });
    const { result } = renderHook(() => useInstallationOverview(options({ enabledHarnessIds: [] })));
    await act(async () => {
      await result.current.refresh();
    });
    expect(overviewState(result.current, "workspace")).toBe("update_available");
    await act(async () => {
      releaseFirst(status("not_installed"));
    });
    expect(overviewState(result.current, "workspace")).toBe("update_available");
  });
});

describe("overview helpers", () => {
  it("counts safe operations and describes an update", () => {
    const mixed = status("update_available", { create_count: 2, update_count: 4, remove_count: 1, conflict_count: 1 });
    expect(safeOperationCount(mixed)).toBe(7);
    expect(describeUpdate(mixed)).toBe("apply 7 safe, skip 1 conflict");
    expect(describeUpdate(status("update_available", { update_count: 1, conflict_count: 2 }))).toBe("apply 1 safe, skip 2 conflicts");
    expect(describeUpdate(status("conflict", { conflict_count: 1 }))).toBe("nothing safe to apply, skip 1 conflict");
    expect(describeUpdate(status("current"))).toBe("current");
    expect(describeUpdate(status("unavailable"))).toBe("unavailable");
    expect(describeUpdate(null)).toBeUndefined();
  });
});
