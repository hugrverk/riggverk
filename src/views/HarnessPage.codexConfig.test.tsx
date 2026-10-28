import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../lib/settingsDraft";
import { renderInFrame } from "../test/renderWithShell";
import {
  installationStatus,
  installScreenOf,
  overviewOf,
  settingsOf,
  skillLoadsOf,
  STATUS_DATA,
  surfaceStatus,
} from "../test/pageFixtures";
import type { AgentTargetMeta, CodexConfigStatus, CodexRuntimeHealth, InstallationState } from "../types";
import { CodexView } from "./CodexView";
import type { HarnessViewProps } from "./pageTypes";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  // The page also reads the harness's security posture; these tests count the commands of the flow under test.
  invoke: (...args: unknown[]) => (args[0] === "get_security_posture" ? Promise.resolve(undefined) : invokeMock(...args)),
}));

const TARGETS: AgentTargetMeta[] = [
  { id: "codex_rules", label: "codex rules", harness: "codex", kind: "rules", target_rel: ".codex/AGENTS.md", source_rel: "templates/codex-rules.md" },
  { id: "codex_config", label: "codex config", harness: "codex", kind: "config", target_rel: ".codex/config.toml", source_rel: "templates/codex/config.toml" },
];

function health(configKept: string[] = []): CodexRuntimeHealth {
  return {
    status: "synced",
    rules_status: "synced",
    skills_status: "synced",
    skills_synced_count: 1,
    skills_expected_count: 1,
    agents_status: "synced",
    bundled_agent_count: 1,
    installed_bundled_agent_count: 1,
    config_status: "synced",
    config_kept: configKept,
    approval_policy: "on-request",
    sandbox_mode: "workspace-write",
    checks: [],
    warnings: [],
    summary: "ok",
    next_action: "",
  } as unknown as CodexRuntimeHealth;
}

const CONFLICT_DETAIL =
  "approvals_reviewer differs from Riggverk's and changed since Riggverk wrote the file, so nothing is written; m keeps your value";

const DIFFERING: CodexConfigStatus = { kept: [], differing: [{ key: "approvals_reviewer", value: "auto_review" }] };
const KEPT: CodexConfigStatus = { kept: [{ key: "approvals_reviewer", value: "auto_review" }], differing: [] };

function overviewWithConfig(state: InstallationState, config: CodexConfigStatus | undefined, detail?: string) {
  const counts = state === "conflict" ? { conflict_count: 1 } : {};
  return overviewOf({
    codex: installationStatus(
      state,
      [surfaceStatus("codex_rules", "current"), { ...surfaceStatus("codex_config", state, detail), ...(config ? { codex_config: config } : {}) }],
      counts,
    ),
  });
}

function props(overrides: Partial<HarnessViewProps> = {}): HarnessViewProps {
  return {
    appSettings: settingsOf({ enabled_target_ids: [...defaultSettings().enabled_target_ids, "codex_config"] }),
    agentTargets: TARGETS,
    settingsSaveStatus: "saved",
    onToggleTarget: vi.fn(),
    skillLoads: skillLoadsOf(),
    overview: overviewOf({}),
    install: installScreenOf(),
    backupRoot: "/tmp/backups",
    rollbackTransactionId: null,
    onRollback: vi.fn(),
    onRefresh: vi.fn(),
    runWorkspaceTask: vi.fn(async () => null) as unknown as HarnessViewProps["runWorkspaceTask"],
    refreshAfterApply: vi.fn(),
    onApplied: vi.fn(),
    wsLog: null,
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    status: STATUS_DATA,
    dataFolderOk: true,
    onClearOutput: vi.fn(),
    ...overrides,
  };
}

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
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

function renderCodex(state: InstallationState, config: CodexConfigStatus | undefined, detail?: string, configKept: string[] = []) {
  const p = props({ overview: overviewWithConfig(state, config, detail) });
  return { p, ...renderInFrame(<CodexView {...p} runtimeHealth={health(configKept)} />) };
}

/** The page: the keys work with focus anywhere in it, and a click on it takes focus. */
function surfaces() {
  return screen.getByRole("region", { name: "Codex" });
}

function focusSurfaces() {
  act(() => surfaces().focus());
}

/** The cell of a surface by its short name ("rules", "config"). */
function surfaceRow(name: string) {
  return surfaces().querySelector<HTMLElement>(`[data-surface="codex_${name}"]`)!;
}

/** Makes a cell the active one, as a click in it does. */
function selectRow(name: string) {
  fireEvent.click(surfaceRow(name));
}

function press(key: string) {
  fireEvent.keyDown(document.activeElement && document.activeElement !== document.body ? document.activeElement : surfaces(), { key });
}

function hint(name: RegExp) {
  if (!surfaces().contains(document.activeElement)) focusSurfaces();
  return within(screen.getByLabelText("Status bar")).queryByRole("button", { name });
}

function mode() {
  return document.querySelector(".statusbar .mode")!.textContent;
}

describe("Codex config keys in the settings cell", () => {
  it("names the differing key and offers keep mine while the config cell is the active one", () => {
    renderCodex("conflict", DIFFERING, CONFLICT_DETAIL);
    // Focus in another cell: the key is not offered.
    selectRow("rules");
    expect(hint(/keep mine/)).toBeNull();
    // The button is there all the same, without the key it would answer to.
    expect(within(surfaceRow("config")).getByRole("button", { name: "Keep mine" }).getAttribute("aria-keyshortcuts")).toBeNull();

    selectRow("config");
    const summary = screen.getByLabelText("Codex config keys");
    expect(summary.textContent).toContain("differs");
    expect(summary.textContent).toContain("approvals_reviewer = auto_review");
    // The state says which key and why; the cell holds a decision that spans the row.
    expect(surfaceRow("config").getAttribute("data-state")).toBe("decide");
    expect(surfaceRow("config").textContent).toContain("approvals_reviewer differs from Riggverk's value");
    expect(within(surfaceRow("config")).getByRole("button", { name: "Keep mine" })).toBeTruthy();
    expect(hint(/keep mine/)).not.toBeNull();
    expect(hint(/hand back/)).toBeNull();
  });

  it("shows a kept key on its cell and in the runtime, and offers hand back", () => {
    renderCodex("current", KEPT, "you keep approvals_reviewer = auto_review; other managed keys follow Riggverk", ["approvals_reviewer"]);
    selectRow("config");
    const row = surfaceRow("config");
    expect(row.querySelector(".state-pill")!.textContent).toBe("Yours");
    expect(row.textContent).toContain("You keep approvals_reviewer");
    const summary = screen.getByLabelText("Codex config keys");
    expect(summary.textContent).toContain("you keep");
    expect(summary.textContent).toContain("the other managed keys follow Riggverk");
    expect(surfaces().textContent).toContain("synced · you keep 1");
    expect(within(row).getByRole("button", { name: "Hand back" })).toBeTruthy();
    expect(hint(/hand back/)).not.toBeNull();
    expect(hint(/keep mine/)).toBeNull();
  });

  it("offers nothing when no enforced key differs and none is kept", () => {
    renderCodex("current", undefined);
    selectRow("config");
    expect(screen.queryByLabelText("Codex config keys")).toBeNull();
    expect(hint(/keep mine/)).toBeNull();
    expect(hint(/hand back/)).toBeNull();
  });
});

describe("keep mine (m)", () => {
  it("asks first, then records the choice with exact args and reloads", async () => {
    const { p } = renderCodex("conflict", DIFFERING, CONFLICT_DETAIL);
    selectRow("config");
    focusSurfaces();
    press("m");
    const dialog = await screen.findByRole("dialog");
    expect(mode()).toBe("CONFIRM");
    expect(dialog.textContent).toContain("approvals_reviewer = auto_review");
    expect(dialog.textContent).toContain("other managed keys keep following Riggverk");
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "keep mine" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_codex_config_kept", { kept: true }));
    await waitFor(() => expect(p.overview.refresh).toHaveBeenCalledTimes(1));
    expect(p.refreshAfterApply).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the confirm is declined", async () => {
    renderCodex("conflict", DIFFERING, CONFLICT_DETAIL);
    selectRow("config");
    focusSurfaces();
    press("m");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(mode()).toBe("NORMAL"));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("hands the kept keys back at once, without a confirm", async () => {
    const { p } = renderCodex("current", KEPT, "you keep approvals_reviewer = auto_review; other managed keys follow Riggverk", ["approvals_reviewer"]);
    selectRow("config");
    focusSurfaces();
    press("m");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_codex_config_kept", { kept: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(p.overview.refresh).toHaveBeenCalledTimes(1));
  });

  it("is a button in the cell too, which asks first and records the same choice", async () => {
    const { p } = renderCodex("conflict", DIFFERING, CONFLICT_DETAIL);
    fireEvent.click(within(surfaceRow("config")).getByRole("button", { name: "Keep mine" }));
    const dialog = await screen.findByRole("dialog");
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "keep mine" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_codex_config_kept", { kept: true }));
    await waitFor(() => expect(p.overview.refresh).toHaveBeenCalledTimes(1));
  });

  it("hands back from the button without a confirm", async () => {
    renderCodex("current", KEPT, "you keep approvals_reviewer = auto_review; other managed keys follow Riggverk", ["approvals_reviewer"]);
    fireEvent.click(within(surfaceRow("config")).getByRole("button", { name: "Hand back" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_codex_config_kept", { kept: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does nothing in another cell, and shows why the backend refused", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "set_codex_config_kept") throw new Error("no enforced key differs from the bundled config; there is nothing to keep");
      return null;
    });
    renderCodex("conflict", DIFFERING, CONFLICT_DETAIL);
    selectRow("rules");
    focusSurfaces();
    press("m");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();

    selectRow("config");
    focusSurfaces();
    press("m");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "keep mine" }));
    expect((await screen.findByRole("alert")).textContent).toContain("nothing to keep");
  });
});
