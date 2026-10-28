import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexConfigDefaultsPreview, SetupResult } from "../types";
import { defaultsKeyList, formatCodexDefaultsOutput, useCodexDefaultsFlow } from "./useCodexDefaultsFlow";
import type { RunWorkspaceTask } from "./useInstallScreen";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const PREVIEW: CodexConfigDefaultsPreview = {
  keys: [{ key: "approvals_reviewer", yours: "auto_review", riggverk: "user" }],
  diff: '- approvals_reviewer = "auto_review"\n+ approvals_reviewer = "user"',
  plan_fingerprint: "abcdef0123456789abcdef",
  preview_token: "tok-1",
};

const RESULT: SetupResult = {
  success: true,
  transaction_id: "tx-1",
  applied: ["Codex config"],
  failed: [],
  rolled_back: [],
  manual_steps: [],
  message: "applied 1",
};

function setup() {
  const run = vi.fn(async (options: { task: () => Promise<unknown> }) => options.task());
  const refresh = vi.fn();
  const onApplied = vi.fn();
  const hook = renderHook(() => useCodexDefaultsFlow({ runWorkspaceTask: run as unknown as RunWorkspaceTask, refresh, onApplied }));
  return { ...hook, run, refresh, onApplied };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("formatCodexDefaultsOutput", () => {
  it("tells what was set, that yours is backed up, and that the transaction can be rolled back", () => {
    const { stdout, stderr } = formatCodexDefaultsOutput(PREVIEW, RESULT);
    expect(stdout.split("\n")).toEqual([
      "plan abcdef01 · use Riggverk defaults approvals_reviewer · fingerprint verified",
      "applied      Codex config · yours backed up",
      "set          approvals_reviewer = user",
      "applied 1",
      "applied 1 · failed 0 · rolled back 0",
      "transaction tx-1 recorded · rollback available",
    ]);
    expect(stderr).toBe("");
  });

  it("names a rollback without claiming a backup, and puts the failures in stderr", () => {
    const failed = formatCodexDefaultsOutput(PREVIEW, { ...RESULT, success: false, applied: [], failed: ["config changed since preview"], rolled_back: ["Codex config"] });
    expect(failed.stdout).toContain("rolled back  Codex config");
    expect(failed.stdout).not.toContain("yours backed up");
    expect(failed.stderr).toBe("config changed since preview");
  });

  it("lists the keys of the preview", () => {
    expect(defaultsKeyList({ ...PREVIEW, keys: [...PREVIEW.keys, { key: "sandbox_mode", yours: "read-only", riggverk: "workspace-write" }] })).toBe("approvals_reviewer, sandbox_mode");
  });
});

describe("useCodexDefaultsFlow", () => {
  it("previews first and writes nothing: idle -> loading -> preview", async () => {
    invokeMock.mockResolvedValue(PREVIEW);
    const { result } = setup();
    expect(result.current.open).toBe(false);
    await act(async () => {
      await result.current.openPreview();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("preview_codex_config_defaults");
    expect(result.current.state).toEqual({ status: "preview", preview: PREVIEW });
    expect(result.current.open).toBe(true);
  });

  it("applies with exactly the preview's fingerprint and token, once, then closes and reports", async () => {
    invokeMock.mockImplementation(async (command: string) => (command === "preview_codex_config_defaults" ? PREVIEW : RESULT));
    const { result, run, refresh, onApplied } = setup();
    await act(async () => {
      await result.current.openPreview();
    });
    await act(async () => {
      result.current.apply();
      // A second apply while the first runs is ignored.
      result.current.apply();
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenLastCalledWith("apply_codex_config_defaults", { planFingerprint: "abcdef0123456789abcdef", previewToken: "tok-1" });
    expect(invokeMock.mock.calls.filter(call => call[0] === "apply_codex_config_defaults")).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({ label: "use Riggverk defaults", action: "apply_codex_config_defaults", refresh });
    expect(onApplied).toHaveBeenCalledWith(RESULT);
    expect(result.current.open).toBe(false);
  });

  it("refuses to apply a preview without a fingerprint or token, and apply does nothing before a preview", async () => {
    invokeMock.mockResolvedValue({ ...PREVIEW, preview_token: "" });
    const { result } = setup();
    act(() => result.current.apply());
    expect(invokeMock).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.openPreview();
    });
    act(() => result.current.apply());
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a rejected apply (stale preview) as an error with its message, and retry previews again", async () => {
    let previews = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "preview_codex_config_defaults") return { ...PREVIEW, preview_token: `tok-${++previews}` };
      throw new Error("Plan fingerprint mismatch: the config changed after preview. Re-run preview before applying.");
    });
    const { result, onApplied } = setup();
    await act(async () => {
      await result.current.openPreview();
    });
    await act(async () => {
      result.current.apply();
    });
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state).toMatchObject({ what: "apply", message: expect.stringContaining("Plan fingerprint mismatch") });
    expect(onApplied).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.state).toMatchObject({ status: "preview", preview: { preview_token: "tok-2" } });
  });

  it("shows a failed preview as an error, and close returns to idle", async () => {
    invokeMock.mockRejectedValue(new Error("no enforced key differs from the bundled config"));
    const { result } = setup();
    await act(async () => {
      await result.current.openPreview();
    });
    expect(result.current.state).toEqual({ status: "error", what: "preview", message: "no enforced key differs from the bundled config" });
    act(() => result.current.close());
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("returns to the preview when the task runner was busy and nothing ran", async () => {
    invokeMock.mockResolvedValue(PREVIEW);
    const run = vi.fn(async () => null);
    const { result } = renderHook(() => useCodexDefaultsFlow({ runWorkspaceTask: run as unknown as RunWorkspaceTask, refresh: vi.fn(), onApplied: vi.fn() }));
    await act(async () => {
      await result.current.openPreview();
    });
    await act(async () => {
      result.current.apply();
    });
    await waitFor(() => expect(result.current.state.status).toBe("preview"));
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a preview that resolves after close", async () => {
    let resolve: (value: CodexConfigDefaultsPreview) => void = () => {};
    invokeMock.mockReturnValue(new Promise<CodexConfigDefaultsPreview>(done => (resolve = done)));
    const { result } = setup();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.openPreview();
    });
    expect(result.current.state.status).toBe("loading");
    act(() => result.current.close());
    await act(async () => {
      resolve(PREVIEW);
      await pending;
    });
    expect(result.current.state).toEqual({ status: "idle" });
  });
});
