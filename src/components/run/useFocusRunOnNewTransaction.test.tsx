import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderInFrame } from "../../test/renderWithShell";
import type { ActionResult } from "../../types";
import { Pane } from "../../ui/Pane";
import { RunPanel } from "./RunPanel";
import { useFocusRunOnNewTransaction } from "./useFocusRunOnNewTransaction";

const APPLY: ActionResult = { success: true, action: "apply_setup update claude", stdout: "applied 2 files", stderr: "", exit_code: 0 };

function panel(transactionId: string | null) {
  return <RunPanel wsRunning={null} wsLog={APPLY} wsLogCompletedAt={Date.now()} rollbackTransactionId={transactionId} onRollback={() => {}} />;
}

function Page({ transactionId, extra }: { transactionId: string | null; extra?: boolean }) {
  useFocusRunOnNewTransaction(transactionId);
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
      {panel(transactionId)}
    </>
  );
}

function focusedPaneId() {
  return (document.activeElement as HTMLElement | null)?.closest("[data-pane-id]")?.getAttribute("data-pane-id");
}

afterEach(cleanup);

describe("useFocusRunOnNewTransaction", () => {
  it("takes focus when a rollback transaction appears, so Undo and z are in reach", () => {
    const { rerenderFrame } = renderInFrame(<Page transactionId={null} />);
    act(() => screen.getByRole("group", { name: "targets" }).focus());
    expect(focusedPaneId()).toBe("targets");
    rerenderFrame(<Page transactionId="tx-1" />);
    expect(focusedPaneId()).toBe("output");
    expect(document.activeElement).toBe(within(screen.getByRole("region", { name: "Run" })).getByRole("button", { name: "Details" }));
  });

  it("works when the panel remounts with the review and already carries the new transaction", () => {
    function Host({ transactionId, review }: { transactionId: string | null; review: boolean }) {
      useFocusRunOnNewTransaction(transactionId);
      return review ? (
        <section>
          <Pane id="plan" title="plan" scrollable>
            <p>plan</p>
          </Pane>
          {panel(null)}
        </section>
      ) : (
        <section>
          <Pane id="targets" title="targets" defaultFocus scrollable>
            <p>targets</p>
          </Pane>
          {panel(transactionId)}
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
