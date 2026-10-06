import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { defaultSettings } from "./lib/settingsDraft";
import type { AppSettings, InstallationState } from "./types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

interface Backend {
  settings: AppSettings;
  commandLog: string[];
  installation: Partial<Record<string, InstallationState>>;
}

function installBackend(overrides: Partial<AppSettings> = {}): Backend {
  const backend: Backend = {
    settings: { ...defaultSettings(), revision: 1, ...overrides },
    commandLog: [],
    installation: {},
  };
  invokeMock.mockImplementation((command: string, args?: { settings?: AppSettings; surfaces?: string[] }) => {
    backend.commandLog.push(command);
    switch (command) {
      case "get_settings":
        return Promise.resolve({ settings: backend.settings, load_warning: null });
      case "update_settings":
        backend.settings = { ...(args?.settings ?? backend.settings), revision: (backend.settings.revision ?? 0) + 1 };
        return Promise.resolve(backend.settings);
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
          markers: [],
          enabled_rule_targets: 0,
          total_rule_targets: 0,
          enabled_config_targets: 0,
          total_config_targets: 0,
          backup_root: "/tmp/backups",
          backup_root_exists: false,
          release_check_available: false,
          bundled_resources_status: "current",
          missing_bundled_count: 0,
          missing_bundled_sample: [],
        });
      case "list_agent_metadata":
        return Promise.resolve({ agents: [], warnings: [] });
      case "get_installation_status": {
        const surface = args?.surfaces?.[0] ?? "";
        const harness = surface.startsWith("open_code") ? "opencode" : surface.split("_")[0]!;
        const state = backend.installation[harness] ?? "current";
        return Promise.resolve({
          state,
          summary: state,
          counts: { create_count: 0, update_count: state === "update_available" ? 2 : 0, remove_count: 0, conflict_count: 0 },
          surfaces: [],
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

  it("starts on the workspace tab with the status bar in NORMAL mode", async () => {
    installBackend();
    render(<App />);
    await ready();
    expect(currentTab()).toBe("Workspace");
    expect(screen.getByLabelText("Status bar").querySelector(".mode")!.textContent).toBe("NORMAL");
  });

  it("switches views with the positional number keys through the normal navigation path", async () => {
    installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: "3" });
    await waitFor(() => expect(currentTab()).toBe("OpenCode"));
    fireEvent.keyDown(document.body, { key: "9" });
    await waitFor(() => expect(currentTab()).toBe("Settings"));
    await screen.findByRole("region", { name: "Settings" });
    fireEvent.keyDown(document.body, { key: "1" });
    await waitFor(() => expect(currentTab()).toBe("Workspace"));
  });

  it("renumbers the tabs when a harness is hidden in settings", async () => {
    installBackend({ enabled_harness_ids: ["codex", "claude"] });
    render(<App />);
    await within(nav()).findByRole("button", { name: "Claude" });
    expect(within(nav()).queryByRole("button", { name: "OpenCode" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "3" });
    await waitFor(() => expect(currentTab()).toBe("Claude"));
  });

  it("opens Settings with Mod+, and via the :settings command", async () => {
    installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    await screen.findByRole("region", { name: "Settings" });
    fireEvent.keyDown(document.body, { key: "1" });
    await waitFor(() => expect(currentTab()).toBe("Workspace"));

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
    expect(currentTab()).toBe("Workspace");
  });

  it("shows installation state from the overview as status dots on the harness tabs", async () => {
    const backend = installBackend();
    backend.installation = { codex: "update_available", cursor: "conflict" };
    render(<App />);
    const codex = await within(nav()).findByRole("button", { name: "Codex, update available" });
    expect(codex.querySelector(".st.st-warn")).not.toBeNull();
    expect(within(nav()).getByRole("button", { name: "Cursor, conflicts" }).querySelector(".st.st-fail")).not.toBeNull();
    expect(within(nav()).getByRole("button", { name: "OpenCode, current" }).querySelector(".st.st-ok")).not.toBeNull();
  });

  it("lets ? open the help overlay and Escape close it", async () => {
    installBackend();
    render(<App />);
    await ready();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const help = screen.getByRole("dialog", { name: "Keyboard help" });
    expect(help.textContent).toContain("Go to Workspace");
    expect(help.textContent).toContain("release-check");
    fireEvent.keyDown(help, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Keyboard help" })).toBeNull();
    await act(async () => {});
  });
});
