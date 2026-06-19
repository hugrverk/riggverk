import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ActionResult } from "./components/TerminalOutput";
import { AppHeaderNav, type AppHeaderView } from "./components/AppHeaderNav";
import { confirmLeaveDirtyEditor } from "./lib/editorGuards";
import { useBackups } from "./lib/useBackups";
import { useUninstallRecovery } from "./lib/useUninstallRecovery";
import { useWorkspaceActions } from "./lib/useWorkspaceActions";
import { useWorkspaceGeneration } from "./lib/useWorkspaceGeneration";
import { useAppSettingsController } from "./hooks/useAppSettingsController";
import { EDITABLE_CONFIG_TARGET_IDS, useLibraryController } from "./hooks/useLibraryController";
import { useWorkspaceHealthController } from "./hooks/useWorkspaceHealthController";
import {
  savedRepoEntriesFromSettings,
} from "./lib/useSavedRepoEntriesController";
import {
  createPromptLoopContextSeed,
  isPromptContextEligibleWorkItem,
  type PromptLoopContextSeed,
} from "./tools/promptLoops/contextHandoff";
import { PromptLoopsTool } from "./tools/promptLoops/PromptLoopsTool";
import { RepoDashboardTool } from "./tools/repoDashboard/RepoDashboardTool";
import { CodexView } from "./views/CodexView";
import { CursorView } from "./views/CursorView";
import { ClaudeView } from "./views/ClaudeView";
import { OpenCodeView } from "./views/OpenCodeView";
import { StartView } from "./views/StartView";
const LibraryView = lazy(() => import("./views/LibraryView").then(m => ({ default: m.LibraryView })));
const SettingsView = lazy(() => import("./views/SettingsView").then(m => ({ default: m.SettingsView })));
import { harnessForView, surfacesNeedingApply } from "./lib/harnessInstallation";
import { filterVisibleMetadataTargets } from "./lib/harnessVisibility";
import type { InstallAgent, RepoDashboardWorkItem, SetupPlan, SetupResult } from "./types";

type View = AppHeaderView;

function isWorkspaceLoadView(view: View): boolean {
  return view === "start" || view === "codex" || view === "opencode" || view === "cursor" || view === "claude";
}

/* ---- main app ---- */

function App() {
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("start");
  const viewRef = useRef<View>("start");
  useEffect(() => { viewRef.current = view; }, [view]);
  const appliedWorkspacePathRef = useRef<string | null | undefined>(undefined);
  const enabledHarnessIdsRef = useRef<InstallAgent[]>([]);

  // backup history state
  const { backups, loadBackups, openBackupsFolder } = useBackups(setError);

  // workspace resource generation
  const { workspaceLoadGenerationRef, isWorkspaceLoadCurrent, beginWorkspaceLoadGeneration } = useWorkspaceGeneration();

  const {
    status,
    workspaceDiagnostics,
    opencodeRuntimeHealth,
    codexRuntimeHealth,
    cursorProfileHealth,
    claudeRuntimeHealth,
    brainSetupText,
    brainSetupSource,
    fetchStatus,
    loadWorkspaceDiagnostics,
    loadOpenCodeRuntimeHealth,
    loadCodexRuntimeHealth,
    loadCursorProfileHealth,
    loadClaudeRuntimeHealth,
    loadBrainSetupSeed,
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
    activeSkillId,
    activeSkillContent,
    skillSearch,
    setSkillSearch,
    openSkill,
    readSkill,
    docs,
    docsHealth,
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
    agentTemplateDraft,
    agentTemplateDirty,
    agentTemplateSaving,
    agentTemplateSaveResult,
    agentTemplateMode,
    setAgentTemplateMode,
    onChangeAgentTemplateDraft,
    onSaveAgentTemplate,
    onResetAgentTemplate,
    librarySourceType,
    setGuardedLibrarySourceType,
    isLibrarySourceDirty,
    libraryDirty,
    agentSources,
    activeAgentId,
    activeAgentContent,
    agentDraft,
    agentDirty,
    agentSaving,
    agentSaveResult,
    agentMode,
    setAgentMode,
    selectAgent,
    openAgent,
    onChangeAgentDraft,
    onSaveAgent,
    onResetAgent,
    configTemplateContent,
    activeConfigTargetId,
    setActiveConfigTargetId,
    configDraft,
    configDirty,
    configSaving,
    configSaveResult,
    configMode,
    setConfigMode,
    configEditorSources,
    activeConfigSourceType,
    configEditorSourceContent,
    configEditorSourceSaveMessage,
    onChangeConfigDraft,
    onSaveConfig,
    onResetConfig,
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
    };
    await Promise.all(harnesses.map(harness => loaders[harness](generation).catch(() => {})));
  }, [
    loadCodexRuntimeHealth,
    loadOpenCodeRuntimeHealth,
    loadClaudeRuntimeHealth,
    loadCursorProfileHealth,
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

  // workspace action runner (terminal output, activity animation, action wrappers)
  const {
    wsRunning,
    wsLog,
    wsLogCompletedAt,
    activityIndex,
    activityCellClass,
    runWsAction,
    runWsTask,
    workspaceActionRequestIdRef,
    resetTerminalOutput,
  } = useWorkspaceActions({
    fetchStatus,
    isInvalidWorkspaceError,
    workspaceDiagnostics,
    setError,
  });

  const resetWorkspaceBoundState = useCallback(() => {
    workspaceActionRequestIdRef.current += 1;
    resetTerminalOutput();
    clearUninstallRecovery();
    resetWorkspaceHealthState();
    resetLibraryState();
  }, [workspaceActionRequestIdRef, resetTerminalOutput, clearUninstallRecovery, resetWorkspaceHealthState, resetLibraryState]);

  const {
    appSettings,
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
    setReduceMotion,
    setLandingView,
    toggleTarget,
    toggleHarness,
    clearSettingsMsg,
    mutateAppSettings,
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
  });

  const enabledHarnessIds = appSettings?.enabled_harness_ids ?? [];
  const enabledHarnessKey = enabledHarnessIds.join(",");
  enabledHarnessIdsRef.current = enabledHarnessIds;

  useEffect(() => {
    if (
      librarySourceType === "configs"
      && !agentTargets.some(target =>
        target.kind === "config"
        && EDITABLE_CONFIG_TARGET_IDS.has(target.id)
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
      && EDITABLE_CONFIG_TARGET_IDS.has(t.id)
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
      && EDITABLE_CONFIG_TARGET_IDS.has(t.id)
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

  const openDefaultWorkspaceFolder = useCallback(async () => {
    try {
      await invoke("open_default_workspace_folder");
    } catch (e) {
      setError(`Open folder: ${e}`);
    }
  }, []);

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

  useEffect(() => {
    loadBrainSetupSeed();
  }, [appSettings?.workspace_path, loadBrainSetupSeed]);

  // Apply landing_view on first settings load and whenever the user changes it.
  const prevLandingViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!appSettings) return;
    const landing = appSettings.landing_view as View;
    const prev = prevLandingViewRef.current;
    if (prev === null) {
      prevLandingViewRef.current = landing;
      if (landing !== "start") setView(landing);
      return;
    }
    if (prev !== landing) {
      prevLandingViewRef.current = landing;
      setView(landing);
    }
  }, [appSettings?.landing_view, appSettings]);

  const lastWorkspaceRefreshRef = useRef(0);
  const switchView = useCallback((v: View) => {
    const requestedHarness = harnessForView(v);
    if (requestedHarness && !enabledHarnessIds.includes(requestedHarness)) v = "start";
    if (v !== view) {
      const isLibraryDirty = view === "library" && isLibrarySourceDirty(librarySourceType);
      if (isLibraryDirty && !confirmLeaveDirtyEditor()) return;
    }
    setView(v);
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
  }, [view, librarySourceType, isLibrarySourceDirty, settingsDirty, settingsSaving, loadLibraryView, loadWorkspaceDiagnostics, loadEnabledHarnessHealth, loadSettings, clearSettingsMsg, enabledHarnessKey]);

  // Shared state for the Prompt Builder + Repo Dashboard tools.
  // Lifted to App so context handoff and saved-repo entry identity stay consistent
  // regardless of which view the user is currently on.
  const savedRepoView = useMemo(
    () => savedRepoEntriesFromSettings(appSettings),
    [appSettings],
  );
  const { entries: savedRepos, activeEntryId: savedReposActiveId, loading: savedReposLoading } = savedRepoView;
  const [promptContextSeed, setPromptContextSeed] = useState<PromptLoopContextSeed | null>(null);
  const promptContextSeedRef = useRef(0);

  const handleUsePromptContext = useCallback(
    (payload: { item: RepoDashboardWorkItem; repoPath: string }) => {
      if (!isPromptContextEligibleWorkItem(payload.item)) return;
      promptContextSeedRef.current += 1;
      setPromptContextSeed(
        createPromptLoopContextSeed(payload.item, {
          repoPath: payload.repoPath,
          savedEntries: savedRepos,
          seedNonce: promptContextSeedRef.current,
        }),
      );
      setView("prompts");
    },
    [savedRepos],
  );

  const runHarnessSetupUpdate = useCallback((surfaces: string[], label: string) => {
    void runWsTask({
      label,
      action: "apply_setup",
      task: async () => {
        const plan = await invoke<SetupPlan>("preview_setup", { surfaces });
        const applySurfaces = surfacesNeedingApply(plan);
        if (!plan.plan_fingerprint || !plan.preview_token || applySurfaces.length === 0) {
          throw new Error("Nothing to apply for harness update");
        }
        return invoke<SetupResult>("apply_setup", {
          surfaces: applySurfaces,
          skipManual: true,
          planFingerprint: plan.plan_fingerprint,
          previewToken: plan.preview_token,
        });
      },
      toActionResult: (r) => ({
        success: r.success,
        action: "apply_setup",
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
      if (result?.success) clearUninstallRecovery();
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
    }).then(captureFromUninstallResult);
  }, [
    runWsTask,
    captureFromUninstallResult,
    loadWorkspaceDiagnostics,
    fetchStatus,
    loadEnabledHarnessHealth,
    workspaceLoadGenerationRef,
  ]);

  const runUninstallRollback = useCallback(() => {
    const transactionId = uninstallRecoveryTransactionId;
    if (!transactionId) return Promise.resolve(false);
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
      if (result?.success) clearUninstallRecovery();
      return result?.success === true;
    });
  }, [
    uninstallRecoveryTransactionId,
    runWsTask,
    clearUninstallRecovery,
    loadWorkspaceDiagnostics,
    loadDocs,
    fetchStatus,
    loadEnabledHarnessHealth,
    workspaceLoadGenerationRef,
  ]);

  const configTargets = useMemo(
    () => agentTargets.filter(t =>
      t.kind === "config"
      && EDITABLE_CONFIG_TARGET_IDS.has(t.id)
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
  const workspaceValid = workspaceDiagnostics?.valid === true;
  const canRunReleaseCheck = workspaceValid && workspaceDiagnostics?.release_check_available === true;
  const gitAvailable = status?.git_available === true;

  return (
      <div className="app-shell">
      <AppHeaderNav
        view={view}
        libraryDirty={libraryDirty}
        settingsErrored={settingsSaveStatus === "error"}
        enabledHarnessIds={enabledHarnessIds}
        onSwitchView={switchView}
      />

      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner-text">{error}</span>
          <button className="error-banner-dismiss" onClick={() => setError(null)} aria-label="Dismiss error">
            &times;
          </button>
        </div>
      )}

      <div className="view-area">
        {view === "start" && (
          <StartView
            workspaceDiagnostics={workspaceDiagnostics}
            onManagedUpdate={runHarnessSetupUpdate}
            onUninstall={runWorkspaceUninstall}
            uninstallRecoveryTransactionId={uninstallRecoveryTransactionId}
            onUninstallRollback={runUninstallRollback}
            onOpenFolder={openDefaultWorkspaceFolder}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            canRunReleaseCheck={canRunReleaseCheck}
            onReleaseCheck={() => runWsAction("release_check", "release-check")}
            backupCount={backups.length}
            onRefreshBackups={loadBackups}
            onOpenBackupsFolder={openBackupsFolder}
            enabledHarnessIds={enabledHarnessIds}
          />
        )}

        {view === "codex" && enabledHarnessIds.includes("codex") && (
          <CodexView
            appSettings={appSettings}
            agentTargets={visibleAgentTargets}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={toggleTarget}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            canRunReleaseCheck={canRunReleaseCheck}
            onHarnessSetupUpdate={runHarnessSetupUpdate}
            runtimeHealth={codexRuntimeHealth}
          />
        )}

        {view === "opencode" && enabledHarnessIds.includes("opencode") && (
          <OpenCodeView
            appSettings={appSettings}
            agentTargets={agentTargets}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={toggleTarget}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            canRunReleaseCheck={canRunReleaseCheck}
            onHarnessSetupUpdate={runHarnessSetupUpdate}
            runtimeHealth={opencodeRuntimeHealth}
          />
        )}

        {view === "cursor" && enabledHarnessIds.includes("cursor") && (
          <CursorView
            appSettings={appSettings}
            agentTargets={agentTargets}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={toggleTarget}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            canRunReleaseCheck={canRunReleaseCheck}
            onHarnessSetupUpdate={runHarnessSetupUpdate}
            runtimeHealth={cursorProfileHealth}
          />
        )}

        {view === "claude" && enabledHarnessIds.includes("claude") && (
          <ClaudeView
            appSettings={appSettings}
            agentTargets={agentTargets}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={toggleTarget}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            canRunReleaseCheck={canRunReleaseCheck}
            onHarnessSetupUpdate={runHarnessSetupUpdate}
            runtimeHealth={claudeRuntimeHealth}
          />
        )}

        {view === "library" && (
          <Suspense fallback={<div className="view-loading">loading library…</div>}>
          <LibraryView
            sourceType={librarySourceType}
            onSetSourceType={setGuardedLibrarySourceType}
            // Docs
            docs={docs}
            docsHealth={docsHealth}
            onGoToWorkspaceRepair={() => setView("start")}
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
            onOpenTemplate={() => invoke<ActionResult>("open_agent_template").catch(e => setError(`Open: ${e}`))}
            agentTemplateDraft={agentTemplateDraft}
            agentTemplateDirty={agentTemplateDirty}
            agentTemplateSaving={agentTemplateSaving}
            agentTemplateSaveResult={agentTemplateSaveResult}
            agentTemplateMode={agentTemplateMode}
            onSetAgentTemplateMode={setAgentTemplateMode}
            onChangeAgentTemplateDraft={onChangeAgentTemplateDraft}
            onSaveAgentTemplate={onSaveAgentTemplate}
            onResetAgentTemplate={onResetAgentTemplate}
            agentTargets={agentTargets}
            // Skills
            skills={visibleSkills}
            activeSkillId={activeSkillId && visibleSkillIds.has(activeSkillId) ? activeSkillId : null}
            activeSkillContent={activeSkillId && visibleSkillIds.has(activeSkillId) ? activeSkillContent : null}
            skillSearch={skillSearch}
            onSetSkillSearch={setSkillSearch}
            onSelectSkillPreview={readSkill}
            onOpenSkill={openSkill}
            // Agents
            agentSources={visibleAgentSources}
            activeAgentId={activeAgentId && visibleAgentIds.has(activeAgentId) ? activeAgentId : null}
            activeAgentContent={activeAgentId && visibleAgentIds.has(activeAgentId) ? activeAgentContent : null}
            onSelectAgent={selectAgent}
            onOpenAgent={openAgent}
            agentDraft={agentDraft}
            agentDirty={agentDirty}
            agentSaving={agentSaving}
            agentSaveResult={agentSaveResult}
            agentMode={agentMode}
            onSetAgentMode={setAgentMode}
            onChangeAgentDraft={onChangeAgentDraft}
            onSaveAgent={onSaveAgent}
            onResetAgent={onResetAgent}
            // Configs
            configTemplateContent={configTemplateContent}
            activeConfigTargetId={activeConfigTargetId}
            configTargets={configTargets}
            onSelectConfigTarget={selectConfigTarget}
            onOpenConfig={() => {
              if (activeConfigTargetId === "opencode_config") {
                invoke<ActionResult>("open_opencode_config_source", { sourceType: activeConfigSourceType }).catch(e => setError(`Open: ${e}`));
              } else {
                invoke<ActionResult>("open_config_template", { targetId: activeConfigTargetId }).catch(e => setError(`Open: ${e}`));
              }
            }}
            configDraft={configDraft}
            configDirty={configDirty}
            configSaving={configSaving}
            configSaveResult={configSaveResult}
            configMode={configMode}
            onSetConfigMode={setConfigMode}
            onChangeConfigDraft={onChangeConfigDraft}
            onSaveConfig={onSaveConfig}
            onResetConfig={onResetConfig}
            configEditorSources={configEditorSources}
            activeConfigSourceType={activeConfigSourceType}
            onSelectConfigSource={selectConfigSourceType}
            configEditorSourceSaveMessage={configEditorSourceSaveMessage}
            configEditorSourceContent={configEditorSourceContent}
            // Brain Setup
            brainSetupText={brainSetupText}
            brainSetupSource={brainSetupSource}
            // Common
            workspaceValid={workspaceValid}
            showConfigs={configTargets.length > 0}
          />
          </Suspense>
        )}

        {view === "prompts" && (
          <PromptLoopsTool
            contextSeed={promptContextSeed}
            savedRepos={savedRepos}
            savedReposLoading={savedReposLoading}
          />
        )}

        {view === "repo-dashboard" && (
          <RepoDashboardTool
            onUsePromptContext={handleUsePromptContext}
            savedEntries={savedRepos}
            activeEntryId={savedReposActiveId}
            mutateSavedEntries={mutateAppSettings}
          />
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
            onSetReduceMotion={setReduceMotion}
            onSetLandingView={setLandingView}
            onToggleHarness={toggleHarness}
            onRetrySave={retrySaveSettings}
            onReset={resetSettings}
            colorResetKey={colorResetKey}
          />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export default App;
