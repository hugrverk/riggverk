import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInstallReview,
  useInstallFlow,
  type InstallFlow,
  type InstallFlowError,
  type InstallFlowRequest,
  type InstallFlowStatus,
} from "../hooks/useInstallFlow";
import { renderInFrame } from "../test/renderWithShell";
import type { PlannedOperation, SetupPlan, SetupResult, SetupSurfaceId } from "../types";
import { InstallPlanPane } from "./InstallPlanPane";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function op(surface: SetupSurfaceId, kind: PlannedOperation["kind"], extra: Partial<PlannedOperation> = {}): PlannedOperation {
  return { surface, kind, summary: `${kind} ${surface}`, ...extra };
}

const REQUEST: InstallFlowRequest = {
  label: "update claude",
  surfaces: ["claude_rules", "claude_agents", "claude_skills"],
};

function planOf(operations: PlannedOperation[], overrides: Partial<SetupPlan> = {}): SetupPlan {
  const pending = operations.some(o => o.kind === "create" || o.kind === "update" || o.kind === "remove");
  return {
    operations,
    synced: [],
    conflicts: operations.filter(o => o.kind === "conflict"),
    manual_steps: [],
    summary: "",
    has_pending_changes: pending,
    is_blocked: false,
    plan_fingerprint: pending ? "fp-reviewed" : null,
    preview_token: pending ? "tok-reviewed" : null,
    ...overrides,
  };
}

const MIXED_OPS: PlannedOperation[] = [
  op("claude_rules", "update", { summary: "Update ~/.claude/CLAUDE.md" }),
  op("claude_agents", "update", { details: ["+ create agents/sentinel.md", "~ update agents/verifier.md"] }),
  op("claude_skills", "conflict", {
    summary: "skills differ",
    conflict_description: "~/.claude/skills was modified locally since install",
  }),
];

interface FlowOptions {
  status?: InstallFlowStatus;
  operations?: PlannedOperation[];
  request?: InstallFlowRequest;
  error?: InstallFlowError;
}

function makeFlow({ status = "review", operations = MIXED_OPS, request = REQUEST, error }: FlowOptions = {}): InstallFlow {
  const review = status === "review" || status === "applying" ? buildInstallReview(request, planOf(operations)) : null;
  return {
    status,
    request,
    review,
    error: error ?? null,
    outcome: null,
    start: vi.fn(async () => null),
    apply: vi.fn(async () => null),
    cancel: vi.fn(),
    repreview: vi.fn(async () => null),
  };
}

function renderPane(flow: InstallFlow, props: Partial<Parameters<typeof InstallPlanPane>[0]> = {}) {
  const onApply = vi.fn();
  const utils = renderInFrame(
    <InstallPlanPane flow={flow} busyLabel={null} backupRoot="/tmp/backups" onApply={onApply} {...props} />,
  );
  return { onApply, ...utils };
}

function grid() {
  return screen.getByRole("grid", { name: "Install plan" });
}

function press(key: string, target: Element = grid()) {
  fireEvent.keyDown(target, { key });
}

function cursorRow() {
  return grid().querySelector("tr[aria-selected='true']") as HTMLElement;
}

/** Key hints live in the status bar (the review pane has focus), not in the pane. */
function bar() {
  return within(screen.getByLabelText("Status bar"));
}

function modeText() {
  return screen.getByLabelText("Status bar").querySelector(".mode")!.textContent;
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe("InstallPlanPane", () => {
  it("lists the plan grouped by surface with a glyph and a text label on every row", () => {
    renderPane(makeFlow());
    expect(Array.from(grid().querySelectorAll("tr.g")).map(row => row.textContent)).toEqual([
      "claude rules",
      "claude agents",
      "claude skills",
    ]);
    const rows = Array.from(grid().querySelectorAll("tbody tr:not(.g)"));
    expect(rows.map(row => row.querySelector("td.op")!.textContent!.trim())).toEqual([
      "~ update",
      "+ create",
      "~ update",
      "! conflict",
    ]);
    // The glyph is decoration; the word next to it carries the meaning.
    for (const row of rows) {
      expect(row.querySelector("td.op .g")!.getAttribute("aria-hidden")).toBe("true");
      expect(row.querySelector("td.op")!.textContent!.trim().split(" ")).toHaveLength(2);
    }
  });

  it("puts the counts in the pane title and highlights conflict rows with their description", () => {
    renderPane(makeFlow());
    const title = screen.getByRole("region", { name: "Install plan" }).querySelector(".pane-title")!.textContent!;
    expect(title).toContain("plan");
    expect(title).toContain("update claude");
    expect(title).toContain("3 surfaces");
    expect(title).toContain("+1");
    expect(title).toContain("~2");
    expect(title).toContain("!1");
    const conflict = grid().querySelector("tr.conf")!;
    expect(conflict.textContent).toContain("~/.claude/skills was modified locally since install");
    expect(conflict.textContent).toContain("preserved, skipped");
  });

  it("asks the question the status-bar buttons answer and notes the backup", () => {
    renderPane(makeFlow());
    const pane = screen.getByRole("region", { name: "Install plan" });
    expect(within(pane).getByRole("status").textContent).toBe("apply 3 safe changes, skip 1 conflict?");
    expect(pane.querySelector(".bk")!.textContent).toContain("/tmp/backups");
    expect(within(pane).queryByRole("button")).toBeNull();
    expect(bar().getByRole("button", { name: /apply/ })).toBeTruthy();
    expect(bar().getByRole("button", { name: /cancel/ })).toBeTruthy();
  });

  it("shows CONFIRM mode while the review is open", () => {
    renderPane(makeFlow());
    expect(modeText()).toBe("CONFIRM");
  });

  it("takes focus when it opens so its keys work without a click", () => {
    renderPane(makeFlow());
    expect(document.activeElement).toBe(grid());
  });

  it("applies with y, once per key press, in review", () => {
    const { onApply } = renderPane(makeFlow());
    press("y");
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("applies with the visible apply button", () => {
    const { onApply } = renderPane(makeFlow());
    fireEvent.click(bar().getByRole("button", { name: /apply/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("never applies on Enter", () => {
    const { onApply } = renderPane(makeFlow());
    press("Enter");
    press("Enter", cursorRow());
    press(" ");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("does not apply a plan with nothing safe in it, and says why", () => {
    const { onApply } = renderPane(makeFlow({ operations: [op("claude_skills", "conflict")] }));
    press("y");
    expect(onApply).not.toHaveBeenCalled();
    const apply = bar().getByRole("button", { name: /apply/ });
    expect(apply.getAttribute("aria-disabled")).toBe("true");
    expect(apply.getAttribute("title")).toBe("nothing safe to apply, 1 conflict");
    fireEvent.click(apply);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("waits for an unrelated running task before applying", () => {
    const { onApply } = renderPane(makeFlow(), { busyLabel: "release-check" });
    press("y");
    expect(onApply).not.toHaveBeenCalled();
    const apply = bar().getByRole("button", { name: /apply/ });
    expect(apply.getAttribute("title")).toBe("release-check is running");
  });

  it("has no apply path for a read-only preview", () => {
    const flow = makeFlow({ request: { ...REQUEST, label: "preview claude", readOnly: true } });
    const { onApply } = renderPane(flow);
    press("y");
    expect(onApply).not.toHaveBeenCalled();
    const pane = screen.getByRole("region", { name: "Install plan" });
    expect(bar().queryByRole("button", { name: /apply/ })).toBeNull();
    expect(bar().getByRole("button", { name: /close/ })).toBeTruthy();
    expect(within(pane).getByRole("status").textContent).toContain("preview only");
    press("n");
    expect(flow.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not apply while previewing, applying or after an error", () => {
    for (const status of ["previewing", "applying", "error"] as const) {
      const flow = makeFlow({
        status,
        error: status === "error" ? { kind: "stale", message: "plan changed", canRepreview: true } : undefined,
      });
      const { onApply, unmount } = renderPane(flow);
      fireEvent.keyDown(screen.getByRole("region", { name: "Install plan" }), { key: "y" });
      expect(onApply).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("cancels with n and with Escape, from inside the pane or from anywhere", () => {
    const flow = makeFlow();
    renderPane(flow);
    press("n");
    press("Escape");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(flow.cancel).toHaveBeenCalledTimes(3);
  });

  it("cannot be cancelled while the apply runs", () => {
    const flow = makeFlow({ status: "applying" });
    renderPane(flow);
    press("n");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(flow.cancel).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "Install plan" })).getByRole("status").textContent).toContain("applying");
  });

  it("moves the cursor with j and k", () => {
    renderPane(makeFlow());
    expect(cursorRow().textContent).toContain("claude rules");
    press("j");
    expect(cursorRow().textContent).toContain("agents/sentinel.md");
    press("j");
    press("j");
    expect(cursorRow().textContent).toContain("claude skills");
    press("j");
    expect(cursorRow().textContent).toContain("claude skills");
    press("k");
    expect(cursorRow().textContent).toContain("agents/verifier.md");
    expect(grid().getAttribute("aria-activedescendant")).toBe(cursorRow().id);
  });

  it("jumps to the next conflict with c and wraps around", () => {
    const ops = [...MIXED_OPS, op("cursor_mcp", "conflict", { summary: "mcp differs" })];
    renderPane(makeFlow({ operations: ops, request: { ...REQUEST, surfaces: [...REQUEST.surfaces, "cursor_mcp"] } }));
    press("c");
    expect(cursorRow().textContent).toContain("claude skills");
    press("c");
    expect(cursorRow().textContent).toContain("cursor mcp");
    press("c");
    expect(cursorRow().textContent).toContain("claude skills");
  });

  it("offers c only when there is a conflict", () => {
    renderPane(makeFlow({ operations: [op("claude_rules", "update")] }));
    expect(bar().queryByRole("button", { name: /next conflict/ })).toBeNull();
    const before = cursorRow();
    press("c");
    expect(cursorRow()).toBe(before);
  });

  it("toggles the details of the cursor row with d", () => {
    renderPane(makeFlow());
    press("j");
    press("j");
    press("j");
    expect(cursorRow().getAttribute("aria-expanded")).toBe("false");
    press("d");
    expect(cursorRow().getAttribute("aria-expanded")).toBe("true");
    const detail = grid().querySelector("tr.detail")!;
    expect(detail.textContent).toContain("skills differ");
    expect(detail.textContent).toContain("~/.claude/skills was modified locally since install");
    press("d");
    expect(grid().querySelector("tr.detail")).toBeNull();
  });

  it("offers a new preview with r after a stale or expired plan, and only then", () => {
    const stale = makeFlow({ status: "error", error: { kind: "stale", message: "Re-run preview: fingerprint mismatch", canRepreview: true } });
    renderPane(stale);
    const pane = screen.getByRole("region", { name: "Install plan" });
    expect(within(pane).getByRole("alert").textContent).toContain("fingerprint mismatch");
    expect(pane.textContent).toContain("Installed files changed after this preview");
    fireEvent.keyDown(pane, { key: "r" });
    expect(stale.repreview).toHaveBeenCalledTimes(1);
    fireEvent.click(bar().getByRole("button", { name: /preview again/ }));
    expect(stale.repreview).toHaveBeenCalledTimes(2);
    cleanup();

    const review = makeFlow();
    renderPane(review);
    press("r");
    expect(review.repreview).not.toHaveBeenCalled();
  });

  it("does not offer a new preview when none can help", () => {
    const flow = makeFlow({ status: "error", error: { kind: "no_surfaces", message: "No surfaces to preview.", canRepreview: false } });
    renderPane(flow);
    fireEvent.keyDown(screen.getByRole("region", { name: "Install plan" }), { key: "r" });
    expect(flow.repreview).not.toHaveBeenCalled();
  });

  it("returns the keyboard to the page when the review closes", () => {
    const { rerenderFrame } = renderPane(makeFlow());
    rerenderFrame(
      <button type="button" data-pane-id="x" data-pane-default="" data-keyscope="pane" aria-label="next page pane">
        page
      </button>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "next page pane" }));
  });
});

describe("InstallPlanPane with the install flow", () => {
  function FlowHarness({ plan, onApply }: { plan: SetupPlan; onApply?: (flow: InstallFlow) => void }) {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "preview_setup") return plan;
      if (command === "apply_setup") return { success: true, transaction_id: "1710000000000", applied: ["x"], failed: [], rolled_back: [], manual_steps: [], message: "ok" } satisfies SetupResult;
      throw new Error(`unexpected ${command}`);
    });
    const flow = useInstallFlow();
    useEffect(() => {
      void flow.start(REQUEST);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <>
        <InstallPlanPane flow={flow} busyLabel={null} onApply={() => { onApply?.(flow); void flow.apply(); }} />
        <span data-testid="status">{flow.status}</span>
      </>
    );
  }

  it("applies exactly the reviewed fingerprint, token and surfaces when y is pressed", async () => {
    renderInFrame(<FlowHarness plan={planOf(MIXED_OPS)} />);
    await screen.findByRole("grid", { name: "Install plan" });
    expect(invokeMock).toHaveBeenCalledWith("preview_setup", { surfaces: REQUEST.surfaces });

    press("y");
    press("y");
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("idle"));
    const applies = invokeMock.mock.calls.filter(call => call[0] === "apply_setup");
    expect(applies).toHaveLength(1);
    expect(applies[0]![1]).toEqual({
      surfaces: ["claude_rules", "claude_agents"],
      skipManual: true,
      planFingerprint: "fp-reviewed",
      previewToken: "tok-reviewed",
    });
  });

  it("does not call apply_setup for a plan without safe operations", async () => {
    renderInFrame(<FlowHarness plan={planOf([op("claude_skills", "conflict")])} />);
    await screen.findByRole("grid", { name: "Install plan" });
    press("y");
    await act(async () => {
      await Promise.resolve();
    });
    expect(invokeMock.mock.calls.some(call => call[0] === "apply_setup")).toBe(false);
  });

  it("surfaces a stale plan from the backend and previews again on r", async () => {
    const plan = planOf(MIXED_OPS);
    let calls = 0;
    function StaleHarness() {
      invokeMock.mockImplementation(async (command: string) => {
        if (command === "preview_setup") return plan;
        calls += 1;
        throw new Error("Plan fingerprint mismatch; re-run preview");
      });
      const flow = useInstallFlow();
      useEffect(() => {
        void flow.start(REQUEST);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <InstallPlanPane flow={flow} busyLabel={null} onApply={() => void flow.apply()} />;
    }
    renderInFrame(<StaleHarness />);
    await screen.findByRole("grid", { name: "Install plan" });
    press("y");
    const alert = await screen.findByRole("alert");
    expect(calls).toBe(1);
    expect(alert.textContent).toContain("fingerprint mismatch");

    fireEvent.keyDown(screen.getByRole("region", { name: "Install plan" }), { key: "r" });
    await screen.findByRole("grid", { name: "Install plan" });
    expect(invokeMock.mock.calls.filter(call => call[0] === "preview_setup")).toHaveLength(2);
  });
});
