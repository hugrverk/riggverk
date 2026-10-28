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
}

function installBackend(overrides: Partial<AppSettings> = {}): Backend {
  const backend: Backend = {
    settings: { ...defaultSettings(), revision: 1, ...overrides },
    commandLog: [],
    installation: {},
    statusRequests: [],
    holdUpdate: null,
    lightHealthRequests: [],
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
      case "get_agent_targets":
      case "list_backups":
      case "list_docs":
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

  it("starts on Overview with the status bar in NORMAL mode", async () => {
    installBackend();
    render(<App />);
    await ready();
    expect(currentTab()).toBe("Overview");
    expect(screen.getByLabelText("Status bar").querySelector(".mode")!.textContent).toBe("NORMAL");
  });

  it("switches views with the positional number keys through the normal navigation path", async () => {
    installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: "3" });
    await waitFor(() => expect(currentTab()).toBe("OpenCode"));
    fireEvent.keyDown(document.body, { key: "7" });
    await waitFor(() => expect(currentTab()).toBe("Settings"));
    await screen.findByRole("region", { name: "Settings" });
    fireEvent.keyDown(document.body, { key: "1" });
    await waitFor(() => expect(currentTab()).toBe("Overview"));
  });

  it("renumbers the tabs when a harness is hidden in settings", async () => {
    installBackend({ enabled_harness_ids: ["codex", "claude"] });
    render(<App />);
    await within(nav()).findByRole("button", { name: "Claude" });
    expect(within(nav()).queryByRole("button", { name: "OpenCode" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "3" });
    await waitFor(() => expect(currentTab()).toBe("Claude"));
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
    // Overview, Codex, OpenCode, Cursor, Claude, Pi, Library, Settings (then the dim "2 more agents" row).
    expect(Array.from(nav().querySelectorAll("button.nav:not(.dim)")).map(item => item.getAttribute("aria-label"))).toEqual([
      "Overview", "Codex", "OpenCode", "Cursor", "Claude", "Pi", "Library", "Settings",
    ]);
    fireEvent.keyDown(document.body, { key: "6" });
    await waitFor(() => expect(currentTab()).toBe("Pi"));
    const detail = await screen.findByRole("region", { name: "Pi detail" });
    await waitFor(() => expect(detail.textContent).toContain("runtime · synced"));
    expect(backend.lightHealthRequests.every(harness => harness === "pi")).toBe(true);
    expect(backend.lightHealthRequests.length).toBeGreaterThan(0);
  });

  it("shows a light harness tab and loads its health once Settings turns it on", async () => {
    const backend = installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    const settings = await screen.findByRole("region", { name: "Settings" });
    fireEvent.click(within(settings).getByRole("checkbox", { name: "kilo" }));
    await within(nav()).findByRole("button", { name: "Kilo" });
    await waitFor(() => expect(backend.lightHealthRequests).toEqual(["kilo"]));
    await waitFor(() => expect(backend.settings.enabled_harness_ids).toEqual(["codex", "opencode", "claude", "cursor", "kilo"]), { timeout: 3000 });
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
    fireEvent.click(within(settings).getByRole("checkbox", { name: "claude" }));
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
    await screen.findByRole("region", { name: "Uninstall" });
    await act(async () => {});
    expect(backend.commandLog).not.toContain("preview_uninstall");
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
      await waitFor(() => expect(foot.textContent).toMatch(/^0 backupschecked \d{2}:\d{2}$/));
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
