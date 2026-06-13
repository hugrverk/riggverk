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

  it("captures a non-empty uninstall transaction id", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(uninstallResult());
    });

    expect(result.current.transactionId).toBe("1710000000000");
  });

  it("captures transaction evidence from a failed uninstall result", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(
        uninstallResult({ success: false, failed: ["partial failure"] }),
      );
    });

    expect(result.current.transactionId).toBe("1710000000000");
  });

  it("does not capture an empty transaction id", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(uninstallResult({ transaction_id: "" }));
    });

    expect(result.current.transactionId).toBeNull();
  });

  it("clears the recovery candidate explicitly", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(uninstallResult());
      result.current.clearRecovery();
    });

    expect(result.current.transactionId).toBeNull();
  });

  it("models successful rollback clearing the candidate", () => {
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

  it("models successful install or update clearing an obsolete candidate", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(uninstallResult());
      result.current.clearRecovery();
    });

    expect(result.current.transactionId).toBeNull();
  });

  it("models workspace-bound reset clearing the candidate", () => {
    const { result } = renderHook(() => useUninstallRecovery());

    act(() => {
      result.current.captureFromUninstallResult(uninstallResult());
      result.current.clearRecovery();
    });

    expect(result.current.transactionId).toBeNull();
  });
});
