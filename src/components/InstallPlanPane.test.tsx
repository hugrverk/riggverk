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
  surfaces: ["claude_rules", "claude_agents", "skills"],
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
  op("skills", "conflict", {
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

/** Key hints live as a key hint (the review pane has focus), not in the pane. */
function bar() {
  return within(screen.getByLabelText("Key hints"));
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(cleanup);

describe("InstallPlanPane", () => {
  it("lists the plan grouped by agent, the conflicts pinned first, with a word and a hollow mark on every row; a conflict is the filled decision mark", () => {
    renderPane(makeFlow());
    expect(Array.from(grid().querySelectorAll("tr.g .gh-name")).map(name => name.textContent)).toEqual([
      "Skipped · needs your decision",
      "Shared",
      "Claude",
    ]);
    expect(grid().querySelector("tr.g-skip")!.textContent).toContain("apply never writes it");
    // The shared group has only the skipped conflict: it points up at it instead of repeating it.
    expect(grid().querySelector("tr.unch")!.textContent).toBe("skills is skipped, see above · nothing else to write");
    const rows = Array.from(grid().querySelectorAll("tbody tr:not(.g):not(.unch)"));
    // The word is the cell's own text; the details button after it has a name of its own.
    const wordOf = (row: Element) =>
      Array.from(row.querySelector("td.op")!.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").trim();
    expect(rows.map(wordOf)).toEqual(["conflict", "update", "create", "update"]);
    // The mark is decoration; the word next to it carries the meaning.
    expect(rows.map(row => row.querySelector("td.op .rv-mark")!.className)).toEqual([
      "rv-mark rv-mark-conflict",
      "rv-mark rv-mark-update",
      "rv-mark rv-mark-create",
      "rv-mark rv-mark-update",
    ]);
    for (const row of rows) expect(row.querySelector("td.op .rv-mark")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("is a review card: titled, with the action bar as its footer", () => {
    renderPane(makeFlow());
    const pane = screen.getByRole("region", { name: "Install plan" });
    expect(pane.classList.contains("pane-card")).toBe(true);
    expect(pane.querySelector(".pane-title b")!.textContent).toBe("Install plan");
    const footer = pane.querySelector<HTMLElement>(".pane-foot")!;
    expect(within(footer).getByRole("button", { name: "apply" })).toBeTruthy();
    expect(within(footer).getByText("Preview first")).toBeTruthy();
    expect(within(footer).getByText("Backed up")).toBeTruthy();
    expect(within(footer).getByText("Undo any time")).toBeTruthy();
  });

  it("states the consequences only where applying writes", () => {
    renderPane(makeFlow({ operations: [op("skills", "conflict")] }));
    expect(screen.queryByText("Undo any time")).toBeNull();
    cleanup();
    renderPane(makeFlow({ request: { ...REQUEST, label: "preview claude", readOnly: true } }));
    expect(screen.queryByText("Undo any time")).toBeNull();
  });

  it("titles a plan that only creates as an install, and keeps update when anything is updated", () => {
    const creates = [op("claude_rules", "create"), op("skills", "create")];
    renderPane(makeFlow({ operations: creates, request: { ...REQUEST, label: "update codex" } }));
    const title = () => screen.getByRole("region", { name: "Install plan" }).querySelector(".pane-title")!.textContent!;
    expect(title()).toContain("install codex");
    expect(title()).not.toContain("update codex");
    cleanup();
    renderPane(makeFlow({ operations: [...creates, op("claude_agents", "update")], request: { ...REQUEST, label: "update codex" } }));
    expect(title()).toContain("update codex");
  });

  it("puts the counts in the pane title and highlights conflict rows with their description", () => {
    renderPane(makeFlow());
    const title = screen.getByRole("region", { name: "Install plan" }).querySelector(".pane-title")!.textContent!;
    expect(title).toContain("plan");
    expect(title).toContain("update claude");
    expect(title).toContain("3 surfaces");
    expect(title).toContain("1 create");
    expect(title).toContain("2 update");
    expect(title).toContain("1 conflict");
    const conflict = grid().querySelector("tr.conf")!;
    expect(conflict.textContent).toContain("~/.claude/skills was modified locally since install");
    expect(conflict.textContent).toContain("preserved, skipped");
  });

  it("asks the question on the confirm line with its answers beside it, and notes the backup", () => {
    renderPane(makeFlow());
    const pane = screen.getByRole("region", { name: "Install plan" });
    expect(within(pane).getByRole("status").textContent).toBe("apply 3 safe changes, skip 1 conflict?");
    expect(pane.querySelector(".bk")!.textContent).toContain("/tmp/backups");
    // The question and its two bracket buttons share the footer row; the key hints repeats them as hints.
    const footer = pane.querySelector(".pane-foot")!;
    expect(Array.from(footer.querySelectorAll("button.tbtn")).map(button => button.textContent)).toEqual(["yapply", "ncancel", "cnext conflict"]);
    expect(within(pane).getByRole("button", { name: "apply" }).classList.contains("tbtn-primary")).toBe(true);
    expect(within(pane).getByRole("button", { name: "cancel" }).getAttribute("aria-keyshortcuts")).toBe("N Escape");
    expect(bar().getByRole("button", { name: /apply/ })).toBeTruthy();
    expect(bar().getByRole("button", { name: /cancel/ })).toBeTruthy();
  });

  describe("confirm line buttons", () => {
    const confirmLine = () => within(screen.getByRole("region", { name: "Install plan" }).querySelector<HTMLElement>(".pane-foot")!);

    it("apply runs the same action as y, cancel the same as n", () => {
      const flow = makeFlow();
      const { onApply } = renderPane(flow);
      fireEvent.click(confirmLine().getByRole("button", { name: "apply" }));
      expect(onApply).toHaveBeenCalledTimes(1);
      fireEvent.click(confirmLine().getByRole("button", { name: "cancel" }));
      expect(flow.cancel).toHaveBeenCalledTimes(1);
    });

    it("keeps Enter from applying, with the keyboard on the grid, on the cancel button or on the apply button itself", () => {
      const { onApply } = renderPane(makeFlow());
      press("Enter");
      fireEvent.keyDown(confirmLine().getByRole("button", { name: "cancel" }), { key: "Enter" });
      expect(onApply).not.toHaveBeenCalled();
      // A focused button would click on Enter; the apply button cancels that default, so nothing runs.
      const apply = confirmLine().getByRole("button", { name: "apply" });
      apply.focus();
      expect(fireEvent.keyDown(apply, { key: "Enter" })).toBe(false);
      expect(onApply).not.toHaveBeenCalled();
      // It is still reachable by mouse, and announces the key it answers to.
      expect(apply.getAttribute("aria-keyshortcuts")).toBe("Y");
      fireEvent.click(apply);
      expect(onApply).toHaveBeenCalledTimes(1);
    });

    it("disables apply with the reason the key would give, and still cancels", () => {
      const flow = makeFlow({ operations: [op("skills", "conflict")] });
      const { onApply } = renderPane(flow);
      const apply = confirmLine().getByRole("button", { name: "apply" });
      expect(apply.getAttribute("aria-disabled")).toBe("true");
      expect(apply.getAttribute("title")).toBe("nothing safe to apply, 1 conflict");
      fireEvent.click(apply);
      expect(onApply).not.toHaveBeenCalled();
      fireEvent.click(confirmLine().getByRole("button", { name: "cancel" }));
      expect(flow.cancel).toHaveBeenCalledTimes(1);
    });

    it("waits for an unrelated running task like the key does", () => {
      const { onApply } = renderPane(makeFlow(), { busyLabel: "uninstall" });
      const apply = confirmLine().getByRole("button", { name: "apply" });
      expect(apply.getAttribute("title")).toBe("uninstall is running");
      fireEvent.click(apply);
      expect(onApply).not.toHaveBeenCalled();
    });

    it("offers only close for a read-only preview", () => {
      const flow = makeFlow({ request: { ...REQUEST, label: "preview claude", readOnly: true } });
      renderPane(flow);
      expect(confirmLine().queryByRole("button", { name: "apply" })).toBeNull();
      fireEvent.click(confirmLine().getByRole("button", { name: "close" }));
      expect(flow.cancel).toHaveBeenCalledTimes(1);
    });

    it("locks both buttons while the apply runs", () => {
      const flow = makeFlow({ status: "applying" });
      const { onApply } = renderPane(flow);
      const apply = confirmLine().getByRole("button", { name: "apply" });
      const cancel = confirmLine().getByRole("button", { name: "cancel" });
      expect(apply.getAttribute("title")).toBe("applying…");
      expect(cancel.getAttribute("title")).toBe("applying; it cannot be cancelled");
      fireEvent.click(apply);
      fireEvent.click(cancel);
      expect(onApply).not.toHaveBeenCalled();
      expect(flow.cancel).not.toHaveBeenCalled();
    });
  });

  it("shows the review as its own region while it is open", () => {
    renderPane(makeFlow());
    expect(screen.getByRole("region", { name: "Install plan" })).toBeTruthy();
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
    const { onApply } = renderPane(makeFlow({ operations: [op("skills", "conflict")] }));
    press("y");
    expect(onApply).not.toHaveBeenCalled();
    const apply = bar().getByRole("button", { name: /apply/ });
    expect(apply.getAttribute("aria-disabled")).toBe("true");
    expect(apply.getAttribute("title")).toBe("nothing safe to apply, 1 conflict");
    fireEvent.click(apply);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("waits for an unrelated running task before applying", () => {
    const { onApply } = renderPane(makeFlow(), { busyLabel: "uninstall" });
    press("y");
    expect(onApply).not.toHaveBeenCalled();
    const apply = bar().getByRole("button", { name: /apply/ });
    expect(apply.getAttribute("title")).toBe("uninstall is running");
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

  it("moves the cursor with j and k, from the pinned conflict down the agents' rows", () => {
    renderPane(makeFlow());
    expect(cursorRow().textContent).toContain("skills");
    press("j");
    expect(cursorRow().textContent).toContain("claude rules");
    press("j");
    expect(cursorRow().textContent).toContain("agents/sentinel.md");
    press("j");
    press("j");
    expect(cursorRow().textContent).toContain("agents/verifier.md");
    press("k");
    expect(cursorRow().textContent).toContain("agents/sentinel.md");
    expect(grid().getAttribute("aria-activedescendant")).toBe(cursorRow().id);
  });

  it("jumps to the next conflict with c and wraps around", () => {
    const ops = [...MIXED_OPS, op("cursor_mcp", "conflict", { summary: "mcp differs" })];
    renderPane(makeFlow({ operations: ops, request: { ...REQUEST, surfaces: [...REQUEST.surfaces, "cursor_mcp"] } }));
    // The conflicts are pinned first; the cursor starts on the first of them.
    expect(cursorRow().textContent).toContain("skills");
    press("c");
    expect(cursorRow().textContent).toContain("cursor mcp");
    press("c");
    expect(cursorRow().textContent).toContain("skills");
    press("j");
    press("j");
    press("c");
    expect(cursorRow().textContent).toContain("skills");
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
    expect(cursorRow().getAttribute("aria-expanded")).toBe("false");
    press("d");
    expect(cursorRow().getAttribute("aria-expanded")).toBe("true");
    const detail = grid().querySelector("tr.detail")!;
    expect(detail.textContent).toContain("skills differ");
    expect(detail.textContent).toContain("~/.claude/skills was modified locally since install");
    press("d");
    expect(grid().querySelector("tr.detail")).toBeNull();
  });

  it("opens and closes the details of a row by pointer, and the cursor follows", () => {
    renderPane(makeFlow());
    const toggles = within(grid()).getAllByRole("button", { name: /^details of / });
    const second = toggles[1]!;
    expect(second.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(second);
    expect(second.getAttribute("aria-expanded")).toBe("true");
    expect(grid().querySelector("tr.detail")).not.toBeNull();
    expect(second.closest("tr")).toBe(cursorRow());
    fireEvent.click(second);
    expect(grid().querySelector("tr.detail")).toBeNull();
  });

  it("jumps to the next conflict from a button in the footer", () => {
    renderPane(makeFlow({ operations: [op("claude_rules", "update"), op("skills", "conflict", { summary: "differs" }), op("claude_agents", "update")] }));
    const pane = screen.getByRole("region", { name: "Install plan" });
    press("j");
    const before = cursorRow();
    fireEvent.click(within(pane).getByRole("button", { name: "next conflict" }));
    expect(cursorRow()).not.toBe(before);
    expect(cursorRow().className).toContain("conf");
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

describe("InstallPlanPane: band, map and states", () => {
  const AGENT_OPS: PlannedOperation[] = [
    op("skills", "update", {
      details: ["+ ~/.agents/skills (3 skills, 3 files)", "- $CODEX_HOME/skills (3 skills, owned copies)", "! ~/.cursor/skills/tdd (edited, kept)"],
    }),
    op("claude_rules", "update", { summary: "Update ~/.claude/CLAUDE.md" }),
    op("claude_agents", "update", { details: ["+ create agents/sentinel.md"] }),
  ];
  const AGENT_REQUEST: InstallFlowRequest = { label: "update all", surfaces: ["skills", "claude_rules", "claude_agents"] };
  const agentFlow = (status: InstallFlowStatus = "review") => makeFlow({ status, operations: AGENT_OPS, request: AGENT_REQUEST });
  const map = () => document.querySelector(".plan-map") as HTMLElement;

  it("sums the plan up in a band of count tiles, each kind in words", () => {
    renderPane(agentFlow());
    const tiles = screen.getByRole("list", { name: "Changes by kind" });
    expect(within(tiles).getAllByRole("listitem").map(tile => tile.textContent)).toEqual([
      "2Createnew files",
      "1Updatebacked up first",
      "1Removebacked up first",
      "1Conflictskipped, yours",
      "0Unchangedalready in sync",
    ]);
    const band = document.querySelector(".plan-band")!;
    expect(band.querySelector(".plan-bar")!.getAttribute("aria-hidden")).toBe("true");
    expect(band.querySelector(".plan-ask")!.textContent).toBe("4 safe changes · 6 files2 existing files are backed up before anything is written");
  });

  it("draws what apply writes to each agent on a map the table states in words, hidden from assistive technology", () => {
    renderPane(agentFlow());
    expect(map().getAttribute("aria-hidden")).toBe("true");
    const chips = Array.from(map().querySelectorAll(".plan-chip")).map(chip => [chip.getAttribute("data-agent"), chip.textContent]);
    expect(chips).toEqual([
      ["codex", "− 1 remove"],
      ["cursor", "■ 1 kept"],
      ["claude", "+ 1 · ~ 1"],
    ]);
    expect(map().querySelector('.plan-ln[data-agent="cursor"]')!.getAttribute("data-curve")).toBe("kept");
    // The table keeps its grid semantics and names every group in words.
    expect(Array.from(grid().querySelectorAll("tr.g .gh-name")).map(name => name.textContent)).toEqual([
      "Skipped · needs your decision",
      "Shared",
      "Claude",
      "Codex",
      "Cursor",
    ]);
  });

  it("lights the cursor row's agent on the map once the cursor moves with j and k", () => {
    renderPane(agentFlow());
    const svg = () => map().querySelector("svg")!;
    expect(svg().classList.contains("has-hl")).toBe(false);
    press("j");
    // The shared folder belongs to no single agent: nothing is lit.
    expect(cursorRow().textContent).toContain("~/.agents/skills");
    expect(svg().classList.contains("has-hl")).toBe(false);
    press("j");
    expect(cursorRow().textContent).toContain("claude rules");
    expect(svg().classList.contains("has-hl")).toBe(true);
    expect(Array.from(map().querySelectorAll(".plan-ln.hl")).map(path => path.getAttribute("data-agent"))).toEqual(["claude"]);
    expect(map().querySelector('.plan-chip.hl')!.getAttribute("data-agent")).toBe("claude");
  });

  it("points a conflict at the page that resolves it", () => {
    const onOpenAgent = vi.fn();
    renderPane(agentFlow(), { onOpenAgent });
    fireEvent.click(within(grid()).getByRole("button", { name: "Open Cursor →" }));
    expect(onOpenAgent).toHaveBeenCalledWith("cursor");
  });

  it("ticks the rows agent by agent while the apply runs", () => {
    const trace = { current: "claude" as const, seen: ["codex" as const, "claude" as const], counts: { codex: 3, claude: 1 }, files: [] };
    renderPane(agentFlow("applying"), { trace, progress: { task: "apply_setup", phase: "apply", done: 4, total: 8, file: "~/.claude/CLAUDE.md" } });
    const stateOf = (file: string) => within(grid()).getByText(file).closest("tr")!.querySelector("td.state")!.textContent;
    expect(stateOf("$CODEX_HOME/skills")).toBe("✓ written");
    expect(stateOf("claude rules")).toBe("writing…");
    expect(stateOf("~/.cursor/skills/tdd")).toBe("skipped");
    expect(within(screen.getByRole("region", { name: "Install plan" })).getByRole("status").textContent).toBe("applying: writing Claude… 4 of 8 files");
    expect(map().querySelector('.plan-ln[data-agent="codex"]')!.getAttribute("data-curve")).toBe("written");
    expect(map().querySelector('.plan-ln[data-agent="claude"]')!.getAttribute("data-curve")).toBe("live");
  });

  it("stays as the receipt of a successful apply, with Undo, until it is dismissed", () => {
    const flow = { ...agentFlow(), status: "idle" as const, request: null, review: null };
    const review = agentFlow().review!;
    const result: SetupResult = { success: true, transaction_id: "tx-42", applied: ["x"], failed: [], rolled_back: [], manual_steps: [], message: "ok" };
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    renderPane(flow, { done: { review, result, at: new Date(2026, 10, 1, 16, 14).getTime() }, onUndo, onDismiss });
    const pane = screen.getByRole("region", { name: "Install plan" });
    expect(pane.querySelector(".pane-title b")!.textContent).toBe("Update applied");
    expect(within(pane).getByRole("status").textContent).toBe("done at 16:14 · 4 changes applied, 1 conflict skipped");
    expect(pane.textContent).toContain("Applied. The rest is yours to decide.");
    expect(pane.querySelector(".bk")!.textContent).toContain("transaction tx-42 recorded · rollback available");
    expect(map().querySelector('.plan-ln[data-agent="claude"]')!.getAttribute("data-curve")).toBe("written");
    const wordOf = (file: string) => within(grid()).getByText(file).closest("tr")!.querySelector("td.op")!.firstChild!.nextSibling!.textContent;
    expect(wordOf("claude rules")).toBe("updated");
    expect(within(pane).queryByRole("button", { name: "apply" })).toBeNull();
    fireEvent.click(within(pane).getByRole("button", { name: "Undo this update…" }));
    expect(onUndo).toHaveBeenCalledWith("tx-42");
    press("n");
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(within(pane).getByRole("button", { name: "dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(3);
    expect(flow.cancel).not.toHaveBeenCalled();
  });
});

describe("InstallPlanPane: a done state with steps left", () => {
  it("never reads as all clear when the run left a step to the user, and lists each step", () => {
    const review = buildInstallReview(REQUEST, planOf([op("claude_rules", "update")]));
    const result: SetupResult = {
      success: true,
      transaction_id: "tx-7",
      applied: ["x"],
      failed: [],
      rolled_back: [],
      manual_steps: ["The files were applied, but a choice to keep your version of one of them could not be cleared: denied"],
      message: "ok",
    };
    const flow = { ...makeFlow(), status: "idle" as const, request: null, review: null };
    renderPane(flow, { done: { review, result, at: new Date(2026, 10, 1, 9, 5).getTime() }, onDismiss: vi.fn() });
    const pane = screen.getByRole("region", { name: "Install plan" });
    expect(pane.textContent).not.toContain("Everything is set up.");
    expect(pane.textContent).toContain("Applied. The rest is yours to decide.");
    expect(within(pane.querySelector<HTMLElement>(".plan-left")!).getByRole("listitem").textContent).toContain("could not be cleared: denied");
    expect(within(pane).getByRole("status").textContent).toBe("done at 09:05 · 1 change applied, 1 step left to you");
    cleanup();

    renderPane(flow, { done: { review, result: { ...result, manual_steps: [] }, at: Date.now() }, onDismiss: vi.fn() });
    expect(screen.getByRole("region", { name: "Install plan" }).textContent).toContain("Everything is set up.");
    expect(document.querySelector(".plan-left")).toBeNull();
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
    renderInFrame(<FlowHarness plan={planOf([op("skills", "conflict")])} />);
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
