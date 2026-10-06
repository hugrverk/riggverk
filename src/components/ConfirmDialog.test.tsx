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

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

/** Probe that records what each `confirm()` call resolves to. */
function ConfirmProbe({ results }: { results: boolean[] }) {
  const confirm = useConfirm();
  return (
    <>
      <button type="button" onClick={async () => { results.push(await confirm("First?")); }}>
        ask first
      </button>
      <button type="button" onClick={async () => { results.push(await confirm("Second?")); }}>
        ask second
      </button>
    </>
  );
}

describe("ConfirmDialog", () => {
  beforeEach(() => {
    // jsdom has no native modal dialog; emulate open/close and the `close` event browsers fire.
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
    HTMLDialogElement.prototype.showModal = originalShowModal;
    HTMLDialogElement.prototype.close = originalClose;
  });

  it("resolves true and closes the dialog when confirm is clicked", async () => {
    const results: boolean[] = [];
    render(
      <ConfirmProvider>
        <ConfirmProbe results={results} />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "ask first" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await vi.waitFor(() => expect(results).toEqual([true]));
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("settles a superseded confirmation as declined when a second one opens", async () => {
    const results: boolean[] = [];
    render(
      <ConfirmProvider>
        <ConfirmProbe results={results} />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "ask first" }));
    await screen.findByText("First?");
    fireEvent.click(screen.getByRole("button", { name: "ask second" }));

    await vi.waitFor(() => expect(results).toEqual([false]));
    expect(screen.getByText("Second?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await vi.waitFor(() => expect(results).toEqual([false, true]));
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

    // What a browser does for Escape on a modal dialog: key press, `cancel`, then close (which fires `close`).
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    dialog.close();

    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(false);
    });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(dialog.hasAttribute("open")).toBe(false);
  });
});
