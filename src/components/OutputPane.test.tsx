import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import type { ActionResult, StatusData } from "../types";
import { Pane } from "../ui/Pane";
import { OutputPane, outputTextOf, useFocusOutputOnNewTransaction, type OutputPaneProps } from "./OutputPane";

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

function props(overrides: Partial<OutputPaneProps> = {}): OutputPaneProps {
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

function pane() {
  return screen.getByRole("region", { name: "Output" });
}

/** Key hints live in the status bar while the pane has focus, not in the pane. */
function bar() {
  return within(screen.getByLabelText("Status bar"));
}

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

afterEach(cleanup);

describe("OutputPane", () => {
  it("shows the prompt, the workspace context and the commands to try while idle", () => {
    renderInFrame(<OutputPane {...props()} />);
    expect(pane().textContent).toContain("❯");
    expect(pane().textContent).toContain("operations ready");
    expect(pane().textContent).toContain("workspace: valid · branch: main · targets: 2 rules, 1 configs");
    expect(pane().textContent).toContain(":update <target>");
    expect(pane().querySelector(".pane-title")!.textContent).not.toContain("[");
  });

  it("shows a finished run as command, status line, stdout rule and the text", () => {
    renderInFrame(<OutputPane {...props({ wsLog: APPLY, wsLogCompletedAt: Date.now() })} />);
    const text = pane().textContent!;
    expect(text).toContain("apply_setup update claude");
    expect(text).toContain("completed · exit 0");
    expect(text).toContain("── stdout");
    expect(pane().querySelector(".pane-title")!.textContent).toContain("apply_setup · ok");
    // Lines written by an apply are toned by their first word; the glyph row never depends on colour alone.
    const tones = Array.from(pane().querySelectorAll(".tui-out span")).map(span => [span.className, span.textContent]);
    expect(tones).toContainEqual(["c-ok", "applied      claude rules"]);
    expect(tones).toContainEqual(["c-fail", "failed       claude agents"]);
  });

  it("shows stderr under its own rule and marks a failed run", () => {
    renderInFrame(<OutputPane {...props({ wsLog: { ...APPLY, success: false, stdout: "", stderr: "write failed", exit_code: 1 } })} />);
    expect(pane().textContent).toContain("failed · exit 1");
    expect(pane().textContent).toContain("── stderr");
    expect(pane().querySelector(".pane-title")!.textContent).toContain("failed");
  });

  it("shows a running task with its label", () => {
    renderInFrame(<OutputPane {...props({ wsRunning: "update claude" })} />);
    expect(within(pane()).getByRole("status").getAttribute("aria-label")).toBe("update claude running");
    expect(pane().querySelector(".pane-title")!.textContent).toContain("update claude · running");
  });

  it("copies the redacted output with y", async () => {
    renderInFrame(<OutputPane {...props({ wsLog: { ...APPLY, stdout: "token = abc123def456\nok" } })} />);
    const body = pane().querySelector(".pane-body")!;
    act(() => (body as HTMLElement).focus());
    fireEvent.keyDown(body, { key: "y" });
    await act(async () => {
      await Promise.resolve();
    });
    const copied = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(copied).toContain("ok");
    expect(copied).not.toContain("abc123def456");
    expect(outputTextOf(null)).toBeNull();
  });

  it("clears with C, but not while a task runs", () => {
    const onClear = vi.fn();
    const { rerenderFrame } = renderInFrame(<OutputPane {...props({ wsLog: APPLY, onClear })} />);
    const body = pane().querySelector(".pane-body")!;
    act(() => (body as HTMLElement).focus());
    fireEvent.keyDown(body, { key: "C", shiftKey: true });
    expect(onClear).toHaveBeenCalledTimes(1);
    rerenderFrame(<OutputPane {...props({ wsLog: APPLY, onClear, wsRunning: "apply" })} />);
    fireEvent.keyDown(body, { key: "C", shiftKey: true });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("offers z rollback only while a transaction can be rolled back, and runs it", () => {
    const onRollback = vi.fn();
    const { rerenderFrame } = renderInFrame(<OutputPane {...props({ wsLog: APPLY })} />);
    const body = pane().querySelector(".pane-body")!;
    act(() => (body as HTMLElement).focus());
    expect(bar().queryByRole("button", { name: /rollback/ })).toBeNull();
    rerenderFrame(<OutputPane {...props({ wsLog: APPLY, rollbackTransactionId: "1710000000000", onRollback })} />);
    const button = bar().getByRole("button", { name: /rollback/ });
    fireEvent.click(button);
    expect(onRollback).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(body, { key: "z" });
    expect(onRollback).toHaveBeenCalledTimes(2);
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
          <OutputPane {...props({ wsLog: APPLY, rollbackTransactionId: transactionId, onRollback })} />
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
      fireEvent.keyDown(document.activeElement!, { key: "z" });
      expect(onRollback).toHaveBeenCalledTimes(1);
    });

    it("works when the output pane remounts with the review and already carries the new transaction", () => {
      function Host({ transactionId, review }: { transactionId: string | null; review: boolean }) {
        useFocusOutputOnNewTransaction(transactionId);
        return review ? (
          <section>
            <Pane id="plan" title="plan" scrollable>
              <p>plan</p>
            </Pane>
            <OutputPane {...props({ wsLog: APPLY })} />
          </section>
        ) : (
          <section>
            <Pane id="targets" title="targets" defaultFocus scrollable>
              <p>targets</p>
            </Pane>
            <OutputPane {...props({ wsLog: APPLY, rollbackTransactionId: transactionId, onRollback: () => {} })} />
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

  it("refreshes with r and says why it cannot while a task runs", () => {
    const onRefresh = vi.fn();
    const { rerenderFrame } = renderInFrame(<OutputPane {...props({ onRefresh })} />);
    const body = pane().querySelector(".pane-body")!;
    act(() => (body as HTMLElement).focus());
    fireEvent.keyDown(body, { key: "r" });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerenderFrame(<OutputPane {...props({ onRefresh, wsRunning: "apply" })} />);
    fireEvent.keyDown(body, { key: "r" });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(bar().getByRole("button", { name: /refresh/ }).getAttribute("title")).toBe("a task is running");
  });
});
