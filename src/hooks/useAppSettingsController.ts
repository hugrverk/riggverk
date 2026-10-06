import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useConfirm } from "../components/ConfirmDialog";
import { isSettingsConflictError } from "../lib/appSettingsMutation";
import {
  applyMutationPreservingPendingLocal,
  mergePendingLocalOntoAcknowledged,
} from "../lib/mergePendingAppSettings";
import {
  applyThemeSettings,
  defaultSettings,
  serializeSettingsForCompare,
  SETTINGS_AUTOSAVE_DEBOUNCE_MS,
  type SettingsSaveStatus,
} from "../lib/settingsDraft";
import type { MutateAppSettings } from "../lib/useSavedRepoEntriesController";
import type { AgentTargetMeta, AppSettings, GetSettingsResponse, InstallAgent } from "../types";

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

/** Outcome of switching the active workspace; `message` is the backend's reason when it was refused. */
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
  fetchStatus: (generation?: number) => Promise<void>;
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
  fetchStatus,
}: AppSettingsControllerDeps) {
  const confirm = useConfirm();
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
  const settingsMutationSeqRef = useRef(0);

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

  const loadSettings = useCallback(async () => {
    try {
      const [settingsResponse, targets] = await Promise.all([
        invoke<GetSettingsResponse>("get_settings"),
        invoke<AgentTargetMeta[]>("get_agent_targets"),
      ]);
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
              fetchStatus(generation);
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
    fetchStatus,
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
      message: "Reset theme, font size, colors and motion to defaults? Workspace and repository settings are kept.",
      confirmLabel: "reset",
      destructive: true,
    });
    if (!confirmed) return;
    const current = appSettingsRef.current;
    if (!current) return;

    // Appearance only: workspace path, repo dashboard entries, targets, harnesses and landing page stay.
    const defaults = defaultSettings();
    const next: AppSettings = {
      ...current,
      appearance: defaults.appearance,
      app_font_size: defaults.app_font_size,
      accent_color: defaults.accent_color,
      background_color: defaults.background_color,
      foreground_color: defaults.foreground_color,
      reduce_motion: defaults.reduce_motion,
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

  const setReduceMotion = useCallback((reduceMotion: boolean) => {
    updateThemeField("reduce_motion", reduceMotion);
  }, [updateThemeField]);

  const setLandingView = useCallback((landingView: string) => {
    setSettingsMsg(null);
    setAppSettings(prev => (prev ? { ...prev, landing_view: landingView } : prev));
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
   * Makes `path` the active workspace (null: back to the default) and reloads everything bound to it, without
   * a full app reload. The backend validates the folder and persists the choice first; only an accepted
   * folder resets workspace-bound state, so a rejected one leaves the current workspace untouched.
   * Resolves with the backend's error text instead of raising it.
   */
  const persistActiveWorkspace = useCallback(async (path: string | null): Promise<WorkspaceSwitchResult> => {
    if (!appSettingsRef.current) return { ok: false, message: "settings are not loaded yet" };
    if (workspaceSwitchInFlightRef.current) return { ok: false, message: "a workspace change is already running" };
    workspaceSwitchInFlightRef.current = true;
    try {
      let saved: AppSettings;
      try {
        saved = path === null
          ? await invoke<AppSettings>("reset_active_workspace_path")
          : await invoke<AppSettings>("try_set_active_workspace_path", { path });
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

  const mutateAppSettings = useCallback<MutateAppSettings>(async mutator => {
    const opId = ++settingsMutationSeqRef.current;
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let base = appSettingsRef.current;
      if (!base) throw new Error("settings not loaded");

      if (attempt > 0) {
        const latestResponse = await invoke<GetSettingsResponse>("get_settings");
        const latest = latestResponse.settings;
        if (opId !== settingsMutationSeqRef.current) {
          return latest;
        }
        settingsRevisionRef.current = latest.revision ?? 0;
        base = mergePendingLocalOntoAcknowledged(
          latest,
          appSettingsRef.current ?? latest,
          savedSettingsRef.current,
        );
      }

      const acknowledgedAtStart = savedSettingsRef.current;
      const next = mutator(base);
      const sentSerialized = serializeSettingsForCompare(next);

      try {
        const saved = await invoke<AppSettings>("update_settings", {
          settings: next,
          expectedRevision: settingsRevisionRef.current,
        });
        if (opId !== settingsMutationSeqRef.current) {
          return saved;
        }

        const merged = applyMutationPreservingPendingLocal(
          saved,
          sentSerialized,
          appSettingsRef.current,
          acknowledgedAtStart,
        );
        settingsRevisionRef.current = saved.revision ?? 0;
        acknowledgeSaved(saved);
        setAppSettings(merged);
        applyThemeSettings(merged);
        setSettingsAutoSaveError(null);
        return saved;
      } catch (error) {
        if (!isSettingsConflictError(error) || attempt === maxAttempts - 1) {
          throw error;
        }
      }
    }

    throw new Error("settings conflict");
  }, [acknowledgeSaved]);

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
    applySavedSettings,
    retrySaveSettings,
    resetSettings,
    persistActiveWorkspace,
    setAppearance,
    setAppFontSize,
    setAccentColor,
    setBackgroundColor,
    setForegroundColor,
    setReduceMotion,
    setLandingView,
    toggleTarget,
    toggleHarness,
    clearSettingsMsg,
    setSettingsMsg,
    mutateAppSettings,
  };
}
