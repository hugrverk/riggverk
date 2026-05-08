import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ActionResult } from "./components/TerminalOutput";
import { confirmLeaveDirtyEditor, dirtyTabClass, dirtyTabAriaLabel } from "./lib/editorGuards";
import { applyThemeSettings, defaultSettings, serializeSettingsForCompare } from "./lib/settingsDraft";
import { wait } from "./lib/timing";
import { useBackups } from "./lib/useBackups";
import { SettingsView } from "./views/SettingsView";
import { WorkspaceView } from "./views/WorkspaceView";
import { LibraryView, type LibrarySourceType } from "./views/LibraryView";
import { RoutingView } from "./views/RoutingView";
import type { AgentMetadataListResponse, AgentMetadataResponse, AgentSourceContent, AgentTargetMeta, AppSettings, CreateWorkspacePlan, CreateWorkspaceResult, DefaultWorkspaceSummary, DocSummary, DocumentContent, InstallAgent, InstallSkillsRequest, RoutingProfilesResponse, SkillSummary, StatusData, TargetProfileMeta, WorkspaceContractResult, WorkspaceDiagnostics } from "./types";

const MIN_RUNNING_MS = 700;
const INVALID_WORKSPACE_TEXT = "invalid workspace path";

type View = "workspace" | "library" | "routing" | "settings";

/* ---- main app ---- */

function App() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [activityIndex, setActivityIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("workspace");

  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [activeDoc, setActiveDoc] = useState<DocumentContent | null>(null);
  const activeDocIdRef = useRef<string | null>(null);

  // doc edit state
  const [docDraft, setDocDraft] = useState("");
  const [docDirty, setDocDirty] = useState(false);
  const [docSaving, setDocSaving] = useState(false);
  const [docSaveResult, setDocSaveResult] = useState<ActionResult | null>(null);
  const [docMode, setDocMode] = useState<"preview" | "edit">("preview");

  // custom doc creation state
  const [showCreateDoc, setShowCreateDoc] = useState(false);
  const [createDocTitle, setCreateDocTitle] = useState("");
  const [createDocSlug, setCreateDocSlug] = useState("");
  const [createDocError, setCreateDocError] = useState<string | null>(null);
  const [createDocCreating, setCreateDocCreating] = useState(false);

  useEffect(() => {
    if (activeDoc) {
      setDocDraft(activeDoc.content);
      setDocDirty(false);
      setDocSaveResult(null);
    } else {
      setDocDraft("");
      setDocDirty(false);
      setDocSaveResult(null);
      setDocMode("preview");
    }
  }, [activeDoc?.id]);

  const [agentTemplate, setAgentTemplate] = useState<DocumentContent | null>(null);

  // agent template edit state
  const [agentTemplateDraft, setAgentTemplateDraft] = useState("");
  const [agentTemplateDirty, setAgentTemplateDirty] = useState(false);
  const [agentTemplateSaving, setAgentTemplateSaving] = useState(false);
  const [agentTemplateSaveResult, setAgentTemplateSaveResult] = useState<ActionResult | null>(null);
  const [agentTemplateMode, setAgentTemplateMode] = useState<"preview" | "edit">("preview");

  useEffect(() => {
    if (agentTemplate) {
      setAgentTemplateDraft(agentTemplate.content);
      setAgentTemplateDirty(false);
      setAgentTemplateSaveResult(null);
    } else {
      setAgentTemplateDraft("");
      setAgentTemplateDirty(false);
      setAgentTemplateSaveResult(null);
      setAgentTemplateMode("preview");
    }
  }, [agentTemplate?.id]);

  const [configTemplateContent, setConfigTemplateContent] = useState<DocumentContent | null>(null);

  const [activeConfigTargetId, setActiveConfigTargetId] = useState<string>("");

  // config template edit state
  const [configDraft, setConfigDraft] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaveResult, setConfigSaveResult] = useState<ActionResult | null>(null);
  const [configMode, setConfigMode] = useState<"preview" | "edit">("preview");

  // backup history state
  const { backups, loadBackups, openBackupsFolder } = useBackups(setError);

  // workspace operations state
  const [wsLog, setWsLog] = useState<ActionResult | null>(null);
  const [wsRunning, setWsRunning] = useState<string | null>(null);
  const [wsLogCompletedAt, setWsLogCompletedAt] = useState<number | null>(null);

  // workspace diagnostics state
  const [workspaceDiagnostics, setWorkspaceDiagnostics] = useState<WorkspaceDiagnostics | null>(null);

  // workspace contract validation
  const [contractResult, setContractResult] = useState<WorkspaceContractResult | null>(null);

  const loadContract = useCallback(async () => {
    try {
      setContractResult(await invoke<WorkspaceContractResult>("validate_workspace_contract"));
    } catch (e) { setError(`Contract: ${e}`); }
  }, []);

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
  const skillsSelectionTouched = useRef(false);

  // skill preview state
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [activeSkillContent, setActiveSkillContent] = useState<DocumentContent | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const activeSkillIdRef = useRef<string | null>(null);
  const activeSkillContentIdRef = useRef<string | null>(null);

  // library source type state
  const [librarySourceType, setLibrarySourceType] = useState<LibrarySourceType>("docs");

  // agent source state
  const [agentSources, setAgentSources] = useState<AgentMetadataResponse[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeAgentContent, setActiveAgentContent] = useState<AgentSourceContent | null>(null);
  const [agentDraft, setAgentDraft] = useState("");
  const [agentDirty, setAgentDirty] = useState(false);
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentSaveResult, setAgentSaveResult] = useState<ActionResult | null>(null);
  const [agentMode, setAgentMode] = useState<"preview" | "edit">("preview");
  const activeAgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeAgentContent) {
      setAgentDraft(activeAgentContent.content);
      setAgentDirty(false);
      setAgentSaveResult(null);
    } else {
      setAgentDraft("");
      setAgentDirty(false);
      setAgentSaveResult(null);
      setAgentMode("preview");
    }
  }, [activeAgentContent]);

  // settings state
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [agentTargets, setAgentTargets] = useState<AgentTargetMeta[]>([]);
  const [targetProfiles, setTargetProfiles] = useState<TargetProfileMeta[]>([]);
  const savedSettingsRef = useRef<string | null>(null);

  const settingsDirty = useMemo(() => {
    if (!appSettings || savedSettingsRef.current === null) return false;
    return serializeSettingsForCompare(appSettings) !== savedSettingsRef.current;
  }, [appSettings]);

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
      const target = appSettings?.workspace_path ?? "~/Agent Workspace";
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
    if (!wsRunning) return;
    setActivityIndex(0);
    const id = window.setInterval(() => setActivityIndex(i => (i + 1) % 8), 110);
    return () => window.clearInterval(id);
  }, [wsRunning]);

  const loadSkills = useCallback(async () => {
    try {
      const loaded = await invoke<SkillSummary[]>("list_skills");
      setSkills(loaded);
      setSkillsLoaded(true);
      if (!skillsSelectionTouched.current && loaded.length > 0) {
        setSelectedSkills(new Set(loaded.map(s => s.name)));
      }
      if (loaded.length > 0) {
        const persistedId = activeSkillIdRef.current;
        const stillExists = persistedId && loaded.some(s => s.id === persistedId);
        const alreadyLoaded = persistedId && activeSkillContentIdRef.current === persistedId;
        if (stillExists && persistedId) {
          setActiveSkillId(persistedId);
          if (!alreadyLoaded) {
            const content = await invoke<DocumentContent>("read_skill", { id: persistedId });
            activeSkillContentIdRef.current = persistedId;
            setActiveSkillContent(content);
          }
        } else {
          const first = loaded[0];
          activeSkillIdRef.current = first.id;
          setActiveSkillId(first.id);
          const content = await invoke<DocumentContent>("read_skill", { id: first.id });
          activeSkillContentIdRef.current = first.id;
          setActiveSkillContent(content);
        }
      } else {
        activeSkillIdRef.current = null;
        activeSkillContentIdRef.current = null;
        setActiveSkillId(null);
        setActiveSkillContent(null);
      }
    } catch (e) {
      setSkills([]);
      setSkillsLoaded(true);
      activeSkillIdRef.current = null;
      activeSkillContentIdRef.current = null;
      setActiveSkillId(null);
      setActiveSkillContent(null);
      if (!isInvalidWorkspaceError(e)) setError(`Skills: ${e}`);
    }
  }, []);

  const loadDocs = useCallback(async () => {
    try {
      const list = await invoke<DocSummary[]>("list_docs");
      setDocs(list);
      if (list.length === 0) {
        activeDocIdRef.current = null;
        setActiveDoc(null);
      } else {
        const persistedId = activeDocIdRef.current;
        if (persistedId && list.some(d => d.id === persistedId)) {
          setActiveDoc(await invoke<DocumentContent>("read_doc", { id: persistedId }));
        } else {
          const first = list[0];
          activeDocIdRef.current = first.id;
          setActiveDoc(await invoke<DocumentContent>("read_doc", { id: first.id }));
        }
      }
    } catch (e) {
      setDocs([]);
      setActiveDoc(null);
      if (!isInvalidWorkspaceError(e)) setError(`Docs: ${e}`);
    }
  }, []);

  const loadRoutingData = useCallback(async () => {
    try {
      const data = await invoke<RoutingProfilesResponse>("get_routing_profiles");
      setRoutingData(data);
      setRoutingError(null);
    } catch (e) {
      setRoutingData(null);
      setRoutingError(String(e));
    }
  }, []);

  const selectDoc = useCallback(async (id: string) => {
    if (docDirty && id !== activeDoc?.id && !confirmLeaveDirtyEditor()) return;
    activeDocIdRef.current = id;
    try { setActiveDoc(await invoke<DocumentContent>("read_doc", { id })); } catch (e) { setError(`Read doc: ${e}`); }
  }, [docDirty, activeDoc?.id]);

  const openDocEditor = useCallback(async (id: string) => {
    try { await invoke<ActionResult>("open_doc", { id }); } catch (e) { setError(`Open doc: ${e}`); }
  }, []);

  const onSaveDoc = useCallback(async () => {
    if (!activeDoc) return;
    setDocSaving(true);
    setDocSaveResult(null);
    try {
      const result = await invoke<ActionResult>("save_doc", { id: activeDoc.id, content: docDraft });
      setDocSaveResult(result);
      if (result.success) {
        if (result.stdout !== "unchanged") {
          const updated = await invoke<DocumentContent>("read_doc", { id: activeDoc.id });
          setActiveDoc(updated);
          setDocDraft(updated.content);
        }
        setDocDirty(false);
      }
    } catch (e) {
      setDocSaveResult({
        success: false,
        action: "save_doc",
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setDocSaving(false);
    }
  }, [activeDoc, docDraft]);

  const onResetDoc = useCallback(() => {
    if (activeDoc) {
      setDocDraft(activeDoc.content);
      setDocDirty(false);
      setDocSaveResult(null);
    }
  }, [activeDoc]);

  const onChangeDocDraft = useCallback((value: string) => {
    setDocDraft(value);
    setDocDirty(value !== (activeDoc?.content ?? ""));
  }, [activeDoc]);

  const onChangeConfigDraft = useCallback((value: string) => {
    setConfigDraft(value);
    setConfigDirty(value !== (configTemplateContent?.content ?? ""));
  }, [configTemplateContent]);

  const loadConfigTemplate = useCallback(async (targetId: string) => {
    try { setConfigTemplateContent(await invoke<DocumentContent>("read_config_template", { targetId })); } catch (e) { setError(`Config: ${e}`); }
  }, []);

  const onSaveConfig = useCallback(async () => {
    if (!activeConfigTargetId) return;
    setConfigSaving(true);
    setConfigSaveResult(null);
    try {
      const result = await invoke<ActionResult>("save_config_template", {
        targetId: activeConfigTargetId,
        content: configDraft,
      });
      setConfigSaveResult(result);
      if (result.success) {
        if (result.stdout !== "unchanged") {
          const reloaded = await invoke<DocumentContent>("read_config_template", { targetId: activeConfigTargetId });
          setConfigTemplateContent(reloaded);
          setConfigDraft(reloaded.content);
        }
        setConfigDirty(false);
      }
    } catch (e) {
      setConfigSaveResult({
        success: false,
        action: "save_config_template",
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setConfigSaving(false);
    }
  }, [activeConfigTargetId, configDraft]);

  const onResetConfig = useCallback(() => {
    if (configTemplateContent) {
      setConfigDraft(configTemplateContent.content);
      setConfigDirty(false);
      setConfigSaveResult(null);
    }
  }, [configTemplateContent]);

  // ── agent source callbacks ──

  const loadAgentSources = useCallback(async () => {
    try {
      const list = await invoke<AgentMetadataListResponse>("list_agent_metadata");
      setAgentSources(list.agents);
      if (list.agents.length > 0) {
        const persistedId = activeAgentIdRef.current;
        const stillExists = persistedId && list.agents.some(a => a.id === persistedId && a.exists);
        const firstExisting = list.agents.find(a => a.exists);
        if (stillExists && persistedId) {
          setActiveAgentId(persistedId);
          const content = await invoke<AgentSourceContent>("read_agent_source", { filename: persistedId });
          setActiveAgentContent(content);
        } else if (firstExisting) {
          activeAgentIdRef.current = firstExisting.id;
          setActiveAgentId(firstExisting.id);
          const content = await invoke<AgentSourceContent>("read_agent_source", { filename: firstExisting.id });
          setActiveAgentContent(content);
        } else {
          activeAgentIdRef.current = null;
          setActiveAgentId(null);
          setActiveAgentContent(null);
        }
      } else {
        activeAgentIdRef.current = null;
        setActiveAgentId(null);
        setActiveAgentContent(null);
      }
    } catch (e) {
      setAgentSources([]);
      setActiveAgentId(null);
      setActiveAgentContent(null);
      if (!isInvalidWorkspaceError(e)) setError(`Agents: ${e}`);
    }
  }, []);

  const loadWorkspaceResources = useCallback(async () => {
    await Promise.all([
      loadSkills().catch(() => {}),
      loadDocs().catch(() => {}),
      loadAgentSources().catch(() => {}),
      loadRoutingData().catch(() => {}),
      loadContract().catch(() => {}),
      fetchStatus().catch(() => {}),
    ]);
  }, [loadSkills, loadDocs, loadAgentSources, loadRoutingData, loadContract, fetchStatus]);

  const runCreate = useCallback(async () => {
    setCreateRunning(true);
    setCreateResult(null);
    try {
      const target = appSettings?.workspace_path ?? "~/Agent Workspace";
      const result = await invoke<CreateWorkspaceResult>("create_workspace_from_defaults", { targetPath: target });
      setCreateResult(result);
      if (result.success && appSettings) {
        skillsSelectionTouched.current = false;
        setSelectedSkills(new Set());
        const s = await invoke<AppSettings>("update_settings", { settings: appSettings });
        setAppSettings(s);
        savedSettingsRef.current = serializeSettingsForCompare(s);
        applyThemeSettings(s);
        setSettingsMsg({ ok: true, text: "workspace created" });
        Promise.all([
          loadWorkspaceDiagnostics(),
          loadWorkspaceResources(),
        ]);
        setCreatePlan(null);
      }
    } catch (e) { setError(`Create: ${e}`); }
    finally { setCreateRunning(false); }
  }, [appSettings, loadWorkspaceDiagnostics, loadWorkspaceResources]);

  const selectAgent = useCallback(async (id: string) => {
    if (agentDirty && id !== activeAgentId && !confirmLeaveDirtyEditor()) return;
    activeAgentIdRef.current = id;
    setActiveAgentId(id);
    try {
      const content = await invoke<AgentSourceContent>("read_agent_source", { filename: id });
      setActiveAgentContent(content);
    } catch (e) { setError(`Read agent: ${e}`); }
  }, [agentDirty, activeAgentId]);

  const openAgent = useCallback(async (id: string) => {
    try { await invoke<ActionResult>("open_agent_source", { filename: id }); } catch (e) { setError(`Open agent: ${e}`); }
  }, []);

  const onSaveAgent = useCallback(async () => {
    if (!activeAgentId) return;
    setAgentSaving(true);
    setAgentSaveResult(null);
    try {
      const result = await invoke<ActionResult>("save_agent_source", { filename: activeAgentId, content: agentDraft });
      setAgentSaveResult(result);
      if (result.success) {
        if (result.stdout !== "unchanged") {
          const updated = await invoke<AgentSourceContent>("read_agent_source", { filename: activeAgentId });
          setActiveAgentContent(updated);
          setAgentDraft(updated.content);
        }
        setAgentDirty(false);
      }
    } catch (e) {
      setAgentSaveResult({
        success: false,
        action: "save_agent_source",
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setAgentSaving(false);
    }
  }, [activeAgentId, agentDraft]);

  const onResetAgent = useCallback(() => {
    if (activeAgentContent) {
      setAgentDraft(activeAgentContent.content);
      setAgentDirty(false);
      setAgentSaveResult(null);
    }
  }, [activeAgentContent]);

  const onChangeAgentDraft = useCallback((value: string) => {
    setAgentDraft(value);
    setAgentDirty(value !== (activeAgentContent?.content ?? ""));
  }, [activeAgentContent]);

  const onCreateDoc = useCallback(async () => {
    if (docDirty && !confirmLeaveDirtyEditor()) return;
    const title = createDocTitle.trim();
    const slug = createDocSlug.trim();
    if (!title || !slug) {
      setCreateDocError("Title and slug are required");
      return;
    }
    setCreateDocCreating(true);
    setCreateDocError(null);
    try {
      const doc = await invoke<DocumentContent>("create_doc", { title, slug, content: null });
      setShowCreateDoc(false);
      setCreateDocTitle("");
      setCreateDocSlug("");
      activeDocIdRef.current = doc.id;
      setActiveDoc(doc);
      await loadDocs();
    } catch (e) {
      setCreateDocError(String(e));
    } finally {
      setCreateDocCreating(false);
    }
  }, [docDirty, createDocTitle, createDocSlug, loadDocs]);

  const loadAgentTemplate = useCallback(async () => {
    try { setAgentTemplate(await invoke<DocumentContent>("read_agent_template")); } catch (e) { setError(`Template: ${e}`); }
  }, []);

  const onChangeAgentTemplateDraft = useCallback((value: string) => {
    setAgentTemplateDraft(value);
    setAgentTemplateDirty(value !== (agentTemplate?.content ?? ""));
  }, [agentTemplate]);

  const onSaveAgentTemplate = useCallback(async () => {
    setAgentTemplateSaving(true);
    setAgentTemplateSaveResult(null);
    try {
      const result = await invoke<ActionResult>("save_agent_template", { content: agentTemplateDraft });
      setAgentTemplateSaveResult(result);
      if (result.success) {
        if (result.stdout !== "unchanged") {
          const updated = await invoke<DocumentContent>("read_agent_template");
          setAgentTemplate(updated);
          setAgentTemplateDraft(updated.content);
        }
        setAgentTemplateDirty(false);
      }
    } catch (e) {
      setAgentTemplateSaveResult({
        success: false,
        action: "save_agent_template",
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setAgentTemplateSaving(false);
    }
  }, [agentTemplateDraft]);

  const onResetAgentTemplate = useCallback(() => {
    if (agentTemplate) {
      setAgentTemplateDraft(agentTemplate.content);
      setAgentTemplateDirty(false);
      setAgentTemplateSaveResult(null);
    }
  }, [agentTemplate]);

  // load config template when library configs source type is active
  useEffect(() => {
    if ((view === "library" && librarySourceType === "configs") && activeConfigTargetId) {
      loadConfigTemplate(activeConfigTargetId);
    }
  }, [view, librarySourceType, activeConfigTargetId, loadConfigTemplate]);

  useEffect(() => {
    if (configTemplateContent) {
      setConfigDraft(configTemplateContent.content);
      setConfigDirty(false);
      setConfigSaveResult(null);
      setConfigMode("preview");
    } else {
      setConfigDraft("");
      setConfigDirty(false);
      setConfigSaveResult(null);
      setConfigMode("preview");
    }
  }, [configTemplateContent?.id]);

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

  const readSkill = useCallback(async (id: string) => {
    activeSkillIdRef.current = id;
    setActiveSkillId(id);
    try {
      const content = await invoke<DocumentContent>("read_skill", { id });
      activeSkillContentIdRef.current = id;
      setActiveSkillContent(content);
    } catch (e) { setError(`Read skill: ${e}`); }
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
      savedSettingsRef.current = serializeSettingsForCompare(s);
      setAgentTargets(targets);
      setTargetProfiles(profiles);
      applyThemeSettings(s);
      setSettingsMsg(null);
    } catch (e) { setError(`Settings: ${e}`); }
  }, []);

  useEffect(() => { loadSettings(); loadWorkspaceDiagnostics(); loadDefaultWorkspaceSummary(); loadWorkspaceResources(); }, [loadSettings, loadWorkspaceDiagnostics, loadDefaultWorkspaceSummary, loadWorkspaceResources]);

  const saveSettings = useCallback(async () => {
    if (!appSettings) return;
    try {
      const s = await invoke<AppSettings>("update_settings", { settings: appSettings });
      setAppSettings(s);
      savedSettingsRef.current = serializeSettingsForCompare(s);
      applyThemeSettings(s);
      setAccentResetKey(k => k + 1);
      setSettingsMsg({ ok: true, text: "settings saved" });
      fetchStatus();
      loadWorkspaceDiagnostics();
    } catch (e) { setSettingsMsg({ ok: false, text: String(e) }); }
  }, [appSettings, fetchStatus, loadWorkspaceDiagnostics]);

  const applyWorkspacePath = useCallback(async (workspacePath: string | null) => {
    setCreatePlan(null);
    setCreateResult(null);
    if (!appSettings) return;
    try {
      // Reset skill selection for the new workspace
      skillsSelectionTouched.current = false;
      setSelectedSkills(new Set());
      const nextSettings = { ...appSettings, workspace_path: workspacePath };
      const s = await invoke<AppSettings>("update_settings", { settings: nextSettings });
      setAppSettings(s);
      savedSettingsRef.current = serializeSettingsForCompare(s);
      applyThemeSettings(s);
      setSettingsMsg(null);
      // Refresh all workspace-dependent data
      await Promise.all([
        loadWorkspaceDiagnostics().catch(() => {}),
        loadWorkspaceResources(),
      ]);
    } catch (e) {
      setError(`Apply workspace path: ${e}`);
    }
  }, [appSettings, loadWorkspaceDiagnostics, loadWorkspaceResources]);

  const resetSettings = useCallback(async () => {
    const defaults = defaultSettings();
    setCreatePlan(null);
    setCreateResult(null);
    try {
      const s = await invoke<AppSettings>("update_settings", { settings: defaults });
      setAppSettings(s);
      savedSettingsRef.current = serializeSettingsForCompare(s);
      applyThemeSettings(s);
      setAccentResetKey(k => k + 1);
      setSettingsMsg({ ok: true, text: "reset to defaults" });
      fetchStatus();
      loadWorkspaceDiagnostics();
    } catch (e) { setSettingsMsg({ ok: false, text: String(e) }); }
  }, [fetchStatus, loadWorkspaceDiagnostics]);

  const setAppearance = useCallback((appearance: AppSettings["appearance"]) => {
    setSettingsMsg(null);
    setAppSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, appearance };
      applyThemeSettings(next);
      return next;
    });
  }, []);

  const setAccentColor = useCallback((accentColor: string | null) => {
    setSettingsMsg(null);
    setAppSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, accent_color: accentColor };
      applyThemeSettings(next);
      return next;
    });
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
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (path) await applyWorkspacePath(path);
      }
    } catch (e) {
      setError(`Choose folder: ${e}`);
    }
  }, [applyWorkspacePath]);

  // routing state
  const [routingData, setRoutingData] = useState<RoutingProfilesResponse | null>(null);
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [routingDirty, setRoutingDirty] = useState(false);

  const switchView = useCallback((v: View) => {
    if (v !== view) {
      const isLibraryDirty = view === "library" && (
        (librarySourceType === "docs" && docDirty) ||
        (librarySourceType === "rules" && agentTemplateDirty) ||
        (librarySourceType === "configs" && configDirty) ||
        (librarySourceType === "agents" && agentDirty)
      );
      const isSettingsDirty = view === "settings" && settingsDirty;
      const isRoutingDirty = view === "routing" && routingDirty;
      if ((isLibraryDirty || isSettingsDirty || isRoutingDirty) && !confirmLeaveDirtyEditor()) return;
    }
    setView(v);
    setSettingsMsg(null);
    if (v === "workspace") { loadWorkspaceDiagnostics(); loadDefaultWorkspaceSummary(); loadContract(); }
    else if (v === "library") { loadDocs(); loadSkills(); loadAgentSources(); loadAgentTemplate(); fetchStatus(); }
    else if (v === "routing") { loadRoutingData(); }
    else if (v === "settings") { if (!settingsDirty) loadSettings(); }
  }, [view, librarySourceType, docDirty, agentTemplateDirty, configDirty, agentDirty, settingsDirty, routingDirty, loadSkills, loadDocs, loadAgentTemplate, loadAgentSources, loadWorkspaceDiagnostics, loadDefaultWorkspaceSummary, loadSettings, fetchStatus]);

  const selectConfigTarget = useCallback((targetId: string) => {
    if (configDirty && targetId !== activeConfigTargetId && !confirmLeaveDirtyEditor()) return;
    setActiveConfigTargetId(targetId);
  }, [configDirty, activeConfigTargetId]);

  const runWsAction = useCallback(async (action: string, label: string) => {
    const startedAt = performance.now();
    setWsRunning(label); setError(null);
    try {
      if (action === "release_check" && workspaceDiagnostics && !workspaceDiagnostics.valid) {
        setWsLog({ success: false, action, stdout: "", stderr: "No valid workspace selected. Set path above or create one.", exit_code: null });
        return;
      }
      const result = await invoke<ActionResult>("run_action", { action });
      setWsLog(result);
      setWsLogCompletedAt(Date.now());
      if (!action.startsWith("open_")) fetchStatus();
    } catch (e) {
      if (isInvalidWorkspaceError(e)) {
        setWsLog({ success: false, action, stdout: "", stderr: "No valid workspace selected. Set path above or create one.", exit_code: null });
      } else {
        setError(`${action}: ${e}`);
      }
    }
    finally {
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      setWsRunning(null);
    }
  }, [fetchStatus, workspaceDiagnostics]);

  const runWsInstall = useCallback(async (dry: boolean) => {
    if (installScope === "project" && installTarget.trim() === "") return;
    const label = dry ? "install skills dry-run" : "install skills";
    const startedAt = performance.now();
    setWsRunning(label); setError(null);
    try {
      const req: InstallSkillsRequest = {
        agents: Array.from(installAgents),
        scope: installScope,
        target: installScope === "project" ? installTarget : undefined,
        skills: Array.from(selectedSkills),
        dry_run: dry,
      };
      const result = await invoke<ActionResult>("install_skills", { request: req });
      setWsLog(result);
      setWsLogCompletedAt(Date.now());
      if (!dry && result.success) fetchStatus();
    } catch (e) {
      setWsLog({ success: false, action: dry ? "install_skills:dry-run" : "install_skills", stdout: "", stderr: String(e), exit_code: null });
      setError(`Install: ${e}`);
    }
    finally {
      const remaining = MIN_RUNNING_MS - (performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      setWsRunning(null);
    }
  }, [installAgents, installScope, installTarget, selectedSkills, fetchStatus]);

  const configEnabled = (status?.enabled_config_target_ids?.length ?? 0) > 0;
  const configTargets = agentTargets.filter(t => t.kind === "config");
  const workspaceValid = workspaceDiagnostics?.valid === true;
  const canRunReleaseCheck = workspaceValid && workspaceDiagnostics?.release_check_available === true;
  const gitAvailable = status?.git_available === true;
  const ruleTargetsEnabled = (status?.enabled_rule_target_ids?.length ?? 0) > 0;
  const installAgentsArray = Array.from(installAgents);
  const skillsCanInstall = selectedSkills.size > 0 && installAgents.size > 0 && !wsRunning && (installScope !== "project" || installTarget.trim() !== "");

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

  const [accentResetKey, setAccentResetKey] = useState(0);

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
        <nav className="nav-icons">
          {/* Workspace */}
          <button
            className={`nav-icon ${view === "workspace" ? "nav-icon-active" : ""}`}
            onClick={() => switchView("workspace")}
            aria-label="Workspace"
            title="Workspace"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4,17 10,11 4,5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
          {/* Library */}
          <button
            className={`nav-icon ${view === "library" ? "nav-icon-active" : ""}${dirtyTabClass(docDirty || agentTemplateDirty || configDirty || agentDirty)}`}
            onClick={() => switchView("library")}
            aria-label={dirtyTabAriaLabel(docDirty || agentTemplateDirty || configDirty || agentDirty, "Library")}
            title="Library"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4,19.5A2.5,2.5 0 0,1 6.5,17H20" />
              <path d="M6.5,2H20v20H6.5A2.5,2.5 0 0,1 4,19.5v-15A2.5,2.5 0 0,1 6.5,2z" />
              <line x1="8" y1="7" x2="16" y2="7" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          {/* Routing */}
          <button
            className={`nav-icon ${view === "routing" ? "nav-icon-active" : ""}${dirtyTabClass(routingDirty)}`}
            onClick={() => switchView("routing")}
            aria-label={dirtyTabAriaLabel(routingDirty, "Brain Setup")}
            title="Brain Setup"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2.5" />
              <circle cx="18" cy="6" r="2.5" />
              <circle cx="6" cy="18" r="2.5" />
              <circle cx="18" cy="18" r="2.5" />
              <line x1="8.5" y1="6" x2="15.5" y2="6" />
              <line x1="6" y1="8.5" x2="6" y2="15.5" />
              <line x1="18" y1="8.5" x2="18" y2="15.5" />
              <line x1="8.5" y1="18" x2="15.5" y2="18" />
            </svg>
          </button>
          {/* Settings */}
          <button
            className={`nav-icon ${view === "settings" ? "nav-icon-active" : ""}${dirtyTabClass(settingsDirty)}`}
            onClick={() => switchView("settings")}
            aria-label={dirtyTabAriaLabel(settingsDirty, "Settings")}
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
          </button>
        </nav>
      </header>

      <div className="view-area">
        {view === "workspace" && (
          <WorkspaceView
            appSettings={appSettings}
            onSetWorkspacePath={setWorkspacePath}
            onApplyWorkspacePath={applyWorkspacePath}
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
            // operations
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            ruleTargetsEnabled={ruleTargetsEnabled}
            configEnabled={configEnabled}
            canRunReleaseCheck={canRunReleaseCheck}
            onPull={() => runWsAction("git_pull", "git pull")}
            onDiffRules={() => runWsAction("diff_agent_rules", "diff rules")}
            onSyncRules={() => runWsAction("sync_agent_rules", "sync rules")}
            onDiffConfigs={() => runWsAction("diff_configs", "diff configs")}
            onSyncConfigs={() => runWsAction("sync_configs", "sync configs")}
            onReleaseCheck={() => runWsAction("release_check", "release-check")}
            onRefreshStatus={fetchStatus}
            // skills
            skills={skills}
            skillsLoaded={skillsLoaded}
            selectedSkills={selectedSkills}
            skillSearch={skillSearch}
            installAgents={installAgentsArray}
            installScope={installScope}
            installTarget={installTarget}
            skillsCanInstall={skillsCanInstall}
            onDryRunSkills={() => runWsInstall(true)}
            onInstallSkills={() => runWsInstall(false)}
            onToggleSkill={toggleSkill}
            onSelectAllSkills={selectAll}
            onClearSelectionSkills={clearSelection}
            onToggleInstallAgent={toggleInstallAgent}
            onSetInstallScope={setInstallScope}
            onSetInstallTarget={setInstallTarget}
            onSetSkillSearch={setSkillSearch}
            onOpenInstallScript={openInstallScript}
            // backups
            backupCount={backups.length}
            onRefreshBackups={loadBackups}
            onOpenBackupsFolder={openBackupsFolder}
            // contract
            contractResult={contractResult}
            onRefreshContract={loadContract}
          />
        )}

        {view === "library" && (
          <LibraryView
            sourceType={librarySourceType}
            onSetSourceType={(type) => {
              const currentDirty =
                (librarySourceType === "docs" && docDirty) ||
                (librarySourceType === "rules" && agentTemplateDirty) ||
                (librarySourceType === "configs" && configDirty) ||
                (librarySourceType === "agents" && agentDirty);
              if (currentDirty && !confirmLeaveDirtyEditor()) return;
              setLibrarySourceType(type);
              if (type === "configs") { fetchStatus(); }
            }}
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
            onOpenConfig={() => invoke<ActionResult>("open_config_template", { targetId: activeConfigTargetId }).catch(e => setError(`Open: ${e}`))}
            configDraft={configDraft}
            configDirty={configDirty}
            configSaving={configSaving}
            configSaveResult={configSaveResult}
            configMode={configMode}
            onSetConfigMode={setConfigMode}
            onChangeConfigDraft={onChangeConfigDraft}
            onSaveConfig={onSaveConfig}
            onResetConfig={onResetConfig}
            // Common
            workspaceValid={workspaceValid}
          />
        )}

        {view === "routing" && (
          <RoutingView
            routingData={routingData}
            routingError={routingError}
            workspaceValid={workspaceValid}
            onProfilesChanged={loadRoutingData}
            onRoutingDirtyChange={setRoutingDirty}
            skills={skills}
            agentSources={agentSources}
            contractResult={contractResult}
          />
        )}

        {view === "settings" && (
          <SettingsView
            appSettings={appSettings}
            settingsMsg={settingsMsg}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsDirty={settingsDirty}
            onSetAppearance={setAppearance}
            onSetAccentColor={setAccentColor}
            onToggleTarget={toggleTarget}
            onApplyProfile={applyTargetProfile}
            onSave={saveSettings}
            onReset={resetSettings}
            accentResetKey={accentResetKey}
          />
        )}
      </div>
    </div>
  );
}

export default App;
