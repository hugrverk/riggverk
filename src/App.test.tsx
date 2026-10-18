import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { version as APP_VERSION } from "../package.json";
import App from "./App";
import { defaultSettings } from "./lib/settingsDraft";
import type { AppSettings } from "./types";

const invokeMock = vi.fn();

// The bundled notes are generated from release-notes/*.md; these tests bring their own.
vi.mock("./generated/release-notes.json", () => ({
  default: { releases: [{ version: "0.1.0", sections: [{ title: "New", items: ["Show what changed after an update"] }] }] },
}));

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
  openResult: { success: boolean; stderr: string };
}

const DEFAULT_WORKSPACE = "/tmp/ws";

function installBackend(overrides: Partial<AppSettings> = {}): Backend {
  const backend: Backend = {
    settings: { ...defaultSettings(), revision: 1, ...overrides },
    commandLog: [],
    openResult: { success: true, stderr: "" },
  };
  invokeMock.mockImplementation((command: string, args?: { settings?: AppSettings; path?: string }) => {
    backend.commandLog.push(command);
    switch (command) {
      case "get_settings":
        return Promise.resolve({ settings: backend.settings, load_warning: null });
      case "update_settings":
        backend.settings = { ...(args?.settings ?? backend.settings), revision: (backend.settings.revision ?? 0) + 1 };
        return Promise.resolve(backend.settings);
      case "try_set_active_workspace_path":
        if (args?.path?.includes("invalid")) {
          return Promise.reject("invalid workspace path: not a valid workspace (missing .agent-workspace/workspace.json)");
        }
        backend.settings = { ...backend.settings, workspace_path: args?.path ?? null, revision: (backend.settings.revision ?? 0) + 1 };
        return Promise.resolve(backend.settings);
      case "reset_active_workspace_path":
        backend.settings = { ...backend.settings, workspace_path: null, revision: (backend.settings.revision ?? 0) + 1 };
        return Promise.resolve(backend.settings);
      case "get_agent_targets":
      case "list_backups":
      case "list_docs":
      case "list_skills":
        return Promise.resolve([]);
      case "get_workspace_diagnostics":
        return Promise.resolve({
          candidate_path: backend.settings.workspace_path ?? DEFAULT_WORKSPACE,
          resolved_path: backend.settings.workspace_path ?? DEFAULT_WORKSPACE,
          valid: true,
          error: null,
          markers: [],
          enabled_rule_targets: 0,
          total_rule_targets: 0,
          enabled_config_targets: 0,
          total_config_targets: 0,
          backup_root: "/tmp/backups",
          backup_root_exists: false,
          bundled_resources_status: "current",
          missing_bundled_count: 0,
          missing_bundled_sample: [],
        });
      case "list_agent_metadata":
        return Promise.resolve({ agents: [], warnings: [] });
      case "open_default_workspace_folder":
        return Promise.resolve({ success: backend.openResult.success, action: command, stdout: "", stderr: backend.openResult.stderr, exit_code: 1 });
      default:
        // Everything workspace-bound reports "no workspace selected", which the UI treats as an empty state.
        return Promise.reject(new Error("no workspace selected"));
    }
  });
  return backend;
}

function commandCount(backend: Backend, command: string): number {
  return backend.commandLog.filter(entry => entry === command).length;
}

/**
 * A key hint of the Start view's detail pane (the cursor starts on "workspace"). Hints live in the status bar
 * while their pane has focus, so this moves focus (back) into the pane when the hint is not showing (a dialog
 * may have taken it). Call it outside `act`: a nested act would not flush the focus change before the query.
 */
function findStatusHint(name: RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const bar = within(screen.getByLabelText("Status bar"));
    const shown = bar.queryByRole("button", { name });
    if (shown) return shown;
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      screen.getByRole("group", { name: "workspace detail" }).focus();
    });
    return bar.getByRole("button", { name });
  });
}

describe("App", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the backups list on mount so the Start chip is current", async () => {
    const backend = installBackend();
    render(<App />);
    await waitFor(() => expect(commandCount(backend, "list_backups")).toBeGreaterThanOrEqual(1));
  });

  it("opens the configured landing view through the normal navigation path and loads its data", async () => {
    const backend = installBackend({ landing_view: "library" });
    render(<App />);

    await waitFor(() => expect(commandCount(backend, "list_docs")).toBeGreaterThanOrEqual(1));
    await screen.findByLabelText("Library source type");
  });

  it("does not navigate away from Settings when the landing page option changes", async () => {
    const backend = installBackend();
    render(<App />);
    await waitFor(() => expect(commandCount(backend, "get_settings")).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("region", { name: "Settings" });
    fireEvent.click(await screen.findByRole("radio", { name: "library" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "library" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("region", { name: "Settings" })).toBe(settings);
    expect(commandCount(backend, "list_docs")).toBe(0);
  });

  it("shows an error banner when the OS opener reports a soft failure", async () => {
    const backend = installBackend();
    backend.openResult = { success: false, stderr: "no application knows how to open this" };
    render(<App />);
    await waitFor(() => expect(commandCount(backend, "get_settings")).toBeGreaterThanOrEqual(1));

    // The Start view's detail pane offers the default workspace folder action once diagnostics report a valid workspace.
    await screen.findByRole("region", { name: "workspace detail" });
    const openButton = await findStatusHint(/open folder/i);
    await act(async () => {
      fireEvent.click(openButton);
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no application knows how to open this"));
  });

  describe("workspace picker in Settings", () => {
    async function openSettings(backend: Backend) {
      render(<App />);
      await waitFor(() => expect(commandCount(backend, "get_settings")).toBeGreaterThanOrEqual(1));
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      await screen.findByRole("region", { name: "Settings" });
      return within(await screen.findByRole("group", { name: "workspace" }));
    }

    beforeEach(() => {
      vi.mocked(open).mockReset();
    });

    it("switches to the chosen folder and reloads workspace state without leaving Settings", async () => {
      const backend = installBackend();
      const row = await openSettings(backend);
      expect(row.getByText("/tmp/ws")).toBeTruthy();
      vi.mocked(open).mockResolvedValue("/tmp/other");
      const diagnosticsBefore = commandCount(backend, "get_workspace_diagnostics");

      await act(async () => {
        fireEvent.click(row.getByRole("button", { name: /choose…/ }));
      });

      await waitFor(() => expect(row.getByText("/tmp/other")).toBeTruthy());
      expect(row.getByRole("status", { name: "Workspace change" }).textContent).toContain("workspace set to /tmp/other");
      expect(backend.settings.workspace_path).toBe("/tmp/other");
      expect(commandCount(backend, "try_set_active_workspace_path")).toBe(1);
      expect(commandCount(backend, "get_workspace_diagnostics")).toBeGreaterThan(diagnosticsBefore);
      expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    });

    it("refuses a folder the backend rejects, says why, and keeps the current workspace", async () => {
      const backend = installBackend();
      const row = await openSettings(backend);
      vi.mocked(open).mockResolvedValue("/tmp/invalid-folder");
      const diagnosticsBefore = commandCount(backend, "get_workspace_diagnostics");

      await act(async () => {
        fireEvent.click(row.getByRole("button", { name: /choose…/ }));
      });

      await waitFor(() =>
        expect(row.getByRole("status", { name: "Workspace change" }).textContent).toContain(
          "/tmp/invalid-folder is not a Riggverk workspace folder (missing .agent-workspace/workspace.json)",
        ),
      );
      expect(row.getByText("/tmp/ws")).toBeTruthy();
      expect(backend.settings.workspace_path).toBeNull();
      expect(commandCount(backend, "get_workspace_diagnostics")).toBe(diagnosticsBefore);
    });

    it("leaves everything alone when the picker is cancelled", async () => {
      const backend = installBackend();
      const row = await openSettings(backend);
      vi.mocked(open).mockResolvedValue(null);

      await act(async () => {
        fireEvent.click(row.getByRole("button", { name: /choose…/ }));
      });

      expect(commandCount(backend, "try_set_active_workspace_path")).toBe(0);
      expect(row.getByRole("status", { name: "Workspace change" }).textContent).toBe("");
    });

    it("resets a custom folder to the default", async () => {
      const backend = installBackend({ workspace_path: "/tmp/other" });
      const row = await openSettings(backend);
      await waitFor(() => expect(row.getByText("/tmp/other")).toBeTruthy());

      await act(async () => {
        fireEvent.click(row.getByRole("button", { name: /reset to default/ }));
      });

      await waitFor(() => expect(row.getByText("/tmp/ws")).toBeTruthy());
      expect(backend.settings.workspace_path).toBeNull();
      expect(commandCount(backend, "reset_active_workspace_path")).toBe(1);
    });
  });

  describe("what's new", () => {
    const overlay = () => screen.queryByRole("dialog", { name: "What's new" });

    it("shows the notes once after an update and records the version when they are closed", async () => {
      const backend = installBackend({ last_seen_version: "0.0.9" });
      render(<App />);

      const dialog = await screen.findByRole("dialog", { name: "What's new" });
      expect(dialog.textContent).toContain("Show what changed after an update");
      expect(backend.settings.last_seen_version).toBe("0.0.9");

      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(overlay()).toBeNull();
      await waitFor(() => expect(backend.settings.last_seen_version).toBe(APP_VERSION), { timeout: 3000 });
      expect(overlay()).toBeNull();
      cleanup();

      // The next launch has nothing new to show.
      invokeMock.mockClear();
      render(<App />);
      await waitFor(() => expect(commandCount(backend, "get_workspace_diagnostics")).toBeGreaterThanOrEqual(1));
      expect(overlay()).toBeNull();
    });

    it("stays closed on a fresh install and only records the version", async () => {
      const backend = installBackend();
      expect(backend.settings.last_seen_version).toBeUndefined();
      render(<App />);

      await waitFor(() => expect(backend.settings.last_seen_version).toBe(APP_VERSION), { timeout: 3000 });
      expect(overlay()).toBeNull();
    });

    it("stays closed when this version was already seen", async () => {
      const backend = installBackend({ last_seen_version: APP_VERSION });
      render(<App />);

      await waitFor(() => expect(commandCount(backend, "get_workspace_diagnostics")).toBeGreaterThanOrEqual(1));
      expect(overlay()).toBeNull();
      expect(commandCount(backend, "update_settings")).toBe(0);
    });

    it(":whatsnew opens the notes at any time and Esc closes them", async () => {
      const backend = installBackend({ last_seen_version: APP_VERSION });
      render(<App />);
      await waitFor(() => expect(commandCount(backend, "get_workspace_diagnostics")).toBeGreaterThanOrEqual(1));

      fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
      const input = screen.getByRole("combobox", { name: "Command" });
      fireEvent.change(input, { target: { value: "whatsnew" } });
      fireEvent.keyDown(input, { key: "Enter" });

      const dialog = await screen.findByRole("dialog", { name: "What's new" });
      expect(dialog.textContent).toContain("Show what changed after an update");
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(overlay()).toBeNull();
      expect(commandCount(backend, "update_settings")).toBe(0);
    });
  });
});
