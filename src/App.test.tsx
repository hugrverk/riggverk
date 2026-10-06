import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { defaultSettings } from "./lib/settingsDraft";
import type { AppSettings } from "./types";

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
  openResult: { success: boolean; stderr: string };
}

function installBackend(overrides: Partial<AppSettings> = {}): Backend {
  const backend: Backend = {
    settings: { ...defaultSettings(), revision: 1, ...overrides },
    commandLog: [],
    openResult: { success: true, stderr: "" },
  };
  invokeMock.mockImplementation((command: string, args?: { settings?: AppSettings }) => {
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
    fireEvent.click(await screen.findByRole("button", { name: "library" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "library" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("region", { name: "Settings" })).toBe(settings);
    expect(commandCount(backend, "list_docs")).toBe(0);
  });

  it("shows an error banner when the OS opener reports a soft failure", async () => {
    const backend = installBackend();
    backend.openResult = { success: false, stderr: "no application knows how to open this" };
    render(<App />);
    await waitFor(() => expect(commandCount(backend, "get_settings")).toBeGreaterThanOrEqual(1));

    // The Start view exposes the default workspace folder action.
    const openButton = await screen.findByRole("button", { name: /open folder/i });
    await act(async () => {
      fireEvent.click(openButton);
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no application knows how to open this"));
  });
});
