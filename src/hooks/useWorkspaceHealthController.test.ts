import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceHealthController } from "./useWorkspaceHealthController";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function setup() {
  const setError = vi.fn();
  const hook = renderHook(() =>
    useWorkspaceHealthController({
      setError,
      workspaceLoadGenerationRef: { current: 0 },
      isWorkspaceLoadCurrent: () => true,
    }),
  );
  return { setError, hook };
}

describe("useWorkspaceHealthController errors", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("reports the message of a rejected status check without the Error prefix", async () => {
    invoke.mockImplementation(() => Promise.reject(new Error("workspace invalid (mock error scenario)")));
    const { setError, hook } = setup();
    await act(async () => {
      await hook.result.current.fetchStatus();
    });
    expect(setError).toHaveBeenCalledWith("Status error: workspace invalid (mock error scenario)");
  });

  it("keeps a string rejection as it is", async () => {
    invoke.mockImplementation(() => Promise.reject("the backend said no"));
    const { setError, hook } = setup();
    await act(async () => {
      await hook.result.current.fetchStatus();
    });
    expect(setError).toHaveBeenCalledWith("Status error: the backend said no");
  });
});
