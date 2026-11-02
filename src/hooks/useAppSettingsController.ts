import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useConfirm } from "../components/ConfirmDialog";
import { isSettingsConflictError } from "../lib/appSettingsMutation";
import { mergePendingLocalOntoAcknowledged } from "../lib/mergePendingAppSettings";
import {
  applyThemeSettings,
  defaultSettings,
  serializeSettingsForCompare,
  SETTINGS_AUTOSAVE_DEBOUNCE_MS,
  type SettingsSaveStatus,
} from "../lib/settingsDraft";
import { workspaceTaskBlockedMessage } from "../lib/workspaceErrors";
import type { AgentTargetMeta, AppSettings, GetSettingsResponse, InstallAgent, UpdateCheckChoice } from "../types";

/**
 * Harness and target toggles as the backend last acknowledged them. Its status commands filter on the saved
 * settings, so anything that asks the backend about them must follow this, not an edit still in memory.
 */
export interface SavedSelection {
  harnessIds: InstallAgent[];
  targetIds: string[];
}

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Outcome of resetting the workspace folder; `message` is the backend's reason when it was refused. */
export type WorkspaceSwitchResult = { ok: true } | { ok: false; message: string };

export interface AppSettingsControllerDeps {
  setError: (message: string | null) => void;
  appliedWorkspacePathRef: MutableRefObject<string | null | undefined>;
  workspaceLoadGenerationRef: MutableRefObject<number>;
  isWorkspaceLoadCurrent: (generation: number) => boolean;
  beginWorkspaceLoadGeneration: (resetFn: () => void) => number;
  resetWorkspaceBoundState: () => void;
  loadWorkspaceDiagnostics: (generation?: number) => Promise<void>;
  loadWorkspaceResources: (generation?: number) => Promise<void>;
  /** Label of the workspace task in flight (apply, uninstall, rollback, ...), or null. A switch must not run under it. */
  workspaceTaskLabel?: string | null;
}

export function useAppSettingsController({
  setError,
  appliedWorkspacePathRef,
  workspaceLoadGenerationRef,
  isWorkspaceLoadCurrent,
  beginWorkspaceLoadGeneration,
  resetWorkspaceBoundState,
  loadWorkspaceDiagnostics,
  loadWorkspaceResources,
  workspaceTaskLabel = null,
}: AppSettingsControllerDeps) {
  const confirm = useConfirm();
  const workspaceTaskLabelRef = useRef(workspaceTaskLabel);
  workspaceTaskLabelRef.current = workspaceTaskLabel;
  const appSettingsRef = useRef<AppSettings | null>(null);
  const [appSettings, setAppSettingsState] = useState<AppSettings | null>(null);
  const setAppSettings = useCallback((
    value: AppSettings | null | ((prev: AppSettings | null) => AppSettings | null),
  ) => {
    // The ref is the source of truth and must be current before the next await, not after React renders.
    const next = typeof value === "function" ? value(appSettingsRef.current) : value;
    appSettingsRef.current = next;
    setAppSettingsState(next);
  }, []);
  const [settingsMsg, setSettingsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [agentTargets, setAgentTargets] = useState<AgentTargetMeta[]>([]);

  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsAutoSaveError, setSettingsAutoSaveError] = useState<string | null>(null);
  const [colorResetKey, setColorResetKey] = useState(0);

  const savedSettingsRef = useRef<string | null>(null);
  const [savedSelection, setSavedSelection] = useState<SavedSelection | null>(null);
  const acknowledgeSaved = useCallback((saved: AppSettings) => {
    savedSettingsRef.current = serializeSettingsForCompare(saved);
    const harnessIds = saved.enabled_harness_ids ?? [];
    const targetIds = saved.enabled_target_ids;
    setSavedSelection(previous =>
      previous && sameList(previous.harnessIds, harnessIds) && sameList(previous.targetIds, targetIds)
        ? previous
        : { harnessIds, targetIds },
    );
  }, []);
  const settingsRevisionRef = useRef(0);
  const settingsLoadedRef = useRef(false);
  const settingsAutosaveInFlightRef = useRef<string | null>(null);
  const settingsAutosaveSkipRef = useRef(false);

  const settingsDirty = useMemo(() => {
    if (!appSettings || savedSettingsRef.current === null) return false;
    return serializeSettingsForCompare(appSettings) !== savedSettingsRef.current;
  }, [appSettings]);

  const settingsSaveStatus: SettingsSaveStatus = useMemo(() => {
    if (settingsAutoSaveError) return "error";
    if (settingsSaving) return "saving";
    if (settingsDirty) return "pending";
    return "saved";
  }, [settingsAutoSaveError, settingsSaving, settingsDirty]);

  const loadGenerationRef = useRef(0);
  const loadSettings = useCallback(async () => {
    // A read that finishes after a newer read began, or after the settings changed here (an edit or a write), is stale.
    const loadGeneration = ++loadGenerationRef.current;
    const startedFrom = appSettingsRef.current;
    const startedRevision = settingsRevisionRef.current;
    try {
      const [settingsResponse, targets] = await Promise.all([
        invoke<GetSettingsResponse>("get_settings"),
        invoke<AgentTargetMeta[]>("get_agent_targets"),
      ]);
      if (
        loadGenerationRef.current !== loadGeneration ||
        appSettingsRef.current !== startedFrom ||
        settingsRevisionRef.current !== startedRevision
      ) {
        return;
      }
      const settings = settingsResponse.settings;
      if (appliedWorkspacePathRef.current === undefined) {
        appliedWorkspacePathRef.current = settings.workspace_path ?? null;
      }
      setAppSettings(settings);
      settingsRevisionRef.current = settings.revision ?? 0;
      acknowledgeSaved(settings);
      if (settingsResponse.load_warning) {
        setSettingsMsg({ ok: false, text: settingsResponse.load_warning });
      } else {
        setSettingsMsg(null);
      }
      setAgentTargets(targets);
      applyThemeSettings(settings);
      setSettingsAutoSaveError(null);
      settingsLoadedRef.current = true;
    } catch (error) {
      setError(`Settings: ${error}`);
    }
  }, [acknowledgeSaved, appliedWorkspacePathRef, setError]);

  const persistAppSettings = useCallback(async (
    settings: AppSettings,
    options?: { bumpColorResetKey?: boolean; announce?: boolean },
  ): Promise<boolean> => {
    const serialized = serializeSettingsForCompare(settings);
    if (settingsAutosaveInFlightRef.current === serialized) return false;

    const nextWorkspacePath = settings.workspace_path ?? null;
    const workspacePathChanged = appliedWorkspacePathRef.current !== undefined
      && nextWorkspacePath !== appliedWorkspacePathRef.current;
    const generation = workspacePathChanged
      ? beginWorkspaceLoadGeneration(resetWorkspaceBoundState)
      : workspaceLoadGenerationRef.current;

    settingsAutosaveInFlightRef.current = serialized;
    setSettingsSaving(true);

    try {
      let payload = settings;
      for (let attempt = 0; ; attempt++) {
        try {
          const saved = await invoke<AppSettings>("update_settings", {
            settings: payload,
            expectedRevision: settingsRevisionRef.current,
          });
          if (workspacePathChanged && !isWorkspaceLoadCurrent(generation)) return false;

          // The write is on disk: always advance the CAS revision, even if the user kept editing meanwhile.
          settingsRevisionRef.current = saved.revision ?? 0;
          acknowledgeSaved(saved);

          const latest = appSettingsRef.current;
          const latestSerialized = latest ? serializeSettingsForCompare(latest) : null;
          const stillCurrent = latestSerialized === serialized;

          if (stillCurrent) {
            setAppSettings(saved);
            appliedWorkspacePathRef.current = saved.workspace_path ?? null;
            applyThemeSettings(saved);
            if (options?.bumpColorResetKey) setColorResetKey(key => key + 1);
            setSettingsAutoSaveError(null);
            if (options?.announce) {
              setSettingsMsg({ ok: true, text: "settings saved" });
            }
            if (workspacePathChanged) {
              await Promise.all([
                loadWorkspaceDiagnostics(generation).catch(() => {}),
                loadWorkspaceResources(generation),
              ]);
            } else {
              loadWorkspaceDiagnostics(generation);
            }
          } else if (latest) {
            // Newer local edits stay pending on top of what was just acknowledged.
            setAppSettings(mergePendingLocalOntoAcknowledged(saved, latest, serialized));
          }
          return stillCurrent;
        } catch (error) {
          if (!isSettingsConflictError(error) || attempt > 0) throw error;
          // Another writer won the compare-and-swap: rebase pending local edits onto the latest file and retry once.
          const latestResponse = await invoke<GetSettingsResponse>("get_settings");
          const acknowledged = latestResponse.settings;
          settingsRevisionRef.current = acknowledged.revision ?? 0;
          payload = mergePendingLocalOntoAcknowledged(
            acknowledged,
            appSettingsRef.current ?? settings,
            savedSettingsRef.current,
          );
        }
      }
    } catch (error) {
      const message = String(error);
      setSettingsAutoSaveError(message);
      setSettingsMsg({ ok: false, text: message });
      return false;
    } finally {
      if (settingsAutosaveInFlightRef.current === serialized) {
        settingsAutosaveInFlightRef.current = null;
      }
      setSettingsSaving(false);
    }
  }, [
    acknowledgeSaved,
    appliedWorkspacePathRef,
    beginWorkspaceLoadGeneration,
    isWorkspaceLoadCurrent,
    loadWorkspaceDiagnostics,
    loadWorkspaceResources,
    resetWorkspaceBoundState,
    workspaceLoadGenerationRef,
  ]);

  const applySavedSettings = useCallback((saved: AppSettings, options?: { skipAutosave?: boolean }) => {
    setAppSettings(saved);
    settingsRevisionRef.current = saved.revision ?? 0;
    appliedWorkspacePathRef.current = saved.workspace_path ?? null;
    acknowledgeSaved(saved);
    if (options?.skipAutosave) settingsAutosaveSkipRef.current = true;
    applyThemeSettings(saved);
    setSettingsMsg(null);
    setSettingsAutoSaveError(null);
  }, [acknowledgeSaved, appliedWorkspacePathRef]);

  const retrySaveSettings = useCallback(async () => {
    const current = appSettingsRef.current;
    if (!current) return;
    await persistAppSettings(current, { announce: true });
  }, [persistAppSettings]);

  const resetSettings = useCallback(async () => {
    const confirmed = await confirm({
      title: "Reset appearance",
      message: "Reset theme, font size, colors and motion to defaults? Workspace settings are kept.",
      confirmLabel: "reset",
      destructive: true,
    });
    if (!confirmed) return;
    const current = appSettingsRef.current;
    if (!current) return;

    // Appearance only: workspace path, targets, harnesses and landing page stay.
    const defaults = defaultSettings();
    const next: AppSettings = {
      ...current,
      appearance: defaults.appearance,
      app_font_size: defaults.app_font_size,
      accent_color: defaults.accent_color,
      background_color: defaults.background_color,
      foreground_color: defaults.foreground_color,
      motion: defaults.motion,
    };
    setSettingsMsg(null);
    setAppSettings(next);
    applyThemeSettings(next);
    const ok = await persistAppSettings(next, { bumpColorResetKey: true });
    if (ok) {
      setSettingsMsg({ ok: true, text: "appearance reset to defaults" });
    }
  }, [confirm, persistAppSettings]);

  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    const current = appSettingsRef.current;
    if (!current || savedSettingsRef.current === null) return;

    // Consume the skip flag on every pass so it can never swallow a later, unrelated edit.
    const skipAutosave = settingsAutosaveSkipRef.current;
    settingsAutosaveSkipRef.current = false;
    const serialized = serializeSettingsForCompare(current);
    if (serialized === savedSettingsRef.current) return;
    if (skipAutosave) return;

    const timer = window.setTimeout(() => {
      const latest = appSettingsRef.current;
      if (!latest || savedSettingsRef.current === null) return;
      const payload = serializeSettingsForCompare(latest);
      if (payload === savedSettingsRef.current) return;
      if (settingsAutosaveInFlightRef.current === payload) return;
      void persistAppSettings(latest);
    }, SETTINGS_AUTOSAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [appSettings, persistAppSettings]);

  /**
   * Writes a change that is still inside the autosave delay (or waits for the write already under way), for a window
   * that is about to close. Resolves true when nothing is left unsaved.
   */
  const flushSettings = useCallback(async (): Promise<boolean> => {
    if (!settingsLoadedRef.current) return true;
    // A write of this very text is in flight: wait for it, then look again.
    for (let waited = 0; settingsAutosaveInFlightRef.current !== null && waited < 50; waited++) {
      await new Promise(resolve => window.setTimeout(resolve, 100));
    }
    const latest = appSettingsRef.current;
    if (!latest || savedSettingsRef.current === null) return true;
    if (serializeSettingsForCompare(latest) === savedSettingsRef.current) return true;
    return persistAppSettings(latest);
  }, [persistAppSettings]);

  const updateThemeField = useCallback(<K extends keyof AppSettings>(field: K, value: AppSettings[K]) => {
    setSettingsMsg(null);
    setAppSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, [field]: value };
      applyThemeSettings(next);
      return next;
    });
  }, []);

  const setAppearance = useCallback((appearance: AppSettings["appearance"]) => {
    setSettingsMsg(null);
    setAppSettings(prev => {
      if (!prev) return prev;
      const next = {
        ...prev,
        appearance,
        background_color: null,
        foreground_color: null,
      };
      applyThemeSettings(next);
      return next;
    });
  }, []);

  const setAppFontSize = useCallback((appFontSize: AppSettings["app_font_size"]) => {
    updateThemeField("app_font_size", appFontSize);
  }, [updateThemeField]);

  const setAccentColor = useCallback((accentColor: string | null) => {
    updateThemeField("accent_color", accentColor);
  }, [updateThemeField]);

  const setBackgroundColor = useCallback((backgroundColor: string | null) => {
    updateThemeField("background_color", backgroundColor);
  }, [updateThemeField]);

  const setForegroundColor = useCallback((foregroundColor: string | null) => {
    updateThemeField("foreground_color", foregroundColor);
  }, [updateThemeField]);

  const setMotion = useCallback((motion: AppSettings["motion"]) => {
    updateThemeField("motion", motion);
  }, [updateThemeField]);

  const setLandingView = useCallback((landingView: string) => {
    setSettingsMsg(null);
    setAppSettings(prev => (prev ? { ...prev, landing_view: landingView } : prev));
  }, []);

  /** Records the app version whose "what's new" was handled; autosaved like any other setting. */
  const setLastSeenVersion = useCallback((version: string) => {
    setAppSettings(prev => (prev && prev.last_seen_version !== version ? { ...prev, last_seen_version: version } : prev));
  }, []);

  /** The update check choice from the consent card or Settings; autosaved. */
  const setUpdateCheck = useCallback((choice: UpdateCheckChoice) => {
    setSettingsMsg(null);
    setAppSettings(prev => (prev && prev.update_check !== choice ? { ...prev, update_check: choice } : prev));
  }, []);

  /** Records a successful update check (seconds since the epoch); autosaved like any other setting. */
  const setLastUpdateCheck = useCallback((seconds: number) => {
    setAppSettings(prev => (prev ? { ...prev, last_update_check: seconds } : prev));
  }, []);

  const toggleTarget = useCallback((id: string) => {
    setSettingsMsg(null);
    setAppSettings(prev => {
      if (!prev) return prev;
      const ids = prev.enabled_target_ids.includes(id)
        ? prev.enabled_target_ids.filter(targetId => targetId !== id)
        : [...prev.enabled_target_ids, id];
      return { ...prev, enabled_target_ids: ids };
    });
  }, []);

  const toggleHarness = useCallback((id: InstallAgent) => {
    setSettingsMsg(null);
    setAppSettings(prev => {
      if (!prev) return prev;
      const current = prev.enabled_harness_ids ?? [];
      const ids = current.includes(id)
        ? current.filter(harnessId => harnessId !== id)
        : [...current, id];
      return { ...prev, enabled_harness_ids: ids };
    });
  }, []);

  const workspaceSwitchInFlightRef = useRef(false);

  /**
   * Drops the saved custom workspace folder (back to the default) and reloads everything bound to it, without a
   * full app reload. The backend clears the saved path first; only an accepted reset resets workspace-bound
   * state, so a refused one leaves the current workspace untouched. Resolves with the backend's error text
   * instead of raising it. The app no longer sets a custom folder: this is the only workspace path change left.
   */
  const resetActiveWorkspace = useCallback(async (): Promise<WorkspaceSwitchResult> => {
    if (!appSettingsRef.current) return { ok: false, message: "settings are not loaded yet" };
    if (workspaceTaskLabelRef.current) return { ok: false, message: workspaceTaskBlockedMessage(workspaceTaskLabelRef.current) };
    if (workspaceSwitchInFlightRef.current) return { ok: false, message: "a workspace change is already running" };
    workspaceSwitchInFlightRef.current = true;
    try {
      let saved: AppSettings;
      try {
        saved = await invoke<AppSettings>("reset_active_workspace_path");
      } catch (error) {
        return { ok: false, message: String(error) };
      }

      const generation = beginWorkspaceLoadGeneration(resetWorkspaceBoundState);
      const local = appSettingsRef.current;
      const baseline = savedSettingsRef.current;
      if (local && baseline !== null && serializeSettingsForCompare(local) !== baseline) {
        // Edits still waiting for their autosave stay pending on top of the acknowledged settings.
        settingsRevisionRef.current = saved.revision ?? 0;
        appliedWorkspacePathRef.current = saved.workspace_path ?? null;
        acknowledgeSaved(saved);
        setAppSettings({
          ...mergePendingLocalOntoAcknowledged(saved, local, baseline),
          workspace_path: saved.workspace_path,
        });
      } else {
        applySavedSettings(saved, { skipAutosave: true });
      }
      await Promise.all([
        loadWorkspaceDiagnostics(generation).catch(() => {}),
        loadWorkspaceResources(generation),
      ]);
      return { ok: true };
    } finally {
      workspaceSwitchInFlightRef.current = false;
    }
  }, [
    acknowledgeSaved,
    applySavedSettings,
    appliedWorkspacePathRef,
    beginWorkspaceLoadGeneration,
    loadWorkspaceDiagnostics,
    loadWorkspaceResources,
    resetWorkspaceBoundState,
    setAppSettings,
  ]);

  const clearSettingsMsg = useCallback(() => setSettingsMsg(null), []);

  return {
    appSettings,
    savedSelection,
    setAppSettings,
    settingsMsg,
    agentTargets,
    settingsDirty,
    settingsSaving,
    settingsSaveStatus,
    settingsAutoSaveError,
    colorResetKey,
    loadSettings,
    persistAppSettings,
    flushSettings,
    applySavedSettings,
    retrySaveSettings,
    resetSettings,
    resetActiveWorkspace,
    setAppearance,
    setAppFontSize,
    setAccentColor,
    setBackgroundColor,
    setForegroundColor,
    setMotion,
    setLandingView,
    setLastSeenVersion,
    setUpdateCheck,
    setLastUpdateCheck,
    toggleTarget,
    toggleHarness,
    clearSettingsMsg,
    setSettingsMsg,
  };
}
