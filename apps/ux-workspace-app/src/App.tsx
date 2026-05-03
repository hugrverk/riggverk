import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ActionResult } from "./components/TerminalOutput";
import { ruleSyncCount, syncTextClass, targetDotClass } from "./lib/status";
import { wait } from "./lib/timing";
import { RulesView } from "./views/RulesView";
import { ConfigsView } from "./views/ConfigsView";
import { DocsView } from "./views/DocsView";
import { HealthView } from "./views/HealthView";
import { SkillsView } from "./views/SkillsView";
import { SettingsView } from "./views/SettingsView";
import { WorkspaceView } from "./views/WorkspaceView";
import type { AgentTargetMeta, AppSettings, BackupRunDetails, BackupRunSummary, CreateWorkspacePlan, CreateWorkspaceResult, DefaultWorkspaceSummary, DocSummary, DocumentContent, InstallAgent, InstallSkillsRequest, SkillSummary, StatusData, TargetProfileMeta, WorkspaceDiagnostics } from "./types";

const DEFAULT_TARGET_IDS = ["codex_rules", "opencode_rules", "auggie_rules", "opencode_config"];
const MIN_RUNNING_MS = 700;
const INVALID_WORKSPACE_TEXT = "invalid workspace path";

type View = "workspace" | "rules" | "skills" | "configs" | "health" | "docs" | "settings";

/* ---- main app ---- */

function App() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [log, setLog] = useState<ActionResult | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [activityIndex, setActivityIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("workspace");

  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [activeDoc, setActiveDoc] = useState<DocumentContent | null>(null);
  const [agentTemplate, setAgentTemplate] = useState<DocumentContent | null>(null);
  const [configTemplateContent, setConfigTemplateContent] = useState<DocumentContent | null>(null);

  // configs view state
  const [configLog, setConfigLog] = useState<ActionResult | null>(null);
  const [configRunning, setConfigRunning] = useState<string | null>(null);
  const [activeConfigTargetId, setActiveConfigTargetId] = useState<string>("");

  // health view state
  const [healthLog, setHealthLog] = useState<ActionResult | null>(null);
  const [healthRunning, setHealthRunning] = useState<string | null>(null);

  // backup history state
  const [backups, setBackups] = useState<BackupRunSummary[]>([]);
  const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null);
  const [backupDetails, setBackupDetails] = useState<BackupRunDetails | null>(null);

  const loadBackups = useCallback(async () => {
    try {
      const list = await invoke<BackupRunSummary[]>("list_backups");
      setBackups(list);
      if (selectedBackupId) {
        if (list.some(r => r.id === selectedBackupId)) {
          try {
            setBackupDetails(await invoke<BackupRunDetails>("get_backup_details", { runId: selectedBackupId }));
          } catch { setBackupDetails(null); }
        } else {
          setSelectedBackupId(null);
          setBackupDetails(null);
        }
      }
    } catch (e) { setError(`Backups: ${e}`); }
  }, [selectedBackupId]);

  const loadBackupDetails = useCallback(async (runId: string) => {
    setSelectedBackupId(runId);
    try { setBackupDetails(await invoke<BackupRunDetails>("get_backup_details", { runId })); } catch (e) { setError(`Backup details: ${e}`); }
  }, []);

  const openBackupsFolder = useCallback(() => {
    invoke<ActionResult>("open_backups_folder").catch(e => setError(`Open backups: ${e}`));
  }, []);

  // workspace diagnostics state
  const [workspaceDiagnostics, setWorkspaceDiagnostics] = useState<WorkspaceDiagnostics | null>(null);

  const loadWorkspaceDiagnostics = useCallback(async () => {
    try {
      setWorkspaceDiagnostics(await invoke<WorkspaceDiagnostics>("get_workspace_diagnostics"));
    } catch (e) { setError(`Workspace diagnostics: ${e}`); }
  }, []);

  // default workspace preview state
  const [defaultWorkspaceSummary, setDefaultWorkspaceSummary] = useState<DefaultWorkspaceSummary | null>(null);

  const loadDefaultWorkspaceSummary = useCallback(async () => {
    try {
      setDefaultWorkspaceSummary(await invoke<DefaultWorkspaceSummary>("get_default_workspace_summary"));
    } catch (e) { setError(`Default workspace: ${e}`); }
  }, []);

  function isInvalidWorkspaceError(e: unknown): boolean {
    return String(e).toLowerCase().includes(INVALID_WORKSPACE_TEXT);
  }

  // install skills state
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [installAgents, setInstallAgents] = useState<Set<string>>(new Set(["opencode"]));
  const [installScope, setInstallScope] = useState<"global" | "project">("global");
  const [installTarget, setInstallTarget] = useState("");
  const [installResult, setInstallResult] = useState<ActionResult | null>(null);
  const [installRunning, setInstallRunning] = useState(false);
  const skillsSelectionTouched = useRef(false);

  // settings state
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [agentTargets, setAgentTargets] = useState<AgentTargetMeta[]>([]);
  const [targetProfiles, setTargetProfiles] = useState<TargetProfileMeta[]>([]);

  // create workspace plan state
  const [createPlan, setCreatePlan] = useState<CreateWorkspacePlan | null>(null);
  const [createPlanRunning, setCreatePlanRunning] = useState(false);

  // create workspace result state
  const [createResult, setCreateResult] = useState<CreateWorkspaceResult | null>(null);
  const [createRunning, setCreateRunning] = useState(false);

  const planCreate = useCallback(async () => {
    setCreatePlanRunning(true);
    setCreatePlan(null);
    setCreateResult(null);
    try {
      const target = appSettings?.workspace_path ?? null;
      const plan = await invoke<CreateWorkspacePlan>("plan_create_workspace", { targetPath: target });
      setCreatePlan(plan);
    } catch (e) { setError(`Plan: ${e}`); }
    finally { setCreatePlanRunning(false); }
  }, [appSettings]);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await invoke<StatusData>("get_status");
      setStatus(data);
      setError(null);
    } catch (e) {
      setStatus(null);
      if (!isInvalidWorkspaceError(e)) setError(`Status error: ${e}`);
    }
  }, []);

  const runCreate = useCallback(async () => {
    setCreateRunning(true);
    setCreateResult(null);
    try {
      const target = appSettings?.workspace_path ?? null;
      const result = await invoke<CreateWorkspaceResult>("create_workspace_from_defaults", { targetPath: target });
      setCreateResult(result);
      if (result.success && appSettings) {
        const s = await invoke<AppSettings>("update_settings", { settings: appSettings });
        setAppSettings(s);
        document.documentElement.setAttribute("data-theme", s.appearance);
        setSettingsMsg({ ok: true, text: "workspace created" });
        fetchStatus();
        loadWorkspaceDiagnostics();
        setCreatePlan(null);
      }
    } catch (e) { setError(`Create: ${e}`); }
    finally { setCreateRunning(false); }
  }, [appSettings, fetchStatus, loadWorkspaceDiagnostics]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // initialize active config target from first enabled / first available
  useEffect(() => {
    const targets = agentTargets.filter(t => t.kind === "config");
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
    const targets = agentTargets.filter(t => t.kind === "config");
    const stillExists = targets.some(t => t.id === activeConfigTargetId);
    if (!stillExists) {
      const enabledSet = new Set(appSettings?.enabled_target_ids ?? []);
      const firstEnabled = targets.find(t => enabledSet.has(t.id));
      const fallback = firstEnabled ?? (targets.length > 0 ? targets[0] : null);
      setActiveConfigTargetId(fallback?.id ?? "");
    }
  }, [agentTargets, appSettings, activeConfigTargetId]);

  useEffect(() => {
    if (!running && !configRunning && !healthRunning && !installRunning) return;
    setActivityIndex(0);
    const id = window.setInterval(() => setActivityIndex(i => (i + 1) % 8), 110);
    return () => window.clearInterval(id);
  }, [running, configRunning, healthRunning, installRunning]);

  const runAction = useCallback(async (action: string) => {
    const startedAt = performance.now();
    setRunning(action); setError(null);
    try {
      const result = await invoke<ActionResult>("run_action", { action });
      setLog(result);
      if (!action.startsWith("open_")) fetchStatus();
    } catch (e) { setError(`${action}: ${e}`); }
    finally {
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      setRunning(null);
    }
  }, [fetchStatus]);

  const loadSkills = useCallback(async () => {
    try {
      const loaded = await invoke<SkillSummary[]>("list_skills");
      setSkills(loaded);
      if (!skillsSelectionTouched.current && loaded.length > 0) {
        setSelectedSkills(new Set(loaded.map(s => s.name)));
      }
    } catch (e) {
      setSkills([]);
      if (!isInvalidWorkspaceError(e)) setError(`Skills: ${e}`);
    }
  }, []);

  const loadDocs = useCallback(async () => {
    try {
      const list = await invoke<DocSummary[]>("list_docs");
      setDocs(list);
      if (list.length > 0) setActiveDoc(await invoke<DocumentContent>("read_doc", { id: list[0].id }));
      else setActiveDoc(null);
    } catch (e) {
      setDocs([]);
      setActiveDoc(null);
      if (!isInvalidWorkspaceError(e)) setError(`Docs: ${e}`);
    }
  }, []);

  const selectDoc = useCallback(async (id: string) => {
    try { setActiveDoc(await invoke<DocumentContent>("read_doc", { id })); } catch (e) { setError(`Read doc: ${e}`); }
  }, []);

  const openDocEditor = useCallback(async (id: string) => {
    try { await invoke<ActionResult>("open_doc", { id }); } catch (e) { setError(`Open doc: ${e}`); }
  }, []);

  const loadAgentTemplate = useCallback(async () => {
    try { setAgentTemplate(await invoke<DocumentContent>("read_agent_template")); } catch (e) { setError(`Template: ${e}`); }
  }, []);

  const loadConfigTemplate = useCallback(async (targetId: string) => {
    try { setConfigTemplateContent(await invoke<DocumentContent>("read_config_template", { targetId })); } catch (e) { setError(`Config: ${e}`); }
  }, []);

  // load config template when target or view changes to configs
  useEffect(() => {
    if (view === "configs" && activeConfigTargetId) {
      loadConfigTemplate(activeConfigTargetId);
    }
  }, [view, activeConfigTargetId, loadConfigTemplate]);

  const runInstall = useCallback(async (dry: boolean) => {
    if (installScope === "project" && installTarget.trim() === "") return;
    setInstallRunning(true);
    setInstallResult(null);
    try {
      const req: InstallSkillsRequest = {
        agents: Array.from(installAgents),
        scope: installScope,
        target: installScope === "project" ? installTarget : undefined,
        skills: Array.from(selectedSkills),
        dry_run: dry,
      };
      const result = await invoke<ActionResult>("install_skills", { request: req });
      setInstallResult(result);
      if (!dry && result.success) fetchStatus();
    } catch (e) {
      setInstallResult({
        success: false,
        action: dry ? "install_skills:dry-run" : "install_skills",
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
      setError(`Install: ${e}`);
    }
    finally { setInstallRunning(false); }
  }, [installAgents, installScope, installTarget, selectedSkills, fetchStatus]);

  const toggleSkill = useCallback((name: string) => {
    skillsSelectionTouched.current = true;
    setSelectedSkills(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => { skillsSelectionTouched.current = true; setSelectedSkills(new Set(skills.map(s => s.name))); }, [skills]);
  const clearSelection = useCallback(() => { skillsSelectionTouched.current = true; setSelectedSkills(new Set()); }, []);

  const toggleInstallAgent = useCallback((agent: InstallAgent) => {
    setInstallAgents(prev => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent); else next.add(agent);
      return next;
    });
  }, []);

  const openSkill = useCallback((id: string) => {
    invoke<ActionResult>("open_skill", { id }).catch(err => setError(`Open: ${err}`));
  }, []);

  const openInstallScript = useCallback(() => {
    invoke<ActionResult>("open_install_skills_script").catch(e => setError(`Open: ${e}`));
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const [s, targets, profiles] = await Promise.all([
        invoke<AppSettings>("get_settings"),
        invoke<AgentTargetMeta[]>("get_agent_targets"),
        invoke<TargetProfileMeta[]>("get_target_profiles"),
      ]);
      setAppSettings(s);
      setAgentTargets(targets);
      setTargetProfiles(profiles);
      document.documentElement.setAttribute("data-theme", s.appearance);
      setSettingsMsg(null);
    } catch (e) { setError(`Settings: ${e}`); }
  }, []);

  useEffect(() => { loadSettings(); loadWorkspaceDiagnostics(); loadDefaultWorkspaceSummary(); }, [loadSettings, loadWorkspaceDiagnostics, loadDefaultWorkspaceSummary]);

  const saveSettings = useCallback(async () => {
    if (!appSettings) return;
    try {
      const s = await invoke<AppSettings>("update_settings", { settings: appSettings });
      setAppSettings(s);
      document.documentElement.setAttribute("data-theme", s.appearance);
      setSettingsMsg({ ok: true, text: "settings saved" });
      fetchStatus();
      loadWorkspaceDiagnostics();
    } catch (e) { setSettingsMsg({ ok: false, text: String(e) }); }
  }, [appSettings, fetchStatus, loadWorkspaceDiagnostics]);

  const resetSettings = useCallback(async () => {
    const defaults: AppSettings = { appearance: "dark", workspace_path: null, enabled_target_ids: DEFAULT_TARGET_IDS };
    setCreatePlan(null);
    setCreateResult(null);
    try {
      const s = await invoke<AppSettings>("update_settings", { settings: defaults });
      setAppSettings(s);
      document.documentElement.setAttribute("data-theme", s.appearance);
      setSettingsMsg({ ok: true, text: "reset to defaults" });
      fetchStatus();
      loadWorkspaceDiagnostics();
    } catch (e) { setSettingsMsg({ ok: false, text: String(e) }); }
  }, [fetchStatus, loadWorkspaceDiagnostics]);

  const setAppearance = useCallback((appearance: AppSettings["appearance"]) => {
    setSettingsMsg(null);
    setAppSettings(prev => prev ? { ...prev, appearance } : prev);
    document.documentElement.setAttribute("data-theme", appearance);
  }, []);

  const setWorkspacePath = useCallback((workspacePath: string | null) => {
    setSettingsMsg(null);
    setCreatePlan(null);
    setCreateResult(null);
    setAppSettings(prev => prev ? { ...prev, workspace_path: workspacePath } : prev);
  }, []);

  const chooseWorkspaceFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        setWorkspacePath(selected);
      }
    } catch (e) {
      setError(`Choose folder: ${e}`);
    }
  }, [setWorkspacePath]);

  const switchView = useCallback((v: View) => {
    setView(v);
    setSettingsMsg(null);
    if (v === "workspace") { loadWorkspaceDiagnostics(); loadDefaultWorkspaceSummary(); }
    else if (v === "skills") loadSkills();
    else if (v === "docs") loadDocs();
    else if (v === "configs") { fetchStatus(); }
    else if (v === "health") { loadBackups(); }
    else if (v === "settings") { loadSettings(); }
    else if (v === "rules") { fetchStatus(); loadAgentTemplate(); }
  }, [loadSkills, loadDocs, loadAgentTemplate, loadBackups, loadWorkspaceDiagnostics, loadDefaultWorkspaceSummary, loadSettings, fetchStatus]);

  const selectConfigTarget = useCallback((targetId: string) => {
    setActiveConfigTargetId(targetId);
  }, []);

  const runConfigAction = useCallback(async (action: string) => {
    const startedAt = performance.now();
    setConfigRunning(action); setError(null);
    try {
      const result = await invoke<ActionResult>("run_action", { action });
      setConfigLog(result);
      fetchStatus();
    } catch (e) { setError(`Config: ${e}`); }
    finally {
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      setConfigRunning(null);
    }
  }, [fetchStatus]);

  const runHealthAction = useCallback(async (action: string) => {
    const startedAt = performance.now();
    setHealthRunning(action); setError(null);
    try {
      if (action === "release_check" && workspaceDiagnostics && !workspaceDiagnostics.valid) {
        setHealthLog({
          success: false,
          action,
          stdout: "",
          stderr: "No valid workspace selected. Use the Workspace tab.",
          exit_code: null,
        });
        return;
      }
      const result = await invoke<ActionResult>("run_action", { action });
      setHealthLog(result);
      fetchStatus();
    } catch (e) {
      if (isInvalidWorkspaceError(e)) {
        setHealthLog({
          success: false,
          action,
          stdout: "",
          stderr: "No valid workspace selected. Use the Workspace tab.",
          exit_code: null,
        });
      } else {
        setError(`Health: ${e}`);
      }
    }
    finally {
      loadBackups();
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      setHealthRunning(null);
    }
  }, [fetchStatus, loadBackups, workspaceDiagnostics]);

  const handleLeftAction = useCallback(async (action: string) => {
    setView("rules");
    await runAction(action);
  }, [runAction]);

  const enabledSet = new Set(appSettings?.enabled_target_ids ?? []);
  const enabledRuleSet = new Set(status?.enabled_rule_target_ids ?? []);
  const rsc = status ? ruleSyncCount(status, enabledRuleSet) : { synced: 0, total: 0 };
  const canInstall = selectedSkills.size > 0 && installAgents.size > 0 && !installRunning && (installScope !== "project" || installTarget.trim() !== "");
  const configEnabled = (status?.enabled_config_target_ids?.length ?? 0) > 0;
  const configTargets = agentTargets.filter(t => t.kind === "config");
  const activeConfigEnabled = enabledSet.has(activeConfigTargetId);
  const workspaceValid = workspaceDiagnostics?.valid === true;
  const canRunReleaseCheck = workspaceValid && workspaceDiagnostics?.release_check_available === true;

  const toggleTarget = useCallback((id: string) => {
    setSettingsMsg(null);
    setAppSettings(prev => {
      if (!prev) return prev;
      const ids = prev.enabled_target_ids.includes(id)
        ? prev.enabled_target_ids.filter(x => x !== id)
        : [...prev.enabled_target_ids, id];
      return { ...prev, enabled_target_ids: ids };
    });
  }, []);

  const applyTargetProfile = useCallback((profileId: string) => {
    const profile = targetProfiles.find(p => p.id === profileId);
    if (!profile) return;
    setSettingsMsg({ ok: true, text: "profile applied — save to persist" });
    setAppSettings(prev => prev ? { ...prev, enabled_target_ids: [...profile.target_ids] } : prev);
  }, [targetProfiles]);

  const activeProfileId = (() => {
    if (!appSettings) return null;
    const currentSet = new Set(appSettings.enabled_target_ids);
    const match = targetProfiles.find(p => {
      const profileSet = new Set(p.target_ids);
      if (profileSet.size !== currentSet.size) return false;
      for (const id of profileSet) {
        if (!currentSet.has(id)) return false;
      }
      return true;
    });
    return match ? match.id : null;
  })();

  function activityCellClass(index: number): string {
    const distance = (index - activityIndex + 8) % 8;
    if (distance === 0) return "terminal-activity-cell terminal-activity-cell-active";
    if (distance === 1 || distance === 7) return "terminal-activity-cell terminal-activity-cell-mid";
    if (distance === 2 || distance === 6) return "terminal-activity-cell terminal-activity-cell-low";
    return "terminal-activity-cell";
  }

  return (
    <div className="app-shell">
      {error && <div className="error-banner">{error}</div>}

      <header className="app-header" data-tauri-drag-region>
        <nav className="view-tabs">
          <button className={`tab ${view === "workspace" ? "tab-active" : ""}`} onClick={() => switchView("workspace")}>workspace</button>
          <button className={`tab ${view === "rules" ? "tab-active" : ""}`} onClick={() => switchView("rules")}>rules</button>
          <button className={`tab ${view === "skills" ? "tab-active" : ""}`} onClick={() => switchView("skills")}>skills</button>
          <button className={`tab ${view === "configs" ? "tab-active" : ""}`} onClick={() => switchView("configs")}>configs</button>
          <button className={`tab ${view === "health" ? "tab-active" : ""}`} onClick={() => switchView("health")}>health</button>
          <button className={`tab ${view === "docs" ? "tab-active" : ""}`} onClick={() => switchView("docs")}>docs</button>
          <button className={`tab ${view === "settings" ? "tab-active" : ""}`} onClick={() => switchView("settings")}>settings</button>
        </nav>
      </header>

      <div className="view-area">
        {view === "workspace" && (
          <WorkspaceView
            appSettings={appSettings}
            onSetWorkspacePath={setWorkspacePath}
            onChooseWorkspaceFolder={chooseWorkspaceFolder}
            workspaceDiagnostics={workspaceDiagnostics}
            onRefreshDiagnostics={loadWorkspaceDiagnostics}
            defaultWorkspaceSummary={defaultWorkspaceSummary}
            createPlan={createPlan}
            createPlanRunning={createPlanRunning}
            onPlanCreate={planCreate}
            createResult={createResult}
            createRunning={createRunning}
            onCreateWorkspace={runCreate}
          />
        )}

        {view === "rules" && (
          <RulesView
            status={status}
            log={log}
            running={running}
            rsc={rsc}
            gitAvailable={status?.git_available === true}
            agentTargets={agentTargets}
            enabledSet={enabledSet}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            syncTextClass={syncTextClass}
            targetDotClass={targetDotClass}
            onRunAction={handleLeftAction}
            agentTemplate={agentTemplate}
            onOpenTemplate={() => invoke<ActionResult>("open_agent_template").catch(e => setError(`Open: ${e}`))}
          />
        )}

        {view === "skills" && (
          <SkillsView
            skills={skills}
            workspaceValid={workspaceValid}
            selectedSkills={selectedSkills}
            installAgents={installAgents}
            installScope={installScope}
            installTarget={installTarget}
            installResult={installResult}
            installRunning={installRunning}
            canInstall={canInstall}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            onToggleSkill={toggleSkill}
            onSelectAll={selectAll}
            onClearSelection={clearSelection}
            onToggleInstallAgent={toggleInstallAgent}
            onSetInstallScope={setInstallScope}
            onSetInstallTarget={setInstallTarget}
            onDryRun={() => runInstall(true)}
            onInstallSelected={() => runInstall(false)}
            onOpenSkill={openSkill}
            onOpenInstallScript={openInstallScript}
          />
        )}

        {view === "docs" && (
          <DocsView
            docs={docs}
            activeDoc={activeDoc}
            workspaceValid={workspaceValid}
            onSelectDoc={selectDoc}
            onOpenDoc={openDocEditor}
          />
        )}

        {view === "health" && (
          <HealthView
            healthLog={healthLog}
            healthRunning={healthRunning}
            onRunHealthCheck={() => runHealthAction("release_check")}
            canRunHealthCheck={canRunReleaseCheck}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            backups={backups}
            onRefreshBackups={loadBackups}
            onOpenBackupsFolder={openBackupsFolder}
            workspaceDiagnostics={workspaceDiagnostics}
            selectedBackupId={selectedBackupId}
            backupDetails={backupDetails}
            onSelectBackup={loadBackupDetails}
          />
        )}

        {view === "configs" && (
          <ConfigsView
            status={status}
            activeConfigContent={configTemplateContent}
            activeConfigTargetId={activeConfigTargetId}
            activeConfigEnabled={activeConfigEnabled}
            configEnabled={configEnabled}
            configLog={configLog}
            configRunning={configRunning}
            configTargets={configTargets}
            onSelectConfigTarget={selectConfigTarget}
            onDiffConfig={() => runConfigAction("diff_configs")}
            onSyncConfig={() => runConfigAction("sync_configs")}
            onOpenConfig={() => invoke<ActionResult>("open_config_template", { targetId: activeConfigTargetId }).catch(e => setError(`Open: ${e}`))}
            syncTextClass={syncTextClass}
            targetDotClass={targetDotClass}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
          />
        )}

        {view === "settings" && (
          <SettingsView
            appSettings={appSettings}
            settingsMsg={settingsMsg}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            onSetAppearance={setAppearance}
            onToggleTarget={toggleTarget}
            onApplyProfile={applyTargetProfile}
            onSave={saveSettings}
            onReset={resetSettings}
          />
        )}
      </div>
    </div>
  );
}

export default App;
