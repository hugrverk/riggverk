import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UninstallRecoveryCard } from "./UninstallRecoveryCard";
import type { SetupResult } from "../types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const TRANSACTION_ID = "1710000000000";

function dryRunResult(overrides: Partial<SetupResult> = {}): SetupResult {
  return {
    success: true,
    transaction_id: TRANSACTION_ID,
    applied: ["Codex rules"],
    failed: [],
    rolled_back: [],
    manual_steps: [],
    message: "Dry run: would restore 1 artifact(s); 0 already restored; 0 conflicted",
    ...overrides,
  };
}

function renderCard(overrides: Partial<Parameters<typeof UninstallRecoveryCard>[0]> = {}) {
  const onRollback = vi.fn(async () => true);
  const utils = render(
    <UninstallRecoveryCard
      transactionId={TRANSACTION_ID}
      busy={false}
      onRollback={onRollback}
      {...overrides}
    />,
  );
  return { onRollback, ...utils };
}

describe("UninstallRecoveryCard", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render without a transaction candidate", () => {
    const { container } = render(
      <UninstallRecoveryCard transactionId={null} busy={false} onRollback={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders recovery when workspace is invalid", () => {
    renderCard();
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
  });

  it("preview invokes rollback_setup_transaction with dry run", async () => {
    invokeMock.mockResolvedValue(dryRunResult());
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("rollback_setup_transaction", {
        transactionId: TRANSACTION_ID,
        dryRun: true,
      });
    });
  });

  it("displays restore, already-restored, and conflict counts after successful dry run", async () => {
    invokeMock.mockResolvedValue(
      dryRunResult({
        applied: ["a", "b"],
        rolled_back: ["c"],
        failed: ["d"],
        message: "Dry run summary",
      }),
    );
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));

    await waitFor(() => {
      expect(screen.getByText("to restore")).toBeTruthy();
      expect(screen.getByText("already restored")).toBeTruthy();
      expect(screen.getByText("conflicts")).toBeTruthy();
      expect(screen.getByText(/Dry run summary/i)).toBeTruthy();
    });
  });

  it("keeps restore disabled before dry run", () => {
    renderCard();
    expect(screen.getByRole("button", { name: /restore workspace/i })).toBeDisabled();
  });

  it("enables restore after successful dry run with restorable artifacts", async () => {
    invokeMock.mockResolvedValue(dryRunResult({ applied: ["rules"] }));
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restore workspace/i })).not.toBeDisabled();
    });
  });

  it("keeps restore disabled when dry run reports conflicts", async () => {
    invokeMock.mockResolvedValue(
      dryRunResult({ success: false, applied: ["rules"], failed: ["occupied target"] }),
    );
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));

    await waitFor(() => {
      expect(screen.getByText("conflicts")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /restore workspace/i })).toBeDisabled();
  });

  it("keeps restore disabled when dry run succeeds with nothing to restore", async () => {
    invokeMock.mockResolvedValue(dryRunResult({ applied: [] }));
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));

    await waitFor(() => {
      expect(screen.getByText("to restore")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /restore workspace/i })).toBeDisabled();
  });

  it("does not call rollback mutation when confirmation is cancelled", async () => {
    invokeMock.mockResolvedValue(dryRunResult({ applied: ["rules"] }));
    const { onRollback } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restore workspace/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /restore workspace/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onRollback).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
  });

  it("calls rollback mutation when confirmation is accepted", async () => {
    invokeMock.mockResolvedValue(dryRunResult({ applied: ["rules"] }));
    const { onRollback } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restore workspace/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /restore workspace/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm restore/i }));

    await waitFor(() => {
      expect(onRollback).toHaveBeenCalledTimes(1);
    });
  });

  it("retains recovery after failed rollback and allows another preview", async () => {
    invokeMock
      .mockResolvedValueOnce(dryRunResult({ applied: ["rules"] }))
      .mockResolvedValueOnce(dryRunResult({ applied: ["rules"] }));
    const onRollback = vi.fn(async () => false);
    renderCard({ onRollback });

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restore workspace/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /restore workspace/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm restore/i }));
    await waitFor(() => expect(onRollback).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
  });

  it("invalidates stale dry-run state when the transaction candidate changes", async () => {
    invokeMock.mockResolvedValue(dryRunResult({ applied: ["rules"] }));
    const { rerender } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restore workspace/i })).not.toBeDisabled();
    });

    rerender(
      <UninstallRecoveryCard
        transactionId="1710000000001"
        busy={false}
        onRollback={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /restore workspace/i })).toBeDisabled();
    expect(screen.queryByText("to restore")).toBeNull();
  });

  it("closes confirmation dialog on Escape without calling rollback", async () => {
    invokeMock.mockResolvedValue(dryRunResult({ applied: ["rules"] }));
    const { onRollback } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: /preview recovery/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restore workspace/i })).not.toBeDisabled();
    });

    const restoreButton = screen.getByRole("button", { name: /restore workspace/i });
    fireEvent.click(restoreButton);

    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    dialog.close();

    await waitFor(() => {
      expect(onRollback).not.toHaveBeenCalled();
    });
    expect(restoreButton).toHaveFocus();
  });
});
