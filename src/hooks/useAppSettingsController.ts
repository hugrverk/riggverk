import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
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
import type { AgentTargetMeta, AppSettings, TargetProfileMeta } from "../types";

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
  const appSettingsRef = useRef<AppSettings | null>(null);
  const [appSettings, setAppSettingsState] = useState<AppSettings | null>(null);
  const setAppSettings = useCallback((
    value: AppSettings | null | ((prev: AppSettings | null) => AppSettings | null),
  ) => {
    setAppSettingsState(prev => {
      const next = typeof value === "function" ? value(prev) : value;
      appSettingsRef.current = next;
      return next;
    });
  }, []);
  const [settingsMsg, setSettingsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [agentTargets, setAgentTargets] = useState<AgentTargetMeta[]>([]);
  const [targetProfiles, setTargetProfiles] = useState<TargetProfileMeta[]>([]);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsAutoSaveError, setSettingsAutoSaveError] = useState<string | null>(null);
  const [colorResetKey, setColorResetKey] = useState(0);

  const savedSettingsRef = useRef<string | null>(null);
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
      const [settings, targets, profiles] = await Promise.all([
        invoke<AppSettings>("get_settings"),
        invoke<AgentTargetMeta[]>("get_agent_targets"),
        invoke<TargetProfileMeta[]>("get_target_profiles"),
      ]);
      if (appliedWorkspacePathRef.current === undefined) {
        appliedWorkspacePathRef.current = settings.workspace_path ?? null;
      }
      setAppSettings(settings);
      settingsRevisionRef.current = settings.revision ?? 0;
      savedSettingsRef.current = serializeSettingsForCompare(settings);
      setAgentTargets(targets);
      setTargetProfiles(profiles);
      applyThemeSettings(settings);
      setSettingsMsg(null);
      setSettingsAutoSaveError(null);
      settingsLoadedRef.current = true;
    } catch (error) {
      setError(`Settings: ${error}`);
    }
  }, [appliedWorkspacePathRef, setError]);

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
      const saved = await invoke<AppSettings>("update_settings", {
        settings,
        expectedRevision: settingsRevisionRef.current,
      });
      if (workspacePathChanged && !isWorkspaceLoadCurrent(generation)) return false;

      const latest = appSettingsRef.current;
      const latestSerialized = latest ? serializeSettingsForCompare(latest) : null;
      const stillCurrent = latestSerialized === serialized;

      if (stillCurrent) {
        settingsRevisionRef.current = saved.revision ?? 0;
        setAppSettings(saved);
        appliedWorkspacePathRef.current = saved.workspace_path ?? null;
        savedSettingsRef.current = serializeSettingsForCompare(saved);
        applyThemeSettings(saved);
        if (options?.bumpColorResetKey) setColorResetKey(key => key + 1);
        setSettingsAutoSaveError(null);
        setSettingsMsg(options?.announce ? { ok: true, text: "settings saved" } : null);
      }

      if (stillCurrent) {
        if (workspacePathChanged) {
          await Promise.all([
            loadWorkspaceDiagnostics(generation).catch(() => {}),
            loadWorkspaceResources(generation),
          ]);
        } else {
          fetchStatus(generation);
          loadWorkspaceDiagnostics(generation);
        }
      }
      return stillCurrent;
    } catch (error) {
      const message = String(error);
      if (isSettingsConflictError(error)) {
        try {
          const latest = await invoke<AppSettings>("get_settings");
          settingsRevisionRef.current = latest.revision ?? 0;
          const latestSerialized = serializeSettingsForCompare(latest);
          const stillCurrent = appSettingsRef.current
            ? serializeSettingsForCompare(appSettingsRef.current) === serialized
            : false;
          if (stillCurrent) {
            setAppSettings(latest);
            savedSettingsRef.current = latestSerialized;
            applyThemeSettings(latest);
          }
          setSettingsAutoSaveError("settings conflict — reloaded latest");
          setSettingsMsg({ ok: false, text: "settings conflict — reloaded latest" });
        } catch (reloadError) {
          const reloadMessage = String(reloadError);
          setSettingsAutoSaveError(reloadMessage);
          setSettingsMsg({ ok: false, text: reloadMessage });
        }
        return false;
      }
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
    savedSettingsRef.current = serializeSettingsForCompare(saved);
    if (options?.skipAutosave) settingsAutosaveSkipRef.current = true;
    applyThemeSettings(saved);
    setSettingsMsg(null);
    setSettingsAutoSaveError(null);
  }, [appliedWorkspacePathRef]);

  const retrySaveSettings = useCallback(async () => {
    const current = appSettingsRef.current;
    if (!current) return;
    await persistAppSettings(current, { announce: true });
  }, [persistAppSettings]);

  const resetSettings = useCallback(async () => {
    settingsAutosaveSkipRef.current = true;
    const ok = await persistAppSettings(defaultSettings(), { bumpColorResetKey: true });
    if (ok) {
      setSettingsMsg({ ok: true, text: "reset to defaults" });
    }
  }, [persistAppSettings]);

  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    const current = appSettingsRef.current;
    if (!current || savedSettingsRef.current === null) return;

    const serialized = serializeSettingsForCompare(current);
    if (serialized === savedSettingsRef.current) return;
    if (settingsAutosaveSkipRef.current) {
      settingsAutosaveSkipRef.current = false;
      return;
    }

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

  const applyTargetProfile = useCallback((profileId: string) => {
    const profile = targetProfiles.find(item => item.id === profileId);
    if (!profile) return;
    setSettingsMsg(null);
    setAppSettings(prev => prev ? { ...prev, enabled_target_ids: [...profile.target_ids] } : prev);
  }, [targetProfiles]);

  const activeProfileId = useMemo(() => {
    if (!appSettings) return null;
    const currentSet = new Set(appSettings.enabled_target_ids);
    const match = targetProfiles.find(profile => {
      const profileSet = new Set(profile.target_ids);
      if (profileSet.size !== currentSet.size) return false;
      for (const id of profileSet) {
        if (!currentSet.has(id)) return false;
      }
      return true;
    });
    return match ? match.id : null;
  }, [appSettings, targetProfiles]);

  const persistActiveWorkspace = useCallback(async (path: string) => {
    if (!appSettings) return;
    const generation = beginWorkspaceLoadGeneration(resetWorkspaceBoundState);
    try {
      const saved = await invoke<AppSettings>("try_set_active_workspace_path", { path });
      if (!isWorkspaceLoadCurrent(generation)) return;
      applySavedSettings(saved, { skipAutosave: true });
      await Promise.all([
        loadWorkspaceDiagnostics(generation).catch(() => {}),
        loadWorkspaceResources(generation),
      ]);
    } catch (error) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Activate workspace: ${error}`);
    }
  }, [
    appSettings,
    applySavedSettings,
    beginWorkspaceLoadGeneration,
    isWorkspaceLoadCurrent,
    loadWorkspaceDiagnostics,
    loadWorkspaceResources,
    resetWorkspaceBoundState,
    setError,
  ]);

  const clearSettingsMsg = useCallback(() => setSettingsMsg(null), []);

  const mutateAppSettings = useCallback<MutateAppSettings>(async mutator => {
    const opId = ++settingsMutationSeqRef.current;
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let base = appSettingsRef.current;
      if (!base) throw new Error("settings not loaded");

      if (attempt > 0) {
        const latest = await invoke<AppSettings>("get_settings");
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
        savedSettingsRef.current = serializeSettingsForCompare(saved);
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
  }, []);

  return {
    appSettings,
    setAppSettings,
    settingsMsg,
    agentTargets,
    targetProfiles,
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
    toggleTarget,
    applyTargetProfile,
    activeProfileId,
    clearSettingsMsg,
    setSettingsMsg,
    mutateAppSettings,
  };
}
