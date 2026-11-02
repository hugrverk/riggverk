import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { defaultSettings } from "./lib/settingsDraft";
import { op, planOf } from "./test/pageFixtures";
import type { AppSettings, InstallAgent, InstallationState } from "./types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));

interface Backend {
  settings: AppSettings;
  commandLog: string[];
  installation: Partial<Record<string, InstallationState>>;
  /** Surfaces of every get_installation_status call, in order. */
  statusRequests: string[][];
  /** When set, update_settings resolves only after this promise does. */
  holdUpdate: Promise<void> | null;
  /** Harness of every get_light_runtime_health call, in order. */
  lightHealthRequests: string[];
  /** When set, get_claude_runtime_health resolves only after this promise does. */
  holdClaudeHealth: Promise<void> | null;
  /** Personal docs the Library lists. */
  docs: Array<{ id: string; title: string; content: string }>;
}

function installBackend(overrides: Partial<AppSettings> = {}): Backend {
  const backend: Backend = {
    settings: { ...defaultSettings(), revision: 1, ...overrides },
    commandLog: [],
    installation: {},
    statusRequests: [],
    holdUpdate: null,
    lightHealthRequests: [],
    holdClaudeHealth: null,
    docs: [],
  };
  invokeMock.mockImplementation((command: string, args?: { settings?: AppSettings; surfaces?: string[]; harness?: string }) => {
    backend.commandLog.push(command);
    switch (command) {
      case "get_settings":
        return Promise.resolve({ settings: backend.settings, load_warning: null });
      case "update_settings":
        return (backend.holdUpdate ?? Promise.resolve()).then(() => {
          backend.settings = { ...(args?.settings ?? backend.settings), revision: (backend.settings.revision ?? 0) + 1 };
          return backend.settings;
        });
      case "list_docs":
        return Promise.resolve(
          backend.docs.map(doc => ({ id: doc.id, title: doc.title, section: "Personal", path: `docs/context/${doc.id}.md`, source: "custom" })),
        );
      case "read_doc": {
        const doc = backend.docs.find(candidate => candidate.id === (args as { id?: string } | undefined)?.id);
        return doc
          ? Promise.resolve({ id: doc.id, title: doc.title, section: "Personal", path: `docs/context/${doc.id}.md`, source: "custom", content: doc.content })
          : Promise.reject(new Error("no such doc"));
      }
      case "get_agent_targets":
      case "list_backups":
      case "list_skills":
        return Promise.resolve([]);
      case "get_workspace_diagnostics":
        return Promise.resolve({
          candidate_path: "/tmp/ws",
          resolved_path: "/tmp/ws",
          valid: true,
          error: null,
          enabled_rule_targets: 0,
          total_rule_targets: 0,
          enabled_config_targets: 0,
          total_config_targets: 0,
          backup_root: "/tmp/backups",
          backup_root_exists: false,
        });
      case "list_agent_metadata":
        return Promise.resolve({ agents: [], warnings: [] });
      case "preview_setup":
        return Promise.resolve(planOf([op("workspace_bundle", "update")]));
      case "apply_setup":
        return Promise.resolve({
          success: true,
          transaction_id: "tx-1",
          applied: ["workspace_bundle"],
          failed: [],
          rolled_back: [],
          manual_steps: [],
          message: "applied",
        });
      case "get_claude_runtime_health":
        return (backend.holdClaudeHealth ?? Promise.resolve()).then(() => Promise.reject(new Error("no runtime")));
      case "get_installation_status": {
        const surface = args?.surfaces?.[0] ?? "";
        // A light harness has the shared `skills` surface only, so the request does not say which one it is.
        const harness = surface.startsWith("open_code") ? "opencode" : surface.split("_")[0]!;
        backend.statusRequests.push(args?.surfaces ?? []);
        // Like the real command, it answers from the saved settings only.
        if (harness !== "workspace" && harness !== "skills" && !backend.settings.enabled_harness_ids.includes(harness as InstallAgent)) {
          return Promise.reject(`Harness disabled: ${harness}`);
        }
        const state = backend.installation[harness] ?? "current";
        return Promise.resolve({
          state,
          summary: state,
          counts: { create_count: 0, update_count: state === "update_available" ? 2 : 0, remove_count: 0, conflict_count: 0 },
          surfaces: [],
        });
      }
      case "get_light_runtime_health": {
        backend.lightHealthRequests.push(args?.harness ?? "");
        return Promise.resolve({
          harness: args?.harness,
          status: "synced",
          cli: { status: "found", version: "1.3.0", source: "path", detail: "found" },
          rules: { status: "synced", path: "~/.pi/agent/AGENTS.md", refinement_lines: 0, user_managed: false, conflict_reason: null, detail: "installed and current" },
          mcp: { status: "synced", path: "~/.pi/agent/mcp.json", playwright_version: "0.0.83", detail: "installed and current" },
          skills: { status: "synced", synced: 17, expected: 17, roots: ["~/.agents/skills"] },
          warnings: [],
          next_action: "No runtime action needed.",
        });
      }
      default:
        return Promise.reject(new Error("no workspace selected"));
    }
  });
  return backend;
}

function nav() {
  return screen.getByRole("navigation", { name: "Main navigation" });
}

function currentTab() {
  return nav().querySelector("[aria-current='page']")?.getAttribute("aria-label");
}

async function ready() {
  await within(nav()).findByRole("button", { name: "Claude" });
}

describe("App shell", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("starts on Overview", async () => {
    installBackend();
    render(<App />);
    await ready();
    expect(currentTab()).toBe("Overview");
  });

  it("switches views with the fixed digit keys through the normal navigation path", async () => {
    installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: "3" });
    await waitFor(() => expect(currentTab()).toBe("OpenCode"));
    fireEvent.keyDown(document.body, { key: "6" });
    await waitFor(() => expect(currentTab()).toBe("History"));
    await screen.findByRole("region", { name: "History" });
    fireEvent.keyDown(document.body, { key: "8" });
    await waitFor(() => expect(currentTab()).toBe("Settings"));
    await screen.findByRole("region", { name: "Settings" });
    fireEvent.keyDown(document.body, { key: "1" });
    await waitFor(() => expect(currentTab()).toBe("Overview"));
  });

  it("keeps the digits where they are when a harness is hidden in settings", async () => {
    installBackend({ enabled_harness_ids: ["codex", "claude"] });
    render(<App />);
    await within(nav()).findByRole("button", { name: "Claude" });
    expect(within(nav()).queryByRole("button", { name: "OpenCode" })).toBeNull();
    // OpenCode's digit does nothing; Claude stays on 5 and Library on 7.
    fireEvent.keyDown(document.body, { key: "3" });
    expect(currentTab()).toBe("Overview");
    fireEvent.keyDown(document.body, { key: "5" });
    await waitFor(() => expect(currentTab()).toBe("Claude"));
    fireEvent.keyDown(document.body, { key: "7" });
    await waitFor(() => expect(currentTab()).toBe("Library"));
  });

  it("hides Copilot, Pi and Kilo by default and asks no health of them", async () => {
    const backend = installBackend();
    render(<App />);
    await ready();
    for (const name of ["Copilot", "Pi", "Kilo"]) expect(within(nav()).queryByRole("button", { name })).toBeNull();
    await act(async () => {});
    expect(backend.lightHealthRequests).toEqual([]);
  });

  it("puts an enabled light harness after Claude, loads only its health and opens its page", async () => {
    const backend = installBackend({ enabled_harness_ids: ["codex", "opencode", "claude", "cursor", "pi"] });
    render(<App />);
    await within(nav()).findByRole("button", { name: "Pi" });
    // Overview, Codex, OpenCode, Cursor, Claude, Pi, History, Library, Settings.
    expect(Array.from(nav().querySelectorAll("button.nav")).map(item => item.getAttribute("aria-label"))).toEqual([
      "Overview", "Codex", "OpenCode", "Cursor", "Claude", "Pi", "History", "Library", "Settings",
    ]);
    // Pi has no digit (6 is History); it opens from the sidebar.
    fireEvent.click(within(nav()).getByRole("button", { name: "Pi" }));
    await waitFor(() => expect(currentTab()).toBe("Pi"));
    const page = await screen.findByRole("region", { name: "Pi" });
    await waitFor(() => expect(within(page).getByRole("region", { name: "Runtime" }).querySelector(".hp-ch b")?.textContent).toBe("synced"));
    expect(backend.lightHealthRequests.every(harness => harness === "pi")).toBe(true);
    expect(backend.lightHealthRequests.length).toBeGreaterThan(0);
  });

  it("shows a light harness tab and loads its health once Settings turns it on", async () => {
    const backend = installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    const settings = await screen.findByRole("region", { name: "Settings" });
    fireEvent.click(within(settings).getByRole("switch", { name: "Kilo" }));
    await within(nav()).findByRole("button", { name: "Kilo" });
    await waitFor(() => expect(backend.lightHealthRequests).toEqual(["kilo"]));
    await waitFor(() => expect(backend.settings.enabled_harness_ids).toEqual(["codex", "opencode", "claude", "cursor", "kilo"]), { timeout: 3000 });
  });

  describe("leaving the Library with unsaved changes", () => {
    const originalShowModal = HTMLDialogElement.prototype.showModal;
    const originalClose = HTMLDialogElement.prototype.close;

    beforeEach(() => {
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
      HTMLDialogElement.prototype.showModal = originalShowModal;
      HTMLDialogElement.prototype.close = originalClose;
    });

    async function editNotes() {
      const backend = installBackend();
      backend.docs = [{ id: "notes", title: "Notes", content: "# Notes\n" }];
      render(<App />);
      await ready();
      fireEvent.keyDown(document.body, { key: "7" });
      fireEvent.click(await screen.findByRole("tab", { name: "Docs" }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
      fireEvent.change(await screen.findByLabelText("Edit document"), { target: { value: "# Notes\nunsaved" } });
      await within(nav()).findByRole("button", { name: "Library, unsaved changes" });
      return backend;
    }

    it("marks the Library while edits are unsaved, keeps them on Keep editing and drops the mark on Discard", async () => {
      await editNotes();

      fireEvent.click(within(nav()).getByRole("button", { name: /Overview/ }));
      let dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
      expect(within(dialog).getByText("Notes has changes you have not saved.")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
      await act(async () => {});
      expect(currentTab()).toBe("Library, unsaved changes");
      expect(within(nav()).getByRole("button", { name: "Library, unsaved changes" })).toBeTruthy();
      expect((screen.getByLabelText("Edit document") as HTMLTextAreaElement).value).toBe("# Notes\nunsaved");

      fireEvent.click(within(nav()).getByRole("button", { name: /Overview/ }));
      dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(currentTab()).toBe("Overview"));
      // The edits were discarded with the leave: no marker, and the draft does not come back.
      expect(within(nav()).queryByRole("button", { name: "Library, unsaved changes" })).toBeNull();
      expect(within(nav()).getByRole("button", { name: "Library" })).toBeTruthy();
      fireEvent.keyDown(document.body, { key: "7" });
      await waitFor(() => expect(currentTab()).toBe("Library"));
      expect(screen.queryByDisplayValue("# Notes\nunsaved")).toBeNull();
      expect(within(nav()).queryByRole("button", { name: "Library, unsaved changes" })).toBeNull();
    });

    it("Save and continue writes the edits and then leaves", async () => {
      const backend = await editNotes();
      const rest = invokeMock.getMockImplementation()!;
      invokeMock.mockImplementation((command: string, args?: { content?: string }) => {
        if (command !== "save_doc") return rest(command, args);
        backend.docs[0]!.content = args?.content ?? "";
        return Promise.resolve({ success: true, action: "save_doc", stdout: "saved", stderr: "", exit_code: 0 });
      });

      fireEvent.click(within(nav()).getByRole("button", { name: /Overview/ }));
      const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save and continue" }));
      await waitFor(() => expect(currentTab()).toBe("Overview"));
      expect(invokeMock).toHaveBeenCalledWith("save_doc", { id: "notes", content: "# Notes\nunsaved" });
    }, 20_000);
  });

  it("opens Settings with Mod+, and via the :settings command", async () => {
    installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    await screen.findByRole("region", { name: "Settings" });
    fireEvent.keyDown(document.body, { key: "1" });
    await waitFor(() => expect(currentTab()).toBe("Overview"));

    fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
    const input = screen.getByRole("combobox", { name: "Command" });
    fireEvent.change(input, { target: { value: "settings" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("region", { name: "Settings" });
    expect(currentTab()).toBe("Settings");
  });

  it("opens History via the :history command and asks the backend for the list", async () => {
    const backend = installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
    const input = screen.getByRole("combobox", { name: "Command" });
    fireEvent.change(input, { target: { value: "history" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("region", { name: "History" });
    expect(currentTab()).toBe("History");
    await waitFor(() => expect(backend.commandLog).toContain("list_setup_history"));
  });

  it("does nothing on z while this session has no update to undo", async () => {
    const backend = installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: "z" });
    await act(async () => {});
    expect(backend.commandLog).not.toContain("rollback_setup_transaction");
  });

  it.each(["all", "workspace"])("keeps the right outcome actions after update %s", async target => {
    const backend = installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
    const input = screen.getByRole("combobox", { name: "Command" });
    fireEvent.change(input, { target: { value: `update ${target === "all" ? "--all" : target}` } });
    fireEvent.keyDown(input, { key: "Enter" });
    const receipt = await screen.findByRole("region", { name: "Workspace install review" });
    fireEvent.click(within(receipt).getByRole("button", { name: /apply/i }));
    await within(receipt).findByRole("button", { name: "Undo this update…" });
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Run" })).getByRole("button", { name: "Details" })).toBeTruthy());
    const run = screen.getByRole("region", { name: "Run" });
    expect(within(receipt).getByRole("button", { name: "dismiss" })).toBeTruthy();
    expect(!!within(run).queryByRole("button", { name: "Undo last update…" })).toBe(target !== "all");
    expect(!!within(run).queryByRole("button", { name: "Dismiss" })).toBe(target !== "all");
    if (target === "all") {
      fireEvent.keyDown(document.body, { key: "z" });
      await waitFor(() => expect(backend.commandLog.filter(command => command === "rollback_setup_transaction")).toHaveLength(1));
      const grid = within(receipt).getByRole("grid", { name: "Install plan" });
      grid.focus();
      fireEvent.keyDown(grid, { key: "n" });
    } else {
      fireEvent.click(within(receipt).getByRole("button", { name: "dismiss" }));
    }
    expect(within(run).getByRole("button", { name: "Undo last update…" })).toBeTruthy();
    expect(within(run).getByRole("button", { name: "Dismiss" })).toBeTruthy();
  }, 15_000);

  it("refuses a hidden harness command with the reason instead of navigating", async () => {
    installBackend({ enabled_harness_ids: ["codex"] });
    render(<App />);
    await within(nav()).findByRole("button", { name: "Codex" });
    fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
    const input = screen.getByRole("combobox", { name: "Command" });
    fireEvent.change(input, { target: { value: "claude" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("claude: claude is hidden in Settings");
    expect(currentTab()).toBe("Overview");
  });

  it("does not mark the agents with their installation state, only with decisions", async () => {
    const backend = installBackend();
    backend.installation = { codex: "update_available", cursor: "conflict" };
    render(<App />);
    await ready();
    await waitFor(() => expect(backend.statusRequests.length).toBeGreaterThanOrEqual(4));
    await act(async () => {});
    for (const name of ["Codex", "OpenCode", "Cursor", "Claude"]) {
      const item = within(nav()).getByRole("button", { name });
      expect(item.querySelector(".nb, .mark")).toBeNull();
    }
  });

  it("asks the backend about a newly enabled harness only after the settings save has landed", async () => {
    const backend = installBackend({ enabled_harness_ids: ["codex"] });
    let release: () => void = () => {};
    backend.holdUpdate = new Promise<void>(resolve => {
      release = resolve;
    });
    const claudeRequests = () => backend.statusRequests.filter(surfaces => surfaces[0]?.startsWith("claude"));
    render(<App />);
    await within(nav()).findByRole("button", { name: "Codex" });
    await waitFor(() => expect(backend.statusRequests.some(surfaces => surfaces[0]?.startsWith("codex"))).toBe(true));

    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    const settings = await screen.findByRole("region", { name: "Settings" });
    fireEvent.click(within(settings).getByRole("switch", { name: "Claude" }));
    await waitFor(() => expect(backend.commandLog).toContain("update_settings"), { timeout: 3000 });
    // Toggled in memory, not yet saved: the backend would still answer "Harness disabled".
    expect(claudeRequests()).toHaveLength(0);

    release();
    const claude = await within(nav()).findByRole("button", { name: "Claude" });
    expect(claude).toBeInTheDocument();
    await waitFor(() => expect(claudeRequests()).toHaveLength(1));
  });

  it("drops :uninstall while the install review is open instead of popping the dialog after it closes", async () => {
    const backend = installBackend();
    render(<App />);
    await ready();
    const runCommand = (line: string) => {
      fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
      const input = screen.getByRole("combobox", { name: "Command" });
      fireEvent.change(input, { target: { value: line } });
      fireEvent.keyDown(input, { key: "Enter" });
    };

    runCommand("update workspace");
    await screen.findByRole("region", { name: "Workspace install review" });
    runCommand("uninstall");
    expect(document.querySelector(".toast")!.textContent).toContain("close the install review first");

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Workspace install review" })).toBeNull());
    // The workspace folder cell is collapsed: the card is not there until the cell opens.
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Workspace folder/ }));
    await screen.findByRole("region", { name: "Uninstall" });
    await act(async () => {});
    expect(backend.commandLog).not.toContain("preview_uninstall");
  });

  it("frees the install task once the files are written, without waiting for a slow health probe", async () => {
    const backend = installBackend();
    render(<App />);
    await ready();
    const runCommand = (line: string) => {
      fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
      const input = screen.getByRole("combobox", { name: "Command" });
      fireEvent.change(input, { target: { value: line } });
      fireEvent.keyDown(input, { key: "Enter" });
    };

    runCommand("update workspace");
    await screen.findByRole("region", { name: "Workspace install review" });
    // From here on the Claude health probe never answers.
    backend.holdClaudeHealth = new Promise<void>(() => {});
    const healthCallsBefore = backend.commandLog.filter(entry => entry === "get_claude_runtime_health").length;
    fireEvent.click(within(screen.getByRole("region", { name: "Workspace install review" })).getByRole("button", { name: /apply/i }));
    await waitFor(() => expect(backend.commandLog).toContain("apply_setup"));
    await waitFor(() =>
      expect(backend.commandLog.filter(entry => entry === "get_claude_runtime_health").length).toBeGreaterThan(healthCallsBefore),
    );

    // The task lock is free again: a second update opens its review instead of being refused.
    await waitFor(() => {
      runCommand("update workspace");
      expect(screen.queryByRole("region", { name: "Workspace install review" })).not.toBeNull();
    }, { timeout: 3000 });
  });

  describe("top bar", () => {
    const updateAll = () => screen.getByRole("button", { name: "Update all" });

    it("keeps Update all off, with the reason, while everything is up to date", async () => {
      installBackend();
      render(<App />);
      await ready();
      await waitFor(() => expect(updateAll().getAttribute("title")).toBe("Everything Riggverk can update is already up to date."));
      expect(updateAll().getAttribute("aria-disabled")).toBe("true");
    });

    it("opens the install review of everything on Overview from any page, and writes nothing", async () => {
      const backend = installBackend();
      backend.installation = { codex: "update_available" };
      render(<App />);
      await ready();
      await waitFor(() => expect(updateAll().getAttribute("aria-disabled")).toBeNull());
      fireEvent.keyDown(document.body, { key: "2" });
      await waitFor(() => expect(currentTab()).toBe("Codex"));
      fireEvent.click(updateAll());
      await screen.findByRole("region", { name: "Workspace install review" });
      expect(currentTab()).toBe("Overview");
      expect(backend.commandLog).toContain("preview_setup");
      expect(backend.commandLog).not.toContain("apply_setup");
    });

    it("Check fetches every installation status again and the foot shows when", async () => {
      const backend = installBackend();
      render(<App />);
      await ready();
      await waitFor(() => expect(backend.statusRequests.length).toBeGreaterThanOrEqual(5));
      const before = backend.statusRequests.length;
      fireEvent.click(screen.getByRole("button", { name: "Check" }));
      await waitFor(() => expect(backend.statusRequests.length).toBeGreaterThanOrEqual(before + 5));
      const foot = document.querySelector(".side .foot")!;
      // The app version leads the foot; then the backups and when the check ran.
      await waitFor(() => expect(foot.textContent).toMatch(/^(\d{4}\.\d+\.\d+)?0 backupschecked \d{2}:\d{2}$/));
    });
  });

  it("lets ? open the help overlay and Escape close it", async () => {
    installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const help = screen.getByRole("dialog", { name: "Keyboard help" });
    expect(help.textContent).toContain("Go to Overview");
    fireEvent.keyDown(help, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Keyboard help" })).toBeNull();
    await act(async () => {});
  });
});
