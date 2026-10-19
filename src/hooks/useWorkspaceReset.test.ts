import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSwitchResult } from "./useAppSettingsController";
import { useWorkspaceReset } from "./useWorkspaceReset";

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => confirmMock,
}));

const OK: WorkspaceSwitchResult = { ok: true };

function setup(
  options: { libraryDirty?: boolean; activePath?: string | null; result?: WorkspaceSwitchResult; blockedReason?: string | null } = {},
) {
  const resetWorkspace = vi.fn(async (): Promise<WorkspaceSwitchResult> => options.result ?? OK);
  const hook = renderHook(() =>
    useWorkspaceReset({
      activePath: options.activePath === undefined ? "/Users/dev/other-workspace" : options.activePath,
      libraryDirty: options.libraryDirty ?? false,
      resetWorkspace,
      blockedReason: options.blockedReason,
    }),
  );
  return { resetWorkspace, ...hook };
}

beforeEach(() => {
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

describe("useWorkspaceReset", () => {
  it("asks first, naming the folder it leaves and what stays there, then resets once confirmed", async () => {
    const { result, resetWorkspace } = setup();

    let message: Awaited<ReturnType<typeof result.current.reset>> = null;
    await act(async () => {
      message = await result.current.reset();
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const config = confirmMock.mock.calls[0]![0];
    expect(config).toMatchObject({ destructive: true, confirmLabel: "reset" });
    expect(config.message).toContain("~/.config/agent-workspace");
    expect(config.message).toContain("Ownership records");
    expect(config.message).toContain("stay in /Users/dev/other-workspace");
    expect(config.message).not.toContain("unsaved");
    expect(resetWorkspace).toHaveBeenCalledTimes(1);
    expect(message).toEqual({ ok: true, text: "workspace reset to the default" });
  });

  it("changes nothing when the confirmation is declined", async () => {
    confirmMock.mockResolvedValue(false);
    const { result, resetWorkspace } = setup();

    let message: unknown = "unset";
    await act(async () => {
      message = await result.current.reset();
    });

    expect(message).toBeNull();
    expect(resetWorkspace).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("says so when the Library holds unsaved changes the reload would drop", async () => {
    const { result } = setup({ libraryDirty: true });
    await act(async () => {
      await result.current.reset();
    });
    expect(confirmMock.mock.calls[0]![0].message).toContain("The Library has unsaved changes");
  });

  it("names the current folder generically while the path is not known yet", async () => {
    const { result } = setup({ activePath: null });
    await act(async () => {
      await result.current.reset();
    });
    expect(confirmMock.mock.calls[0]![0].message).toContain("stay in the current folder");
  });

  it("reports a refused reset as is", async () => {
    const { result } = setup({ result: { ok: false, message: "AGENT_WORKSPACE_PATH is set and overrides the saved workspace" } });
    let message: Awaited<ReturnType<typeof result.current.reset>> = null;
    await act(async () => {
      message = await result.current.reset();
    });
    expect(message).toEqual({ ok: false, text: "AGENT_WORKSPACE_PATH is set and overrides the saved workspace" });
  });

  it("refuses without asking while a workspace task runs", async () => {
    const { result, resetWorkspace } = setup({ blockedReason: "apply is running" });
    let message: Awaited<ReturnType<typeof result.current.reset>> = null;
    await act(async () => {
      message = await result.current.reset();
    });
    expect(message).toEqual({ ok: false, text: "apply is running" });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(resetWorkspace).not.toHaveBeenCalled();
  });

  it("is busy from the confirmation until the reset settles and ignores a second request meanwhile", async () => {
    let answer: (approved: boolean) => void = () => {};
    confirmMock.mockImplementation(() => new Promise<boolean>(resolveConfirm => {
      answer = resolveConfirm;
    }));
    const { result, resetWorkspace } = setup();

    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = result.current.reset();
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(true);

    let second: unknown = "unset";
    await act(async () => {
      second = await result.current.reset();
    });
    expect(second).toBeNull();
    expect(confirmMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(true);
      await first;
    });
    expect(resetWorkspace).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });
});
