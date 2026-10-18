import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeRefusedWorkspace, useWorkspacePicker } from "./useWorkspacePicker";
import type { WorkspaceSwitchResult } from "./useAppSettingsController";

const { openMock, confirmMock } = vi.hoisted(() => ({ openMock: vi.fn(), confirmMock: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => confirmMock,
}));

const OK: WorkspaceSwitchResult = { ok: true };

function setup(
  options: { libraryDirty?: boolean; activePath?: string | null; result?: WorkspaceSwitchResult; blockedReason?: string | null } = {},
) {
  const switchWorkspace = vi.fn(async (_path: string | null): Promise<WorkspaceSwitchResult> => options.result ?? OK);
  const hook = renderHook(() =>
    useWorkspacePicker({
      activePath: options.activePath ?? "/Users/dev/.config/agent-workspace",
      libraryDirty: options.libraryDirty ?? false,
      switchWorkspace,
      blockedReason: options.blockedReason,
    }),
  );
  return { switchWorkspace, ...hook };
}

beforeEach(() => {
  openMock.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

describe("useWorkspacePicker choose", () => {
  it("opens a directory picker at the active workspace and switches to the chosen folder", async () => {
    openMock.mockResolvedValue("/Users/dev/other");
    const { result, switchWorkspace } = setup();

    let message: Awaited<ReturnType<typeof result.current.choose>> = null;
    await act(async () => {
      message = await result.current.choose();
    });

    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false, defaultPath: "/Users/dev/.config/agent-workspace" }),
    );
    expect(switchWorkspace).toHaveBeenCalledWith("/Users/dev/other");
    expect(message).toEqual({ ok: true, text: "workspace set to /Users/dev/other" });
  });

  it("does not hand a display path with ~ to the dialog as its start folder", async () => {
    openMock.mockResolvedValue(null);
    const { result } = setup({ activePath: "~/.config/agent-workspace" });
    await act(async () => {
      await result.current.choose();
    });
    expect(openMock.mock.calls[0]![0].defaultPath).toBeUndefined();
  });

  it("refuses with the reason before the folder dialog opens while a workspace task runs", async () => {
    const reason = "apply is running; wait for it to finish before switching workspace";
    const { result, switchWorkspace } = setup({ blockedReason: reason });
    let chosen: unknown = "unset";
    let reset: unknown = "unset";
    await act(async () => {
      chosen = await result.current.choose();
      reset = await result.current.reset();
    });
    expect(chosen).toEqual({ ok: false, text: reason });
    expect(reset).toEqual({ ok: false, text: reason });
    expect(openMock).not.toHaveBeenCalled();
    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it("does nothing when the picker is cancelled", async () => {
    openMock.mockResolvedValue(null);
    const { result, switchWorkspace } = setup();
    let message: unknown = "unset";
    await act(async () => {
      message = await result.current.choose();
    });
    expect(message).toBeNull();
    expect(switchWorkspace).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("reports an unavailable picker instead of throwing", async () => {
    openMock.mockRejectedValue(new Error("no dialog plugin"));
    const { result, switchWorkspace } = setup();
    let message: Awaited<ReturnType<typeof result.current.choose>> = null;
    await act(async () => {
      message = await result.current.choose();
    });
    expect(message).toEqual({ ok: false, text: "the folder picker is not available here" });
    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it("turns a refused folder into a clear message that names what is missing", async () => {
    openMock.mockResolvedValue("/Users/dev/not-a-workspace");
    const { result } = setup({
      result: {
        ok: false,
        message: "invalid workspace path: not a valid workspace (missing .agent-workspace/workspace.json)",
      },
    });
    let message: Awaited<ReturnType<typeof result.current.choose>> = null;
    await act(async () => {
      message = await result.current.choose();
    });
    expect(message).toEqual({
      ok: false,
      text: "/Users/dev/not-a-workspace is not a Riggverk workspace folder (missing .agent-workspace/workspace.json)",
    });
  });

  it("passes other refusals through unchanged", async () => {
    openMock.mockResolvedValue("/Users/dev/other");
    const { result } = setup({ result: { ok: false, message: "AGENT_WORKSPACE_PATH is set and overrides the workspace" } });
    let message: Awaited<ReturnType<typeof result.current.choose>> = null;
    await act(async () => {
      message = await result.current.choose();
    });
    expect(message).toEqual({ ok: false, text: "AGENT_WORKSPACE_PATH is set and overrides the workspace" });
  });
});

describe("useWorkspacePicker unsaved Library changes", () => {
  it("asks before switching and switches once confirmed", async () => {
    openMock.mockResolvedValue("/Users/dev/other");
    const { result, switchWorkspace } = setup({ libraryDirty: true });
    await act(async () => {
      await result.current.choose();
    });
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ destructive: true, confirmLabel: "switch" }));
    expect(confirmMock.mock.calls[0]![0].message).toContain("unsaved changes");
    expect(switchWorkspace).toHaveBeenCalledWith("/Users/dev/other");
  });

  it("leaves everything as it is when the confirmation is declined", async () => {
    openMock.mockResolvedValue("/Users/dev/other");
    confirmMock.mockResolvedValue(false);
    const { result, switchWorkspace } = setup({ libraryDirty: true });
    let message: unknown = "unset";
    await act(async () => {
      message = await result.current.choose();
    });
    expect(message).toBeNull();
    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it("does not ask when the Library is clean", async () => {
    openMock.mockResolvedValue("/Users/dev/other");
    const { result } = setup({ libraryDirty: false });
    await act(async () => {
      await result.current.choose();
    });
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("asks for a reset too", async () => {
    confirmMock.mockResolvedValue(false);
    const { result, switchWorkspace } = setup({ libraryDirty: true });
    await act(async () => {
      await result.current.reset();
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(switchWorkspace).not.toHaveBeenCalled();
  });
});

describe("useWorkspacePicker reset", () => {
  it("switches back to the default workspace", async () => {
    const { result, switchWorkspace } = setup();
    let message: Awaited<ReturnType<typeof result.current.reset>> = null;
    await act(async () => {
      message = await result.current.reset();
    });
    expect(openMock).not.toHaveBeenCalled();
    expect(switchWorkspace).toHaveBeenCalledWith(null);
    expect(message).toEqual({ ok: true, text: "workspace reset to the default" });
  });

  it("reports a refused reset as is", async () => {
    const { result } = setup({ result: { ok: false, message: "settings are not loaded yet" } });
    let message: Awaited<ReturnType<typeof result.current.reset>> = null;
    await act(async () => {
      message = await result.current.reset();
    });
    expect(message).toEqual({ ok: false, text: "settings are not loaded yet" });
  });
});

describe("useWorkspacePicker busy", () => {
  it("is busy from the picker until the switch settles and ignores a second request meanwhile", async () => {
    let finishSwitch: (result: WorkspaceSwitchResult) => void = () => {};
    const switchWorkspace = vi.fn(
      () => new Promise<WorkspaceSwitchResult>(resolveSwitch => {
        finishSwitch = resolveSwitch;
      }),
    );
    openMock.mockResolvedValue("/Users/dev/other");
    const { result } = renderHook(() =>
      useWorkspacePicker({ activePath: null, libraryDirty: false, switchWorkspace }),
    );

    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = result.current.choose();
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(true);

    let second: unknown = "unset";
    await act(async () => {
      second = await result.current.reset();
    });
    expect(second).toBeNull();
    expect(switchWorkspace).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishSwitch(OK);
      await first;
    });
    expect(result.current.busy).toBe(false);
  });
});

describe("describeRefusedWorkspace", () => {
  it("keeps the detail of an invalid-workspace error and drops the generic wording", () => {
    expect(describeRefusedWorkspace("/x", "invalid workspace path: not a valid workspace (folder not found)")).toBe(
      "/x is not a Riggverk workspace folder (folder not found)",
    );
    expect(describeRefusedWorkspace("/x", "invalid workspace path: not a valid workspace")).toBe(
      "/x is not a Riggverk workspace folder",
    );
  });
});
