import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { version as APP_VERSION } from "../package.json";
import { LEAVE_DIRTY_MESSAGE } from "./lib/editorGuards";
import { invokeOpen } from "./lib/invokeOpen";
import { useConfirm } from "./components/ConfirmDialog";
import { useKeymap } from "./keyboard/useKeymap";
import { useBackups } from "./lib/useBackups";
import { decideCountsByHarness, updateAllDisabledReason } from "./lib/shellSummary";
import { useUninstallRecovery } from "./lib/useUninstallRecovery";
import { useWorkspaceActions } from "./lib/useWorkspaceActions";
import { useWorkspaceGeneration } from "./lib/useWorkspaceGeneration";
import { useAppSettingsController } from "./hooks/useAppSettingsController";
import { useApplyProgress } from "./hooks/useApplyProgress";
import { useCheckedAt } from "./hooks/useCheckedAt";
import { useWhatsNewOnUpgrade } from "./hooks/useWhatsNewOnUpgrade";
import { useWorkspaceReset } from "./hooks/useWorkspaceReset";
import { workspaceTaskBlockedMessage } from "./lib/workspaceErrors";
import { useEffectiveSkillLoads } from "./hooks/useEffectiveSkillLoads";
import { useInstallationOverview } from "./hooks/useInstallationOverview";
import { useInstallScreen } from "./hooks/useInstallScreen";
import { useRollbackRequest } from "./hooks/useRollbackRequest";
import { useLandingView } from "./hooks/useLandingView";
import { BUNDLED_CONFIG_TARGET_IDS, useLibraryController } from "./hooks/useLibraryController";
import { useWorkspaceHealthController } from "./hooks/useWorkspaceHealthController";
import { CodexView } from "./views/CodexView";
import { CursorView } from "./views/CursorView";
import { ClaudeView } from "./views/ClaudeView";
import { LightHarnessView } from "./views/LightHarnessView";
import { OpenCodeView } from "./views/OpenCodeView";
import { HistoryView } from "./views/HistoryView";
import { OverviewView } from "./views/OverviewView";
const LibraryView = lazy(() => import("./views/LibraryView").then(m => ({ default: m.LibraryView })));
const SettingsView = lazy(() => import("./views/SettingsView").then(m => ({ default: m.SettingsView })));
import { harnessForView } from "./lib/harnessInstallation";
import { filterVisibleMetadataTargets } from "./lib/harnessVisibility";
import type { HarnessRuntimeHealth } from "./lib/harnessRuntimeRows";
import { redactTerminalOutput } from "./lib/redactTerminalOutput";
import { AppFrame, ShellProviders, useAppCommands, useShellState, type AppView } from "./shell";
import { LIGHT_AGENTS, type InstallAgent, type SetupResult } from "./types";

type View = AppView;

/** The workspace page and every harness page show diagnostics and runtime health. */
function isWorkspaceLoadView(view: View): boolean {
  return view === "start" || harnessForView(view) !== null;
}

/* ---- main app ---- */

/**
 * Inner app shell that uses the confirm dialog context.
 * Rendered by `App()` inside `ShellProviders`, which also provides the confirm dialog.
 */
function AppShell() {
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("start");
  const viewRef = useRef<View>("start");
  useEffect(() => { viewRef.current = view; }, [view]);
  const appliedWorkspacePathRef = useRef<string | null | undefined>(undefined);
  const confirm = useConfirm();
  const enabledHarnessIdsRef = useRef<InstallAgent[]>([]);

  // backup history state
  const { backups, loadBackups, openBackupsFolder } = useBackups(setError);

  // workspace resource generation
  const { workspaceLoadGenerationRef, isWorkspaceLoadCurrent, beginWorkspaceLoadGeneration } = useWorkspaceGeneration();

  const {
    workspaceDiagnostics,
    opencodeRuntimeHealth,
    codexRuntimeHealth,
    cursorProfileHealth,
    claudeRuntimeHealth,
    lightRuntimeHealth,
    fetchStatus,
    loadWorkspaceDiagnostics,
    loadOpenCodeRuntimeHealth,
    loadCodexRuntimeHealth,
    loadCursorProfileHealth,
    loadClaudeRuntimeHealth,
    loadLightRuntimeHealth,
    resetWorkspaceHealthState,
    clearHarnessHealth,
    isInvalidWorkspaceError,
  } = useWorkspaceHealthController({
    setError,
    workspaceLoadGenerationRef,
    isWorkspaceLoadCurrent,
  });

  const {
    skills,
    packLibrary,
    packError,
    forgetPack,
    activeSkillId,
    activeSkillContent,
    skillSearch,
    setSkillSearch,
    readSkill,
    docs,
    activeDoc,
    docDraft,
    docDirty,
    docSaving,
    docSaveResult,
    docMode,
    setDocMode,
    showCreateDoc,
    createDocTitle,
    createDocSlug,
    createDocError,
    createDocCreating,
    setShowCreateDoc,
    setCreateDocTitle,
    setCreateDocSlug,
    selectDoc,
    openDocEditor,
    onChangeDocDraft,
    onSaveDoc,
    onResetDoc,
    onCreateDoc,
    agentTemplate,
    rulesFiles,
    activeRulesSurface,
    activeRulesFile,
    rulesDraft,
    rulesDirty,
    rulesSaving,
    rulesSaveResult,
    selectRulesFile,
    openRulesFile,
    onChangeRulesDraft,
    onSaveRules,
    onResetRules,
    librarySourceType,
    setGuardedLibrarySourceType,
    isLibrarySourceDirty,
    discardDrafts,
    libraryDirty,
    agentSources,
    activeAgentId,
    activeAgentContent,
    selectAgent,
    configTemplateContent,
    activeConfigTargetId,
    setActiveConfigTargetId,
    configEditorSources,
    activeConfigSourceType,
    configEditorSourceContent,
    selectConfigTarget,
    selectConfigSourceType,
    loadDocs,
    loadWorkspaceLibraryResources,
    loadLibraryView,
    resetLibraryState,
  } = useLibraryController({
    setError,
    workspaceLoadGenerationRef,
    isWorkspaceLoadCurrent,
    isInvalidWorkspaceError,
    fetchStatus,
    view,
  });

  const loadEnabledHarnessHealth = useCallback(async (
    generation = workspaceLoadGenerationRef.current,
    harnesses = enabledHarnessIdsRef.current,
  ) => {
    const loaders: Record<InstallAgent, (generation?: number) => Promise<void>> = {
      codex: loadCodexRuntimeHealth,
      opencode: loadOpenCodeRuntimeHealth,
      claude: loadClaudeRuntimeHealth,
      cursor: loadCursorProfileHealth,
      copilot: generation => loadLightRuntimeHealth("copilot", generation),
      pi: generation => loadLightRuntimeHealth("pi", generation),
      kilo: generation => loadLightRuntimeHealth("kilo", generation),
    };
    await Promise.all(harnesses.map(harness => loaders[harness](generation).catch(() => {})));
  }, [
    loadCodexRuntimeHealth,
    loadOpenCodeRuntimeHealth,
    loadClaudeRuntimeHealth,
    loadCursorProfileHealth,
    loadLightRuntimeHealth,
    workspaceLoadGenerationRef,
  ]);

  const loadWorkspaceResources = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    const tasks: Promise<unknown>[] = [
      fetchStatus(generation).catch(() => {}),
      loadEnabledHarnessHealth(generation),
    ];
    // Library data is loaded on demand by loadLibraryView when the Library
    // opens; refresh here only when it is the active view (workspace change).
    if (viewRef.current === "library") {
      tasks.push(loadWorkspaceLibraryResources(generation));
    }
    await Promise.all(tasks);
  }, [loadWorkspaceLibraryResources, fetchStatus, loadEnabledHarnessHealth, workspaceLoadGenerationRef]);

  const {
    transactionId: uninstallRecoveryTransactionId,
    captureFromUninstallResult,
    clearRecovery: clearUninstallRecovery,
  } = useUninstallRecovery();
  // Transaction the last successful install left; `z` and `:rollback` restore it from its backup.
  const [applyTransactionId, setApplyTransactionId] = useState<string | null>(null);
  const rollbackTransactionId = applyTransactionId ?? uninstallRecoveryTransactionId;
  const [uninstallPreviewRequested, setUninstallPreviewRequested] = useState(false);
  const [overviewRefreshKey, setOverviewRefreshKey] = useState(0);
  const { notify } = useShellState();

  // workspace action runner (terminal output, activity animation, action wrappers)
  const {
    wsRunning,
    wsLog,
    wsLogCompletedAt,
    runWsTask,
    workspaceActionRequestIdRef,
    resetTerminalOutput,
  } = useWorkspaceActions({ setError });

  const wsProgress = useApplyProgress(wsRunning);

  // Keep the backups chip current: on mount and whenever a workspace task (apply, uninstall, rollback) finishes.
  useEffect(() => {
    if (!wsRunning) void loadBackups();
  }, [wsRunning, loadBackups]);

  const resetWorkspaceBoundState = useCallback(() => {
    workspaceActionRequestIdRef.current += 1;
    resetTerminalOutput();
    clearUninstallRecovery();
    setApplyTransactionId(null);
    resetWorkspaceHealthState();
    resetLibraryState();
  }, [workspaceActionRequestIdRef, resetTerminalOutput, clearUninstallRecovery, resetWorkspaceHealthState, resetLibraryState]);

  const {
    appSettings,
    savedSelection,
    settingsMsg,
    agentTargets,
    settingsDirty,
    settingsSaving,
    settingsSaveStatus,
    colorResetKey,
    loadSettings,
    retrySaveSettings,
    resetSettings,
    setAppearance,
    setAppFontSize,
    setAccentColor,
    setBackgroundColor,
    setForegroundColor,
    setMotion,
    setLandingView,
    setLastSeenVersion,
    toggleTarget,
    toggleHarness,
    clearSettingsMsg,
    resetActiveWorkspace,
  } = useAppSettingsController({
    setError,
    appliedWorkspacePathRef,
    workspaceLoadGenerationRef,
    isWorkspaceLoadCurrent,
    beginWorkspaceLoadGeneration,
    resetWorkspaceBoundState,
    loadWorkspaceDiagnostics,
    loadWorkspaceResources,
    fetchStatus,
    workspaceTaskLabel: wsRunning,
  });

  const enabledHarnessIds = appSettings?.enabled_harness_ids ?? [];
  const enabledHarnessKey = enabledHarnessIds.join(",");
  enabledHarnessIdsRef.current = enabledHarnessIds;

  // Settings (`R`) and `:workspace reset` share one confirmed reset. It also makes the install overview stale.
  const activeWorkspacePath =
    workspaceDiagnostics?.resolved_path ?? workspaceDiagnostics?.candidate_path ?? appSettings?.workspace_path ?? null;
  const resetWorkspace = useCallback(async () => {
    const result = await resetActiveWorkspace();
    if (result.ok) setOverviewRefreshKey(key => key + 1);
    return result;
  }, [resetActiveWorkspace]);
  const workspaceReset = useWorkspaceReset({
    activePath: activeWorkspacePath,
    libraryDirty,
    resetWorkspace,
    blockedReason: wsRunning ? workspaceTaskBlockedMessage(wsRunning) : null,
  });

  useEffect(() => {
    if (
      librarySourceType === "configs"
      && !agentTargets.some(target =>
        target.kind === "config"
        && BUNDLED_CONFIG_TARGET_IDS.has(target.id)
        && enabledHarnessIds.includes(target.harness)
      )
    ) {
      setGuardedLibrarySourceType("docs");
    }
  }, [agentTargets, enabledHarnessKey, librarySourceType, setGuardedLibrarySourceType]);

  // initialize active config target from first enabled / first available
  useEffect(() => {
    const targets = agentTargets.filter(t =>
      t.kind === "config"
      && BUNDLED_CONFIG_TARGET_IDS.has(t.id)
      && (appSettings?.enabled_harness_ids ?? []).includes(t.harness)
    );
    const enabledSet = new Set(appSettings?.enabled_target_ids ?? []);
    const firstEnabled = targets.find(t => enabledSet.has(t.id));
    const selected = firstEnabled ?? (targets.length > 0 ? targets[0] : null);
    if (selected && !activeConfigTargetId) {
      setActiveConfigTargetId(selected.id);
    }
  }, [agentTargets, appSettings, activeConfigTargetId]);

  // fallback when active config target disappears from registry or settings
  useEffect(() => {
    if (!activeConfigTargetId) return;
    const targets = agentTargets.filter(t =>
      t.kind === "config"
      && BUNDLED_CONFIG_TARGET_IDS.has(t.id)
      && (appSettings?.enabled_harness_ids ?? []).includes(t.harness)
    );
    const stillExists = targets.some(t => t.id === activeConfigTargetId);
    if (!stillExists) {
      const enabledSet = new Set(appSettings?.enabled_target_ids ?? []);
      const firstEnabled = targets.find(t => enabledSet.has(t.id));
      const fallback = firstEnabled ?? (targets.length > 0 ? targets[0] : null);
      setActiveConfigTargetId(fallback?.id ?? "");
    }
  }, [agentTargets, appSettings, activeConfigTargetId]);

  const openDefaultWorkspaceFolder = useCallback(
    () => invokeOpen("open_default_workspace_folder", undefined, "Open folder", setError),
    [],
  );

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const previousEnabledHarnessesRef = useRef<InstallAgent[] | null>(null);
  useEffect(() => {
    if (!appSettings) return;
    const previous = previousEnabledHarnessesRef.current;
    previousEnabledHarnessesRef.current = enabledHarnessIds;
    if (previous === null) {
      void Promise.all([loadWorkspaceDiagnostics(), loadWorkspaceResources()]);
      return;
    }
    previous
      .filter(harness => !enabledHarnessIds.includes(harness))
      .forEach(clearHarnessHealth);
    const newlyEnabled = enabledHarnessIds.filter(harness => !previous.includes(harness));
    if (newlyEnabled.length > 0) {
      void Promise.all([fetchStatus(), loadEnabledHarnessHealth(undefined, newlyEnabled)]);
    }
    const activeHarness = harnessForView(viewRef.current);
    if (activeHarness && !enabledHarnessIds.includes(activeHarness)) setView("start");
  }, [
    appSettings,
    enabledHarnessKey,
    clearHarnessHealth,
    fetchStatus,
    loadEnabledHarnessHealth,
    loadWorkspaceDiagnostics,
    loadWorkspaceResources,
  ]);

  const lastWorkspaceRefreshRef = useRef(0);
  const switchView = useCallback(async (v: View) => {
    const requestedHarness = harnessForView(v);
    if (requestedHarness && !enabledHarnessIds.includes(requestedHarness)) v = "start";
    if (v !== view) {
      const isLibraryDirty = view === "library" && isLibrarySourceDirty(librarySourceType);
      if (isLibraryDirty) {
        const ok = await confirm(LEAVE_DIRTY_MESSAGE);
        if (!ok) return;
        // Leaving means discarding: the sidebar's Library marker goes with the drafts.
        discardDrafts();
      }
    }
    setView(v);
    viewRef.current = v;
    if (v !== "settings") clearSettingsMsg();
    if (isWorkspaceLoadView(v)) {
      // Diagnostics and health hash many files backend-side; refreshing on
      // every tab hop makes navigation feel sluggish. Post-apply refreshes
      // are explicit, so a short staleness window is safe here.
      const now = Date.now();
      if (now - lastWorkspaceRefreshRef.current > 10_000) {
        lastWorkspaceRefreshRef.current = now;
        loadWorkspaceDiagnostics();
        loadEnabledHarnessHealth();
      }
    }
    else if (v === "library") loadLibraryView();
    else if (v === "settings" && !settingsDirty && !settingsSaving) { loadSettings(); }
  }, [view, librarySourceType, isLibrarySourceDirty, discardDrafts, settingsDirty, settingsSaving, loadLibraryView, loadWorkspaceDiagnostics, loadEnabledHarnessHealth, loadSettings, clearSettingsMsg, enabledHarnessKey]);

  useLandingView({ landingView: appSettings?.landing_view, currentView: view, navigate: switchView });

  // Reload what an install or rollback may have changed on disk.
  const refreshAfterApply = useCallback(async () => {
    const gen = workspaceLoadGenerationRef.current;
    await Promise.all([
      loadWorkspaceDiagnostics(gen),
      loadDocs(gen),
      fetchStatus(),
      loadEnabledHarnessHealth(gen),
    ]);
  }, [loadWorkspaceDiagnostics, loadDocs, fetchStatus, loadEnabledHarnessHealth, workspaceLoadGenerationRef]);

  // An install or a rules conversion that wrote files leaves the transaction `z` rolls back.
  const onApplied = useCallback((result: SetupResult) => {
    clearUninstallRecovery();
    setApplyTransactionId(result.applied.length > 0 ? result.transaction_id : null);
  }, [clearUninstallRecovery]);

  // `u`, `p`, `:update` and `:preview` open the review on the page; only `y` there applies it.
  const install = useInstallScreen({
    view,
    getView: () => viewRef.current,
    switchView,
    settings: appSettings,
    runWorkspaceTask: runWsTask,
    refresh: refreshAfterApply,
    onApplied,
  });

  const runWorkspaceUninstall = useCallback((planFingerprint: string, previewToken: string) => {
    void runWsTask({
      label: "uninstall",
      action: "apply_uninstall",
      task: async () =>
        invoke<SetupResult>("apply_uninstall", { planFingerprint, previewToken }),
      toActionResult: (r) => ({
        success: r.success,
        action: "apply_uninstall",
        stdout: r.message,
        stderr: r.failed.length > 0 ? r.failed.join("; ") : "",
        exit_code: r.success ? 0 : 1,
      }),
      refresh: async () => {
        const gen = workspaceLoadGenerationRef.current;
        await Promise.all([
          loadWorkspaceDiagnostics(gen),
          fetchStatus(),
          loadEnabledHarnessHealth(gen),
        ]);
      },
    }).then(result => {
      captureFromUninstallResult(result);
      if (result?.success && result.applied.length > 0) setApplyTransactionId(null);
    });
  }, [
    runWsTask,
    captureFromUninstallResult,
    loadWorkspaceDiagnostics,
    fetchStatus,
    loadEnabledHarnessHealth,
    workspaceLoadGenerationRef,
  ]);

  const runRollbackTransaction = useCallback((transactionId: string) => {
    return runWsTask({
      label: "rollback",
      action: "rollback_setup_transaction",
      task: async () =>
        invoke<SetupResult>("rollback_setup_transaction", { transactionId, dryRun: false }),
      toActionResult: (r) => ({
        success: r.success,
        action: "rollback_setup_transaction",
        stdout: r.message,
        stderr: r.failed.length > 0 ? r.failed.join("; ") : "",
        exit_code: r.success ? 0 : 1,
      }),
      refresh: async () => {
        const gen = workspaceLoadGenerationRef.current;
        await Promise.all([
          loadWorkspaceDiagnostics(gen),
          loadDocs(gen),
          fetchStatus(),
          loadEnabledHarnessHealth(gen),
        ]);
      },
    }).then((result) => {
      if (result?.success) {
        clearUninstallRecovery();
        setApplyTransactionId(null);
      }
      return result?.success === true;
    });
  }, [
    runWsTask,
    clearUninstallRecovery,
    loadWorkspaceDiagnostics,
    loadDocs,
    fetchStatus,
    loadEnabledHarnessHealth,
    workspaceLoadGenerationRef,
  ]);

  /** The recovery card's path: always the transaction the last uninstall left. */
  const runUninstallRollback = useCallback(() => {
    if (!uninstallRecoveryTransactionId) return Promise.resolve(false);
    return runRollbackTransaction(uninstallRecoveryTransactionId);
  }, [uninstallRecoveryTransactionId, runRollbackTransaction]);

  /** `z` and `:rollback`: a dry run first, then the existing confirm, then the rollback itself. */
  const requestRollback = useRollbackRequest({
    transactionId: rollbackTransactionId,
    confirm,
    runRollback: runRollbackTransaction,
    setError,
  });

  // `z`: Undo last update, from anywhere outside a text field. The same dry run and confirm as `:rollback`; the key
  // does nothing while there is no transaction of this session to undo.
  useKeymap([
    {
      id: "app.undo-last-update",
      keys: "z",
      title: "Undo last update",
      group: "Workspace",
      scope: "global",
      when: () => (rollbackTransactionId ? (wsRunning ? `${wsRunning} is running` : true) : false),
      run: () => void requestRollback(),
    },
  ]);

  /**
   * `:uninstall`: go to the workspace page, where the Uninstall card opens its preview dialog. The card is not
   * on the page while the install review is open, so the request is dropped then instead of waiting to pop the
   * dialog once the review closes.
   */
  const requestUninstallPreview = useCallback(async () => {
    if (install.isOpenOn("start")) {
      notify("close the install review first (n or Esc), then run :uninstall", { tone: "warn" });
      return;
    }
    await switchView("start");
    if (viewRef.current === "start") setUninstallPreviewRequested(true);
  }, [install, notify, switchView]);

  const configTargets = useMemo(
    () => agentTargets.filter(t =>
      t.kind === "config"
      && BUNDLED_CONFIG_TARGET_IDS.has(t.id)
      && enabledHarnessIds.includes(t.harness)
    ),
    [agentTargets, enabledHarnessKey],
  );
  const visibleAgentTargets = useMemo(
    () => agentTargets.filter(target => enabledHarnessIds.includes(target.harness)),
    [agentTargets, enabledHarnessKey],
  );
  const visibleSkills = useMemo(
    () => skills.flatMap(skill => {
      const targets = filterVisibleMetadataTargets(skill.targets, enabledHarnessIds);
      return targets === null ? [] : [{ ...skill, targets }];
    }),
    [skills, enabledHarnessKey],
  );
  const visibleAgentSources = useMemo(
    () => agentSources.flatMap(agent => {
      const targets = filterVisibleMetadataTargets(
        agent.metadata?.targets ?? [],
        enabledHarnessIds,
      );
      return targets === null
        ? []
        : [{ ...agent, metadata: agent.metadata ? { ...agent.metadata, targets } : null }];
    }),
    [agentSources, enabledHarnessKey],
  );
  const visibleSkillIds = useMemo(() => new Set(visibleSkills.map(skill => skill.id)), [visibleSkills]);
  const visibleAgentIds = useMemo(() => new Set(visibleAgentSources.map(agent => agent.id)), [visibleAgentSources]);
  const dataFolderOk = workspaceDiagnostics?.valid === true;

  const overview = useInstallationOverview({
    dataFolderOk,
    busy: wsRunning !== null,
    // The backend filters its status on the saved settings, so follow the acknowledged toggles, not edits
    // still waiting for their autosave.
    enabledHarnessIds: savedSelection?.harnessIds ?? [],
    enabledTargetIds: savedSelection?.targetIds,
    refreshKey: overviewRefreshKey,
  });
  // The folders the overview describes, read as the harnesses will load them.
  const skillLoads = useEffectiveSkillLoads({
    dataFolderOk,
    busy: wsRunning !== null,
    enabledHarnessIds: savedSelection?.harnessIds ?? [],
    refreshKey: overviewRefreshKey,
  });

  const refreshAll = useCallback(async () => {
    await Promise.all([
      loadWorkspaceDiagnostics(),
      loadWorkspaceResources(),
      loadBackups(),
      overview.refresh(),
      skillLoads.refresh(),
    ]);
  }, [loadWorkspaceDiagnostics, loadWorkspaceResources, loadBackups, overview.refresh, skillLoads.refresh]);

  const checkedAt = useCheckedAt(overview);
  const updateAllDisabled = updateAllDisabledReason(overview, { dataFolderOk, busyLabel: wsRunning, settingsSaving });
  const decideCounts = useMemo(
    () => decideCountsByHarness(overview, enabledHarnessIds, appSettings, dataFolderOk),
    [overview, enabledHarnessKey, appSettings, dataFolderOk],
  );

  // What the Overview reads of each enabled agent's runtime: the AGENTS.override.md warning and the runtime sub-lines.
  const runtimeHealthByHarness = useMemo<Partial<Record<InstallAgent, HarnessRuntimeHealth>>>(
    () => ({
      codex: { harness: "codex", health: codexRuntimeHealth },
      opencode: { harness: "opencode", health: opencodeRuntimeHealth },
      claude: { harness: "claude", health: claudeRuntimeHealth },
      cursor: { harness: "cursor", health: cursorProfileHealth },
      copilot: { harness: "copilot", health: lightRuntimeHealth.copilot ?? null },
      pi: { harness: "pi", health: lightRuntimeHealth.pi ?? null },
      kilo: { harness: "kilo", health: lightRuntimeHealth.kilo ?? null },
    }),
    [codexRuntimeHealth, opencodeRuntimeHealth, claudeRuntimeHealth, cursorProfileHealth, lightRuntimeHealth],
  );

  // What the Overview and harness pages share: the run panel, the install review and the rollback path.
  const pageProps = {
    wsLog,
    wsLogCompletedAt,
    wsRunning,
    wsProgress,
    dataFolderOk,
    onClearOutput: resetTerminalOutput,
    overview,
    install,
    backupRoot: workspaceDiagnostics?.backup_root ?? null,
    rollbackTransactionId,
    onRollback: () => void requestRollback(),
    onRefresh: () => void refreshAll(),
  };
  const harnessPageProps = {
    ...pageProps,
    runWorkspaceTask: runWsTask,
    refreshAfterApply,
    onApplied,
    skillLoads,
    appSettings,
    agentTargets: visibleAgentTargets,
    settingsSaveStatus,
    onToggleTarget: toggleTarget,
  };

  const outputText = useMemo(() => {
    if (!wsLog) return null;
    const text = [redactTerminalOutput(wsLog.stdout), redactTerminalOutput(wsLog.stderr)].filter(Boolean).join("\n");
    return text || null;
  }, [wsLog]);

  // The command line has no row to show the outcome in: a reset is a notice, a refusal the error banner.
  const reportWorkspaceReset = (message: { ok: boolean; text: string } | null) => {
    if (!message) return;
    if (message.ok) notify(message.text, { tone: "ok" });
    else setError(message.text);
  };

  useWhatsNewOnUpgrade({ settings: appSettings, appVersion: APP_VERSION, recordVersion: setLastSeenVersion });

  useAppCommands({
    enabledHarnessIds,
    dataFolderOk,
    busyLabel: wsRunning,
    overview,
    switchView,
    setLibrarySource: setGuardedLibrarySourceType,
    appearance: appSettings?.appearance,
    setAppearance,
    refresh: refreshAll,
    openFolder: openDefaultWorkspaceFolder,
    openBackups: openBackupsFolder,
    clearOutput: resetTerminalOutput,
    outputText,
    openInstall: install.open,
    rollbackTransactionId,
    requestRollback,
    requestUninstallPreview,
    workspaceReset: {
      isDefault: appSettings?.workspace_path == null,
      busy: workspaceReset.busy,
      reset: async () => reportWorkspaceReset(await workspaceReset.reset()),
    },
    setError,
  });

  return (
      <AppFrame
        view={view}
        onSwitchView={switchView}
        libraryDirty={libraryDirty}
        settingsErrored={settingsSaveStatus === "error"}
        enabledHarnessIds={enabledHarnessIds}
        error={error}
        onDismissError={() => setError(null)}
        onCheck={() => {
          notify("Checking every agent again…");
          void refreshAll();
        }}
        onUpdateAll={() => void install.open("all")}
        updateAllDisabled={updateAllDisabled}
        checking={overview.loading}
        decideCounts={decideCounts}
        version={APP_VERSION}
        backupCount={backups.length}
        checkedAt={checkedAt}
      >
        {view === "start" && (
          <OverviewView
            {...pageProps}
            workspaceDiagnostics={workspaceDiagnostics}
            appSettings={appSettings}
            enabledHarnessIds={enabledHarnessIds}
            runtimeHealth={runtimeHealthByHarness}
            checkedAt={checkedAt}
            updateAllDisabled={updateAllDisabled}
            onUndo={transactionId => void requestRollback(transactionId)}
            onNavigate={switchView}
            onUninstall={runWorkspaceUninstall}
            uninstallRecoveryTransactionId={uninstallRecoveryTransactionId}
            onUninstallRollback={runUninstallRollback}
            uninstallPreviewRequested={uninstallPreviewRequested}
            onUninstallPreviewHandled={() => setUninstallPreviewRequested(false)}
            onOpenFolder={openDefaultWorkspaceFolder}
            backupCount={backups.length}
            onOpenBackupsFolder={openBackupsFolder}
          />
        )}

        {view === "codex" && enabledHarnessIds.includes("codex") && (
          <CodexView {...harnessPageProps} runtimeHealth={codexRuntimeHealth} />
        )}

        {view === "opencode" && enabledHarnessIds.includes("opencode") && (
          <OpenCodeView
            {...harnessPageProps}
            runtimeHealth={opencodeRuntimeHealth}
            onModelUpdated={() => {
              void loadOpenCodeRuntimeHealth();
              setOverviewRefreshKey(key => key + 1);
            }}
          />
        )}

        {view === "cursor" && enabledHarnessIds.includes("cursor") && (
          <CursorView {...harnessPageProps} runtimeHealth={cursorProfileHealth} />
        )}

        {view === "claude" && enabledHarnessIds.includes("claude") && (
          <ClaudeView {...harnessPageProps} runtimeHealth={claudeRuntimeHealth} />
        )}

        {LIGHT_AGENTS.map(harness =>
          view === harness && enabledHarnessIds.includes(harness) ? (
            <LightHarnessView
              key={harness}
              {...harnessPageProps}
              harness={harness}
              runtimeHealth={lightRuntimeHealth[harness] ?? null}
            />
          ) : null,
        )}

        {view === "history" && (
          <HistoryView
            dataFolderOk={dataFolderOk}
            backupCount={backups.length}
            wsRunning={wsRunning}
            wsLogCompletedAt={wsLogCompletedAt}
            onUndo={transactionId => void requestRollback(transactionId)}
          />
        )}

        {view === "library" && (
          <Suspense fallback={<div className="view-loading">loading library…</div>}>
          <LibraryView
            sourceType={librarySourceType}
            onSetSourceType={setGuardedLibrarySourceType}
            // Docs
            docs={docs}
            activeDoc={activeDoc}
            onSelectDoc={selectDoc}
            onOpenDoc={openDocEditor}
            docDraft={docDraft}
            docDirty={docDirty}
            docSaving={docSaving}
            docSaveResult={docSaveResult}
            docMode={docMode}
            onSetDocMode={setDocMode}
            onChangeDocDraft={onChangeDocDraft}
            onSaveDoc={onSaveDoc}
            onResetDoc={onResetDoc}
            showCreateDoc={showCreateDoc}
            createDocTitle={createDocTitle}
            createDocSlug={createDocSlug}
            createDocError={createDocError}
            createDocCreating={createDocCreating}
            onSetShowCreateDoc={setShowCreateDoc}
            onSetCreateDocTitle={setCreateDocTitle}
            onSetCreateDocSlug={setCreateDocSlug}
            onCreateDoc={onCreateDoc}
            // Rules
            agentTemplate={agentTemplate}
            agentTargets={agentTargets}
            rulesFiles={rulesFiles}
            activeRulesSurface={activeRulesSurface}
            activeRulesFile={activeRulesFile}
            onSelectRulesFile={selectRulesFile}
            onOpenRulesFile={openRulesFile}
            rulesDraft={rulesDraft}
            rulesDirty={rulesDirty}
            rulesSaving={rulesSaving}
            rulesSaveResult={rulesSaveResult}
            onChangeRulesDraft={onChangeRulesDraft}
            onSaveRules={onSaveRules}
            onResetRules={onResetRules}
            // Skills
            skills={visibleSkills}
            activeSkillId={activeSkillId && visibleSkillIds.has(activeSkillId) ? activeSkillId : null}
            activeSkillContent={activeSkillId && visibleSkillIds.has(activeSkillId) ? activeSkillContent : null}
            skillSearch={skillSearch}
            onSetSkillSearch={setSkillSearch}
            onSelectSkillPreview={readSkill}
            packLibrary={packLibrary}
            packError={packError}
            onForgetPack={forgetPack}
            // Agents
            agentSources={visibleAgentSources}
            activeAgentId={activeAgentId && visibleAgentIds.has(activeAgentId) ? activeAgentId : null}
            activeAgentContent={activeAgentId && visibleAgentIds.has(activeAgentId) ? activeAgentContent : null}
            onSelectAgent={selectAgent}
            // Configs
            configTemplateContent={configTemplateContent}
            activeConfigTargetId={activeConfigTargetId}
            configTargets={configTargets}
            onSelectConfigTarget={selectConfigTarget}
            configEditorSources={configEditorSources}
            activeConfigSourceType={activeConfigSourceType}
            onSelectConfigSource={selectConfigSourceType}
            configEditorSourceContent={configEditorSourceContent}
            // Common
            dataFolderOk={dataFolderOk}
            showConfigs={configTargets.length > 0}
          />
          </Suspense>
        )}

        {view === "settings" && (
          <Suspense fallback={<div className="view-loading">loading…</div>}>
          <SettingsView
            appSettings={appSettings}
            settingsMsg={settingsMsg}
            settingsSaveStatus={settingsSaveStatus}
            onSetAppearance={setAppearance}
            onSetAppFontSize={setAppFontSize}
            onSetAccentColor={setAccentColor}
            onSetBackgroundColor={setBackgroundColor}
            onSetForegroundColor={setForegroundColor}
            onSetMotion={setMotion}
            onSetLandingView={setLandingView}
            onToggleHarness={toggleHarness}
            onRetrySave={retrySaveSettings}
            onReset={resetSettings}
            colorResetKey={colorResetKey}
            workspacePath={activeWorkspacePath}
            workspaceBusy={workspaceReset.busy}
            onResetWorkspace={workspaceReset.reset}
          />
          </Suspense>
        )}
      </AppFrame>
  );
}

/**
 * Root component wraps the app in the shell (keymap, commands, overlays, confirm dialog).
 */
function App() {
  return (
    <ShellProviders>
      <AppShell />
    </ShellProviders>
  );
}

export default App;
