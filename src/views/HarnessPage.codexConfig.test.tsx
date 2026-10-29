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
  surfaceStatus,
} from "../test/pageFixtures";
import type { ActionResult, AgentTargetMeta, CodexConfigDefaultsPreview, CodexConfigStatus, CodexRuntimeHealth, InstallationState, SetupResult } from "../types";
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

const REVIEWER_EXPECTED = [{ key: "approvals_reviewer", value: "user" }];
const DIFFERING: CodexConfigStatus = { kept: [], differing: [{ key: "approvals_reviewer", value: "auto_review" }], expected: REVIEWER_EXPECTED };
const KEPT: CodexConfigStatus = { kept: [{ key: "approvals_reviewer", value: "auto_review" }], differing: [], expected: REVIEWER_EXPECTED };

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
    onRefresh: vi.fn(),
    runWorkspaceTask: vi.fn(async () => null) as unknown as HarnessViewProps["runWorkspaceTask"],
    refreshAfterApply: vi.fn(),
    onApplied: vi.fn(),
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    dataFolderOk: true,
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
  return within(screen.getByLabelText("Key hints")).queryByRole("button", { name });
}

function table() {
  return screen.getByRole("table", { name: "Managed Codex settings" });
}

/** The rows of the managed-keys table as [key, Riggverk, yours] texts, header left out. */
function tableRows() {
  return within(table())
    .getAllByRole("row")
    .slice(1)
    .map(row => Array.from(row.children).map(cell => cell.textContent));
}

describe("Codex config keys in the settings cell", () => {
  it("shows Riggverk's value against yours per managed key, marks the one that differs and offers keep mine", () => {
    renderCodex("conflict", DIFFERING, CONFLICT_DETAIL);
    // Focus in another cell: the key is not offered.
    selectRow("rules");
    expect(hint(/keep mine/)).toBeNull();
    // The choice is there all the same, without the key it would answer to.
    expect(within(surfaceRow("config")).getByRole("button", { name: "Keep mine" }).getAttribute("aria-keyshortcuts")).toBeNull();

    selectRow("config");
    // Five managed keys; the differing one first with both values, the rest follow Riggverk and carry a check.
    expect(tableRows()).toEqual([
      ["approvals_reviewer", "user", "differs: auto_review"],
      ["approval_policy", "default", "same ✓"],
      ["sandbox_mode", "default", "same ✓"],
      ["apps._default.approvals_reviewer", "default", "same ✓"],
      ["apps._default.default_tools_approval_mode", "default", "same ✓"],
    ]);
    const differing = within(table()).getByRole("row", { name: /approvals_reviewer user/ });
    expect(differing.getAttribute("data-key-state")).toBe("differs");
    expect(differing.querySelector(".is-differs")).not.toBeNull();
    // The why line, the note about the keys that are never compared, and the state that says which key and why.
    expect(surfaceRow("config").textContent).toContain("Riggverk manages 5 keys in this file. One differs from Riggverk's default, so it changed nothing.");
    expect(surfaceRow("config").textContent).toContain("model and model_reasoning_effort are yours after the first install and are never compared.");
    expect(surfaceRow("config").getAttribute("data-state")).toBe("decide");
    expect(surfaceRow("config").textContent).toContain("approvals_reviewer differs from Riggverk's value");
    expect(within(surfaceRow("config")).getByRole("button", { name: "Keep mine" })).toBeTruthy();
    expect(hint(/keep mine/)).not.toBeNull();
    expect(hint(/hand back/)).toBeNull();
  });

  it("offers the two choices as cards with what is promised", () => {
    renderCodex("conflict", DIFFERING, CONFLICT_DETAIL);
    const cards = within(surfaceRow("config")).getByRole("group", { name: "Resolve the Codex config" });
    expect(within(cards).getAllByRole("button").map(card => card.getAttribute("aria-labelledby") && document.getElementById(card.getAttribute("aria-labelledby")!)!.firstChild!.textContent)).toEqual([
      "Keep mine",
      "Use Riggverk defaults",
    ]);
    expect(within(cards).getByRole("button", { name: "Keep mine" }).getAttribute("aria-describedby")).not.toBeNull();
    expect(cards.parentElement!.querySelector(".hp-conseq")!.textContent).toBe("Preview firstBacked upUndo any time");
    expect(cards.textContent).toContain("approvals_reviewer stays as it is. Riggverk still manages the other 4 keys.");
    expect(cards.textContent).toContain("Sets approvals_reviewer to user. Everything else keeps its value and place.");
  });

  it("says Riggverk's value is unknown from a backend that does not send it, and still offers the choices", () => {
    renderCodex("conflict", { kept: [], differing: [{ key: "approvals_reviewer", value: "auto_review" }] }, CONFLICT_DETAIL);
    expect(tableRows()[0]).toEqual(["approvals_reviewer", "unknown", "differs: auto_review"]);
    expect(surfaceRow("config").textContent).toContain("Sets approvals_reviewer to Riggverk’s value.");
  });

  it("shows a kept key on its cell and in the runtime, and offers hand back", () => {
    renderCodex("current", KEPT, "you keep approvals_reviewer = auto_review; other managed keys follow Riggverk", ["approvals_reviewer"]);
    selectRow("config");
    const row = surfaceRow("config");
    expect(row.querySelector(".state-pill")!.textContent).toBe("Yours");
    expect(row.textContent).toContain("You keep approvals_reviewer, so Riggverk never writes it.");
    expect(tableRows()[0]).toEqual(["approvals_reviewer", "user", "auto_review (kept)"]);
    expect(within(table()).getByRole("row", { name: /approvals_reviewer user/ }).getAttribute("data-key-state")).toBe("kept");
    expect(surfaces().textContent).toContain("synced · you keep 1");
    expect(within(row).getByRole("button", { name: "Hand back" })).toBeTruthy();
    // Nothing differs any more: no cards, no way to set Riggverk's defaults.
    expect(within(row).queryByRole("button", { name: "Keep mine" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Use Riggverk defaults" })).toBeNull();
    expect(hint(/hand back/)).not.toBeNull();
    expect(hint(/keep mine/)).toBeNull();
    expect(hint(/use Riggverk defaults/)).toBeNull();
  });

  it("offers nothing when no enforced key differs and none is kept", () => {
    renderCodex("current", undefined);
    selectRow("config");
    expect(screen.queryByRole("table", { name: "Managed Codex settings" })).toBeNull();
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
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

const DEFAULTS_PREVIEW: CodexConfigDefaultsPreview = {
  keys: [{ key: "approvals_reviewer", yours: "auto_review", riggverk: "user" }],
  diff: '- approvals_reviewer = "auto_review"\n+ approvals_reviewer = "user"',
  plan_fingerprint: "fp-codex-defaults-1234567890",
  preview_token: "tok-codex-defaults-1",
};

const DEFAULTS_RESULT: SetupResult = {
  success: true,
  transaction_id: "tx-codex-1",
  applied: ["Codex config"],
  failed: [],
  rolled_back: [],
  manual_steps: [],
  message: "applied 1 · preserved 0 · failed 0 · transaction tx-codex-1 recorded",
};

function taskRunner() {
  const logs: ActionResult[] = [];
  const mock = vi.fn(async (options: { task: () => Promise<unknown>; toActionResult: (r: never) => ActionResult; refresh?: () => unknown }) => {
    const result = await options.task();
    logs.push(options.toActionResult(result as never));
    await options.refresh?.();
    return result;
  });
  return { runWorkspaceTask: mock as unknown as HarnessViewProps["runWorkspaceTask"], mock, logs };
}

function defaultsBackend(overrides: Record<string, () => unknown> = {}) {
  invokeMock.mockImplementation(async (command: string) => {
    const handler = overrides[command];
    if (handler) return handler();
    switch (command) {
      case "preview_codex_config_defaults":
        return DEFAULTS_PREVIEW;
      case "apply_codex_config_defaults":
        return DEFAULTS_RESULT;
      default:
        return null;
    }
  });
}

function renderDefaults() {
  const tasks = taskRunner();
  const p = { ...props({ overview: overviewWithConfig("conflict", DIFFERING, CONFLICT_DETAIL), runWorkspaceTask: tasks.runWorkspaceTask }), tasks };
  return { p, ...renderInFrame(<CodexView {...p} runtimeHealth={health()} />) };
}

function review() {
  return screen.getByRole("region", { name: "Config review" });
}

function keyHints() {
  return within(screen.getByLabelText("Key hints"));
}

describe("use Riggverk defaults (b, y)", () => {
  async function openPreview() {
    defaultsBackend();
    const rendered = renderDefaults();
    fireEvent.click(within(surfaceRow("config")).getByRole("button", { name: "Use Riggverk defaults" }));
    await screen.findByLabelText("Keys set to Riggverk's values");
    return rendered;
  }

  it("previews first: the keys with your value and Riggverk's, a key-only diff, and writes nothing", async () => {
    await openPreview();
    expect(invokeMock).toHaveBeenCalledWith("preview_codex_config_defaults");
    expect(invokeMock).not.toHaveBeenCalledWith("apply_codex_config_defaults", expect.anything());
    expect(review()).toBeTruthy();
    // The review takes the page's place, like the other reviews.
    expect(screen.queryByRole("region", { name: "Codex" })).toBeNull();
    expect(screen.getByLabelText("Keys set to Riggverk's values").textContent).toContain("approvals_reviewerauto_review → user");
    const added = Array.from(review().querySelectorAll(".diff-line.add")).map(row => row.querySelector(".diff-text")!.textContent);
    const removed = Array.from(review().querySelectorAll(".diff-line.remove")).map(row => row.querySelector(".diff-text")!.textContent);
    expect([removed, added]).toEqual([[' approvals_reviewer = "auto_review"'], [' approvals_reviewer = "user"']]);
    expect(review().textContent).toContain("set approvals_reviewer to Riggverk’s value?");
    expect(review().textContent).toContain("Backup:");
  });

  it("opens from the button, from the card and from b, and only while the config cell is the active one", async () => {
    defaultsBackend();
    renderDefaults();
    // b in another cell does nothing, and the hint is not offered there.
    selectRow("rules");
    expect(hint(/use Riggverk defaults/)).toBeNull();
    focusSurfaces();
    press("b");
    expect(invokeMock).not.toHaveBeenCalledWith("preview_codex_config_defaults");

    selectRow("config");
    expect(hint(/use Riggverk defaults/)).not.toBeNull();
    focusSurfaces();
    press("b");
    await screen.findByLabelText("Keys set to Riggverk's values");
    expect(invokeMock).toHaveBeenCalledWith("preview_codex_config_defaults");
  });

  it("applies with exactly the preview's fingerprint and token on y, and reports into the output with the transaction", async () => {
    const { p } = await openPreview();
    press("y");
    await waitFor(() => expect(p.onApplied).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenLastCalledWith("apply_codex_config_defaults", {
      planFingerprint: "fp-codex-defaults-1234567890",
      previewToken: "tok-codex-defaults-1",
    });
    expect(p.onApplied).toHaveBeenCalledWith(DEFAULTS_RESULT);
    expect(p.tasks.mock.mock.calls[0]![0]).toMatchObject({ label: "use Riggverk defaults", action: "apply_codex_config_defaults" });
    await waitFor(() => expect(p.refreshAfterApply).toHaveBeenCalledTimes(1));
    const log = p.tasks.logs[0]!;
    expect(log).toMatchObject({ success: true, action: "apply_codex_config_defaults", exit_code: 0 });
    expect(log.stdout).toContain("set          approvals_reviewer = user");
    // The transaction is the rollback candidate (`z` undoes it).
    expect(log.stdout).toContain("transaction tx-codex-1 recorded · rollback available");
    // The review closes and the page comes back.
    expect(await screen.findByRole("region", { name: "Codex" })).toBeTruthy();
  });

  it("never applies on Enter, and y is also a button", async () => {
    const { p } = await openPreview();
    press("Enter");
    const apply = await within(review()).findByRole("button", { name: /apply/ });
    // A focused Apply button swallows Enter too.
    expect(fireEvent.keyDown(apply, { key: "Enter" })).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("apply_codex_config_defaults", expect.anything());
    fireEvent.click(apply);
    await waitFor(() => expect(p.onApplied).toHaveBeenCalledTimes(1));
  });

  it("cancels with n and Escape and writes nothing", async () => {
    await openPreview();
    press("n");
    expect(invokeMock).not.toHaveBeenCalledWith("apply_codex_config_defaults", expect.anything());
    expect(await screen.findByRole("region", { name: "Codex" })).toBeTruthy();
    fireEvent.click(within(surfaceRow("config")).getByRole("button", { name: "Use Riggverk defaults" }));
    await screen.findByLabelText("Keys set to Riggverk's values");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(await screen.findByRole("region", { name: "Codex" })).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith("apply_codex_config_defaults", expect.anything());
  });

  it("keeps a rejected apply (stale fingerprint) in the review, reports it in the output, and previews again on r", async () => {
    let previews = 0;
    defaultsBackend({
      preview_codex_config_defaults: () => ({ ...DEFAULTS_PREVIEW, preview_token: `tok-${++previews}` }),
      apply_codex_config_defaults: () => {
        throw new Error("Plan fingerprint mismatch: the config changed after preview. Re-run preview before applying.");
      },
    });
    const { p } = renderDefaults();
    fireEvent.click(within(surfaceRow("config")).getByRole("button", { name: "Use Riggverk defaults" }));
    await screen.findByLabelText("Keys set to Riggverk's values");
    press("y");
    expect((await screen.findByRole("alert")).textContent).toContain("Plan fingerprint mismatch");
    expect(p.onApplied).not.toHaveBeenCalled();
    expect(p.tasks.logs[0]).toMatchObject({ success: false, action: "apply_codex_config_defaults" });
    expect(p.tasks.logs[0]!.stderr).toContain("Plan fingerprint mismatch");
    expect(review().textContent).toContain("Nothing was written; preview again");
    press("r");
    await screen.findByLabelText("Keys set to Riggverk's values");
    expect(previews).toBe(2);
  });

  it("shows a failed preview with a way to try again, and nothing was written", async () => {
    let attempts = 0;
    defaultsBackend({
      preview_codex_config_defaults: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("no enforced key differs from the bundled config; there is nothing to reset");
        return DEFAULTS_PREVIEW;
      },
    });
    renderDefaults();
    fireEvent.click(within(surfaceRow("config")).getByRole("button", { name: "Use Riggverk defaults" }));
    expect((await screen.findByRole("alert")).textContent).toContain("nothing to reset");
    expect(review().textContent).toContain("Nothing was written.");
    fireEvent.click(within(review()).getByRole("button", { name: /try again/ }));
    await screen.findByLabelText("Keys set to Riggverk's values");
    expect(invokeMock).not.toHaveBeenCalledWith("apply_codex_config_defaults", expect.anything());
  });

  it("waits for a running task before it applies", async () => {
    const { p, rerenderFrame } = await openPreview();
    rerenderFrame(<CodexView {...p} wsRunning="uninstall" runtimeHealth={health()} />);
    const apply = keyHints().getByRole("button", { name: /apply/ });
    expect(apply.getAttribute("title")).toBe("uninstall is running");
    press("y");
    expect(invokeMock).not.toHaveBeenCalledWith("apply_codex_config_defaults", expect.anything());
  });

  it("waits for a running task before it even previews, with the reason on the card", () => {
    defaultsBackend();
    const tasks = taskRunner();
    const p = props({ overview: overviewWithConfig("conflict", DIFFERING, CONFLICT_DETAIL), runWorkspaceTask: tasks.runWorkspaceTask, wsRunning: "update codex" });
    renderInFrame(<CodexView {...p} runtimeHealth={health()} />);
    const card = within(surfaceRow("config")).getByRole("button", { name: "Use Riggverk defaults" });
    expect(card.getAttribute("aria-disabled")).toBe("true");
    expect(card.getAttribute("title")).toBe("update codex is running");
    fireEvent.click(card);
    expect(invokeMock).not.toHaveBeenCalledWith("preview_codex_config_defaults");
  });
});
