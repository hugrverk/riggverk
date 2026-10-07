import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import type { ActionResult, StatusData } from "../types";
import { Pane } from "../ui/Pane";
import { OutputStrip, outputTextOf, useFocusOutputOnNewTransaction, type OutputStripProps } from "./OutputStrip";

const STATUS = {
  branch: "main",
  git_available: true,
  enabled_rule_target_ids: ["a", "b"],
  enabled_config_target_ids: ["c"],
} as unknown as StatusData;

const APPLY: ActionResult = {
  success: true,
  action: "apply_setup update claude",
  stdout: "plan abcd1234 · 2 surfaces · fingerprint verified\napplied      claude rules\nfailed       claude agents\napplied 1 · failed 1 · rolled back 0",
  stderr: "",
  exit_code: 0,
};

const TRANSACTION = "1710000000123456789";

function props(overrides: Partial<OutputStripProps> = {}): OutputStripProps {
  return {
    wsRunning: null,
    wsLog: null,
    wsLogCompletedAt: null,
    status: STATUS,
    workspaceValid: true,
    gitAvailable: true,
    canRunReleaseCheck: true,
    ...overrides,
  };
}

function strip() {
  return screen.getByRole("region", { name: "Output" });
}

/** The one-row summary: the strip's primary focus target and its toggle. */
function line() {
  return within(strip()).getByRole("button");
}

/** The log the line controls. Found through `aria-controls`: a collapsed (hidden) element has no accessible name. */
function log() {
  return document.getElementById(line().getAttribute("aria-controls")!)!;
}

function statusBar() {
  return screen.getByLabelText("Status bar");
}

function focusLine() {
  act(() => line().focus());
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(target, { key, ...init });
}

const scrollTo = vi.fn();
const scrollIntoView = vi.fn();

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  scrollTo.mockClear();
  scrollIntoView.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: scrollTo });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: scrollIntoView });
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("OutputStrip", () => {
  describe("the line", () => {
    it("is one quiet row while idle: ready, the workspace context, no command hints and no caret", () => {
      renderInFrame(<OutputStrip {...props()} />);
      expect(line().textContent).toBe("❯ready · workspace valid · branch main↵ expand");
      expect(strip().textContent).not.toContain("try:");
      expect(strip().querySelector(".tui-caret")).toBeNull();
      expect(line().getAttribute("aria-expanded")).toBe("false");
      expect(log().hidden).toBe(true);
    });

    it("says what is missing instead of a branch it does not have", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ status: null })} />);
      expect(line().textContent).toContain("ready · waiting for workspace status…");
      rerenderFrame(<OutputStrip {...props({ workspaceValid: false, gitAvailable: false })} />);
      expect(line().textContent).toContain("ready · workspace invalid↵");
      expect(line().textContent).not.toContain("branch");
    });

    it("shows a running task with its label and the loader, and opens by itself", () => {
      renderInFrame(<OutputStrip {...props({ wsRunning: "update claude" })} />);
      expect(line().textContent).toBe("❯update clauderunningesc collapse");
      expect(line().getAttribute("aria-expanded")).toBe("true");
      // One loader: the open log's. Collapsed, the line carries it.
      expect(line().querySelector(".terminal-activity")).toBeNull();
      expect(within(strip()).getByRole("status").getAttribute("aria-label")).toBe("update claude running");
      fireEvent.click(line());
      expect(line().querySelector(".terminal-activity")).not.toBeNull();
    });

    it("shows a finished run as verdict glyph, the task's own name, ok and when", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY, wsLogCompletedAt: Date.now() })} />);
      const text = line().textContent!;
      // The same words the line showed while the task ran, not the action id.
      expect(text.startsWith("✓update claude · ok · ")).toBe(true);
      expect(text).toContain("just now");
      expect(text).not.toContain("rollback");
      expect(line().querySelector(".g")!.className).toContain("c-ok");
    });

    it("marks a failed run with the fail glyph and the word", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: { ...APPLY, success: false, stdout: "", stderr: "write failed", exit_code: 1 } })} />);
      expect(line().textContent).toContain("✗update claude · failed");
      expect(line().querySelector(".g")!.className).toContain("c-fail");
    });

    it("names a release check the same way finished as while it ran", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsRunning: "release-check" })} />);
      expect(line().textContent).toContain("release-check");
      rerenderFrame(<OutputStrip {...props({ wsLog: { ...APPLY, action: "release_check" } })} />);
      expect(line().textContent).toContain("✓release-check · ok");
      expect(line().textContent).not.toContain("release_check");
    });

    it("names the transaction z would roll back, in the result only", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsLog: APPLY, rollbackTransactionId: TRANSACTION })} />);
      expect(line().textContent).toContain("· z rollback 456789");
      rerenderFrame(<OutputStrip {...props({ rollbackTransactionId: TRANSACTION })} />);
      expect(line().textContent).not.toContain("rollback");
    });
  });

  describe("pane contract", () => {
    it("is a pane that forwards focus to the line", () => {
      renderInFrame(<OutputStrip {...props()} />);
      expect(strip().getAttribute("data-pane-id")).toBe("output");
      expect(strip().getAttribute("data-keyscope")).toBe("pane");
      expect(strip().classList.contains("outstrip")).toBe(true);
      expect(line().hasAttribute("data-pane-primary")).toBe(true);
      act(() => strip().focus());
      expect(document.activeElement).toBe(line());
    });

    it("takes a custom pane id", () => {
      renderInFrame(<OutputStrip {...props({ id: "claude-output" })} />);
      expect(strip().getAttribute("data-pane-id")).toBe("claude-output");
    });

    it("is reached with l and left with h like any pane, and its keys work there", () => {
      const onRefresh = vi.fn();
      renderInFrame(
        <>
          <Pane id="list" title="list" defaultFocus scrollable>
            <p>list</p>
          </Pane>
          <OutputStrip {...props({ onRefresh })} />
        </>,
      );
      act(() => screen.getByRole("group", { name: "list" }).focus());
      press(document.activeElement!, "l");
      expect(document.activeElement).toBe(line());
      press(line(), "r");
      expect(onRefresh).toHaveBeenCalledTimes(1);
      press(line(), "h");
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "list" }));
    });
  });

  describe("expanding", () => {
    it("toggles with a click and lists the log it controls", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY, wsLogCompletedAt: Date.now() })} />);
      expect(log().hidden).toBe(true);
      // Collapsed, the log is not even rendered.
      expect(strip().textContent).not.toContain("── stdout");
      expect(line().getAttribute("aria-controls")).toBe(log().id);

      fireEvent.click(line());
      expect(line().getAttribute("aria-expanded")).toBe("true");
      expect(log().hidden).toBe(false);
      expect(log().textContent).toContain("completed · exit 0");
      expect(log().textContent).toContain("── stdout");
      // The line names the command and when it ran; the log does not say it again.
      expect(log().querySelector(".tui-cmdline")).toBeNull();
      expect(log().textContent).not.toContain("update claude");
      expect(line().textContent).toContain("esc collapse");
      // Lines written by an apply are toned by their first word; the glyph row never depends on colour alone.
      const tones = Array.from(log().querySelectorAll(".tui-out span")).map(span => [span.className, span.textContent]);
      expect(tones).toContainEqual(["c-ok", "applied      claude rules"]);
      expect(tones).toContainEqual(["c-fail", "failed       claude agents"]);

      fireEvent.click(line());
      expect(line().getAttribute("aria-expanded")).toBe("false");
      expect(log().hidden).toBe(true);
    });

    it("brings the strip into view when it opens, for a stacked page that scrolls", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      expect(scrollIntoView).not.toHaveBeenCalled();
      fireEvent.click(line());
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(strip());
      fireEvent.click(line());
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it("shows stderr under its own rule", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: { ...APPLY, success: false, stdout: "", stderr: "write failed", exit_code: 1 } })} />);
      fireEvent.click(line());
      expect(log().textContent).toContain("failed · exit 1");
      expect(log().textContent).toContain("── stderr");
      expect(log().textContent).toContain("write failed");
    });

    it("has nothing to show when idle and says so", () => {
      renderInFrame(<OutputStrip {...props()} />);
      fireEvent.click(line());
      expect(log().textContent).toContain("nothing run yet");
    });

    it("redacts secrets in the log", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: { ...APPLY, stdout: "token = abc123def456\nok" } })} />);
      fireEvent.click(line());
      expect(log().textContent).toContain("output redacted");
      expect(log().textContent).not.toContain("abc123def456");
    });

    it("opens when a task starts and again when the result arrives, even after the user collapsed it", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props()} />);
      expect(line().getAttribute("aria-expanded")).toBe("false");

      rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude" })} />);
      expect(line().getAttribute("aria-expanded")).toBe("true");

      // The user's toggle wins while the task runs ...
      fireEvent.click(line());
      expect(line().getAttribute("aria-expanded")).toBe("false");
      rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude" })} />);
      expect(line().getAttribute("aria-expanded")).toBe("false");

      // ... until the result arrives.
      rerenderFrame(<OutputStrip {...props({ wsLog: APPLY, wsLogCompletedAt: Date.now() })} />);
      expect(line().getAttribute("aria-expanded")).toBe("true");
      expect(log().textContent).toContain("── stdout");
    });

    it("behaves the same under StrictMode's double render", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props()} />, {}, { strict: true });
      rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude" })} />);
      expect(line().getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(line());
      expect(line().getAttribute("aria-expanded")).toBe("false");
      rerenderFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      expect(line().getAttribute("aria-expanded")).toBe("true");
    });

    it("opens for a new result without a run in between", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      expect(line().getAttribute("aria-expanded")).toBe("false");
      rerenderFrame(<OutputStrip {...props({ wsLog: { ...APPLY, action: "apply_setup update codex" } })} />);
      expect(line().getAttribute("aria-expanded")).toBe("true");
    });

    it("leaves the toggle alone when nothing new arrived, and when the output is cleared", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      // Same log object, new render (a timer tick, a status refresh): no re-open.
      rerenderFrame(<OutputStrip {...props({ wsLog: APPLY, workspaceValid: false })} />);
      expect(line().getAttribute("aria-expanded")).toBe("false");
      rerenderFrame(<OutputStrip {...props({ wsLog: null })} />);
      expect(line().getAttribute("aria-expanded")).toBe("false");
    });

    it("starts open only for a task in flight, not for a result that is already there", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      expect(line().getAttribute("aria-expanded")).toBe("false");
      cleanup();
      renderInFrame(<OutputStrip {...props({ wsRunning: "apply" })} />);
      expect(line().getAttribute("aria-expanded")).toBe("true");
    });
  });

  describe("keys", () => {
    it("Enter in the log collapses it and keeps focus in the strip", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      fireEvent.click(line());
      act(() => log().focus());
      press(log(), "Enter");
      expect(line().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(line());
      // Collapsed, the log is out of the tab order; Enter on the line itself is the button's own click.
      expect(log().hasAttribute("tabindex")).toBe(false);
    });

    it("leaves Enter on the line to the button, so it does not toggle twice", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      focusLine();
      press(line(), "Enter");
      expect(line().getAttribute("aria-expanded")).toBe("false");
    });

    it("Escape collapses an open log, from the line and from the log", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      fireEvent.click(line());
      focusLine();
      press(line(), "Escape");
      expect(line().getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(line());
      act(() => log().focus());
      press(log(), "Escape");
      expect(line().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(line());
    });

    it("keeps Escape for the strip while it is open, and gives it back to the error line once collapsed", () => {
      const onDismissError = vi.fn();
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />, { error: "backups: boom", onDismissError });
      fireEvent.click(line());
      focusLine();
      press(line(), "Escape");
      expect(onDismissError).not.toHaveBeenCalled();
      expect(line().getAttribute("aria-expanded")).toBe("false");
      press(line(), "Escape");
      expect(onDismissError).toHaveBeenCalledTimes(1);
    });

    it("offers expand, then collapse, in the status bar while the strip has focus", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      focusLine();
      fireEvent.click(within(statusBar()).getByRole("button", { name: /expand/ }));
      expect(line().getAttribute("aria-expanded")).toBe("true");
      expect(within(statusBar()).queryByRole("button", { name: /expand/ })).toBeNull();
      fireEvent.click(within(statusBar()).getByRole("button", { name: /collapse/ }));
      expect(line().getAttribute("aria-expanded")).toBe("false");
    });

    it("copies the redacted output with y", async () => {
      renderInFrame(<OutputStrip {...props({ wsLog: { ...APPLY, stdout: "token = abc123def456\nok" } })} />);
      focusLine();
      press(line(), "y");
      await act(async () => {
        await Promise.resolve();
      });
      const copied = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(copied).toContain("ok");
      expect(copied).not.toContain("abc123def456");
      expect(outputTextOf(null)).toBeNull();
    });

    it("offers y only when there is output to copy", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props()} />);
      focusLine();
      expect(within(statusBar()).queryByRole("button", { name: /copy output/ })).toBeNull();
      rerenderFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      expect(within(statusBar()).getByRole("button", { name: /copy output/ })).not.toBeNull();
    });

    it("clears with C, but not while a task runs", () => {
      const onClear = vi.fn();
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsLog: APPLY, onClear })} />);
      focusLine();
      press(line(), "C", { shiftKey: true });
      expect(onClear).toHaveBeenCalledTimes(1);
      rerenderFrame(<OutputStrip {...props({ wsLog: APPLY, onClear, wsRunning: "apply" })} />);
      press(line(), "C", { shiftKey: true });
      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it("offers z rollback only while a transaction can be rolled back, and runs it", () => {
      const onRollback = vi.fn();
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      focusLine();
      expect(within(statusBar()).queryByRole("button", { name: /rollback/ })).toBeNull();
      press(line(), "z");
      expect(onRollback).not.toHaveBeenCalled();

      rerenderFrame(<OutputStrip {...props({ wsLog: APPLY, rollbackTransactionId: TRANSACTION, onRollback })} />);
      fireEvent.click(within(statusBar()).getByRole("button", { name: /rollback/ }));
      expect(onRollback).toHaveBeenCalledTimes(1);
      press(line(), "z");
      expect(onRollback).toHaveBeenCalledTimes(2);

      // A transaction without a handler is not offered either.
      rerenderFrame(<OutputStrip {...props({ wsLog: APPLY, rollbackTransactionId: TRANSACTION })} />);
      expect(within(statusBar()).queryByRole("button", { name: /rollback/ })).toBeNull();
    });

    it("refreshes with r and says why it cannot while a task runs", () => {
      const onRefresh = vi.fn();
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ onRefresh })} />);
      focusLine();
      press(line(), "r");
      expect(onRefresh).toHaveBeenCalledTimes(1);
      rerenderFrame(<OutputStrip {...props({ onRefresh, wsRunning: "apply" })} />);
      press(line(), "r");
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(within(statusBar()).getByRole("button", { name: /refresh/ }).getAttribute("title")).toBe("a task is running");
    });

    it("scrolls the log with g g and G, opening a collapsed strip first", () => {
      renderInFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
      Object.defineProperty(log(), "scrollHeight", { configurable: true, value: 480 });
      focusLine();

      press(line(), "G", { shiftKey: true });
      expect(line().getAttribute("aria-expanded")).toBe("true");
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 480 });

      press(line(), "g");
      press(line(), "g");
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });
      expect(scrollTo).toHaveBeenCalledTimes(2);

      fireEvent.click(line());
      press(line(), "g");
      press(line(), "g");
      expect(line().getAttribute("aria-expanded")).toBe("true");
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });
      expect(scrollTo).toHaveBeenCalledTimes(3);
    });
  });

  describe("useFocusOutputOnNewTransaction", () => {
    function Page({ transactionId, extra, onRollback = () => {} }: { transactionId: string | null; extra?: boolean; onRollback?: () => void }) {
      useFocusOutputOnNewTransaction(transactionId);
      return (
        <>
          <Pane id="targets" title="targets" defaultFocus scrollable>
            <p>targets</p>
          </Pane>
          {extra && (
            <Pane id="surfaces" title="surfaces" scrollable>
              <p>surfaces</p>
            </Pane>
          )}
          <OutputStrip {...props({ wsLog: APPLY, rollbackTransactionId: transactionId, onRollback })} />
        </>
      );
    }

    function focusedPaneId() {
      return (document.activeElement as HTMLElement | null)?.closest("[data-pane-id]")?.getAttribute("data-pane-id");
    }

    it("takes focus when a rollback transaction appears, so z works right away", () => {
      const onRollback = vi.fn();
      const { rerenderFrame } = renderInFrame(<Page transactionId={null} onRollback={onRollback} />);
      act(() => screen.getByRole("group", { name: "targets" }).focus());
      expect(focusedPaneId()).toBe("targets");
      rerenderFrame(<Page transactionId="tx-1" onRollback={onRollback} />);
      expect(focusedPaneId()).toBe("output");
      expect(document.activeElement).toBe(line());
      fireEvent.keyDown(document.activeElement!, { key: "z" });
      expect(onRollback).toHaveBeenCalledTimes(1);
    });

    it("works when the strip remounts with the review and already carries the new transaction", () => {
      function Host({ transactionId, review }: { transactionId: string | null; review: boolean }) {
        useFocusOutputOnNewTransaction(transactionId);
        return review ? (
          <section>
            <Pane id="plan" title="plan" scrollable>
              <p>plan</p>
            </Pane>
            <OutputStrip {...props({ wsLog: APPLY })} />
          </section>
        ) : (
          <section>
            <Pane id="targets" title="targets" defaultFocus scrollable>
              <p>targets</p>
            </Pane>
            <OutputStrip {...props({ wsLog: APPLY, rollbackTransactionId: transactionId, onRollback: () => {} })} />
          </section>
        );
      }
      const { rerenderFrame } = renderInFrame(<Host transactionId={null} review />);
      act(() => screen.getByRole("group", { name: "plan" }).focus());
      // The apply finishes: the review (and the focus in it) goes, the page's own panes come back with the new
      // transaction already set.
      rerenderFrame(<Host transactionId="tx-1" review={false} />);
      expect(focusedPaneId()).toBe("output");
    });

    it("leaves a pane the user moved to, and a transaction that was already there on mount", () => {
      const { rerenderFrame } = renderInFrame(<Page transactionId={null} extra />);
      act(() => screen.getByRole("group", { name: "surfaces" }).focus());
      rerenderFrame(<Page transactionId="tx-1" extra />);
      expect(focusedPaneId()).toBe("surfaces");
      cleanup();

      renderInFrame(<Page transactionId="tx-2" />);
      act(() => screen.getByRole("group", { name: "targets" }).focus());
      expect(focusedPaneId()).toBe("targets");
    });
  });
});
