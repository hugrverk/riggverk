import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import {
  CLEAN_CODEX,
  flowOf,
  INVALID_DIAGNOSTICS,
  installationStatus,
  installScreenOf,
  op,
  overviewOf,
  RISKY_CLAUDE,
  settingsOf,
  surfaceStatus,
  VALID_DIAGNOSTICS,
} from "../test/pageFixtures";
import type { ApplyProgress, CodexRuntimeHealth, FilesStatus, InstallAgent, SecurityPosture, SetupHistoryEntry } from "../types";
import { OverviewView, type OverviewViewProps } from "./OverviewView";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

let postures: Partial<Record<InstallAgent, SecurityPosture>> = {};
let history: SetupHistoryEntry[] = [];

beforeEach(() => {
  postures = {};
  history = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: { harness?: InstallAgent }) => {
    if (command === "get_security_posture") {
      const posture = postures[args!.harness!];
      if (posture) return posture;
    }
    if (command === "list_setup_history") return history;
    throw new Error(`unexpected invoke ${command}`);
  });
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

const RULES_CONFLICT = {
  layout: "legacy" as const,
  refinement_lines: 0,
  conflict_reason: "legacy_diverged" as const,
  user_managed: false,
};

const OVERVIEW = overviewOf({
  workspace: installationStatus("current", [surfaceStatus("workspace_bundle", "current", "none")]),
  codex: installationStatus("current", [surfaceStatus("codex_rules", "current"), surfaceStatus("skills", "current")]),
  opencode: installationStatus("update_available", [surfaceStatus("open_code_config", "update_available", "2 to update")], { update_count: 2 }),
  claude: installationStatus(
    "conflict",
    [
      { ...surfaceStatus("claude_rules", "conflict", "rules detail"), rules: RULES_CONFLICT },
      surfaceStatus("claude_agents", "current"),
      surfaceStatus("skills", "current"),
    ],
    { conflict_count: 1 },
  ),
  cursor: installationStatus("update_available", [surfaceStatus("cursor_agents", "update_available")], { update_count: 1 }),
});

function props(overrides: Partial<OverviewViewProps> = {}): OverviewViewProps {
  return {
    workspaceDiagnostics: VALID_DIAGNOSTICS,
    appSettings: settingsOf({ enabled_harness_ids: ALL, enabled_target_ids: ["codex_rules", "claude_rules", "claude_agents", "opencode_config", "cursor_setup"] }),
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
    onUndo: vi.fn(),
    wsLog: null,
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    dataFolderOk: true,
    onClearOutput: vi.fn(),
    ...overrides,
  };
}

function renderOverview(overrides: Partial<OverviewViewProps> = {}) {
  const merged = props(overrides);
  return { props: merged, ...renderInFrame(<OverviewView {...merged} />) };
}

function page() {
  return screen.getByRole("region", { name: "Overview" });
}

function cell(name: string) {
  return within(page()).getByRole("button", { name }).closest("article")!;
}

/** A key hint of the focused page: hints live as a key hint, not in the page. */
function hint(name: RegExp) {
  return within(screen.getByLabelText("Key hints")).getByRole("button", { name });
}

function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(page(), { key, ...init });
}

describe("Overview header", () => {
  it("answers in a short sentence and counts only the states that are not zero", () => {
    renderOverview();
    expect(screen.getByRole("heading", { name: "Your setup works." })).toBeTruthy();
    const counts = screen.getByRole("list", { name: "Counts by state" });
    const lines = within(counts).getAllByRole("listitem").map(item => item.textContent);
    expect(lines).toEqual(expect.arrayContaining(["4 up to date", "2 updates ready", "1 needs your decision"]));
    // Fix by hand, yours and similar are zero here: they are not shown, dimmed or otherwise.
    expect(lines.join(" ")).not.toMatch(/fix by hand|yours/);
    expect(lines.join(" ")).not.toMatch(/\b0 /);
  });

  it("says when the status was read and that nothing was written", () => {
    renderOverview({ checkedAt: new Date(2026, 9, 28, 15, 42) });
    expect(within(screen.getByRole("list", { name: "Counts by state" })).getByText("Checked 15:42, nothing written")).toBeTruthy();
  });

  it("says everything is set up when nothing waits for a decision, a fix or an update", () => {
    const current = installationStatus("current", [surfaceStatus("codex_rules", "current"), surfaceStatus("skills", "current")]);
    renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, codex: current }), enabledHarnessIds: ["codex"] });
    expect(screen.getByRole("heading", { name: "Everything is set up." })).toBeTruthy();
  });

  it("says nothing is set up yet on a fresh profile", () => {
    const fresh = installationStatus("not_installed", [surfaceStatus("codex_rules", "not_installed"), surfaceStatus("skills", "not_installed")]);
    renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, codex: fresh }), enabledHarnessIds: ["codex"] });
    expect(screen.getByRole("heading", { name: "Nothing is set up yet." })).toBeTruthy();
  });

  it("names an unusable folder and counts it as the one thing to fix", () => {
    renderOverview({ workspaceDiagnostics: INVALID_DIAGNOSTICS, dataFolderOk: false, overview: overviewOf({}) });
    expect(screen.getByRole("heading", { name: "Riggverk can't use its folder." })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Counts by state" })).getByText(/to fix by hand/)).toBeTruthy();
  });
});

describe("Overview agent cells", () => {
  it("has one cell per enabled agent with its state in a pill and in words, and the decision first among the signals", () => {
    renderOverview();
    const claude = cell("Claude");
    expect(within(claude).getByText("1 to decide")).toBeTruthy();
    expect(claude.getAttribute("data-state")).toBe("decide");
    const rows = within(within(claude).getByRole("list", { name: "Claude surfaces" })).getAllByRole("listitem").map(row => row.textContent);
    expect(rows).toEqual(["Rulesneeds decision", "Agentsup to date", "Skillsup to date", "Settingsnot managed"]);
    expect(within(claude).getByText("Your file differs from every shipped version")).toBeTruthy();
    expect(within(cell("Codex")).getByText("Up to date")).toBeTruthy();
    expect(within(cell("OpenCode")).getByText("Update ready")).toBeTruthy();
    expect(within(page()).queryByRole("button", { name: "Copilot" })).toBeNull();
  });

  it("opens an agent's page from its name", () => {
    const { props: p } = renderOverview();
    fireEvent.click(within(page()).getByRole("button", { name: "Codex" }));
    expect(p.onNavigate).toHaveBeenCalledWith("codex");
  });

  it("tells a rules file the user manages as yours, not as current", () => {
    const managed = installationStatus("current", [{ ...surfaceStatus("claude_rules", "current"), rules: { ...RULES_CONFLICT, user_managed: true } }]);
    renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, claude: managed }), enabledHarnessIds: ["claude"] });
    expect(within(cell("Claude")).getByText("Yours")).toBeTruthy();
    expect(within(cell("Claude")).getByText("You manage this file; base updates are waiting")).toBeTruthy();
  });

  it("tells skill files in conflict as a decision on the agent that shows them", () => {
    const files: FilesStatus = {
      conflicts: 1,
      kept: 0,
      kept_updates: 0,
      units: [
        {
          key: "skill:claude:tdd",
          kind: "skill",
          name: "tdd",
          folder: "~/.claude/skills",
          wanted: true,
          state: "conflict",
          reason: "edited",
          bundle_changed: false,
          read_by: ["Claude"],
          files: [{ rel: "SKILL.md", state: "conflict", reason: "edited", bundle_changed: false }],
          more_files: 0,
        },
      ],
      more: 0,
    };
    const status = installationStatus("conflict", [{ ...surfaceStatus("skills", "conflict"), files }], { conflict_count: 1 });
    renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, claude: status }), enabledHarnessIds: ["claude"] });
    expect(within(cell("Claude")).getByText("1 to decide")).toBeTruthy();
    expect(within(cell("Claude")).getByText("1 file you edited")).toBeTruthy();
  });

  it("warns on the Codex cell when AGENTS.override.md replaces AGENTS.md, and nowhere else", () => {
    const health = {
      checks: [{ id: "rules_override", label: "AGENTS.override.md replaces AGENTS.md", status: "warn", detail: "the Riggverk base block is not loaded until it is removed or emptied" }],
    } as unknown as CodexRuntimeHealth;
    renderOverview({ runtimeHealth: { codex: { harness: "codex", health } } });
    expect(within(cell("Codex")).getByRole("alert").textContent).toContain("AGENTS.override.md replaces AGENTS.md");
    expect(within(cell("Claude")).queryByRole("alert")).toBeNull();
  });

  it("adds a runtime sentence for an up to date agent whose runtime diverged", () => {
    const diverged = { harness: "claude" as const, health: { rules_synced: false, agents_synced: true, skills_synced: true } as never };
    const current = installationStatus("current", [surfaceStatus("claude_rules", "current"), surfaceStatus("claude_agents", "current"), surfaceStatus("skills", "current")]);
    renderOverview({
      overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, claude: current }),
      enabledHarnessIds: ["claude"],
      runtimeHealth: { claude: diverged },
    });
    expect(within(cell("Claude")).getByText("Up to date")).toBeTruthy();
    expect(within(cell("Claude")).getByText("Runtime check: diverged")).toBeTruthy();
  });

  it("lists the agents that are off and leads to Settings", () => {
    const { props: p } = renderOverview({ enabledHarnessIds: ["codex", "claude"] });
    const more = screen.getByRole("region", { name: "Agents that are off" });
    expect(more.textContent).toContain("OpenCode, Cursor, Copilot, Pi and Kilo are off.");
    fireEvent.click(within(more).getByRole("button", { name: "Add agents…" }));
    expect(p.onNavigate).toHaveBeenCalledWith("settings");
  });

  it("shows no such row when every agent is on", () => {
    renderOverview({ enabledHarnessIds: ["codex", "opencode", "cursor", "claude", "copilot", "pi", "kilo"] });
    expect(screen.queryByRole("region", { name: "Agents that are off" })).toBeNull();
  });
});

describe("Overview worth a look", () => {
  it("lists risky findings per agent, links to the agent and counts them", async () => {
    postures = { claude: RISKY_CLAUDE, codex: CLEAN_CODEX };
    const { props: p } = renderOverview();
    const look = await screen.findByRole("region", { name: "Worth a look · 1" });
    expect(look.textContent).toContain("starts in bypassPermissions mode: no permission prompts");
    fireEvent.click(within(look).getByRole("button", { name: /Claude/ }));
    expect(p.onNavigate).toHaveBeenCalledWith("claude");
  });

  it("is not there when nothing is risky, and a posture that cannot be read does not break the page", async () => {
    postures = { codex: CLEAN_CODEX };
    renderOverview();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_security_posture", { harness: "codex" }));
    expect(screen.queryByRole("region", { name: /Worth a look/ })).toBeNull();
  });
});

describe("Overview last update", () => {
  function entry(overrides: Partial<SetupHistoryEntry> = {}): SetupHistoryEntry {
    return {
      transaction_id: "1792663200000000000",
      created_at: "1792663200000000000",
      finished_at: "1792663202000000000",
      status: "applied",
      surfaces: ["codex_rules"],
      harnesses: ["codex"],
      changes: [{ surface: "codex_rules", kind: "update", path: "~/.codex/AGENTS.md", applied: true, restored: false }],
      operation_counts: { create: 0, update: 1, remove: 0 },
      backup_files: 1,
      is_newest_completed: true,
      undoable: true,
      receipt: { synced: ["claude_rules"], left_for_you: [{ surface: "cursor_agents", reason: "conflict" }] },
      ...overrides,
    };
  }

  it("shows the receipt of the newest update from the history and offers Undo only where the backend does", async () => {
    history = [entry()];
    const { props: p } = renderOverview();
    const receipt = await screen.findByRole("region", { name: /^Last update · Codex/ });
    expect(receipt.textContent).toContain("Changedcodex rules · 1 file");
    expect(receipt.textContent).toContain("Left for youcursor agents · you edited it");
    fireEvent.click(within(receipt).getByRole("button", { name: "Undo this update…" }));
    // Undo only names the transaction; the dry run and the confirm are the owner's.
    expect(p.onUndo).toHaveBeenCalledWith("1792663200000000000");
  });

  it("offers no Undo for an update that is not the newest completed one, or is already undone", async () => {
    history = [entry({ status: "rolled_back", undoable: false })];
    renderOverview();
    const receipt = await screen.findByRole("region", { name: /^Last update · Codex/ });
    expect(within(receipt).getByText("Undone")).toBeTruthy();
    expect(within(receipt).queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("disables Undo with the reason while a task runs", async () => {
    history = [entry()];
    renderOverview({ wsRunning: "update all" });
    const undo = await screen.findByRole("button", { name: "Undo this update…" });
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(undo.getAttribute("title")).toBe("update all is running");
  });

  it("shows no cell without a history", async () => {
    renderOverview();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_setup_history", expect.anything()));
    expect(screen.queryByRole("region", { name: /Last update/ })).toBeNull();
  });
});

describe("Overview keys", () => {
  it("opens the review of every update with u and a read-only preview with p", () => {
    const { props: p } = renderOverview();
    press("u");
    expect(p.install.open).toHaveBeenCalledWith("all", { scope: "start" });
    press("p");
    expect(p.install.open).toHaveBeenLastCalledWith("all", { readOnly: true, scope: "start" });
  });

  it("does not open the review when everything is up to date, and says why", () => {
    const current = installationStatus("current", [surfaceStatus("codex_rules", "current")]);
    const { props: p } = renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, codex: current }), enabledHarnessIds: ["codex"] });
    act(() => page().focus());
    press("u");
    expect(p.install.open).not.toHaveBeenCalled();
    const update = hint(/update all/);
    expect(update.getAttribute("aria-disabled")).toBe("true");
    expect(update.getAttribute("title")).toBe("Everything Riggverk can update is already up to date.");
  });

  it("uses the reason the shell computed for Update all when it hands one over", () => {
    const { props: p } = renderOverview({ updateAllDisabled: "Saving target changes…" });
    press("u");
    expect(p.install.open).not.toHaveBeenCalled();
  });

  it("checks again with r", () => {
    const { props: p } = renderOverview();
    press("r");
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("offers the folder and the backups on the page, by key and as hints", () => {
    const { props: p } = renderOverview();
    act(() => page().focus());
    fireEvent.click(hint(/open folder/));
    fireEvent.click(hint(/backups/));
    expect(p.onOpenFolder).toHaveBeenCalledTimes(1);
    expect(p.onOpenBackupsFolder).toHaveBeenCalledTimes(1);
    press("o");
    press("B", { shiftKey: true });
    expect(p.onOpenFolder).toHaveBeenCalledTimes(2);
    expect(p.onOpenBackupsFolder).toHaveBeenCalledTimes(2);
  });

  it("offers no folder key while a task runs, and none for an unusable folder", () => {
    const { props: p } = renderOverview({ wsRunning: "update all" });
    press("o");
    expect(p.onOpenFolder).not.toHaveBeenCalled();
    cleanup();
    const unusable = renderOverview({ workspaceDiagnostics: INVALID_DIAGNOSTICS, dataFolderOk: false, overview: overviewOf({}) });
    press("o");
    expect(unusable.props.onOpenFolder).not.toHaveBeenCalled();
  });
});

describe("Overview workspace folder", () => {
  function folder() {
    return screen.getByRole("region", { name: "Workspace folder" });
  }

  it("is collapsed, with its state and path in view, and opens with the keyboard", () => {
    renderOverview({ rollbackTransactionId: "1710000000000" });
    const toggle = within(folder()).getByRole("button", { name: /Workspace folder/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("/tmp/workspace");
    expect(within(folder()).getByText("Up to date")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(folder()).getByLabelText("Workspace folder facts").textContent).toContain("2 runs · /tmp/backups");
    expect(within(folder()).getByLabelText("Workspace folder facts").textContent).toContain("1710000000000 · rollback available");
    expect(screen.getByRole("region", { name: "Uninstall" })).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
  });

  it("tells what the data folder holds and the old copies an update removes", () => {
    const workspace = installationStatus(
      "update_available",
      [
        {
          ...surfaceStatus("workspace_bundle", "update_available", "133 old copies to remove, 1 left in place"),
          data_folder: { personal_docs: 3, ownership_records: false, left_in_place: 1 },
        },
      ],
      { remove_count: 133 },
    );
    renderOverview({ overview: overviewOf({ workspace }), enabledHarnessIds: [] });
    expect(within(folder()).getByText("Update ready")).toBeTruthy();
    expect(within(folder()).getByText("133 old copies to remove, 1 left in place")).toBeTruthy();
    fireEvent.click(within(folder()).getByRole("button", { name: /Workspace folder/ }));
    const facts = within(folder()).getByLabelText("Workspace folder facts").textContent;
    expect(facts).toContain("personal docs3");
    expect(facts).toContain("ownership recordsnone yet");
    expect(facts).toContain("left in place1 · edited old copies the app no longer reads");
  });

  it("keeps what an earlier release left behind in view while collapsed", () => {
    const earlier = "/Users/me/.config/agent-workspace"; // residue-allow: the earlier folder a note names
    renderOverview({
      workspaceDiagnostics: {
        ...VALID_DIAGNOSTICS,
        layout_notes: [
          `Riggverk kept using ${earlier} because it could not rename it to /Users/me/.config/riggverk (Permission denied).`,
          `An earlier folder ${earlier} still exists next to /Users/me/.config/riggverk; Riggverk left the earlier folder untouched.`,
        ],
      },
    });
    expect(folder().textContent).toContain(`Riggverk kept using ${earlier} because it could not rename it`);
    expect(folder().textContent).toContain("left the earlier folder untouched");
  });

  it("shows no layout note when the diagnostics carry none", () => {
    renderOverview({ workspaceDiagnostics: { ...VALID_DIAGNOSTICS, layout_notes: [] } });
    expect(folder().textContent).not.toContain("earlier folder");
  });

  it("says why the folder is unusable and offers no uninstall", () => {
    renderOverview({ workspaceDiagnostics: INVALID_DIAGNOSTICS, dataFolderOk: false, overview: overviewOf({}) });
    expect(folder().textContent).toContain("the folder is a symlink");
    fireEvent.click(within(folder()).getByRole("button", { name: /Workspace folder/ }));
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
  });

  it("opens by itself for a pending :uninstall request, so the card that handles it is mounted", () => {
    const handled = vi.fn();
    renderOverview({ uninstallPreviewRequested: true, onUninstallPreviewHandled: handled });
    expect(within(folder()).getByRole("button", { name: /Workspace folder/ }).getAttribute("aria-expanded")).toBe("true");
    expect(handled).toHaveBeenCalled();
  });

  it("opens by itself when an uninstall can be recovered, also while the folder is gone", () => {
    renderOverview({
      workspaceDiagnostics: INVALID_DIAGNOSTICS,
      dataFolderOk: false,
      overview: overviewOf({}),
      uninstallRecoveryTransactionId: "1710000000000",
    });
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
  });

  it("has the folder and backups buttons, with the reason when a task runs", () => {
    const { props: p } = renderOverview();
    fireEvent.click(within(folder()).getByRole("button", { name: /Workspace folder/ }));
    fireEvent.click(within(folder()).getByRole("button", { name: "Open folder" }));
    fireEvent.click(within(folder()).getByRole("button", { name: "Backups folder" }));
    expect(p.onOpenFolder).toHaveBeenCalledTimes(1);
    expect(p.onOpenBackupsFolder).toHaveBeenCalledTimes(1);
    cleanup();
    renderOverview({ wsRunning: "update all" });
    fireEvent.click(within(folder()).getByRole("button", { name: /Workspace folder/ }));
    expect(within(folder()).getByRole("button", { name: "Open folder" }).getAttribute("title")).toBe("update all is running");
  });
});

describe("Overview install review", () => {
  it("shows the plan and the run panel instead of the page while the review is open", () => {
    const flow = flowOf([op("workspace_bundle", "update")], { label: "update all", surfaces: ["workspace_bundle"] });
    renderOverview({ install: installScreenOf(flow, "start"), wsRunning: "update all" });
    expect(screen.getByRole("grid", { name: "Install plan" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Run" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Overview" })).toBeNull();
    const review = screen.getByRole("region", { name: "Workspace install review" });
    expect(review.classList.contains("review")).toBe(true);
    expect([...review.children].map(child => child.getAttribute("data-pane-id"))).toEqual(["plan", "output"]);
  });

  it("hands apply to the install screen when y is pressed, and never on Enter", () => {
    const flow = flowOf([op("workspace_bundle", "update")], { label: "update all", surfaces: ["workspace_bundle"] });
    const install = installScreenOf(flow, "start");
    renderOverview({ install });
    const plan = screen.getByRole("grid", { name: "Install plan" });
    fireEvent.keyDown(plan, { key: "Enter" });
    expect(install.apply).not.toHaveBeenCalled();
    fireEvent.keyDown(plan, { key: "y" });
    expect(install.apply).toHaveBeenCalledTimes(1);
  });

  it("does not show a review that belongs to another page", () => {
    const flow = flowOf([op("claude_rules", "update")]);
    renderOverview({ install: installScreenOf(flow, "claude") });
    expect(screen.queryByRole("grid", { name: "Install plan" })).toBeNull();
    expect(page()).toBeTruthy();
  });
});

describe("Overview run panel", () => {
  const progress: ApplyProgress = { task: "apply_setup", phase: "apply", done: 4, total: 7, file: "~/.claude/skills/handoff/SKILL.md" };
  const done = { success: true, action: "apply_setup update claude", stdout: "applied 2", stderr: "", exit_code: 0 };

  it("takes no room before the first run", () => {
    renderOverview();
    expect(screen.queryByRole("region", { name: "Run" })).toBeNull();
  });

  it("shows the backend's progress while a task runs, and only a phase word until the backend reports", () => {
    renderOverview({ wsRunning: "update claude", wsProgress: progress });
    const panel = screen.getByRole("region", { name: "Run" });
    expect(within(panel).getByRole("progressbar").getAttribute("aria-valuetext")).toBe("4 of 7");
    expect(within(panel).getByText("~/.claude/skills/handoff/SKILL.md")).toBeTruthy();
    cleanup();
    renderOverview({ wsRunning: "update claude", wsProgress: null });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Run" })).getByText("working…")).toBeTruthy();
  });

  it("offers Undo last update when the run left a transaction, and hands it to the app's rollback path", () => {
    const onRollback = vi.fn();
    renderOverview({ wsLog: done, wsLogCompletedAt: Date.now(), rollbackTransactionId: "1710000000000", onRollback });
    const undo = within(screen.getByRole("region", { name: "Run" })).getByRole("button", { name: "Undo last update…" });
    expect(undo.getAttribute("aria-keyshortcuts")).toBe("z");
    fireEvent.click(undo);
    expect(onRollback).toHaveBeenCalledTimes(1);
  });
});

describe("Overview page keys scope", () => {
  it("makes the page the default pane, so the keys work right after the view opens", () => {
    renderOverview();
    expect(page().getAttribute("data-pane-id")).toBe("page");
    expect(page().hasAttribute("data-pane-default")).toBe(true);
    expect(page().getAttribute("tabindex")).toBe("-1");
  });
});
