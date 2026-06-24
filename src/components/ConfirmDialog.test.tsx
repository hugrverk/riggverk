import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider, useConfirm } from "./ConfirmDialog";

function TestConsumer({ message = "Test message" }: { message?: string }) {
  const confirm = useConfirm();
  return (
    <button type="button" onClick={async () => confirm(message)}>
      show confirm
    </button>
  );
}

describe("ConfirmDialog", () => {
  beforeEach(() => {
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

  it("renders children", () => {
    render(
      <ConfirmProvider>
        <div data-testid="child">hello</div>
      </ConfirmProvider>,
    );
    expect(screen.getByTestId("child")).toBeTruthy();
  });

  it("shows a themed dialog with message when confirmed", async () => {
    render(
      <ConfirmProvider>
        <TestConsumer message="Leave with unsaved changes?" />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /show confirm/i }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Leave with unsaved changes?")).toBeTruthy();
    expect(screen.getByText("cancel")).toBeTruthy();
    expect(screen.getByText("confirm")).toBeTruthy();
  });

  it("renders a destructive confirm button when marked destructive", async () => {
    function DestructiveTest() {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={() => confirm({ message: "Delete?", destructive: true, confirmLabel: "delete all" })}
        >
          trigger destructive
        </button>
      );
    }

    render(
      <ConfirmProvider>
        <DestructiveTest />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /trigger destructive/i }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    const deleteBtn = screen.getByRole("button", { name: /delete all/i });
    expect(deleteBtn.className).toContain("btn-danger");
  });

  it("closes dialog when cancel is clicked and resolves to false", async () => {
    const onResult = vi.fn();
    function ResultTest() {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={async () => {
            const result = await confirm("Test?");
            onResult(result);
          }}
        >
          show confirm
        </button>
      );
    }

    render(
      <ConfirmProvider>
        <ResultTest />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /show confirm/i }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(false);
    });
  });

  it("closes dialog on Escape and resolves to false", async () => {
    const onResult = vi.fn();
    function ResultTest() {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={async () => {
            const result = await confirm("Test?");
            onResult(result);
          }}
        >
          show confirm
        </button>
      );
    }

    render(
      <ConfirmProvider>
        <ResultTest />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /show confirm/i }));
    const dialog = await screen.findByRole("dialog");

    // Native dialog close fires the close event on close()
    dialog.close();

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(false);
    });
  });
});
