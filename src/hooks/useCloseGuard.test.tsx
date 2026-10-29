import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCloseGuard } from "./useCloseGuard";

const tauri = vi.hoisted(() => ({ isTauri: true }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauri.isTauri,
}));

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;
let closeHandler: CloseHandler | null = null;
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: CloseHandler) => {
      closeHandler = handler;
      return unlisten;
    },
  }),
}));

const confirm = vi.fn(async (_config: unknown) => true);

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => confirm,
}));

function setup(overrides: Partial<Parameters<typeof useCloseGuard>[0]> = {}) {
  const options = {
    hasUnsaved: () => false,
    confirmLeave: vi.fn(async (_confirmLabel?: string) => true),
    flushSettings: vi.fn(async () => true),
    ...overrides,
  };
  const view = renderHook(() => useCloseGuard(options));
  return { options, view };
}

async function requestClose(): Promise<{ prevented: boolean }> {
  await waitFor(() => expect(closeHandler).not.toBeNull());
  let prevented = false;
  await closeHandler!({ preventDefault: () => { prevented = true; } });
  return { prevented };
}

beforeEach(() => {
  tauri.isTauri = true;
  closeHandler = null;
  unlisten.mockReset();
  confirm.mockReset();
  confirm.mockResolvedValue(true);
});

afterEach(cleanup);

describe("useCloseGuard in the app window", () => {
  it("lets the window close when nothing is unsaved", async () => {
    const { options } = setup();
    expect((await requestClose()).prevented).toBe(false);
    expect(options.confirmLeave).toHaveBeenCalledWith("Save and quit");
    expect(options.flushSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the window open on Keep editing, and writes no settings", async () => {
    const { options } = setup({ confirmLeave: vi.fn(async () => false) });
    expect((await requestClose()).prevented).toBe(true);
    expect(options.flushSettings).not.toHaveBeenCalled();
  });

  it("writes a settings change that is still inside the autosave delay before closing", async () => {
    const order: string[] = [];
    setup({
      confirmLeave: vi.fn(async () => { order.push("library"); return true; }),
      flushSettings: vi.fn(async () => { order.push("settings"); return true; }),
    });
    expect((await requestClose()).prevented).toBe(false);
    expect(order).toEqual(["library", "settings"]);
  });

  it("asks before quitting over a settings change that could not be written", async () => {
    const { options } = setup({ flushSettings: vi.fn(async () => false) });
    confirm.mockResolvedValueOnce(false);
    expect((await requestClose()).prevented).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(options.flushSettings).toHaveBeenCalledTimes(1);

    confirm.mockResolvedValueOnce(true);
    expect((await requestClose()).prevented).toBe(false);
  });

  it("stops listening when the app unmounts", async () => {
    const { view } = setup();
    await waitFor(() => expect(closeHandler).not.toBeNull());
    view.unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});

describe("useCloseGuard in the browser build", () => {
  beforeEach(() => {
    tauri.isTauri = false;
  });

  it("asks the browser to confirm leaving while something is unsaved", () => {
    setup({ hasUnsaved: () => true });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(closeHandler).toBeNull();
  });

  it("leaves the page alone when nothing is unsaved", () => {
    setup({ hasUnsaved: () => false });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
