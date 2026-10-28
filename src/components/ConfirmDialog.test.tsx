import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeymap } from "../keyboard/useKeymap";
import { renderInFrame, renderWithShell } from "../test/renderWithShell";
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
    expect(deleteBtn.className).toContain("tbtn-danger");
  });

  it("lays the footer out as bracket buttons, cancel first, with the confirm one primary", async () => {
    render(
      <ConfirmProvider>
        <TestConsumer />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /show confirm/i }));
    const dialog = await screen.findByRole("dialog");
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".app-modal-footer button"));
    expect(buttons.map(button => button.textContent)).toEqual(["ncancel", "yconfirm"]);
    expect(buttons.every(button => button.classList.contains("tbtn"))).toBe(true);
    expect(buttons[0]!.classList.contains("tbtn-primary")).toBe(false);
    expect(buttons[1]!.classList.contains("tbtn-primary")).toBe(true);
  });

  it("uses the custom labels in the buttons and keeps the key caps out of their names", async () => {
    function Labelled() {
      const confirm = useConfirm();
      return (
        <button type="button" onClick={() => confirm({ message: "Go?", confirmLabel: "roll back", cancelLabel: "keep" })}>
          trigger labelled
        </button>
      );
    }
    render(
      <ConfirmProvider>
        <Labelled />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /trigger labelled/i }));
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "roll back" }).querySelector("kbd")!.textContent).toBe("y");
    expect(screen.getByRole("button", { name: "keep" }).querySelector("kbd")!.textContent).toBe("n");
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
    const dialog = (await screen.findByRole("dialog")) as HTMLDialogElement;

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

  describe("status bar mode", () => {
    const mode = () => screen.getByLabelText("Shell mode").textContent;

    it("shows CONFIRM while any confirmation is open and NORMAL again once it settles", async () => {
      const results: boolean[] = [];
      renderInFrame(<ConfirmProbe results={results} />);
      expect(mode()).toBe("NORMAL");

      fireEvent.click(screen.getByRole("button", { name: "ask first" }));
      await screen.findByRole("dialog");
      expect(mode()).toBe("CONFIRM");
      fireEvent.click(screen.getByRole("button", { name: "cancel" }));
      await vi.waitFor(() => expect(mode()).toBe("NORMAL"));

      fireEvent.click(screen.getByRole("button", { name: "ask first" }));
      const cancel = await screen.findByRole("button", { name: "cancel" });
      expect(mode()).toBe("CONFIRM");
      fireEvent.keyDown(cancel, { key: "y" });
      await vi.waitFor(() => expect(mode()).toBe("NORMAL"));
      expect(results).toEqual([false, true]);
    });

    it("stays in CONFIRM when a second confirmation supersedes the first", async () => {
      renderInFrame(<ConfirmProbe results={[]} />);
      fireEvent.click(screen.getByRole("button", { name: "ask first" }));
      await screen.findByText("First?");
      fireEvent.click(screen.getByRole("button", { name: "ask second" }));
      await screen.findByText("Second?");
      expect(mode()).toBe("CONFIRM");

      fireEvent.keyDown(screen.getByRole("button", { name: "cancel" }), { key: "n" });
      await vi.waitFor(() => expect(mode()).toBe("NORMAL"));
    });
  });

  describe("keys", () => {
    async function openConfirm(results: boolean[]) {
      render(
        <ConfirmProvider>
          <ConfirmProbe results={results} />
        </ConfirmProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "ask first" }));
      return (await screen.findByRole("dialog")) as HTMLDialogElement;
    }

    it("focuses cancel when the dialog opens so Enter does not confirm by default", async () => {
      const dialog = await openConfirm([]);
      const cancel = screen.getByRole("button", { name: "cancel" });
      expect(document.activeElement).toBe(cancel);
      expect(dialog.contains(cancel)).toBe(true);
    });

    it("lets Enter on the focused cancel button leave the confirmation open", async () => {
      const results: boolean[] = [];
      const dialog = await openConfirm(results);
      fireEvent.keyDown(screen.getByRole("button", { name: "cancel" }), { key: "Enter" });
      await Promise.resolve();
      expect(results).toEqual([]);
      expect(dialog.hasAttribute("open")).toBe(true);
    });

    it("leaves Enter to the native button activation on the confirm button", async () => {
      await openConfirm([]);
      const confirmButton = screen.getByRole("button", { name: "confirm" });
      // fireEvent returns false when a handler called preventDefault, which would stop the browser's click.
      expect(fireEvent.keyDown(confirmButton, { key: "Enter" })).toBe(true);
    });

    it("cancels on Escape and closes the dialog", async () => {
      const results: boolean[] = [];
      const dialog = await openConfirm(results);
      fireEvent.keyDown(screen.getByRole("button", { name: "confirm" }), { key: "Escape" });
      await vi.waitFor(() => expect(results).toEqual([false]));
      expect(dialog.hasAttribute("open")).toBe(false);
    });

    it("confirms on y and cancels on n, in either case", async () => {
      const results: boolean[] = [];
      render(
        <ConfirmProvider>
          <ConfirmProbe results={results} />
        </ConfirmProvider>,
      );
      for (const [key, expected] of [["y", true], ["N", false], ["Y", true], ["n", false]] as const) {
        fireEvent.click(screen.getByRole("button", { name: "ask first" }));
        const cancel = await screen.findByRole("button", { name: "cancel" });
        fireEvent.keyDown(cancel, { key });
        await vi.waitFor(() => expect(results.at(-1)).toBe(expected));
      }
      expect(results).toEqual([true, false, true, false]);
    });

    it("ignores y and n with a modifier, while composing, and on key repeat", async () => {
      const results: boolean[] = [];
      const dialog = await openConfirm(results);
      const cancel = screen.getByRole("button", { name: "cancel" });
      fireEvent.keyDown(cancel, { key: "y", ctrlKey: true });
      fireEvent.keyDown(cancel, { key: "y", metaKey: true });
      fireEvent.keyDown(cancel, { key: "n", altKey: true });
      fireEvent.keyDown(cancel, { key: "y", isComposing: true });
      fireEvent.keyDown(cancel, { key: "y", repeat: true });
      await Promise.resolve();
      expect(results).toEqual([]);
      expect(dialog.hasAttribute("open")).toBe(true);
    });

    it("exposes the keys as hints without changing the button names", async () => {
      await openConfirm([]);
      const cancel = screen.getByRole("button", { name: "cancel" });
      const confirmButton = screen.getByRole("button", { name: "confirm" });
      expect(cancel.getAttribute("aria-keyshortcuts")).toBe("n");
      expect(confirmButton.getAttribute("aria-keyshortcuts")).toBe("y");
      expect(cancel.querySelector("kbd")!.textContent).toBe("n");
      expect(confirmButton.querySelector("kbd")!.textContent).toBe("y");
      expect(screen.getByRole("dialog").getAttribute("data-keyscope")).toBe("overlay");
    });

    it("keeps the window keymap out of the way while the dialog is open", async () => {
      const results: boolean[] = [];
      const globalRun = vi.fn();
      function GlobalBinding() {
        useKeymap([{ id: "test.global", keys: "1", title: "Global one", scope: "global", run: globalRun }]);
        return null;
      }
      renderWithShell(
        <>
          <GlobalBinding />
          <ConfirmProbe results={results} />
        </>,
      );

      fireEvent.keyDown(document.body, { key: "1" });
      expect(globalRun).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "ask first" }));
      const cancel = await screen.findByRole("button", { name: "cancel" });
      fireEvent.keyDown(cancel, { key: "1" });
      expect(globalRun).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(cancel, { key: "y" });
      await vi.waitFor(() => expect(results).toEqual([true]));
      expect(globalRun).toHaveBeenCalledTimes(1);
    });

    it("handles y exactly once even when the window keymap binds y", async () => {
      const results: boolean[] = [];
      const globalRun = vi.fn();
      function GlobalY() {
        useKeymap([{ id: "test.global-y", keys: "y", title: "Global y", scope: "global", run: globalRun }]);
        return null;
      }
      renderWithShell(
        <>
          <GlobalY />
          <ConfirmProbe results={results} />
        </>,
      );

      fireEvent.click(screen.getByRole("button", { name: "ask first" }));
      fireEvent.keyDown(await screen.findByRole("button", { name: "cancel" }), { key: "y" });
      await vi.waitFor(() => expect(results).toEqual([true]));
      expect(globalRun).not.toHaveBeenCalled();
    });
  });
});
