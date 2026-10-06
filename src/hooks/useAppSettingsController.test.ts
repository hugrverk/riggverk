import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_CONFLICT_ERROR } from "../lib/appSettingsMutation";
import { useAppSettingsController } from "./useAppSettingsController";
import type { AppSettings } from "../types";

const invoke = vi.fn();
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => confirmMock,
}));

const baseSettings: AppSettings = {
  appearance: "dark",
  app_font_size: "medium",
  workspace_path: null,
  enabled_target_ids: ["codex_rules"],
  enabled_harness_ids: ["codex", "opencode", "claude", "cursor"],
  accent_color: null,
  background_color: null,
  foreground_color: null,
  reduce_motion: false,
  landing_view: "start",
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
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  });
}

describe("useAppSettingsController loadSettings", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("keeps load_warning visible in settings status", async () => {
    const warning = "settings file was corrupt and moved to a local backup; using defaults";
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_settings") {
        return Promise.resolve({ settings: baseSettings, load_warning: warning });
      }
      if (cmd === "get_agent_targets") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    const { result } = renderHook(() => useAppSettingsController(createDeps()));

    await act(async () => {
      await result.current.loadSettings();
    });

    expect(result.current.settingsMsg).toEqual({ ok: false, text: warning });
  });

  it("clears settings status when load has no warning", async () => {
    mockInitialLoad();
    const { result } = renderHook(() => useAppSettingsController(createDeps()));

    await act(async () => {
      await result.current.loadSettings();
    });

    expect(result.current.settingsMsg).toBeNull();
  });
});

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
    expect(result.current.appSettings?.repo_dashboard_entries?.[0]?.id).toBe("imported");
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
    expect(result.current.appSettings?.repo_dashboard_entries ?? []).toHaveLength(0);

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

    expect(updateAttempts).toBe(2);
    const updates = invoke.mock.calls.filter(([cmd]) => cmd === "update_settings");
    // First attempt is sent against the revision loaded at startup, the retry against the reloaded one.
    expect(updates[0][1].expectedRevision).toBe(1);
    expect(updates[1][1].expectedRevision).toBe(2);
    // The retry applies the mutator to the rebased settings: server data + pending local edit + mutation.
    expect(updates[1][1].settings.active_repo_dashboard_id).toBe("server");
    expect(updates[1][1].settings.repo_dashboard_entries).toEqual([{ id: "server", label: "Server", path: "/tmp/server" }]);
    expect(updates[1][1].settings.app_font_size).toBe("large");
    expect(result.current.appSettings?.app_font_size).toBe("large");
    expect(result.current.appSettings?.active_repo_dashboard_id).toBe("server");
  });

  it("gives up after repeated conflicts and surfaces the error", async () => {
    const { result } = renderHook(() => useAppSettingsController(createDeps()));
    await act(async () => {
      await result.current.loadSettings();
    });

    invoke.mockImplementation((cmd: string) => {
      if (cmd === "update_settings") return Promise.reject(new Error(SETTINGS_CONFLICT_ERROR));
      if (cmd === "get_settings") return Promise.resolve({ settings: { ...baseSettings, revision: 2 }, load_warning: null });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await expect(
      act(async () => {
        await result.current.mutateAppSettings(current => ({ ...current, active_repo_dashboard_id: "x" }));
      }),
    ).rejects.toThrow(SETTINGS_CONFLICT_ERROR);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "update_settings")).toHaveLength(3);
  });

  it("persists extra-large through setAppFontSize", async () => {
    mockInitialLoad();
    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings }) => {
      if (cmd === "update_settings") {
        return Promise.resolve({ ...(args?.settings ?? baseSettings), revision: 2 });
      }
      if (cmd === "get_settings") {
        return Promise.resolve({ settings: baseSettings, load_warning: null });
      }
      if (cmd === "get_agent_targets") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    const { result } = renderHook(() => useAppSettingsController(createDeps()));
    await act(async () => {
      await result.current.loadSettings();
    });

    await act(async () => {
      result.current.setAppFontSize("extra-large");
    });

    await waitFor(() => expect(result.current.appSettings?.app_font_size).toBe("extra-large"));
  });
});

describe("useAppSettingsController autosave", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("persists a font size change through autosave", async () => {
    mockInitialLoad();
    const { result } = renderHook(() => useAppSettingsController(createDeps()));
    await act(async () => {
      await result.current.loadSettings();
    });
    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings }) => {
      if (cmd === "update_settings") return Promise.resolve({ ...args?.settings, revision: 2 });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      result.current.setAppFontSize("extra-large");
    });
    await advance(700);

    const updates = invoke.mock.calls.filter(([cmd]) => cmd === "update_settings");
    expect(updates).toHaveLength(1);
    expect(updates[0][1].settings.app_font_size).toBe("extra-large");
    expect(updates[0][1].expectedRevision).toBe(1);
    expect(result.current.settingsSaveStatus).toBe("saved");
  });

  it("advances the revision when the user keeps editing during an in-flight save", async () => {
    mockInitialLoad();
    const { result } = renderHook(() => useAppSettingsController(createDeps()));
    await act(async () => {
      await result.current.loadSettings();
    });

    let resolveFirst: (value: AppSettings) => void = () => {};
    let sentFirst: AppSettings | undefined;
    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings; expectedRevision?: number }) => {
      if (cmd === "update_settings") {
        if (args?.expectedRevision === 1) {
          sentFirst = args.settings;
          return new Promise<AppSettings>(resolve => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ ...args?.settings, revision: (args?.expectedRevision ?? 0) + 1 });
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      result.current.setAppFontSize("large");
    });
    await advance(700);
    expect(sentFirst?.app_font_size).toBe("large");

    // Edit while the first save is still in flight.
    await act(async () => {
      result.current.setAppearance("light");
    });
    await act(async () => {
      resolveFirst({ ...sentFirst!, revision: 2 });
    });
    await advance(700);

    const updates = invoke.mock.calls.filter(([cmd]) => cmd === "update_settings");
    expect(updates).toHaveLength(2);
    expect(updates[1][1].expectedRevision).toBe(2);
    expect(updates[1][1].settings.appearance).toBe("light");
    expect(updates[1][1].settings.app_font_size).toBe("large");
    expect(result.current.settingsSaveStatus).toBe("saved");
    expect(result.current.appSettings?.revision).toBe(3);
    expect(result.current.appSettings?.appearance).toBe("light");
  });

  it("rebases pending edits onto the latest settings after a conflict and retries once", async () => {
    mockInitialLoad();
    const { result } = renderHook(() => useAppSettingsController(createDeps()));
    await act(async () => {
      await result.current.loadSettings();
    });

    const server: AppSettings = {
      ...baseSettings,
      revision: 7,
      repo_dashboard_entries: [{ id: "server", label: "Server", path: "/tmp/server" }],
      active_repo_dashboard_id: "server",
    };
    let updateCalls = 0;
    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings; expectedRevision?: number }) => {
      if (cmd === "update_settings") {
        updateCalls += 1;
        if (updateCalls === 1) return Promise.reject(new Error(SETTINGS_CONFLICT_ERROR));
        return Promise.resolve({ ...args?.settings, revision: 8 });
      }
      if (cmd === "get_settings") return Promise.resolve({ settings: server, load_warning: null });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      result.current.setReduceMotion(true);
    });
    await act(async () => {
      await result.current.retrySaveSettings();
    });

    const updates = invoke.mock.calls.filter(([cmd]) => cmd === "update_settings");
    expect(updates).toHaveLength(2);
    expect(updates[1][1].expectedRevision).toBe(7);
    expect(updates[1][1].settings.reduce_motion).toBe(true);
    expect(updates[1][1].settings.repo_dashboard_entries).toEqual(server.repo_dashboard_entries);
    expect(updates[1][1].settings.active_repo_dashboard_id).toBe("server");
    expect(result.current.settingsSaveStatus).toBe("saved");
    expect(result.current.appSettings?.reduce_motion).toBe(true);
    expect(result.current.appSettings?.revision).toBe(8);
  });

  it("keeps a pending landing_view edit when a conflict is rebased", async () => {
    mockInitialLoad();
    const { result } = renderHook(() => useAppSettingsController(createDeps()));
    await act(async () => {
      await result.current.loadSettings();
    });

    let updateCalls = 0;
    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings }) => {
      if (cmd === "update_settings") {
        updateCalls += 1;
        if (updateCalls === 1) return Promise.reject(new Error(SETTINGS_CONFLICT_ERROR));
        return Promise.resolve({ ...args?.settings, revision: 4 });
      }
      if (cmd === "get_settings") return Promise.resolve({ settings: { ...baseSettings, revision: 3 }, load_warning: null });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      result.current.setLandingView("prompts");
    });
    await act(async () => {
      await result.current.retrySaveSettings();
    });

    const updates = invoke.mock.calls.filter(([cmd]) => cmd === "update_settings");
    expect(updates[1][1].settings.landing_view).toBe("prompts");
    expect(result.current.appSettings?.landing_view).toBe("prompts");
  });

  it("reports an error and keeps edits when the retry conflicts again", async () => {
    mockInitialLoad();
    const { result } = renderHook(() => useAppSettingsController(createDeps()));
    await act(async () => {
      await result.current.loadSettings();
    });

    invoke.mockImplementation((cmd: string) => {
      if (cmd === "update_settings") return Promise.reject(new Error(SETTINGS_CONFLICT_ERROR));
      if (cmd === "get_settings") return Promise.resolve({ settings: { ...baseSettings, revision: 3 }, load_warning: null });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      result.current.setAppearance("light");
    });
    await act(async () => {
      await result.current.retrySaveSettings();
    });

    expect(invoke.mock.calls.filter(([cmd]) => cmd === "update_settings")).toHaveLength(2);
    expect(result.current.settingsSaveStatus).toBe("error");
    expect(result.current.appSettings?.appearance).toBe("light");
  });
});

describe("useAppSettingsController resetSettings", () => {
  const customised: AppSettings = {
    ...baseSettings,
    revision: 4,
    appearance: "light",
    app_font_size: "large",
    accent_color: "#ff0000",
    reduce_motion: true,
    landing_view: "library",
    workspace_path: "/tmp/workspace",
    repo_dashboard_entries: [{ id: "repo-1", label: "Repo", path: "/tmp/repo" }],
    active_repo_dashboard_id: "repo-1",
  };

  beforeEach(() => {
    invoke.mockReset();
    confirmMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadCustomised() {
    mockInitialLoad(customised);
    const deps = createDeps();
    const hook = renderHook(() => useAppSettingsController(deps));
    await act(async () => {
      await hook.result.current.loadSettings();
    });
    return hook;
  }

  it("does nothing when the confirmation is declined", async () => {
    confirmMock.mockResolvedValue(false);
    const { result } = await loadCustomised();
    invoke.mockClear();

    await act(async () => {
      await result.current.resetSettings();
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.appSettings?.appearance).toBe("light");
  });

  it("resets appearance only, keeps repo and workspace fields, and applies the saved response", async () => {
    confirmMock.mockResolvedValue(true);
    const { result } = await loadCustomised();
    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings }) => {
      if (cmd === "update_settings") return Promise.resolve({ ...args?.settings, revision: 5 });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.resetSettings();
    });

    const updates = invoke.mock.calls.filter(([cmd]) => cmd === "update_settings");
    expect(updates).toHaveLength(1);
    const sent = updates[0][1].settings as AppSettings;
    expect(updates[0][1].expectedRevision).toBe(4);
    expect(sent.appearance).toBe("dark");
    expect(sent.app_font_size).toBe("medium");
    expect(sent.accent_color).toBeNull();
    expect(sent.reduce_motion).toBe(false);
    expect(sent.workspace_path).toBe("/tmp/workspace");
    expect(sent.repo_dashboard_entries).toEqual(customised.repo_dashboard_entries);
    expect(sent.active_repo_dashboard_id).toBe("repo-1");
    expect(sent.landing_view).toBe("library");

    expect(result.current.appSettings?.revision).toBe(5);
    expect(result.current.appSettings?.appearance).toBe("dark");
    expect(result.current.appSettings?.repo_dashboard_entries).toHaveLength(1);
    expect(result.current.colorResetKey).toBe(1);
    expect(result.current.settingsMsg).toEqual({ ok: true, text: "appearance reset to defaults" });
    expect(result.current.settingsSaveStatus).toBe("saved");
  });

  it("autosaves the next edit after a reset against the new revision", async () => {
    confirmMock.mockResolvedValue(true);
    const { result } = await loadCustomised();
    invoke.mockImplementation((cmd: string, args?: { settings?: AppSettings; expectedRevision?: number }) => {
      if (cmd === "update_settings") {
        return Promise.resolve({ ...args?.settings, revision: (args?.expectedRevision ?? 0) + 1 });
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.resetSettings();
    });
    await act(async () => {
      result.current.setAppFontSize("small");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    const updates = invoke.mock.calls.filter(([cmd]) => cmd === "update_settings");
    expect(updates).toHaveLength(2);
    expect(updates[1][1].expectedRevision).toBe(5);
    expect(updates[1][1].settings.app_font_size).toBe("small");
    expect(result.current.settingsSaveStatus).toBe("saved");
  });
});

describe("useAppSettingsController persistActiveWorkspace", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loaded(deps = createDeps()) {
    mockInitialLoad();
    const hook = renderHook(() => useAppSettingsController(deps));
    await act(async () => {
      await hook.result.current.loadSettings();
    });
    return { ...hook, deps };
  }

  it("validates through the backend, then switches the workspace and reloads what is bound to it", async () => {
    const { result, deps } = await loaded();
    const order: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      if (cmd === "try_set_active_workspace_path") return { ...baseSettings, workspace_path: "/tmp/other", revision: 2 };
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    deps.beginWorkspaceLoadGeneration.mockImplementation(() => {
      order.push("begin generation");
      return 7;
    });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.persistActiveWorkspace("/tmp/other");
    });

    expect(outcome).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("try_set_active_workspace_path", { path: "/tmp/other" });
    // Workspace-bound state is only reset once the backend accepted the folder.
    expect(order).toEqual(["try_set_active_workspace_path", "begin generation"]);
    expect(deps.beginWorkspaceLoadGeneration).toHaveBeenCalledWith(deps.resetWorkspaceBoundState);
    expect(deps.loadWorkspaceDiagnostics).toHaveBeenCalledWith(7);
    expect(deps.loadWorkspaceResources).toHaveBeenCalledWith(7);
    expect(result.current.appSettings?.workspace_path).toBe("/tmp/other");
    expect(result.current.appSettings?.revision).toBe(2);
    expect(deps.appliedWorkspacePathRef.current).toBe("/tmp/other");
    expect(result.current.settingsSaveStatus).toBe("saved");
  });

  it("returns the backend's reason for a refused folder and leaves the current workspace untouched", async () => {
    const { result, deps } = await loaded();
    invoke.mockRejectedValue("invalid workspace path: not a valid workspace (missing README.md)");

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.persistActiveWorkspace("/tmp/nope");
    });

    expect(outcome).toEqual({
      ok: false,
      message: "invalid workspace path: not a valid workspace (missing README.md)",
    });
    expect(deps.beginWorkspaceLoadGeneration).not.toHaveBeenCalled();
    expect(deps.resetWorkspaceBoundState).not.toHaveBeenCalled();
    expect(deps.loadWorkspaceResources).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
    expect(result.current.appSettings?.workspace_path).toBeNull();
  });

  it("resets to the default through its own command", async () => {
    const custom = { ...baseSettings, workspace_path: "/tmp/other", revision: 3 };
    mockInitialLoad(custom);
    const deps = createDeps();
    const { result } = renderHook(() => useAppSettingsController(deps));
    await act(async () => {
      await result.current.loadSettings();
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "reset_active_workspace_path") return { ...custom, workspace_path: null, revision: 4 };
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.persistActiveWorkspace(null);
    });

    expect(outcome).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("reset_active_workspace_path");
    expect(result.current.appSettings?.workspace_path).toBeNull();
    expect(deps.appliedWorkspacePathRef.current).toBeNull();
    expect(deps.loadWorkspaceResources).toHaveBeenCalledTimes(1);
  });

  it("keeps an edit that is still waiting for its autosave on top of the switched settings", async () => {
    const { result } = await loaded();
    await act(async () => {
      result.current.setAppFontSize("large");
    });
    invoke.mockImplementation(async (cmd: string, args?: { settings?: AppSettings; expectedRevision?: number }) => {
      if (cmd === "try_set_active_workspace_path") return { ...baseSettings, workspace_path: "/tmp/other", revision: 2 };
      if (cmd === "update_settings") return { ...args?.settings, revision: (args?.expectedRevision ?? 0) + 1 };
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await act(async () => {
      await result.current.persistActiveWorkspace("/tmp/other");
    });

    // The new workspace path and the pending font size both survive; the autosave then writes both once.
    expect(result.current.appSettings?.workspace_path).toBe("/tmp/other");
    expect(result.current.appSettings?.app_font_size).toBe("large");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    const updates = invoke.mock.calls.filter(([cmd]) => cmd === "update_settings");
    expect(updates).toHaveLength(1);
    expect(updates[0][1].expectedRevision).toBe(2);
    expect(updates[0][1].settings.workspace_path).toBe("/tmp/other");
    expect(updates[0][1].settings.app_font_size).toBe("large");
  });

  it("refuses a second switch while one is running", async () => {
    const { result } = await loaded();
    let finish: (settings: AppSettings) => void = () => {};
    invoke.mockImplementation(() => new Promise<AppSettings>(resolveSwitch => {
      finish = resolveSwitch;
    }));

    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = result.current.persistActiveWorkspace("/tmp/a");
      await Promise.resolve();
    });
    let second: unknown;
    await act(async () => {
      second = await result.current.persistActiveWorkspace("/tmp/b");
    });
    expect(second).toEqual({ ok: false, message: "a workspace change is already running" });

    await act(async () => {
      finish({ ...baseSettings, workspace_path: "/tmp/a", revision: 2 });
      await first;
    });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "try_set_active_workspace_path")).toHaveLength(1);
  });

  it("refuses before settings are loaded", async () => {
    const deps = createDeps();
    const { result } = renderHook(() => useAppSettingsController(deps));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.persistActiveWorkspace("/tmp/other");
    });
    expect(outcome).toEqual({ ok: false, message: "settings are not loaded yet" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
