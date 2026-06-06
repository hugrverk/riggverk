import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ActionResult } from "./components/TerminalOutput";
import { AppHeaderNav } from "./components/AppHeaderNav";
import { confirmLeaveDirtyEditor } from "./lib/editorGuards";
import { useBackups } from "./lib/useBackups";
import { useWorkspaceActions } from "./lib/useWorkspaceActions";
import { useWorkspaceGeneration } from "./lib/useWorkspaceGeneration";
import { useAppSettingsController } from "./hooks/useAppSettingsController";
import { EDITABLE_CONFIG_TARGET_IDS, useLibraryController } from "./hooks/useLibraryController";
import { useWorkspaceHealthController } from "./hooks/useWorkspaceHealthController";
import { CodexView } from "./views/CodexView";
import { CursorView } from "./views/CursorView";
import { ClaudeView } from "./views/ClaudeView";
import { OpenCodeView } from "./views/OpenCodeView";
import { deriveInstallState, StartView } from "./views/StartView";
import { ToolsView } from "./views/ToolsView";
const LibraryView = lazy(() => import("./views/LibraryView").then(m => ({ default: m.LibraryView })));
const SettingsView = lazy(() => import("./views/SettingsView").then(m => ({ default: m.SettingsView })));
import type { InitializeWorkspaceResult, RepairWorkspaceResult } from "./types";

type View =
  | "start"
  | "codex"
  | "opencode"
  | "cursor"
  | "claude"
  | "library"
  | "tools"
  | "settings";

function isWorkspaceLoadView(view: View): boolean {
  return view === "start" || view === "codex" || view === "opencode" || view === "cursor" || view === "claude";
}

/* ---- main app ---- */

function App() {
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("start");
  const appliedWorkspacePathRef = useRef<string | null | undefined>(undefined);

  // backup history state
  const { backups, loadBackups, openBackupsFolder } = useBackups(setError);

  // workspace resource generation
  const { workspaceLoadGenerationRef, isWorkspaceLoadCurrent, beginWorkspaceLoadGeneration } = useWorkspaceGeneration();

  const {
    status,
    workspaceDiagnostics,
    opencodeRuntimeHealth,
    cursorProfileHealth,
    brainSetupText,
    brainSetupSource,
    fetchStatus,
    loadWorkspaceDiagnostics,
    loadOpenCodeRuntimeHealth,
    loadCursorProfileHealth,
    loadBrainSetupSeed,
    resetWorkspaceHealthState,
    isInvalidWorkspaceError,
  } = useWorkspaceHealthController({
    setError,
    workspaceLoadGenerationRef,
    isWorkspaceLoadCurrent,
  });

  const {
    skills,
    skillsLoaded,
    selectedSkills,
    activeSkillId,
    activeSkillContent,
    skillSearch,
    setSkillSearch,
    toggleSkill,
    selectAllSkills,
    clearSkillSelection,
    openSkill,
    readSkill,
    openInstallScript,
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

  const [workspaceInstallRunning, setWorkspaceInstallRunning] = useState(false);

  const loadWorkspaceResources = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    await Promise.all([
      loadWorkspaceLibraryResources(generation),
      fetchStatus(generation).catch(() => {}),
      loadOpenCodeRuntimeHealth(generation).catch(() => {}),
      loadCursorProfileHealth(generation).catch(() => {}),
    ]);
  }, [loadWorkspaceLibraryResources, fetchStatus, loadOpenCodeRuntimeHealth, loadCursorProfileHealth, workspaceLoadGenerationRef]);

  // workspace action runner (terminal output, activity animation, action wrappers)
  const {
    wsRunning,
    wsLog,
    wsLogCompletedAt,
    activityIndex,
    activityCellClass,
    runWsAction,
    runWsInstallForAgents,
    runWsTask,
    workspaceActionRequestIdRef,
    resetTerminalOutput,
  } = useWorkspaceActions({
    fetchStatus,
    isInvalidWorkspaceError,
    workspaceDiagnostics,
    selectedSkills,
    setError,
  });

  const resetWorkspaceBoundState = useCallback(() => {
    workspaceActionRequestIdRef.current += 1;
    resetTerminalOutput();
    resetWorkspaceHealthState();
    resetLibraryState();
  }, [workspaceActionRequestIdRef, resetTerminalOutput, resetWorkspaceHealthState, resetLibraryState]);

  const {
    appSettings,
    settingsMsg,
    setSettingsMsg,
    agentTargets,
    targetProfiles,
    settingsDirty,
    settingsSaving,
    settingsSaveStatus,
    colorResetKey,
    loadSettings,
    persistActiveWorkspace,
    retrySaveSettings,
    resetSettings,
    setAppearance,
    setAppFontSize,
    setAccentColor,
    setBackgroundColor,
    setForegroundColor,
    toggleTarget,
    applyTargetProfile,
    activeProfileId,
    clearSettingsMsg,
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

  // initialize active config target from first enabled / first available
  useEffect(() => {
    const targets = agentTargets.filter(t => t.kind === "config" && EDITABLE_CONFIG_TARGET_IDS.has(t.id));
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
    const targets = agentTargets.filter(t => t.kind === "config" && EDITABLE_CONFIG_TARGET_IDS.has(t.id));
    const stillExists = targets.some(t => t.id === activeConfigTargetId);
    if (!stillExists) {
      const enabledSet = new Set(appSettings?.enabled_target_ids ?? []);
      const firstEnabled = targets.find(t => enabledSet.has(t.id));
      const fallback = firstEnabled ?? (targets.length > 0 ? targets[0] : null);
      setActiveConfigTargetId(fallback?.id ?? "");
    }
  }, [agentTargets, appSettings, activeConfigTargetId]);

  const runInstallDefaultWorkspace = useCallback(async () => {
    setWorkspaceInstallRunning(true);
    try {
      const result = await invoke<InitializeWorkspaceResult>("install_default_workspace");
      if (result.success) {
        setSettingsMsg({ ok: true, text: "workspace installed" });
        await persistActiveWorkspace(result.target_path);
      } else {
        setError(`Install workspace: ${result.message}`);
      }
    } catch (e) {
      setError(`Install workspace: ${e}`);
    } finally {
      setWorkspaceInstallRunning(false);
    }
  }, [persistActiveWorkspace]);

  const openDefaultWorkspaceFolder = useCallback(async () => {
    try {
      await invoke("open_default_workspace_folder");
    } catch (e) {
      setError(`Open folder: ${e}`);
    }
  }, []);

  useEffect(() => { loadSettings(); loadWorkspaceDiagnostics(); loadWorkspaceResources(); }, [loadSettings, loadWorkspaceDiagnostics, loadWorkspaceResources]);

  useEffect(() => {
    loadBrainSetupSeed();
  }, [appSettings?.workspace_path, loadBrainSetupSeed]);

  const switchView = useCallback((v: View) => {
    if (v !== view) {
      const isLibraryDirty = view === "library" && isLibrarySourceDirty(librarySourceType);
      if (isLibraryDirty && !confirmLeaveDirtyEditor()) return;
    }
    setView(v);
    if (v !== "settings") clearSettingsMsg();
    if (isWorkspaceLoadView(v)) {
      loadWorkspaceDiagnostics();
      loadCursorProfileHealth();
      loadOpenCodeRuntimeHealth();
    }
    else if (v === "library") loadLibraryView();
    else if (v === "settings" && !settingsDirty && !settingsSaving) { loadSettings(); }
  }, [view, librarySourceType, isLibrarySourceDirty, settingsDirty, settingsSaving, loadLibraryView, loadWorkspaceDiagnostics, loadCursorProfileHealth, loadOpenCodeRuntimeHealth, loadSettings, clearSettingsMsg]);

  const runCursorProfileAction = useCallback((action: string, label: string) => {
    runWsTask({
      label,
      action,
      task: async () => {
        return await invoke<ActionResult>("run_cursor_profile_action", { action });
      },
      toActionResult: (r) => r,
      refresh: async () => {
        await Promise.all([
          loadCursorProfileHealth(workspaceLoadGenerationRef.current),
          fetchStatus(),
        ]);
      },
    });
  }, [runWsTask, loadCursorProfileHealth, fetchStatus, workspaceLoadGenerationRef]);

  const repairWorkspaceToActionResult = useCallback((r: RepairWorkspaceResult): ActionResult => {
    const lines = [
      ...r.copied_files.map((f) => `copy: ${f}`),
      ...r.refreshed_files.map((f) => `refresh: ${f}`),
    ];
    const stdout = lines.length > 0 ? `${lines.join("\n")}\n${r.message}` : r.message;
    const stderr = [...r.errors, ...r.warnings].filter(Boolean).join("\n");
    return {
      success: r.ok,
      action: "repair_default_workspace",
      stdout,
      stderr,
      exit_code: r.ok ? 0 : 1,
    };
  }, []);

  const runCursorWorkspaceRepair = useCallback(() => {
    runWsTask({
      label: "repair workspace",
      action: "repair_default_workspace",
      task: async () => invoke<RepairWorkspaceResult>("repair_default_workspace"),
      toActionResult: repairWorkspaceToActionResult,
      refresh: async () => {
        const generation = workspaceLoadGenerationRef.current;
        await Promise.all([
          loadWorkspaceDiagnostics(generation),
          loadCursorProfileHealth(generation),
          loadDocs(generation),
          fetchStatus(generation),
        ]);
      },
    });
  }, [
    runWsTask,
    repairWorkspaceToActionResult,
    loadWorkspaceDiagnostics,
    loadCursorProfileHealth,
    loadDocs,
    fetchStatus,
    workspaceLoadGenerationRef,
  ]);

  const runDefaultWorkspaceResourceAction = useCallback(
    (label: "repair workspace" | "update resources") => {
      runWsTask({
        label,
        action: "repair_default_workspace",
        task: async () => invoke<RepairWorkspaceResult>("repair_default_workspace"),
        toActionResult: repairWorkspaceToActionResult,
        refresh: async () => {
          const generation = workspaceLoadGenerationRef.current;
          await Promise.all([
            loadWorkspaceDiagnostics(generation),
            loadDocs(generation),
            fetchStatus(generation),
          ]);
        },
      });
    },
    [
      runWsTask,
      repairWorkspaceToActionResult,
      loadWorkspaceDiagnostics,
      loadDocs,
      fetchStatus,
      workspaceLoadGenerationRef,
    ],
  );

  const workspaceResourceActionRunning =
    wsRunning === "repair workspace" || wsRunning === "update resources";

  const enabledTargetIds = status?.enabled_target_ids ?? [];
  const codexConfigEnabled = enabledTargetIds.includes("codex_config");
  const opencodeConfigEnabled = enabledTargetIds.includes("opencode_config");
  const opencodeAgentsEnabled = enabledTargetIds.includes("opencode_agents") || opencodeConfigEnabled;
  const codexRulesEnabled = enabledTargetIds.includes("codex_rules");
  const opencodeRulesEnabled = enabledTargetIds.includes("opencode_rules");
  const claudeRulesEnabled = enabledTargetIds.includes("claude_rules");
  const claudeAgentsEnabled = enabledTargetIds.includes("claude_agents");
  const configTargets = useMemo(
    () => agentTargets.filter(t => t.kind === "config" && EDITABLE_CONFIG_TARGET_IDS.has(t.id)),
    [agentTargets],
  );
  const workspaceValid = workspaceDiagnostics?.valid === true;
  const installState = deriveInstallState(workspaceDiagnostics);
  const canRunReleaseCheck = workspaceValid && workspaceDiagnostics?.release_check_available === true;
  const gitAvailable = status?.git_available === true;
  const targetSkillsShared = {
    skills,
    skillsLoaded,
    selectedSkills,
    skillSearch,
    onToggleSkill: toggleSkill,
    onSelectAllSkills: selectAllSkills,
    onClearSelectionSkills: clearSkillSelection,
    onSetSkillSearch: setSkillSearch,
    onOpenInstallScript: openInstallScript,
  };

  return (
      <div className="app-shell">
      <AppHeaderNav
        view={view}
        libraryDirty={libraryDirty}
        settingsErrored={settingsSaveStatus === "error"}
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
            installState={installState}
            installRunning={workspaceInstallRunning}
            repairRunning={workspaceResourceActionRunning}
            onRefreshDiagnostics={() => {
              loadWorkspaceDiagnostics();
              fetchStatus();
            }}
            onInstall={runInstallDefaultWorkspace}
            onRepair={() => runDefaultWorkspaceResourceAction("repair workspace")}
            onUpdateResources={() => runDefaultWorkspaceResourceAction("update resources")}
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
            onRefreshStatus={fetchStatus}
            onReleaseCheck={() => runWsAction("release_check", "release-check")}
            backupCount={backups.length}
            onRefreshBackups={loadBackups}
            onOpenBackupsFolder={openBackupsFolder}
          />
        )}

        {view === "codex" && (
          <CodexView
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={toggleTarget}
            onApplyProfile={applyTargetProfile}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            ruleTargetsEnabled={codexRulesEnabled}
            codexConfigEnabled={codexConfigEnabled}
            canRunReleaseCheck={canRunReleaseCheck}
            onDiffRules={() => runWsAction("diff_codex_rules", "diff codex rules")}
            onSyncRules={() => runWsAction("sync_codex_rules", "sync codex rules")}
            onDiffConfigs={() => runWsAction("diff_codex_config", "diff codex config")}
            {...targetSkillsShared}
            onDryRunSkills={() => runWsInstallForAgents(true, ["codex"], "install skills dry-run (codex)")}
            onInstallSkills={() => runWsInstallForAgents(false, ["codex"], "install skills (codex)")}
          />
        )}

        {view === "opencode" && (
          <OpenCodeView
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={toggleTarget}
            onApplyProfile={applyTargetProfile}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            ruleTargetsEnabled={opencodeRulesEnabled}
            opencodeAgentsEnabled={opencodeAgentsEnabled}
            opencodeConfigEnabled={opencodeConfigEnabled}
            canRunReleaseCheck={canRunReleaseCheck}
            opencodeRuntimeHealth={opencodeRuntimeHealth}
            onDiffRules={() => runWsTask({
              label: "diff opencode rules",
              action: "diff_opencode_rules",
              task: async () => invoke<ActionResult>("run_action", { action: "diff_opencode_rules" }),
              toActionResult: (r) => r,
              refresh: fetchStatus,
            })}
            onSyncRules={() => runWsTask({
              label: "sync opencode rules",
              action: "sync_opencode_rules",
              task: async () => invoke<ActionResult>("run_action", { action: "sync_opencode_rules" }),
              toActionResult: (r) => r,
              refresh: fetchStatus,
            })}
            onRefreshOpenCodeRuntimeHealth={loadOpenCodeRuntimeHealth}
            onGenerateOpenCodeConfig={() => runWsTask({
              label: "generate opencode config",
              action: "generate_opencode_config_snapshot",
              task: async () => invoke<ActionResult>("generate_opencode_config_snapshot"),
              toActionResult: (r) => r,
              refresh: loadOpenCodeRuntimeHealth,
            })}
            onPlanWorkspaceRepair={() => runWsTask({
              label: "plan workspace repair",
              action: "plan_workspace_repair",
              task: async () => invoke<RepairWorkspaceResult>("plan_workspace_repair"),
              toActionResult: (r) => ({
                success: r.ok,
                action: "plan_workspace_repair",
                stdout: r.copied_files.length > 0 ? r.copied_files.join("\n") + "\n" : r.message + "\n",
                stderr: r.errors.join("\n") + (r.warnings.length > 0 ? r.warnings.join("\n") : ""),
                exit_code: r.ok ? 0 : 1,
              }),
              refresh: loadOpenCodeRuntimeHealth,
            })}
            onApplyWorkspaceRepair={() => runWsTask({
              label: "apply workspace repair",
              action: "apply_workspace_repair",
              task: async () => invoke<RepairWorkspaceResult>("apply_workspace_repair"),
              toActionResult: (r) => ({
                success: r.ok,
                action: "apply_workspace_repair",
                stdout: r.copied_files.length > 0 ? "Copied:\n" + r.copied_files.join("\n") + "\n" : r.message + "\n",
                stderr: r.errors.join("\n"),
                exit_code: r.ok ? 0 : 1,
              }),
              refresh: loadOpenCodeRuntimeHealth,
            })}
            onDiffOpenCodeAgents={() => runWsTask({
              label: "diff opencode agents",
              action: "diff_opencode_agents",
              task: async () => invoke<ActionResult>("run_action", { action: "diff_opencode_agents" }),
              toActionResult: (r) => r,
              refresh: () => { loadOpenCodeRuntimeHealth(); fetchStatus(); },
            })}
            onSyncOpenCodeAgents={() => runWsTask({
              label: "sync opencode agents",
              action: "sync_opencode_agents",
              task: async () => invoke<ActionResult>("run_action", { action: "sync_opencode_agents" }),
              toActionResult: (r) => r,
              refresh: () => { loadOpenCodeRuntimeHealth(); fetchStatus(); },
            })}
            onDiffOpenCodeConfig={() => runWsTask({
              label: "diff opencode config",
              action: "diff_opencode_config",
              task: async () => invoke<ActionResult>("run_action", { action: "diff_opencode_config" }),
              toActionResult: (r) => r,
              refresh: () => { loadOpenCodeRuntimeHealth(); fetchStatus(); },
            })}
            onSyncOpenCodeConfig={() => runWsTask({
              label: "sync opencode config",
              action: "sync_opencode_config",
              task: async () => invoke<ActionResult>("run_action", { action: "sync_opencode_config" }),
              toActionResult: (r) => r,
              refresh: () => { loadOpenCodeRuntimeHealth(); fetchStatus(); },
            })}
            {...targetSkillsShared}
            onDryRunSkills={() => runWsInstallForAgents(true, ["opencode"], "install skills dry-run (opencode)")}
            onInstallSkills={() => runWsInstallForAgents(false, ["opencode"], "install skills (opencode)")}
          />
        )}

        {view === "cursor" && (
          <CursorView
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={toggleTarget}
            onApplyProfile={applyTargetProfile}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            canRunReleaseCheck={canRunReleaseCheck}
            cursorProfileHealth={cursorProfileHealth}
            onRefreshCursorProfile={() => loadCursorProfileHealth()}
            onRepairWorkspace={runCursorWorkspaceRepair}
            onCursorDiffGlobalProfile={() => runCursorProfileAction("cursor_diff_global_profile", "cursor diff global profile")}
            onCursorApplyGlobalProfile={() => runCursorProfileAction("cursor_apply_global_profile", "cursor apply global profile")}
            onCursorValidateGlobalProfile={() => runCursorProfileAction("cursor_validate_global_profile", "cursor validate global profile")}
            onCursorOpenSettings={() => runCursorProfileAction("cursor_open_settings", "cursor open settings")}
            onCursorCopyUserRules={() => runCursorProfileAction("cursor_copy_user_rules", "cursor copy user rules")}
            onCursorShowPlaywrightMcp={() => runCursorProfileAction("cursor_show_playwright_mcp", "cursor show playwright mcp")}
            onCursorCopyPlaywrightMcp={() => runCursorProfileAction("cursor_copy_playwright_mcp", "cursor copy playwright mcp")}
            onCursorCopySandboxSafe={() => runCursorProfileAction("cursor_copy_sandbox_safe", "cursor copy sandbox safe")}
            onCursorCopySandboxPlaywrightSafe={() => runCursorProfileAction("cursor_copy_sandbox_playwright_safe", "cursor copy sandbox playwright-safe")}
            onCursorCopySandboxPlaywrightFull={() => runCursorProfileAction("cursor_copy_sandbox_playwright_full", "cursor copy sandbox playwright-full")}
            {...targetSkillsShared}
            onDryRunSkills={() => runWsInstallForAgents(true, ["cursor"], "install skills dry-run (cursor)")}
            onInstallSkills={() => runWsInstallForAgents(false, ["cursor"], "install skills (cursor)")}
          />
        )}

        {view === "claude" && (
          <ClaudeView
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={toggleTarget}
            onApplyProfile={applyTargetProfile}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            ruleTargetsEnabled={claudeRulesEnabled}
            agentsTargetsEnabled={claudeAgentsEnabled}
            agentsStatusLabel={status?.claude_agents}
            canRunReleaseCheck={canRunReleaseCheck}
            onDiffRules={() => runWsAction("diff_claude_rules", "diff claude rules")}
            onSyncRules={() => runWsAction("sync_claude_rules", "sync claude rules")}
            onDiffAgents={() => runWsTask({
              label: "diff claude agents",
              action: "diff_claude_agents",
              task: async () => invoke<ActionResult>("run_action", { action: "diff_claude_agents" }),
              toActionResult: (r) => r,
              refresh: fetchStatus,
            })}
            onSyncAgents={() => runWsTask({
              label: "sync claude agents",
              action: "sync_claude_agents",
              task: async () => invoke<ActionResult>("run_action", { action: "sync_claude_agents" }),
              toActionResult: (r) => r,
              refresh: fetchStatus,
            })}
            {...targetSkillsShared}
            onDryRunSkills={() => runWsInstallForAgents(true, ["claude"], "install skills dry-run (claude)")}
            onInstallSkills={() => runWsInstallForAgents(false, ["claude"], "install skills (claude)")}
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
            skills={skills}
            activeSkillId={activeSkillId}
            activeSkillContent={activeSkillContent}
            skillSearch={skillSearch}
            onSetSkillSearch={setSkillSearch}
            onSelectSkillPreview={readSkill}
            onOpenSkill={openSkill}
            // Agents
            agentSources={agentSources}
            activeAgentId={activeAgentId}
            activeAgentContent={activeAgentContent}
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
          />
          </Suspense>
        )}

        {view === "tools" && (
          <ToolsView />
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
