import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import type { ActionResult, StatusData } from "../types";
import { Pane } from "../ui/Pane";
import { OutputStrip, outputTextOf, useFocusOutputOnNewTransaction, type OutputStripProps } from "./OutputStrip";

const STATUS = {
  repo_path: "/tmp/workspace",
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
    dataFolderOk: true,
    ...overrides,
  };
}

function strip() {
  return screen.getByRole("region", { name: "Output" });
}

/** The one-row summary: the strip's primary focus target and its toggle. Not the only button once a result offers rollback. */
function line() {
  return strip().querySelector<HTMLButtonElement>("button[aria-controls]")!;
}

/** The mouse-only `↵ expand` / `esc collapse` key beside the line. */
function affordance() {
  return strip().querySelector(".outstrip-affordance")!;
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
      expect(line().textContent).toBe("❯ready · workspace valid");
      expect(affordance().textContent).toBe("↵ expand");
      expect(strip().textContent).not.toContain("try:");
      expect(strip().querySelector(".tui-caret")).toBeNull();
      expect(line().getAttribute("aria-expanded")).toBe("false");
      expect(log().hidden).toBe(true);
    });

    it("says what is missing instead of a status it does not have", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ status: null })} />);
      expect(line().textContent).toContain("ready · waiting for workspace status…");
      rerenderFrame(<OutputStrip {...props({ dataFolderOk: false })} />);
      expect(line().textContent).toBe("❯ready · workspace invalid");
    });

    it("shows a running task with its label and the loader, and opens by itself", () => {
      renderInFrame(<OutputStrip {...props({ wsRunning: "update claude" })} />);
      expect(line().textContent).toBe("❯update claudeworking…⠋0.0srunning");
      expect(affordance().textContent).toBe("esc collapse");
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

    it("names an uninstall the same way finished as while it ran", () => {
      const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsRunning: "uninstall" })} />);
      expect(line().textContent).toContain("uninstall");
      rerenderFrame(<OutputStrip {...props({ wsLog: { ...APPLY, action: "apply_uninstall" } })} />);
      expect(line().textContent).toContain("✓uninstall · ok");
      expect(line().textContent).not.toContain("apply_uninstall");
    });

    it("offers the transaction z would roll back, as its own button beside the result only", () => {
      const onRollback = vi.fn();
      const { rerenderFrame } = renderInFrame(
        <OutputStrip {...props({ wsLog: APPLY, rollbackTransactionId: TRANSACTION, onRollback })} />,
      );
      const rollback = within(strip()).getByRole("button", { name: "rollback 456789" });
      expect(rollback.querySelector("kbd")!.textContent).toBe("z");
      expect(rollback.getAttribute("aria-keyshortcuts")).toBe("Z");
      // A sibling of the line's toggle in the same row: buttons never nest.
      expect(line().contains(rollback)).toBe(false);
      expect(rollback.parentElement).toBe(line().parentElement);
      expect(line().querySelector("button")).toBeNull();
      expect(line().textContent).not.toContain("rollback");
      fireEvent.click(rollback);
      expect(onRollback).toHaveBeenCalledTimes(1);
      // Clicking the offer does not toggle the log.
      expect(line().getAttribute("aria-expanded")).toBe("false");

      rerenderFrame(<OutputStrip {...props({ rollbackTransactionId: TRANSACTION, onRollback })} />);
      expect(within(strip()).queryByRole("button", { name: /rollback/ })).toBeNull();
      rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude", wsLog: APPLY, rollbackTransactionId: TRANSACTION, onRollback })} />);
      expect(within(strip()).queryByRole("button", { name: /rollback/ })).toBeNull();
      rerenderFrame(<OutputStrip {...props({ wsLog: APPLY, rollbackTransactionId: TRANSACTION })} />);
      expect(within(strip()).queryByRole("button", { name: /rollback/ })).toBeNull();
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
      expect(affordance().textContent).toBe("esc collapse");
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
      rerenderFrame(<OutputStrip {...props({ wsLog: APPLY, dataFolderOk: false })} />);
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

describe("OutputStrip progress", () => {
  const WRITING = { task: "apply_setup", phase: "apply", done: 4, total: 7, file: "~/.claude/skills/handoff/SKILL.md" } as const;

  it("reads the bar, count and file on the line while files are written", () => {
    renderInFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: WRITING })} />);
    const bar = line().querySelector("[role='progressbar']")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("4");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("7");
    expect(bar.getAttribute("style")).toContain("--p: 57%");
    expect(line().textContent).toBe("❯update claude░░░░░░░░░░██████████4/7~/.claude/skills/handoff/SKILL.md⠋0.0srunning");
  });

  it("keeps the file on one ellipsized, titled item instead of wrapping the line", () => {
    const file = "~/.claude/skills/a-very-long-skill-name/references/an-even-longer-file-name.md";
    renderInFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: { ...WRITING, file } })} />);
    const item = line().querySelector(".pfile")!;
    expect(item.textContent).toBe(file);
    expect(item.getAttribute("title")).toBe(file);
    expect(line().querySelectorAll(".pfile")).toHaveLength(1);
  });

  it("falls back to the loader and a word while backing up and before the first event", () => {
    const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsRunning: "update claude" })} />);
    expect(line().querySelector("[role='progressbar']")).toBeNull();
    expect(line().textContent).toContain("working…");

    rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: { ...WRITING, phase: "backup", done: 2 } })} />);
    expect(line().querySelector("[role='progressbar']")).toBeNull();
    expect(line().textContent).toContain("backing up…");
    expect(line().textContent).not.toContain("4/7");

    // Without a total there is nothing to count, so the line stays indeterminate.
    rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: { ...WRITING, total: null } })} />);
    expect(line().querySelector("[role='progressbar']")).toBeNull();
    expect(line().textContent).toContain("working…");
  });

  it("carries the loader on the line only while the log is collapsed, and shows the full bar when done", () => {
    renderInFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: { ...WRITING, phase: "backup" } })} />);
    expect(line().querySelector(".terminal-activity")).toBeNull();
    fireEvent.click(line());
    expect(line().querySelector(".terminal-activity")).not.toBeNull();
    cleanup();

    renderInFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: { ...WRITING, phase: "done", done: 7, file: null } })} />);
    expect(line().querySelector(".pbar")!.classList.contains("done")).toBe(true);
    expect(line().textContent).toContain("7/7");
  });

  it("tells the open log the count, file and time, and lists the files as they are written", () => {
    const first = { ...WRITING, done: 0, file: "~/.claude/CLAUDE.md" };
    const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: first })} />);
    const status = within(strip()).getByRole("status");
    // Only the label is announced; the numbers around it are not.
    expect(status.getAttribute("aria-label")).toBe("update claude running");
    expect(log().querySelector(".tui-progress-label")!.textContent).toBe("working… · 0/7 · ~/.claude/CLAUDE.md · 0.0s");
    expect(log().querySelector(".tui-progress-label [aria-hidden='true']")).not.toBeNull();
    const listed = () => Array.from(log().querySelectorAll(".tail-line")).map(item => item.textContent);
    expect(listed()).toEqual(["~/.claude/CLAUDE.md"]);

    rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: { ...first, done: 1, file: "~/.claude/agents/verifier.md" } })} />);
    // The same file reported twice is one line.
    rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: { ...first, done: 1, file: "~/.claude/agents/verifier.md" } })} />);
    rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: { ...first, done: 7, file: null } })} />);
    expect(listed()).toEqual(["~/.claude/CLAUDE.md", "~/.claude/agents/verifier.md"]);
    expect(log().querySelector(".tui-progress-label")!.textContent).toBe("working… · 7/7 · 0.0s");
  });

  it("names the backup phase in the log and lists no file for it", () => {
    renderInFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: { ...WRITING, phase: "backup", done: 1 } })} />);
    expect(log().querySelector(".tui-progress-label")!.textContent).toBe("working… · backing up · 0.0s");
    expect(log().querySelector(".tail-line")).toBeNull();
  });

  it("keeps only the latest files of a long run", () => {
    const at = (index: number) => ({ ...WRITING, done: index, total: 100, file: `~/.claude/skills/s${index}/SKILL.md` });
    const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: at(0) })} />);
    for (let index = 1; index < 60; index++) {
      rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: at(index) })} />);
    }
    const listed = Array.from(log().querySelectorAll(".tail-line")).map(item => item.textContent);
    expect(listed).toHaveLength(40);
    expect(listed[0]).toBe("~/.claude/skills/s20/SKILL.md");
    expect(listed.at(-1)).toBe("~/.claude/skills/s59/SKILL.md");
  });

  it("starts the next task with an empty list", () => {
    const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsRunning: "update claude", progress: WRITING })} />);
    expect(log().querySelectorAll(".tail-line")).toHaveLength(1);
    rerenderFrame(<OutputStrip {...props({ wsLog: APPLY })} />);
    rerenderFrame(<OutputStrip {...props({ wsRunning: "rollback" })} />);
    expect(log().querySelector(".tail-line")).toBeNull();
  });
});

describe("OutputStrip success moment", () => {
  const FAILED: ActionResult = { ...APPLY, success: false, stdout: "", stderr: "write failed", exit_code: 1 };

  afterEach(() => document.documentElement.removeAttribute("data-motion"));

  /** jsdom has no AnimationEvent: React listens for the prefixed event there, and the name the handler reads is attached by hand. */
  function animationEnd(animationName: string) {
    for (const type of ["animationend", "webkitAnimationEnd"]) {
      fireEvent(strip(), Object.assign(new Event(type, { bubbles: true }), { animationName }));
    }
  }

  function landsUnder(level: string, result: ActionResult) {
    document.documentElement.setAttribute("data-motion", level);
    const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsRunning: "update claude" })} />);
    rerenderFrame(<OutputStrip {...props({ wsRunning: null, wsLog: result, wsLogCompletedAt: Date.now() })} />);
    return rerenderFrame;
  }

  it("pops the check and fades the border once when a success lands under full motion", () => {
    landsUnder("full", APPLY);
    expect(strip().classList.contains("just-done")).toBe(true);
    expect(line().querySelector(".g")!.classList.contains("tick")).toBe(true);
    // The check's own animation ending does not clear it; the border fade does.
    animationEnd("tick-pop");
    expect(strip().classList.contains("just-done")).toBe(true);
    animationEnd("outstrip-ok-fade");
    expect(strip().classList.contains("just-done")).toBe(false);
  });

  it("flags nothing under subtle or off motion", () => {
    for (const level of ["subtle", "off"]) {
      landsUnder(level, APPLY);
      expect(strip().classList.contains("just-done"), level).toBe(false);
      cleanup();
    }
  });

  it("flags nothing for a failure", () => {
    landsUnder("full", FAILED);
    expect(strip().classList.contains("just-done")).toBe(false);
    expect(line().querySelector(".g")!.classList.contains("tick")).toBe(false);
  });

  it("stays calm for a result that was already there when the strip mounted", () => {
    document.documentElement.setAttribute("data-motion", "full");
    renderInFrame(<OutputStrip {...props({ wsLog: APPLY, wsLogCompletedAt: Date.now() - 60_000 })} />);
    expect(strip().classList.contains("just-done")).toBe(false);
    expect(line().querySelector(".g")!.classList.contains("tick")).toBe(true);
  });

  it("counts a result of the last second or two as landed when the strip mounts onto it", () => {
    // The page swaps the review for its panes, and remounts the strip, as the task ends.
    document.documentElement.setAttribute("data-motion", "full");
    renderInFrame(<OutputStrip {...props({ wsLog: APPLY, wsLogCompletedAt: Date.now() - 200 })} />);
    expect(strip().classList.contains("just-done")).toBe(true);
    cleanup();

    document.documentElement.setAttribute("data-motion", "subtle");
    renderInFrame(<OutputStrip {...props({ wsLog: APPLY, wsLogCompletedAt: Date.now() - 200 })} />);
    expect(strip().classList.contains("just-done")).toBe(false);
    cleanup();

    document.documentElement.setAttribute("data-motion", "full");
    renderInFrame(<OutputStrip {...props({ wsLog: { ...APPLY, success: false }, wsLogCompletedAt: Date.now() - 200 })} />);
    expect(strip().classList.contains("just-done")).toBe(false);
  });

  it("waits for the task to end when the result arrives while it is still shown as running", () => {
    document.documentElement.setAttribute("data-motion", "full");
    const { rerenderFrame } = renderInFrame(<OutputStrip {...props({ wsRunning: "update claude" })} />);
    rerenderFrame(<OutputStrip {...props({ wsRunning: "update claude", wsLog: APPLY })} />);
    expect(strip().classList.contains("just-done")).toBe(false);
    rerenderFrame(<OutputStrip {...props({ wsRunning: null, wsLog: APPLY })} />);
    expect(strip().classList.contains("just-done")).toBe(true);
  });

  it("drops the flag when the output is cleared", () => {
    const rerenderFrame = landsUnder("full", APPLY);
    rerenderFrame(<OutputStrip {...props()} />);
    expect(strip().classList.contains("just-done")).toBe(false);
  });
});
