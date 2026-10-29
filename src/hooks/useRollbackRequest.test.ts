import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmConfig } from "../components/ConfirmDialog";
import type { SetupHistoryEntry, SetupResult } from "../types";
import { useRollbackRequest } from "./useRollbackRequest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function dryRun(overrides: Partial<SetupResult> = {}): SetupResult {
  return {
    success: true,
    transaction_id: "1710000000000",
    applied: ["ClaudeRules", "ClaudeAgents"],
    failed: [],
    rolled_back: [],
    manual_steps: [],
    message: "Dry run: would restore 2 artifact(s); 0 already restored; 0 conflicted",
    ...overrides,
  };
}

function historyEntry(transactionId: string): SetupHistoryEntry {
  return {
    transaction_id: transactionId,
    created_at: "1792663200000000000",
    finished_at: "1792663202000000000",
    status: "applied",
    surfaces: ["claude_rules"],
    harnesses: ["claude"],
    changes: [{ surface: "claude_rules", kind: "update", path: "~/.claude/CLAUDE.md", applied: true, restored: false }],
    operation_counts: { create: 0, update: 1, remove: 0 },
    backup_files: 1,
    is_newest_completed: true,
    undoable: true,
    receipt: null,
  };
}

function setup(transactionId: string | null = "1710000000000", approved = true) {
  const options = {
    transactionId,
    confirm: vi.fn(async (_config: ConfirmConfig | string) => approved),
    runRollback: vi.fn(async () => true),
    setError: vi.fn(),
  };
  const { result } = renderHook(() => useRollbackRequest(options));
  return { ...options, request: result.current };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("useRollbackRequest", () => {
  it("does nothing without a transaction", async () => {
    const t = setup(null);
    await t.request();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(t.confirm).not.toHaveBeenCalled();
  });

  it("dry-runs first, confirms with the dry-run summary, then rolls back that transaction", async () => {
    invokeMock.mockImplementation(async (command: string) => (command === "list_setup_history" ? [historyEntry("1710000000000")] : dryRun()));
    const t = setup();
    await t.request();

    expect(invokeMock).toHaveBeenCalledWith("rollback_setup_transaction", { transactionId: "1710000000000", dryRun: true });
    expect(t.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: "roll back" }));
    // The run is named by what it did and when, with the restored count; the id and the engine's sentence stay out of it.
    const message = (t.confirm.mock.calls[0]![0] as ConfirmConfig).message as string;
    expect(message).toMatch(/^Undo Updated Claude \(.+\)\? This restores 2 items from the backup\.$/);
    expect(message).not.toContain("1710000000000");
    expect(message).not.toMatch(/dry run|artifact/i);
    expect(t.runRollback).toHaveBeenCalledWith("1710000000000");
  });

  it("still asks, without a name, when the history cannot be read", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_setup_history") throw new Error("no history");
      return dryRun({ applied: ["ClaudeRules"] });
    });
    const t = setup();
    await t.request();
    expect((t.confirm.mock.calls[0]![0] as ConfirmConfig).message).toBe("Undo the update? This restores 1 item from the backup.");
    expect(t.runRollback).toHaveBeenCalledWith("1710000000000");
  });

  it("undoes a named transaction (the Overview's Undo, also after a restart) through the same dry run and confirm", async () => {
    invokeMock.mockResolvedValue(dryRun());
    const t = setup(null);
    await t.request("1792663200000000000");
    expect(invokeMock).toHaveBeenCalledWith("rollback_setup_transaction", { transactionId: "1792663200000000000", dryRun: true });
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(t.runRollback).toHaveBeenCalledWith("1792663200000000000");
    // Declining still writes nothing.
    t.runRollback.mockClear();
    const declined = setup(null, false);
    await declined.request("1792663200000000000");
    expect(declined.runRollback).not.toHaveBeenCalled();
  });

  it("does not take a click event for a transaction id", async () => {
    const t = setup(null);
    await (t.request as (value: unknown) => Promise<void>)({ type: "click" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not roll back when the confirm is declined", async () => {
    invokeMock.mockResolvedValue(dryRun());
    const t = setup("1710000000000", false);
    await t.request();
    expect(t.runRollback).not.toHaveBeenCalled();
  });

  it("reports a dry run with conflicts or nothing to restore instead of asking", async () => {
    const conflicted = setup();
    invokeMock.mockResolvedValue(dryRun({ success: false, failed: ["occupied"], message: "Dry run: 1 conflicted" }));
    await conflicted.request();
    expect(conflicted.setError).toHaveBeenCalledWith(expect.stringContaining("nothing can be restored"));
    expect(conflicted.confirm).not.toHaveBeenCalled();

    const empty = setup();
    invokeMock.mockResolvedValue(dryRun({ applied: [], rolled_back: ["ClaudeRules"] }));
    await empty.request();
    expect(empty.setError).toHaveBeenCalledTimes(1);
    expect(empty.runRollback).not.toHaveBeenCalled();
  });

  it("reports a failing dry run", async () => {
    invokeMock.mockRejectedValue(new Error("backup missing"));
    const t = setup();
    await t.request();
    expect(t.setError).toHaveBeenCalledWith("rollback: Error: backup missing");
    expect(t.confirm).not.toHaveBeenCalled();
  });
});
