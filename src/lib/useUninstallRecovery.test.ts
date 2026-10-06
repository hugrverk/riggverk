import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useUninstallRecovery } from "./useUninstallRecovery";
import type { SetupResult } from "../types";

function uninstallResult(overrides: Partial<SetupResult> = {}): SetupResult {
  return {
    success: true,
    transaction_id: "1710000000000",
    applied: ["rules"],
    failed: [],
    rolled_back: [],
    manual_steps: [],
    message: "uninstalled",
    ...overrides,
  };
}

describe("useUninstallRecovery", () => {
  it("starts without a recovery candidate", () => {
    const { result } = renderHook(() => useUninstallRecovery());
    expect(result.current.transactionId).toBeNull();
  });

  it("captures the transaction id of a successful uninstall that changed something", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(uninstallResult());
    });

    expect(result.current.transactionId).toBe("1710000000000");
  });

  it("does not arm recovery for a failed uninstall", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(
        uninstallResult({ success: false, applied: [], failed: ["preflight failed"] }),
      );
    });

    expect(result.current.transactionId).toBeNull();
  });

  it("does not arm recovery for a no-op uninstall", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(uninstallResult({ applied: [] }));
    });

    expect(result.current.transactionId).toBeNull();
  });

  it("ignores a missing result and an empty transaction id", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(null);
      result.current.captureFromUninstallResult(uninstallResult({ transaction_id: "" }));
    });

    expect(result.current.transactionId).toBeNull();
  });

  it("clears the recovery candidate explicitly", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(uninstallResult());
    });
    expect(result.current.transactionId).toBe("1710000000000");

    act(() => {
      result.current.clearRecovery();
    });
    expect(result.current.transactionId).toBeNull();
  });
});
