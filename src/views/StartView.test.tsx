import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import {
  flowOf,
  INVALID_DIAGNOSTICS,
  installationStatus,
  installScreenOf,
  op,
  overviewOf,
  settingsOf,
  STATUS_DATA,
  surfaceStatus,
  VALID_DIAGNOSTICS,
} from "../test/pageFixtures";
import type { ApplyProgress, InstallAgent } from "../types";
import { StartView, type StartViewProps } from "./StartView";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected invoke");
  }),
}));

const outputStripProps = vi.fn();

// The real strip, with its props recorded: the pages must hand it the backend's progress.
vi.mock("../components/OutputStrip", async importOriginal => {
  const actual = await importOriginal<typeof import("../components/OutputStrip")>();
  return {
    ...actual,
    OutputStrip: (stripProps: Parameters<typeof actual.OutputStrip>[0]) => {
      outputStripProps(stripProps);
      return <actual.OutputStrip {...stripProps} />;
    },
  };
});

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

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
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

const ALL: InstallAgent[] = ["codex", "opencode", "claude", "cursor"];

const OVERVIEW = overviewOf({
  workspace: installationStatus("current", [surfaceStatus("workspace_bundle", "current", "installed · a7c3e1")]),
  codex: installationStatus("current", [
    surfaceStatus("codex_rules", "current"),
    surfaceStatus("codex_skills", "current"),
  ]),
  opencode: installationStatus("update_available", [surfaceStatus("open_code_config", "update_available")], { update_count: 2 }),
  claude: installationStatus(
    "update_available",
    [
      surfaceStatus("claude_rules", "update_available", "bundle a7c3e1 → installed 91be20"),
      surfaceStatus("claude_agents", "current"),
      surfaceStatus("claude_skills", "conflict", "modified locally since install"),
    ],
    { update_count: 1, conflict_count: 1 },
    { conflict_details: ["~/.claude/skills modified locally"] },
  ),
  cursor: installationStatus("conflict", [surfaceStatus("cursor_mcp", "conflict")], { conflict_count: 1 }),
});

function props(overrides: Partial<StartViewProps> = {}): StartViewProps {
  return {
    workspaceDiagnostics: VALID_DIAGNOSTICS,
    appSettings: settingsOf(),
    enabledHarnessIds: ALL,
    onNavigate: vi.fn(),
    overview: OVERVIEW,
    install: installScreenOf(),
    backupRoot: "/tmp/backups",
    rollbackTransactionId: null,
    onRollback: vi.fn(),
    onRefresh: vi.fn(),
    onUninstall: vi.fn(),
    uninstallRecoveryTransactionId: null,
    onUninstallRollback: vi.fn(async () => false),
    uninstallPreviewRequested: false,
    onUninstallPreviewHandled: vi.fn(),
    onOpenFolder: vi.fn(),
    backupCount: 2,
    onOpenBackupsFolder: vi.fn(),
    wsLog: null,
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    status: STATUS_DATA,
    workspaceValid: true,
    gitAvailable: true,
    onClearOutput: vi.fn(),
    ...overrides,
  };
}

function renderStart(overrides: Partial<StartViewProps> = {}) {
  const merged = props(overrides);
  return { props: merged, ...renderInFrame(<StartView {...merged} />) };
}

function harnessList() {
  return screen.getByRole("listbox", { name: "Harnesses" });
}

function rowOf(list: HTMLElement, name: string) {
  return within(list).getAllByRole("option").find(option => option.textContent!.includes(name))!;
}

function press(key: string, target: Element = harnessList()) {
  fireEvent.keyDown(target, { key });
}

/** The detail pane of the row under the cursor ("workspace detail", "claude detail", ...). */
function detail(name = "workspace") {
  return screen.getByRole("region", { name: `${name} detail` });
}

/** A key hint of the focused pane: hints live in the status bar, not in the panes. */
function hint(name: RegExp) {
  return within(screen.getByLabelText("Status bar")).getByRole("button", { name });
}

describe("StartView panes", () => {
  it("is a list, the detail of its cursor row and the output strip, without a prose note", () => {
    const { container } = renderStart();
    const screenEl = screen.getByRole("region", { name: "Workspace" });
    expect(screenEl.classList.contains("pair")).toBe(true);
    expect([...screenEl.children].map(child => child.getAttribute("data-pane-id"))).toEqual(["harnesses", "detail", "output"]);
    expect(screen.getByRole("region", { name: "Harnesses" })).toBeTruthy();
    expect(detail()).toBeTruthy();
    expect(screen.getByRole("region", { name: "Output" })).toBeTruthy();
    // The detail is one scroll, not a second listbox, and the old surfaces and status panes are gone.
    expect(screen.queryByRole("listbox", { name: /surfaces/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Surfaces" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Status" })).toBeNull();
    expect(container.textContent).not.toContain("Install and update one local workspace");
    expect(container.querySelector(".pane-note")).toBeNull();
  });

  it("shows the workspace and the enabled harnesses with their installation state", () => {
    renderStart({ enabledHarnessIds: ["codex", "claude", "cursor"] });
    const rows = within(harnessList()).getAllByRole("option");
    expect(rows.map(row => row.textContent!.replace("▸", "").trim())).toEqual([
      "workspacecurrent",
      "codexcurrent",
      "cursor1 conflict",
      "claude1 to update · 1 conflict",
    ]);
    expect(screen.getByRole("region", { name: "Harnesses" }).querySelector(".pane-title")!.textContent).toContain("· 4");
  });

  it("follows the cursor: the detail pane shows the surfaces of the row under it, a state word each", () => {
    renderStart();
    const workspace = detail();
    expect(workspace.querySelector(".pane-title")!.textContent).toBe("workspace · current");
    for (let i = 0; i < 4; i++) press("j");
    expect(rowOf(harnessList(), "claude").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("region", { name: "workspace detail" })).toBeNull();
    const claude = detail("claude");
    expect(claude.querySelector(".pane-title")!.textContent).toBe("claude · 1 to update · 1 conflict");
    expect(claude.querySelector(".pane-title .c-fail")!.textContent).toBe("1 to update · 1 conflict");
    const rows = within(within(claude).getByRole("list", { name: "claude surfaces" })).getAllByRole("listitem");
    expect(rows.map(row => row.querySelector(".meta")!.textContent)).toEqual(["update", "current", "conflict"]);
    expect(rows[0]!.textContent).toContain("bundle a7c3e1 → installed 91be20");
    // One state signal per row: the word in its tone colour, no glyph.
    expect(rows.map(row => row.querySelector(".meta")!.className)).toEqual(["meta c-warn", "meta c-ok", "meta c-fail"]);
    expect(claude.querySelector(".rows .g")).toBeNull();
  });

  it("shows surfaces whose target toggle is off as off", () => {
    renderStart({ appSettings: settingsOf() });
    press("j");
    expect(rowOf(harnessList(), "codex").getAttribute("aria-selected")).toBe("true");
    const surfaces = within(detail("codex")).getByRole("list", { name: "codex surfaces" });
    const config = within(surfaces).getAllByRole("listitem").find(row => row.textContent!.includes("config"))!;
    expect(config.querySelector(".meta")!.textContent).toBe("off");
    expect(config.textContent).toContain("target codex_config is off");
  });

  it("draws the installed map with a text label per cell", () => {
    renderStart();
    const matrix = screen.getByRole("table", { name: "Installed surfaces" });
    const claude = within(matrix).getByRole("rowheader", { name: "claude" }).parentElement!;
    const cells = within(claude).getAllByRole("cell").map(cell => cell.querySelector(".visually-hidden")!.textContent);
    expect(cells).toEqual(["n/a", "current", "update", "conflict", "n/a", "n/a"]);
  });

  it("shows status, verification and the last transaction for the selected target", () => {
    renderStart({ rollbackTransactionId: "1710000000000" });
    const pane = detail();
    // The state is the title's ("workspace · current"); the status rows add the path.
    expect(pane.querySelector(".pane-title")!.textContent).toContain("workspace · current");
    expect(within(pane).getByLabelText("workspace status").textContent).not.toContain("current");
    expect(within(pane).getByLabelText("workspace status").textContent).toContain("/tmp/workspace");
    const verify = within(pane).getByLabelText("Verification and backups");
    expect(verify.textContent).toContain("2 runs · /tmp/backups");
    expect(verify.textContent).toContain("1710000000000 · rollback available");
  });

  it("leaves the status group out when the title already says everything", () => {
    renderStart();
    for (let i = 0; i < 3; i++) press("j");
    // Cursor: no changes, no error, no preserved files, no rules file. The title carries its state.
    const cursor = detail("cursor");
    expect(cursor.querySelector(".pane-title")!.textContent).toBe("cursor · 1 conflict");
    expect(within(cursor).queryByLabelText("cursor status")).toBeNull();
    expect([...cursor.querySelectorAll(".group")].map(group => group.textContent)).toEqual(["surfaces", "verify", "lifecycle"]);
  });

  it("adds the backend's change breakdown only for an update, without its prefix", () => {
    const update = installationStatus("update_available", [], { create_count: 5, update_count: 165, remove_count: 3 }, {
      summary: "Update available: 5 to create, 165 to update, 3 to remove",
    });
    renderStart({ overview: overviewOf({ workspace: update }) });
    const status = within(detail()).getByLabelText("workspace status");
    expect(status.textContent).toContain("changes5 to create, 165 to update, 3 to remove");
    expect(status.textContent).not.toContain("Update available");
    cleanup();
    renderStart({ overview: overviewOf({ workspace: installationStatus("conflict", [], { conflict_count: 2 }) }) });
    expect(within(detail()).getByLabelText("workspace status").textContent).not.toContain("changes");
  });

  it("offers the rollback key on the output strip when a transaction can be rolled back", () => {
    const onRollback = vi.fn();
    renderStart({ rollbackTransactionId: "1710000000000", onRollback });
    act(() => within(screen.getByRole("region", { name: "Output" })).getByRole("button").focus());
    fireEvent.click(hint(/rollback/));
    expect(onRollback).toHaveBeenCalledTimes(1);
  });
});

describe("StartView keys", () => {
  it("opens the install review for the harness under the cursor with u and a read-only preview with p", () => {
    const { props: p } = renderStart();
    for (let i = 0; i < 4; i++) press("j");
    press("u");
    // The review of a harness started here stays on the workspace page.
    expect(p.install.open).toHaveBeenCalledWith("claude", { scope: "start" });
    press("p");
    expect(p.install.open).toHaveBeenLastCalledWith("claude", { readOnly: true, scope: "start" });
  });

  it("offers an update key for the workspace row and labels it after the state", () => {
    const { props: p } = renderStart({ overview: overviewOf({ workspace: installationStatus("update_available", [], { update_count: 1 }) }) });
    const list = harnessList();
    act(() => list.focus());
    expect(hint(/update/)).toBeTruthy();
    press("u", list);
    expect(p.install.open).toHaveBeenCalledWith("workspace", { scope: "start" });
  });

  it("does not offer an update for a target that is already current, and explains why", () => {
    const { props: p } = renderStart();
    act(() => harnessList().focus());
    press("u");
    expect(p.install.open).not.toHaveBeenCalled();
    const update = hint(/update/);
    expect(update.getAttribute("aria-disabled")).toBe("true");
    expect(update.getAttribute("title")).toMatch(/already current/);
  });

  it("lets the workspace be installed while it is invalid, but nothing else", () => {
    const { props: p } = renderStart({ workspaceDiagnostics: INVALID_DIAGNOSTICS, workspaceValid: false, overview: overviewOf({}) });
    act(() => harnessList().focus());
    expect(hint(/install/)).toBeTruthy();
    press("u");
    expect(p.install.open).toHaveBeenCalledWith("workspace", { scope: "start" });
    press("j");
    press("u");
    expect(p.install.open).toHaveBeenCalledTimes(1);
    expect(rowOf(harnessList(), "codex").textContent).toContain("needs workspace");
  });

  it("Enter opens a harness page, and on the workspace row moves focus to the detail pane", () => {
    const { props: p } = renderStart();
    act(() => harnessList().focus());
    press("Enter");
    expect(p.onNavigate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(detail()).getByRole("group", { name: "workspace detail" }));
    act(() => harnessList().focus());
    press("j");
    press("Enter");
    expect(p.onNavigate).toHaveBeenCalledWith("codex");
  });

  it("offers the folder and the backups while the detail pane has focus", () => {
    const { props: p } = renderStart();
    const body = within(detail()).getByRole("group", { name: "workspace detail" });
    act(() => body.focus());
    fireEvent.click(hint(/open folder/));
    fireEvent.click(hint(/backups/));
    expect(p.onOpenFolder).toHaveBeenCalledTimes(1);
    expect(p.onOpenBackupsFolder).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(body, { key: "o" });
    fireEvent.keyDown(body, { key: "B", shiftKey: true });
    expect(p.onOpenFolder).toHaveBeenCalledTimes(2);
    expect(p.onOpenBackupsFolder).toHaveBeenCalledTimes(2);
  });

  it("does not offer those keys while the harness list has focus, but offers update, preview and refresh on both panes", () => {
    renderStart({ overview: overviewOf({ workspace: installationStatus("update_available", [], { update_count: 1 }) }) });
    act(() => harnessList().focus());
    expect(within(screen.getByLabelText("Status bar")).queryByRole("button", { name: /open folder/ })).toBeNull();
    expect(hint(/preview/)).toBeTruthy();
    expect(hint(/refresh/)).toBeTruthy();
    act(() => within(detail()).getByRole("group", { name: "workspace detail" }).focus());
    expect(hint(/update/)).toBeTruthy();
    expect(hint(/preview/)).toBeTruthy();
    expect(hint(/refresh/)).toBeTruthy();
  });

  it("refreshes with r", () => {
    const { props: p } = renderStart();
    press("r");
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("StartView install review", () => {
  it("shows the plan and the output strip instead of the two panes while the review is open", () => {
    const flow = flowOf([op("workspace_bundle", "update")], { label: "update workspace", surfaces: ["workspace_bundle"] });
    renderStart({ install: installScreenOf(flow, "start") });
    expect(screen.getByRole("grid", { name: "Install plan" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Output" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Harnesses" })).toBeNull();
    expect(screen.queryByRole("region", { name: "workspace detail" })).toBeNull();
    const review = screen.getByRole("region", { name: "Workspace install review" });
    expect(review.classList.contains("review")).toBe(true);
    expect([...review.children].map(child => child.getAttribute("data-pane-id"))).toEqual(["plan", "output"]);
  });

  it("hands apply to the install screen when y is pressed", () => {
    const flow = flowOf([op("workspace_bundle", "update")], { label: "update workspace", surfaces: ["workspace_bundle"] });
    const install = installScreenOf(flow, "start");
    renderStart({ install });
    fireEvent.keyDown(screen.getByRole("grid", { name: "Install plan" }), { key: "y" });
    expect(install.apply).toHaveBeenCalledTimes(1);
  });

  it("does not show a review that belongs to another page", () => {
    const flow = flowOf([op("claude_rules", "update")]);
    renderStart({ install: installScreenOf(flow, "claude") });
    expect(screen.queryByRole("grid", { name: "Install plan" })).toBeNull();
    expect(harnessList()).toBeTruthy();
  });
});

describe("StartView uninstall recovery", () => {
  it("does not render recovery without a transaction candidate", () => {
    renderStart({ uninstallRecoveryTransactionId: null });
    expect(screen.queryByRole("region", { name: /recover previous uninstall/i })).toBeNull();
  });

  it("renders recovery when a transaction candidate exists", () => {
    renderStart({ uninstallRecoveryTransactionId: "1710000000000" });
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
  });

  it("keeps showing recovery after the workspace became valid again", () => {
    renderStart({ workspaceValid: true, uninstallRecoveryTransactionId: "1710000000000" });
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
  });

  it("shows recovery while the workspace is still gone, which is when it is needed", () => {
    renderStart({
      workspaceDiagnostics: INVALID_DIAGNOSTICS,
      workspaceValid: false,
      overview: overviewOf({}),
      uninstallRecoveryTransactionId: "1710000000000",
    });
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
  });

  it("offers the uninstall preview only for a valid workspace", () => {
    renderStart();
    expect(screen.getByRole("region", { name: "Uninstall" })).toBeTruthy();
  });
});

describe("StartView output strip progress", () => {
  const progress: ApplyProgress = {
    task: "apply_setup",
    phase: "apply",
    done: 4,
    total: 7,
    file: "~/.claude/skills/handoff/SKILL.md",
  };

  beforeEach(() => outputStripProps.mockClear());

  it("hands the backend's progress to the strip", () => {
    renderStart({ wsRunning: "update claude", wsProgress: progress });
    expect(outputStripProps).toHaveBeenLastCalledWith(expect.objectContaining({ progress }));
  });

  it("hands it null until the backend reports", () => {
    renderStart({ wsRunning: "update claude", wsProgress: null });
    expect(outputStripProps).toHaveBeenLastCalledWith(expect.objectContaining({ progress: null }));
  });
});

describe("StartView live counters", () => {
  afterEach(() => {
    delete document.documentElement.dataset.motion;
  });

  const UPDATED = {
    ...OVERVIEW,
    entries: {
      ...OVERVIEW.entries,
      opencode: {
        ...OVERVIEW.entries.opencode!,
        status: installationStatus("current", [surfaceStatus("open_code_config", "current")]),
      },
    },
  };

  function renderChanging() {
    const first = props();
    const view = renderInFrame(<StartView {...first} />);
    return {
      ...view,
      applyUpdate: () => view.rerenderFrame(<StartView {...first} overview={UPDATED} />),
    };
  }

  it("rolls a row's meta when its state changes, and no other row", () => {
    document.documentElement.dataset.motion = "full";
    const { applyUpdate } = renderChanging();
    const before = rowOf(harnessList(), "opencode").querySelector(".meta")!.textContent;
    expect(harnessList().querySelector(".roll-old")).toBeNull();
    applyUpdate();
    expect(harnessList().querySelectorAll(".roll-old")).toHaveLength(1);
    expect(rowOf(harnessList(), "opencode").querySelector(".roll-old")!.textContent).toBe(before);
    expect(rowOf(harnessList(), "opencode").querySelector(".roll-new")!.textContent).toBe("current");
  });

  it("swaps the meta instantly when motion is off", () => {
    document.documentElement.dataset.motion = "off";
    const { applyUpdate } = renderChanging();
    applyUpdate();
    expect(harnessList().querySelector(".roll-old")).toBeNull();
    expect(rowOf(harnessList(), "opencode").querySelector(".meta")!.textContent).toBe("current");
  });

  it("does not roll the detail title when the cursor moves to another harness", () => {
    document.documentElement.dataset.motion = "full";
    renderStart();
    press("j");
    press("j");
    expect(screen.getByRole("region", { name: "opencode detail" })).toBeTruthy();
    expect(document.querySelector(".roll-old")).toBeNull();
  });
});
