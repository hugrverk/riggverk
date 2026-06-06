import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_CONFLICT_ERROR } from "../lib/appSettingsMutation";
import { useAppSettingsController } from "./useAppSettingsController";
import type { AppSettings } from "../types";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const baseSettings: AppSettings = {
  appearance: "dark",
  app_font_size: "medium",
  workspace_path: null,
  enabled_target_ids: ["codex_rules"],
  accent_color: null,
  background_color: null,
  foreground_color: null,
  repo_dashboard_entries: [],
  active_repo_dashboard_id: null,
  revision: 1,
};

function createDeps() {
  return {
    setError: vi.fn(),
    appliedWorkspacePathRef: { current: undefined as string | null | undefined },
    workspaceLoadGenerationRef: { current: 0 },
    isWorkspaceLoadCurrent: () => true,
    beginWorkspaceLoadGeneration: vi.fn(() => 0),
    resetWorkspaceBoundState: vi.fn(),
    loadWorkspaceDiagnostics: vi.fn(async () => {}),
    loadWorkspaceResources: vi.fn(async () => {}),
    fetchStatus: vi.fn(async () => {}),
  };
}

function mockInitialLoad(settings = baseSettings) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "get_settings") return Promise.resolve({ settings, load_warning: null });
    if (cmd === "get_agent_targets") return Promise.resolve([]);
    if (cmd === "get_target_profiles") return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  });
}

describe("useAppSettingsController mutateAppSettings", () => {
  beforeEach(() => {
    invoke.mockReset();
    mockInitialLoad();
  });

  it("preserves repository save and a concurrent theme change", async () => {
    const { result } = renderHook(() => useAppSettingsController(createDeps()));

    await act(async () => {
      await result.current.loadSettings();
    });
    await waitFor(() => expect(result.current.appSettings).not.toBeNull());

    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings; expectedRevision?: number }) => {
      if (cmd === "update_settings") {
        const next = args?.settings ?? baseSettings;
        return Promise.resolve({ ...next, revision: (baseSettings.revision ?? 0) + 1 });
      }
      if (cmd === "get_settings") return Promise.resolve({ settings: baseSettings, load_warning: null });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      result.current.setAppearance("light");
    });
    await act(async () => {
      await result.current.mutateAppSettings(current => ({
        ...current,
        repo_dashboard_entries: [{ id: "repo-1", label: "Repo", path: "/tmp/repo" }],
        active_repo_dashboard_id: "repo-1",
      }));
    });

    expect(result.current.appSettings?.appearance).toBe("light");
    expect(result.current.appSettings?.repo_dashboard_entries).toHaveLength(1);
    expect(result.current.appSettings?.active_repo_dashboard_id).toBe("repo-1");
  });

  it("preserves repository import and a concurrent target toggle", async () => {
    const { result } = renderHook(() => useAppSettingsController(createDeps()));

    await act(async () => {
      await result.current.loadSettings();
    });
    await waitFor(() => expect(result.current.appSettings).not.toBeNull());

    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings }) => {
      if (cmd === "update_settings") {
        const next = args?.settings ?? baseSettings;
        return Promise.resolve({ ...next, revision: (baseSettings.revision ?? 0) + 1 });
      }
      if (cmd === "get_settings") return Promise.resolve({ settings: baseSettings, load_warning: null });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      result.current.toggleTarget("opencode_config");
    });
    await act(async () => {
      await result.current.mutateAppSettings(current => ({
        ...current,
        repo_dashboard_entries: [
          { id: "imported", label: "Imported", path: "/tmp/imported" },
        ],
      }));
    });

    expect(result.current.appSettings?.enabled_target_ids).toContain("opencode_config");
    expect(result.current.appSettings?.repo_dashboard_entries[0]?.id).toBe("imported");
  });

  it("ignores out-of-order mutation responses", async () => {
    const { result } = renderHook(() => useAppSettingsController(createDeps()));

    await act(async () => {
      await result.current.loadSettings();
    });
    await waitFor(() => expect(result.current.appSettings).not.toBeNull());

    let resolveFirst: ((value: AppSettings) => void) | null = null;
    let updateCalls = 0;

    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings }) => {
      if (cmd === "update_settings") {
        updateCalls += 1;
        const next = args?.settings ?? baseSettings;
        if (updateCalls === 1) {
          return new Promise<AppSettings>(resolve => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ ...next, revision: 3 });
      }
      if (cmd === "get_settings") return Promise.resolve({ settings: { ...baseSettings, revision: 1 }, load_warning: null });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    let firstMutation!: Promise<AppSettings>;
    await act(async () => {
      firstMutation = result.current.mutateAppSettings(current => ({
        ...current,
        repo_dashboard_entries: [{ id: "stale", label: "Stale", path: "/tmp/stale" }],
      }));
    });

    await act(async () => {
      await result.current.mutateAppSettings(current => ({
        ...current,
        appearance: "light",
      }));
    });

    expect(result.current.appSettings?.appearance).toBe("light");
    expect(result.current.appSettings?.repo_dashboard_entries).toHaveLength(0);

    await act(async () => {
      resolveFirst?.({
        ...baseSettings,
        revision: 2,
        repo_dashboard_entries: [{ id: "stale", label: "Stale", path: "/tmp/stale" }],
        active_repo_dashboard_id: "stale",
      });
      await firstMutation;
    });

    expect(result.current.appSettings?.appearance).toBe("light");
    expect(result.current.appSettings?.repo_dashboard_entries).toHaveLength(0);
  });

  it("retries CAS conflicts and rebases pending local changes", async () => {
    const { result } = renderHook(() => useAppSettingsController(createDeps()));

    await act(async () => {
      await result.current.loadSettings();
    });
    await waitFor(() => expect(result.current.appSettings).not.toBeNull());

    let updateAttempts = 0;
    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings; expectedRevision?: number }) => {
      if (cmd === "update_settings") {
        updateAttempts += 1;
        if (updateAttempts === 1) {
          return Promise.reject(new Error(SETTINGS_CONFLICT_ERROR));
        }
        const next = args?.settings ?? baseSettings;
        return Promise.resolve({ ...next, revision: 3 });
      }
      if (cmd === "get_settings") {
        return Promise.resolve({
          settings: {
            ...baseSettings,
            revision: 2,
            appearance: "light",
            repo_dashboard_entries: [{ id: "server", label: "Server", path: "/tmp/server" }],
          },
          load_warning: null,
        });
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      result.current.setAppFontSize("large");
    });
    await act(async () => {
      await result.current.mutateAppSettings(current => ({
        ...current,
        active_repo_dashboard_id: "server",
      }));
    });

    expect(updateAttempts).toBeGreaterThan(1);
    expect(result.current.appSettings?.app_font_size).toBe("large");
    expect(result.current.appSettings?.active_repo_dashboard_id).toBe("server");
  });
});
