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
import type { InstallAgent } from "../types";
import { StartView, type StartViewProps } from "./StartView";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected invoke");
  }),
}));

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
    onReleaseCheck: vi.fn(),
    backupCount: 2,
    onOpenBackupsFolder: vi.fn(),
    wsLog: null,
    wsLogCompletedAt: null,
    wsRunning: null,
    status: STATUS_DATA,
    workspaceValid: true,
    gitAvailable: true,
    canRunReleaseCheck: true,
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

/** A key hint of the focused pane: hints live in the status bar, not in the panes. */
function hint(name: RegExp) {
  return within(screen.getByLabelText("Status bar")).getByRole("button", { name });
}

describe("StartView panes", () => {
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

  it("lists the surfaces of the harness under the cursor with a glyph and a state word each", () => {
    renderStart();
    for (let i = 0; i < 4; i++) press("j");
    expect(rowOf(harnessList(), "claude").getAttribute("aria-selected")).toBe("true");
    const surfaces = screen.getByRole("listbox", { name: "claude surfaces" });
    const rows = within(surfaces).getAllByRole("option");
    expect(rows.map(row => row.querySelector(".meta")!.textContent!.trim())).toEqual(["◐ update", "● current", "✗ conflict"]);
    expect(rows[0]!.textContent).toContain("bundle a7c3e1 → installed 91be20");
  });

  it("shows surfaces whose target toggle is off as off", () => {
    renderStart({ appSettings: settingsOf() });
    press("j");
    expect(rowOf(harnessList(), "codex").getAttribute("aria-selected")).toBe("true");
    const surfaces = screen.getByRole("listbox", { name: "codex surfaces" });
    const config = within(surfaces).getAllByRole("option").find(row => row.textContent!.includes("config"))!;
    expect(config.querySelector(".meta")!.textContent!.trim()).toBe("· off");
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
    renderStart({ rollbackTransactionId: "1710000000000", wsLog: { success: true, action: "release_check", stdout: "ok", stderr: "", exit_code: 0 }, wsLogCompletedAt: Date.now() });
    const status = screen.getByRole("region", { name: "Status" });
    expect(within(status).getByLabelText("workspace status").textContent).toContain("current");
    expect(within(status).getByLabelText("workspace status").textContent).toContain("/tmp/workspace");
    const verify = within(status).getByLabelText("Verification and backups");
    expect(verify.textContent).toContain("release-check");
    expect(verify.textContent).toContain("ok");
    expect(verify.textContent).toContain("2 runs · /tmp/backups");
    expect(verify.textContent).toContain("1710000000000 · rollback available");
  });

  it("shows the output pane with the rollback key when a transaction can be rolled back", () => {
    const onRollback = vi.fn();
    renderStart({ rollbackTransactionId: "1710000000000", onRollback });
    act(() => screen.getByRole("group", { name: "Output" }).focus());
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

  it("Enter opens a harness page, and on the workspace row drills into the surfaces pane", () => {
    const { props: p } = renderStart();
    act(() => harnessList().focus());
    press("Enter");
    expect(p.onNavigate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "workspace surfaces" }));
    act(() => harnessList().focus());
    press("j");
    press("Enter");
    expect(p.onNavigate).toHaveBeenCalledWith("codex");
  });

  it("runs the release check, opens the folder and the backups from the status pane", () => {
    const { props: p } = renderStart();
    const status = screen.getByRole("region", { name: "Status" });
    const body = status.querySelector(".pane-body")!;
    act(() => (body as HTMLElement).focus());
    fireEvent.keyDown(body, { key: "R", shiftKey: true });
    fireEvent.keyDown(body, { key: "o" });
    fireEvent.keyDown(body, { key: "B", shiftKey: true });
    expect(p.onReleaseCheck).toHaveBeenCalledTimes(1);
    expect(p.onOpenFolder).toHaveBeenCalledTimes(1);
    expect(p.onOpenBackupsFolder).toHaveBeenCalledTimes(1);
  });

  it("refreshes with r", () => {
    const { props: p } = renderStart();
    press("r");
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("StartView install review", () => {
  it("shows the plan and the output instead of the four panes while the review is open", () => {
    const flow = flowOf([op("workspace_bundle", "update")], { label: "update workspace", surfaces: ["workspace_bundle"] });
    renderStart({ install: installScreenOf(flow, "start") });
    expect(screen.getByRole("grid", { name: "Install plan" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Output" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Harnesses" })).toBeNull();
    expect(screen.getByRole("region", { name: "Workspace install review" })).toBeTruthy();
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
