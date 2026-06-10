import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SetupLifecycle } from "./SetupLifecycle";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const previewPlan = {
  operations: [
    { surface: "open_code_rules", kind: "create", summary: "missing", details: [] },
  ],
  synced: [],
  conflicts: [],
  manual_steps: [],
  summary: "1 surface(s) need update",
  has_pending_changes: true,
  is_blocked: false,
  plan_fingerprint: "abc123def4567890",
};

describe("SetupLifecycle", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "preview_setup") return previewPlan;
      if (cmd === "apply_setup") {
        return {
          success: true,
          transaction_id: "999",
          applied: ["OpenCodeRules"],
          failed: [],
          rolled_back: [],
          manual_steps: [],
          message: "ok",
        };
      }
      if (cmd === "rollback_setup_transaction") {
        return {
          success: true,
          transaction_id: "999",
          applied: [],
          failed: [],
          rolled_back: ["OpenCodeRules"],
          manual_steps: [],
          message: "rolled back",
        };
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("blocks apply when global workspace mutation is running", () => {
    render(<SetupLifecycle wsRunning="install skills" runSetupTask={vi.fn()} />);
    expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled();
  });

  it("loads preview and enables apply when idle", async () => {
    render(<SetupLifecycle wsRunning={null} runSetupTask={vi.fn()} />);
    expect(await screen.findByText("OpenCode Rules")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^apply$/i })).not.toBeDisabled();
  });

  it("forwards apply through runSetupTask", async () => {
    const runSetupTask = vi.fn(async (opts) => {
      const res = await opts.task();
      opts.toActionResult(res);
      return res;
    });
    render(<SetupLifecycle wsRunning={null} runSetupTask={runSetupTask} />);
    await screen.findByText("OpenCode Rules");
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() => expect(runSetupTask).toHaveBeenCalled());
    expect(runSetupTask.mock.calls[0][0].label).toBe("setup apply");
  });

  it("cancels rollback confirmation on Escape after apply result", async () => {
    const runSetupTask = vi.fn(async (opts) => {
      const res = await opts.task();
      opts.toActionResult(res);
      return res;
    });
    render(<SetupLifecycle wsRunning={null} runSetupTask={runSetupTask} />);
    await screen.findByText("OpenCode Rules");
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await screen.findByText("SUCCESS");
    fireEvent.click(screen.getByRole("button", { name: /rollback/i }));
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });
});
