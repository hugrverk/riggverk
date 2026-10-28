import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmConfig } from "../components/ConfirmDialog";
import type { SetupResult } from "../types";
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

function setup(transactionId: string | null = "1710000000000", approved = true) {
  const release = vi.fn();
  const options = {
    transactionId,
    confirm: vi.fn(async (_config: ConfirmConfig | string) => approved),
    beginConfirm: vi.fn(() => release),
    runRollback: vi.fn(async () => true),
    setError: vi.fn(),
  };
  const { result } = renderHook(() => useRollbackRequest(options));
  return { ...options, release, request: result.current };
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
    invokeMock.mockResolvedValue(dryRun());
    const t = setup();
    await t.request();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("rollback_setup_transaction", { transactionId: "1710000000000", dryRun: true });
    expect(t.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: "roll back",
        message: expect.stringContaining("would restore 2 artifact(s)"),
      }),
    );
    expect(t.confirm.mock.calls[0]![0]).toEqual(expect.objectContaining({ message: expect.stringContaining("1710000000000") }));
    expect(t.runRollback).toHaveBeenCalledWith("1710000000000");
    // CONFIRM mode is held for exactly the length of the dialog.
    expect(t.beginConfirm).toHaveBeenCalledTimes(1);
    expect(t.release).toHaveBeenCalledTimes(1);
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
    expect(t.release).toHaveBeenCalledTimes(1);
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
