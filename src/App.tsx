import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ActionResult } from "./components/TerminalOutput";
import { ToolIcon } from "./components/ToolIcon";
import { confirmLeaveDirtyEditor, dirtyTabClass, dirtyTabAriaLabel } from "./lib/editorGuards";
import { buildBrainSetupBlock } from "./lib/brainSetup";
import { applyThemeSettings, defaultSettings, serializeSettingsForCompare } from "./lib/settingsDraft";
import { useBackups } from "./lib/useBackups";
import { useWorkspaceActions } from "./lib/useWorkspaceActions";
import { useWorkspaceGeneration } from "./lib/useWorkspaceGeneration";
import { isLibrarySourceTypeDirty } from "./lib/libraryDirtyGuards";
import { CodexView } from "./views/CodexView";
import { CursorView } from "./views/CursorView";
import { ClaudeView } from "./views/ClaudeView";
import { AugmentView } from "./views/AugmentView";
import { OpenCodeView } from "./views/OpenCodeView";
import { StartView } from "./views/StartView";
const LibraryView = lazy(() => import("./views/LibraryView").then(m => ({ default: m.LibraryView })));
import type { LibrarySourceType } from "./views/LibraryView";
const SettingsView = lazy(() => import("./views/SettingsView").then(m => ({ default: m.SettingsView })));
import { DEFAULT_WORKSPACE_PATH } from "./lib/settingsDraft";
import type { AgentMetadataListResponse, AgentMetadataResponse, AgentSourceContent, AgentTargetMeta, AppSettings, BrainSetupSeedResult, ConfigEditorSourceMeta, CreateWorkspacePlan, CreateWorkspaceResult, CursorProfileHealth, DocSummary, DocumentContent, InitializeWorkspaceResult, OpenCodeRuntimeHealth, RepairWorkspaceResult, SkillSummary, StatusData, TargetProfileMeta, WorkspaceContractResult, WorkspaceDiagnostics, WorkspaceSetupEvaluation } from "./types";

const INVALID_WORKSPACE_TEXT = "invalid workspace path";
const NO_WORKSPACE_TEXT = "no workspace selected";
const EDITABLE_CONFIG_TARGET_IDS = new Set(["opencode_config"]);

type View =
  | "start"
  | "codex"
  | "opencode"
  | "cursor"
  | "claude"
  | "augment"
  | "library"
  | "settings";

function isWorkspaceLoadView(view: View): boolean {
  return view === "start" || view === "codex" || view === "opencode" || view === "cursor" || view === "claude" || view === "augment";
}

/* ---- main app ---- */

function App() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("start");
  const appliedWorkspacePathRef = useRef<string | null | undefined>(undefined);

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

  // opencode config editor source state
  const [configEditorSources, setConfigEditorSources] = useState<ConfigEditorSourceMeta[]>([]);
  const [activeConfigSourceType, setActiveConfigSourceType] = useState<string>("base");
  const [configEditorSourceContent, setConfigEditorSourceContent] = useState<DocumentContent | null>(null);
  const [configEditorSourceSaveMessage, setConfigEditorSourceSaveMessage] = useState<string>("");

  // backup history state
  const { backups, loadBackups, openBackupsFolder } = useBackups(setError);

  // workspace resource generation
  const { workspaceLoadGenerationRef, isWorkspaceLoadCurrent, beginWorkspaceLoadGeneration } = useWorkspaceGeneration();

  // workspace operations state (moved to hook)
  const [workspaceDiagnostics, setWorkspaceDiagnostics] = useState<WorkspaceDiagnostics | null>(null);

  // workspace contract validation
  const [, setContractResult] = useState<WorkspaceContractResult | null>(null);

  // opencode runtime health
  const [opencodeRuntimeHealth, setOpencodeRuntimeHealth] = useState<OpenCodeRuntimeHealth | null>(null);
  const [cursorProfileHealth, setCursorProfileHealth] = useState<CursorProfileHealth | null>(null);
  const [brainSetupSeed, setBrainSetupSeed] = useState<BrainSetupSeedResult | null>(null);

  const loadContract = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const result = await invoke<WorkspaceContractResult>("validate_workspace_contract");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setContractResult(result);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (!isInvalidWorkspaceError(e)) setError(`Contract: ${e}`);
      setContractResult(null);
    }
  }, [isWorkspaceLoadCurrent]);

  const loadCursorProfileHealth = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const health = await invoke<CursorProfileHealth>("get_cursor_profile_health");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setCursorProfileHealth(health);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setCursorProfileHealth(null);
      if (!isInvalidWorkspaceError(e)) setError(`Cursor profile: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  const loadBrainSetupSeed = useCallback(async () => {
    try {
      const result = await invoke<BrainSetupSeedResult>("read_brain_setup_seed");
      setBrainSetupSeed(result);
    } catch {
      setBrainSetupSeed(null);
    }
  }, []);

  const loadOpenCodeRuntimeHealth = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const health = await invoke<OpenCodeRuntimeHealth>("get_opencode_runtime_health");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setOpencodeRuntimeHealth(health);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      // Don't show error for runtime health — it's informational
      setOpencodeRuntimeHealth(null);
    }
  }, [isWorkspaceLoadCurrent]);

  const loadWorkspaceDiagnostics = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const diagnostics = await invoke<WorkspaceDiagnostics>("get_workspace_diagnostics");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setWorkspaceDiagnostics(diagnostics);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Workspace diagnostics: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  // default workspace preview state
  function isInvalidWorkspaceError(e: unknown): boolean {
    const message = String(e).toLowerCase();
    return message.includes(INVALID_WORKSPACE_TEXT) || message.includes(NO_WORKSPACE_TEXT);
  }

  // install skills state
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const installAgents = useMemo(() => new Set<string>(["opencode"]), []);
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

  const [workspacePathDraft, setWorkspacePathDraft] = useState("");
  const [workspaceSetup, setWorkspaceSetup] = useState<WorkspaceSetupEvaluation | null>(null);
  const [initResult, setInitResult] = useState<InitializeWorkspaceResult | null>(null);
  const [initRunning, setInitRunning] = useState(false);

  useEffect(() => {
    if (workspaceDiagnostics?.valid && appSettings?.workspace_path) {
      setWorkspacePathDraft(appSettings.workspace_path);
    }
  }, [appSettings?.workspace_path, workspaceDiagnostics?.valid]);

  const workspaceSetupTarget = useCallback((): string => {
    const trimmed = workspacePathDraft.trim();
    if (trimmed) return trimmed;
    if (workspaceSetup?.candidate_path) return workspaceSetup.candidate_path;
    if (createPlan?.target_path) return createPlan.target_path;
    return DEFAULT_WORKSPACE_PATH;
  }, [workspacePathDraft, workspaceSetup?.candidate_path, createPlan?.target_path]);

  const evaluateWorkspaceCandidate = useCallback(async (targetPath?: string) => {
    const path = (targetPath ?? workspacePathDraft.trim()) || DEFAULT_WORKSPACE_PATH;
    setCreatePlanRunning(true);
    setCreatePlan(null);
    setCreateResult(null);
    setInitResult(null);
    setWorkspaceSetup(null);
    try {
      const evaluation = await invoke<WorkspaceSetupEvaluation>("evaluate_workspace_setup", {
        targetPath: path,
      });
      setWorkspaceSetup(evaluation);
      setCreatePlan(evaluation.plan);
      setWorkspacePathDraft(evaluation.candidate_path || path);
    } catch (e) {
      setError(`Workspace setup: ${e}`);
    } finally {
      setCreatePlanRunning(false);
    }
  }, [workspacePathDraft]);

  const planCreate = useCallback(async () => {
    await evaluateWorkspaceCandidate(workspaceSetupTarget());
  }, [evaluateWorkspaceCandidate, workspaceSetupTarget]);

  const fetchStatus = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const data = await invoke<StatusData>("get_status");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setStatus(data);
      setError(null);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setStatus(null);
      if (!isInvalidWorkspaceError(e)) setError(`Status error: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const isLibrarySourceDirty = useCallback((sourceType: LibrarySourceType): boolean => {
    return isLibrarySourceTypeDirty(sourceType, docDirty, agentTemplateDirty, agentDirty, configDirty);
  }, [docDirty, agentTemplateDirty, agentDirty, configDirty]);

  const setGuardedLibrarySourceType = useCallback((type: LibrarySourceType) => {
    if (type === librarySourceType) return;
    if (isLibrarySourceDirty(librarySourceType) && !confirmLeaveDirtyEditor()) return;
    setLibrarySourceType(type);
    if (type === "configs") fetchStatus();
  }, [librarySourceType, isLibrarySourceDirty, fetchStatus]);

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

  const loadSkills = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const loaded = await invoke<SkillSummary[]>("list_skills");
      if (!isWorkspaceLoadCurrent(generation)) return;
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
            if (!isWorkspaceLoadCurrent(generation)) return;
            activeSkillContentIdRef.current = persistedId;
            setActiveSkillContent(content);
          }
        } else {
          const first = loaded[0];
          activeSkillIdRef.current = first.id;
          setActiveSkillId(first.id);
          const content = await invoke<DocumentContent>("read_skill", { id: first.id });
          if (!isWorkspaceLoadCurrent(generation)) return;
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
      if (!isWorkspaceLoadCurrent(generation)) return;
      setSkills([]);
      setSkillsLoaded(true);
      activeSkillIdRef.current = null;
      activeSkillContentIdRef.current = null;
      setActiveSkillId(null);
      setActiveSkillContent(null);
      if (!isInvalidWorkspaceError(e)) setError(`Skills: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  const loadDocs = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const list = await invoke<DocSummary[]>("list_docs");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setDocs(list);
      if (list.length === 0) {
        activeDocIdRef.current = null;
        setActiveDoc(null);
      } else {
        const persistedId = activeDocIdRef.current;
        if (persistedId && list.some(d => d.id === persistedId)) {
          const doc = await invoke<DocumentContent>("read_doc", { id: persistedId });
          if (!isWorkspaceLoadCurrent(generation)) return;
          setActiveDoc(doc);
        } else {
          const first = list[0];
          activeDocIdRef.current = first.id;
          const doc = await invoke<DocumentContent>("read_doc", { id: first.id });
          if (!isWorkspaceLoadCurrent(generation)) return;
          setActiveDoc(doc);
        }
      }
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setDocs([]);
      setActiveDoc(null);
      if (!isInvalidWorkspaceError(e)) setError(`Docs: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  const selectDoc = useCallback(async (id: string) => {
    if (docDirty && id !== activeDoc?.id && !confirmLeaveDirtyEditor()) return;
    activeDocIdRef.current = id;
    const generation = workspaceLoadGenerationRef.current;
    try {
      const doc = await invoke<DocumentContent>("read_doc", { id });
      if (!isWorkspaceLoadCurrent(generation)) return;
      setActiveDoc(doc);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Read doc: ${e}`);
    }
  }, [docDirty, activeDoc?.id, isWorkspaceLoadCurrent]);

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
    const baseline = activeConfigTargetId === "opencode_config"
      ? (configEditorSourceContent?.content ?? "")
      : (configTemplateContent?.content ?? "");
    setConfigDirty(value !== baseline);
  }, [configTemplateContent, configEditorSourceContent, activeConfigTargetId]);

  const loadConfigTemplate = useCallback(async (targetId: string, generation = workspaceLoadGenerationRef.current) => {
    try {
      const content = await invoke<DocumentContent>("read_config_template", { targetId });
      if (!isWorkspaceLoadCurrent(generation)) return;
      setConfigTemplateContent(content);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Config: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  // ── opencode config editor source callbacks ──

  const loadConfigEditorSources = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const sources = await invoke<ConfigEditorSourceMeta[]>("list_opencode_config_editor_sources");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setConfigEditorSources(sources);
    } catch {
      // non-critical; config editor sources are optional metadata
    }
  }, [isWorkspaceLoadCurrent]);

  const loadConfigEditorSourceContent = useCallback(async (sourceType: string, generation = workspaceLoadGenerationRef.current) => {
    try {
      const content = await invoke<DocumentContent>("read_opencode_config_source", { sourceType });
      if (!isWorkspaceLoadCurrent(generation)) return;
      setConfigEditorSourceContent(content);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Config source: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  const onSaveConfig = useCallback(async () => {
    if (!activeConfigTargetId) return;
    setConfigSaving(true);
    setConfigSaveResult(null);
    setConfigEditorSourceSaveMessage("");

    // For opencode_config, use the source-aware save command
    if (activeConfigTargetId === "opencode_config") {
      try {
        const result = await invoke<ActionResult>("save_opencode_config_source", {
          sourceType: activeConfigSourceType,
          content: configDraft,
        });
        setConfigSaveResult(result);
        if (result.success) {
          if (result.stdout !== "unchanged") {
            const reloaded = await invoke<DocumentContent>("read_opencode_config_source", {
              sourceType: activeConfigSourceType,
            });
            setConfigEditorSourceContent(reloaded);
            setConfigDraft(reloaded.content);
            setConfigEditorSourceSaveMessage("saved. Use Workspace → generate to update snapshot.");
          }
          setConfigDirty(false);
        }
      } catch (e) {
        setConfigSaveResult({
          success: false,
          action: "save_opencode_config_source",
          stdout: "",
          stderr: String(e),
          exit_code: null,
        });
      } finally {
        setConfigSaving(false);
      }
      return;
    }

    // Fallback: use old save_config_template for non-opencode_config targets
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
  }, [activeConfigTargetId, activeConfigSourceType, configDraft]);

  const onResetConfig = useCallback(() => {
    const baseline = activeConfigTargetId === "opencode_config"
      ? configEditorSourceContent
      : configTemplateContent;
    if (baseline) {
      setConfigDraft(baseline.content);
      setConfigDirty(false);
      setConfigSaveResult(null);
    }
  }, [configTemplateContent, configEditorSourceContent, activeConfigTargetId]);

  // ── agent source callbacks ──

  const loadAgentSources = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const list = await invoke<AgentMetadataListResponse>("list_agent_metadata");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setAgentSources(list.agents);
      if (list.agents.length > 0) {
        const persistedId = activeAgentIdRef.current;
        const stillExists = persistedId && list.agents.some(a => a.id === persistedId && a.exists);
        const firstExisting = list.agents.find(a => a.exists);
        if (stillExists && persistedId) {
          setActiveAgentId(persistedId);
          const content = await invoke<AgentSourceContent>("read_agent_source", { filename: persistedId });
          if (!isWorkspaceLoadCurrent(generation)) return;
          setActiveAgentContent(content);
        } else if (firstExisting) {
          activeAgentIdRef.current = firstExisting.id;
          setActiveAgentId(firstExisting.id);
          const content = await invoke<AgentSourceContent>("read_agent_source", { filename: firstExisting.id });
          if (!isWorkspaceLoadCurrent(generation)) return;
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
      if (!isWorkspaceLoadCurrent(generation)) return;
      setAgentSources([]);
      setActiveAgentId(null);
      setActiveAgentContent(null);
      if (!isInvalidWorkspaceError(e)) setError(`Agents: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  const loadWorkspaceResources = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    await Promise.all([
      loadSkills(generation).catch(() => {}),
      loadDocs(generation).catch(() => {}),
      loadAgentSources(generation).catch(() => {}),
      loadContract(generation).catch(() => {}),
      fetchStatus(generation).catch(() => {}),
      loadOpenCodeRuntimeHealth(generation).catch(() => {}),
      loadCursorProfileHealth(generation).catch(() => {}),
    ]);
  }, [loadSkills, loadDocs, loadAgentSources, loadContract, fetchStatus, loadOpenCodeRuntimeHealth, loadCursorProfileHealth]);

  const persistActiveWorkspace = useCallback(async (path: string) => {
    if (!appSettings) return;
    const generation = beginWorkspaceLoadGeneration(resetWorkspaceBoundState);
    try {
      const s = await invoke<AppSettings>("try_set_active_workspace_path", { path });
      if (!isWorkspaceLoadCurrent(generation)) return;
      setAppSettings(s);
      setWorkspacePathDraft(s.workspace_path ?? path);
      appliedWorkspacePathRef.current = s.workspace_path ?? null;
      savedSettingsRef.current = serializeSettingsForCompare(s);
      applyThemeSettings(s);
      setSettingsMsg(null);
      setWorkspaceSetup(null);
      setCreatePlan(null);
      setCreateResult(null);
      setInitResult(null);
      await Promise.all([
        loadWorkspaceDiagnostics(generation).catch(() => {}),
        loadWorkspaceResources(generation),
      ]);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Activate workspace: ${e}`);
    }
  }, [appSettings, beginWorkspaceLoadGeneration, isWorkspaceLoadCurrent, loadWorkspaceDiagnostics, loadWorkspaceResources]);

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
    installAgents,
    selectedSkills,
    setError,
  });

  const resetWorkspaceBoundState = useCallback(() => {
    workspaceActionRequestIdRef.current += 1;
    resetTerminalOutput();
    setStatus(null);
    setWorkspaceDiagnostics(null);
    setContractResult(null);
    setOpencodeRuntimeHealth(null);
    setCursorProfileHealth(null);

    setSkills([]);
    setSkillsLoaded(false);
    skillsSelectionTouched.current = false;
    setSelectedSkills(new Set());
    activeSkillIdRef.current = null;
    activeSkillContentIdRef.current = null;
    setActiveSkillId(null);
    setActiveSkillContent(null);

    activeDocIdRef.current = null;
    setDocs([]);
    setActiveDoc(null);

    activeAgentIdRef.current = null;
    setAgentSources([]);
    setActiveAgentId(null);
    setActiveAgentContent(null);
    setAgentTemplate(null);
    setConfigTemplateContent(null);
  }, [workspaceActionRequestIdRef, resetTerminalOutput]);

  const runCreate = useCallback(async () => {
    setCreateRunning(true);
    setCreateResult(null);
    setInitResult(null);
    try {
      const result = await invoke<InitializeWorkspaceResult>("initialize_workspace_at_path", {
        targetPath: workspaceSetupTarget(),
        confirmNonEmpty: false,
      });
      setInitResult(result);
      if (result.success) {
        setSettingsMsg({ ok: true, text: "workspace created" });
        await persistActiveWorkspace(result.target_path);
      } else {
        setCreateResult({
          success: result.success,
          status: result.status,
          target_path: result.target_path,
          message: result.message,
          copied_files: result.copied_files,
          skipped_files: [],
          warnings: result.warnings,
          created_dirs: [],
        });
      }
    } catch (e) { setError(`Create: ${e}`); }
    finally { setCreateRunning(false); }
  }, [persistActiveWorkspace, workspaceSetupTarget]);

  const runInitializeNonEmpty = useCallback(async () => {
    setInitRunning(true);
    setInitResult(null);
    setCreateResult(null);
    try {
      const result = await invoke<InitializeWorkspaceResult>("initialize_workspace_at_path", {
        targetPath: workspaceSetupTarget(),
        confirmNonEmpty: true,
      });
      setInitResult(result);
      if (result.success) {
        setSettingsMsg({ ok: true, text: "workspace initialized" });
        await persistActiveWorkspace(result.target_path);
      }
    } catch (e) { setError(`Initialize: ${e}`); }
    finally { setInitRunning(false); }
  }, [persistActiveWorkspace, workspaceSetupTarget]);

  const activateExistingWorkspace = useCallback(async () => {
    const path = workspaceSetup?.candidate_path ?? workspaceSetupTarget();
    await persistActiveWorkspace(path);
  }, [persistActiveWorkspace, workspaceSetup?.candidate_path, workspaceSetupTarget]);

  const selectAgent = useCallback(async (id: string) => {
    if (agentDirty && id !== activeAgentId && !confirmLeaveDirtyEditor()) return;
    activeAgentIdRef.current = id;
    setActiveAgentId(id);
    const generation = workspaceLoadGenerationRef.current;
    try {
      const content = await invoke<AgentSourceContent>("read_agent_source", { filename: id });
      if (!isWorkspaceLoadCurrent(generation)) return;
      setActiveAgentContent(content);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Read agent: ${e}`);
    }
  }, [agentDirty, activeAgentId, isWorkspaceLoadCurrent]);

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

  const loadAgentTemplate = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const template = await invoke<DocumentContent>("read_agent_template");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setAgentTemplate(template);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Template: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

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

  // load config template and editor sources when library configs view is active
  useEffect(() => {
    if ((view === "library" && librarySourceType === "configs") && activeConfigTargetId) {
      loadConfigTemplate(activeConfigTargetId);
      if (activeConfigTargetId === "opencode_config") {
        loadConfigEditorSources();
        setActiveConfigSourceType("base");
      }
    }
  }, [view, librarySourceType, activeConfigTargetId, loadConfigTemplate, loadConfigEditorSources]);

  // load config editor source content when source type changes for opencode_config
  useEffect(() => {
    if (activeConfigTargetId === "opencode_config" && activeConfigSourceType && view === "library" && librarySourceType === "configs") {
      loadConfigEditorSourceContent(activeConfigSourceType);
    }
  }, [activeConfigTargetId, activeConfigSourceType, view, librarySourceType, loadConfigEditorSourceContent]);

  // Sync editor source content into the shared config draft state
  useEffect(() => {
    if (activeConfigTargetId === "opencode_config" && configEditorSourceContent) {
      setConfigDraft(configEditorSourceContent.content);
      setConfigDirty(false);
      setConfigSaveResult(null);
      setConfigEditorSourceSaveMessage("");
      setConfigMode("preview");
    }
  }, [configEditorSourceContent?.id, activeConfigTargetId]);

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

  const openSkill = useCallback((id: string) => {
    invoke<ActionResult>("open_skill", { id }).catch(err => setError(`Open: ${err}`));
  }, []);

  const readSkill = useCallback(async (id: string) => {
    activeSkillIdRef.current = id;
    setActiveSkillId(id);
    const generation = workspaceLoadGenerationRef.current;
    try {
      const content = await invoke<DocumentContent>("read_skill", { id });
      if (!isWorkspaceLoadCurrent(generation)) return;
      activeSkillContentIdRef.current = id;
      setActiveSkillContent(content);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Read skill: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

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
      if (appliedWorkspacePathRef.current === undefined) {
        appliedWorkspacePathRef.current = s.workspace_path ?? null;
      }
      setAppSettings(s);
      savedSettingsRef.current = serializeSettingsForCompare(s);
      setAgentTargets(targets);
      setTargetProfiles(profiles);
      applyThemeSettings(s);
      setSettingsMsg(null);
    } catch (e) { setError(`Settings: ${e}`); }
  }, []);

  useEffect(() => { loadSettings(); loadWorkspaceDiagnostics(); loadWorkspaceResources(); loadBrainSetupSeed(); }, [loadSettings, loadWorkspaceDiagnostics, loadWorkspaceResources, loadBrainSetupSeed]);

  useEffect(() => {
    loadBrainSetupSeed();
  }, [appSettings?.workspace_path, loadBrainSetupSeed]);

  const saveSettings = useCallback(async () => {
    if (!appSettings) return;
    const nextWorkspacePath = appSettings.workspace_path ?? null;
    const workspacePathChanged = appliedWorkspacePathRef.current !== undefined
      && nextWorkspacePath !== appliedWorkspacePathRef.current;
    const generation = workspacePathChanged
      ? beginWorkspaceLoadGeneration(resetWorkspaceBoundState)
      : workspaceLoadGenerationRef.current;
    try {
      const s = await invoke<AppSettings>("update_settings", { settings: appSettings });
      if (workspacePathChanged && !isWorkspaceLoadCurrent(generation)) return;
      setAppSettings(s);
      appliedWorkspacePathRef.current = s.workspace_path ?? null;
      savedSettingsRef.current = serializeSettingsForCompare(s);
      applyThemeSettings(s);
      setColorResetKey(k => k + 1);
      setSettingsMsg({ ok: true, text: "settings saved" });
      if (workspacePathChanged) {
        await Promise.all([
          loadWorkspaceDiagnostics(generation).catch(() => {}),
          loadWorkspaceResources(generation),
        ]);
      } else {
        fetchStatus(generation);
        loadWorkspaceDiagnostics(generation);
      }
    } catch (e) { setSettingsMsg({ ok: false, text: String(e) }); }
  }, [appSettings, beginWorkspaceLoadGeneration, fetchStatus, isWorkspaceLoadCurrent, loadWorkspaceDiagnostics, loadWorkspaceResources]);

  const clearActiveWorkspace = useCallback(async () => {
    if (!appSettings) return;
    const generation = beginWorkspaceLoadGeneration(resetWorkspaceBoundState);
    try {
      const nextSettings = { ...appSettings, workspace_path: null };
      const s = await invoke<AppSettings>("update_settings", { settings: nextSettings });
      if (!isWorkspaceLoadCurrent(generation)) return;
      setAppSettings(s);
      setWorkspacePathDraft("");
      appliedWorkspacePathRef.current = null;
      savedSettingsRef.current = serializeSettingsForCompare(s);
      setWorkspaceSetup(null);
      setCreatePlan(null);
      setCreateResult(null);
      setInitResult(null);
      await loadWorkspaceDiagnostics(generation).catch(() => {});
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Clear workspace: ${e}`);
    }
  }, [appSettings, beginWorkspaceLoadGeneration, isWorkspaceLoadCurrent, loadWorkspaceDiagnostics]);

  const checkWorkspacePathFromDraft = useCallback(async () => {
    const trimmed = workspacePathDraft.trim();
    if (!trimmed) return;
    await evaluateWorkspaceCandidate(trimmed);
  }, [workspacePathDraft, evaluateWorkspaceCandidate]);

  const useDefaultWorkspace = useCallback(async () => {
    setWorkspacePathDraft(DEFAULT_WORKSPACE_PATH);
    await evaluateWorkspaceCandidate(DEFAULT_WORKSPACE_PATH);
  }, [evaluateWorkspaceCandidate]);

  const resetSettings = useCallback(async () => {
    const defaults = defaultSettings();
    setCreatePlan(null);
    setCreateResult(null);
    const nextWorkspacePath = defaults.workspace_path ?? null;
    const workspacePathChanged = appliedWorkspacePathRef.current !== undefined
      && nextWorkspacePath !== appliedWorkspacePathRef.current;
    const generation = workspacePathChanged
      ? beginWorkspaceLoadGeneration(resetWorkspaceBoundState)
      : workspaceLoadGenerationRef.current;
    try {
      const s = await invoke<AppSettings>("update_settings", { settings: defaults });
      if (workspacePathChanged && !isWorkspaceLoadCurrent(generation)) return;
      setAppSettings(s);
      appliedWorkspacePathRef.current = s.workspace_path ?? null;
      savedSettingsRef.current = serializeSettingsForCompare(s);
      applyThemeSettings(s);
      setColorResetKey(k => k + 1);
      setSettingsMsg({ ok: true, text: "reset to defaults" });
      if (workspacePathChanged) {
        await Promise.all([
          loadWorkspaceDiagnostics(generation).catch(() => {}),
          loadWorkspaceResources(generation),
        ]);
      } else {
        fetchStatus(generation);
        loadWorkspaceDiagnostics(generation);
      }
    } catch (e) { setSettingsMsg({ ok: false, text: String(e) }); }
  }, [beginWorkspaceLoadGeneration, fetchStatus, isWorkspaceLoadCurrent, loadWorkspaceDiagnostics, loadWorkspaceResources]);

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

  const setBackgroundColor = useCallback((backgroundColor: string | null) => {
    setSettingsMsg(null);
    setAppSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, background_color: backgroundColor };
      applyThemeSettings(next);
      return next;
    });
  }, []);

  const setForegroundColor = useCallback((foregroundColor: string | null) => {
    setSettingsMsg(null);
    setAppSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, foreground_color: foregroundColor };
      applyThemeSettings(next);
      return next;
    });
  }, []);

  const chooseWorkspaceFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (path) {
          setWorkspacePathDraft(path);
          await evaluateWorkspaceCandidate(path);
        }
      }
    } catch (e) {
      setError(`Choose folder: ${e}`);
    }
  }, [evaluateWorkspaceCandidate]);

  const switchView = useCallback((v: View) => {
    if (v !== view) {
      const isLibraryDirty = view === "library" && isLibrarySourceDirty(librarySourceType);
      const isSettingsDirty = view === "settings" && settingsDirty;
      if ((isLibraryDirty || isSettingsDirty) && !confirmLeaveDirtyEditor()) return;
    }
    setView(v);
    setSettingsMsg(null);
    if (isWorkspaceLoadView(v)) {
      loadWorkspaceDiagnostics();
      loadContract();
      loadCursorProfileHealth();
      loadOpenCodeRuntimeHealth();
    }
    else if (v === "library") { loadDocs(); loadSkills(); loadAgentSources(); loadAgentTemplate(); fetchStatus(); }
    else if (v === "settings") { if (!settingsDirty) loadSettings(); }
  }, [view, librarySourceType, isLibrarySourceDirty, settingsDirty, loadSkills, loadDocs, loadAgentTemplate, loadAgentSources, loadWorkspaceDiagnostics, loadContract, loadCursorProfileHealth, loadOpenCodeRuntimeHealth, loadSettings, fetchStatus]);

  const selectConfigTarget = useCallback((targetId: string) => {
    if (configDirty && targetId !== activeConfigTargetId && !confirmLeaveDirtyEditor()) return;
    setActiveConfigTargetId(targetId);
    setActiveConfigSourceType("base");
    setConfigEditorSourceContent(null);
    setConfigEditorSourceSaveMessage("");
  }, [configDirty, activeConfigTargetId]);

  const selectConfigSourceType = useCallback((sourceType: string) => {
    if (configDirty && sourceType !== activeConfigSourceType && !confirmLeaveDirtyEditor()) return;
    setActiveConfigSourceType(sourceType);
    setConfigEditorSourceContent(null);
    setConfigEditorSourceSaveMessage("");
    setConfigMode("preview");
    setConfigSaveResult(null);
  }, [configDirty, activeConfigSourceType]);

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

  const configEnabled = (status?.enabled_config_target_ids?.length ?? 0) > 0;
  const codexConfigEnabled = (status?.enabled_config_target_ids ?? []).includes("codex_config");
  const configTargets = useMemo(
    () => agentTargets.filter(t => t.kind === "config" && EDITABLE_CONFIG_TARGET_IDS.has(t.id)),
    [agentTargets],
  );
  const workspaceValid = workspaceDiagnostics?.valid === true;
  const canRunReleaseCheck = workspaceValid && workspaceDiagnostics?.release_check_available === true;
  const gitAvailable = status?.git_available === true;
  const ruleTargetsEnabled = (status?.enabled_rule_target_ids?.length ?? 0) > 0;
  const targetSkillsShared = {
    skills,
    skillsLoaded,
    selectedSkills,
    skillSearch,
    onToggleSkill: toggleSkill,
    onSelectAllSkills: selectAll,
    onClearSelectionSkills: clearSelection,
    onSetSkillSearch: setSkillSearch,
    onOpenInstallScript: openInstallScript,
  };

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

  const [colorResetKey, setColorResetKey] = useState(0);

  const applyTargetProfile = useCallback((profileId: string) => {
    const profile = targetProfiles.find(p => p.id === profileId);
    if (!profile) return;
    setSettingsMsg({ ok: true, text: "profile applied — save to persist" });
    setAppSettings(prev => prev ? { ...prev, enabled_target_ids: [...profile.target_ids] } : prev);
  }, [targetProfiles]);

  const brainSetupText = useMemo(() => {
    if (brainSetupSeed?.status === "found" && brainSetupSeed.content.trim()) {
      return brainSetupSeed.content;
    }
    return buildBrainSetupBlock();
  }, [brainSetupSeed]);

  const brainSetupSource = brainSetupSeed?.status === "found" && brainSetupSeed.content.trim()
    ? brainSetupSeed.source
    : "generated fallback";

  const activeProfileId = useMemo(() => {
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
  }, [appSettings, targetProfiles]);

  return (
      <div className="app-shell">
      <header className="app-header">
        <div className="app-header-drag-leading" data-tauri-drag-region aria-hidden="true" />
        <nav className="nav-icons" aria-label="Main navigation" data-tauri-drag-region>
          <button
            className={`nav-icon ${view === "start" ? "nav-icon-active" : ""}`}
            onClick={() => switchView("start")}
            aria-label="Start"
            title="Start"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V9.5z" />
            </svg>
          </button>
          <button
            className={`nav-icon ${view === "codex" ? "nav-icon-active" : ""}`}
            onClick={() => switchView("codex")}
            aria-label="Codex"
            title="Codex"
          >
            <ToolIcon name="codex" />
          </button>
          <button
            className={`nav-icon ${view === "opencode" ? "nav-icon-active" : ""}`}
            onClick={() => switchView("opencode")}
            aria-label="OpenCode"
            title="OpenCode"
          >
            <ToolIcon name="opencode" />
          </button>
          <button
            className={`nav-icon ${view === "cursor" ? "nav-icon-active" : ""}`}
            onClick={() => switchView("cursor")}
            aria-label="Cursor"
            title="Cursor"
          >
            <ToolIcon name="cursor" />
          </button>
          <button
            className={`nav-icon ${view === "claude" ? "nav-icon-active" : ""}`}
            onClick={() => switchView("claude")}
            aria-label="Claude"
            title="Claude"
          >
            <ToolIcon name="claude" />
          </button>
          <button
            className={`nav-icon ${view === "augment" ? "nav-icon-active" : ""}`}
            onClick={() => switchView("augment")}
            aria-label="Augment"
            title="Augment"
          >
            <ToolIcon name="augment" />
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
        <div className="app-header-drag-trailing" data-tauri-drag-region aria-hidden="true" />
      </header>

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
            appSettings={appSettings}
            pathDraft={workspacePathDraft}
            onPathDraftChange={setWorkspacePathDraft}
            onCheckPath={checkWorkspacePathFromDraft}
            onUseDefaultWorkspace={useDefaultWorkspace}
            onChooseWorkspaceFolder={chooseWorkspaceFolder}
            onClearActiveWorkspace={clearActiveWorkspace}
            workspaceDiagnostics={workspaceDiagnostics}
            workspaceSetup={workspaceSetup}
            setupEvaluating={createPlanRunning}
            onRefreshDiagnostics={() => {
              loadWorkspaceDiagnostics();
              fetchStatus();
            }}
            createPlan={createPlan}
            createPlanRunning={createPlanRunning}
            onPlanCreate={planCreate}
            createResult={createResult}
            createRunning={createRunning}
            onCreateWorkspace={runCreate}
            initResult={initResult}
            initRunning={initRunning}
            onInitializeWorkspace={runInitializeNonEmpty}
            onActivateWorkspace={activateExistingWorkspace}
            wsLog={wsLog}
            wsLogCompletedAt={wsLogCompletedAt}
            wsRunning={wsRunning}
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            status={status}
            workspaceValid={workspaceValid}
            gitAvailable={gitAvailable}
            canRunReleaseCheck={canRunReleaseCheck}
            onPull={() => runWsAction("git_pull", "git pull")}
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
            settingsDirty={settingsDirty}
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
            ruleTargetsEnabled={ruleTargetsEnabled}
            configEnabled={configEnabled}
            codexConfigEnabled={codexConfigEnabled}
            canRunReleaseCheck={canRunReleaseCheck}
            onDiffRules={() => runWsAction("diff_agent_rules", "diff rules")}
            onSyncRules={() => runWsAction("sync_agent_rules", "sync rules")}
            onDiffConfigs={() => runWsAction("diff_configs", "diff configs")}
            onSyncConfigs={() => runWsAction("sync_configs", "sync configs")}
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
            settingsDirty={settingsDirty}
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
            configEnabled={configEnabled}
            canRunReleaseCheck={canRunReleaseCheck}
            opencodeRuntimeHealth={opencodeRuntimeHealth}
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
            onDiffConfigs={() => runWsAction("diff_configs", "diff configs")}
            onSyncConfigs={() => runWsAction("sync_configs", "sync configs")}
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
            settingsDirty={settingsDirty}
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
            onCursorDiffGlobal={() => runCursorProfileAction("cursor_diff_global_agents", "cursor diff global")}
            onCursorSyncGlobal={() => runCursorProfileAction("cursor_sync_global_agents", "cursor sync global")}
            onCursorShowUserRules={() => runCursorProfileAction("cursor_show_user_rules", "cursor show user rules")}
            onCursorCopyUserRules={() => runCursorProfileAction("cursor_copy_user_rules", "cursor copy user rules")}
            onCursorOpenSettings={() => runCursorProfileAction("cursor_open_settings", "cursor open settings")}
            onCursorShowPlaywrightMcp={() => runCursorProfileAction("cursor_show_playwright_mcp", "cursor show playwright mcp")}
            onCursorCopyPlaywrightMcp={() => runCursorProfileAction("cursor_copy_playwright_mcp", "cursor copy playwright mcp")}
            onCursorShowSandboxSafe={() => runCursorProfileAction("cursor_show_sandbox_safe", "cursor show sandbox safe")}
            onCursorCopySandboxSafe={() => runCursorProfileAction("cursor_copy_sandbox_safe", "cursor copy sandbox safe")}
            onCursorShowSandboxPlaywrightSafe={() => runCursorProfileAction("cursor_show_sandbox_playwright_safe", "cursor show sandbox playwright-safe")}
            onCursorCopySandboxPlaywrightSafe={() => runCursorProfileAction("cursor_copy_sandbox_playwright_safe", "cursor copy sandbox playwright-safe")}
            onCursorShowSandboxPlaywrightFull={() => runCursorProfileAction("cursor_show_sandbox_playwright_full", "cursor show sandbox playwright-full")}
            onCursorCopySandboxPlaywrightFull={() => runCursorProfileAction("cursor_copy_sandbox_playwright_full", "cursor copy sandbox playwright-full")}
            onCursorValidateProfile={() => runCursorProfileAction("cursor_validate_profile", "cursor validate profile")}
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
            settingsDirty={settingsDirty}
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
            ruleTargetsEnabled={ruleTargetsEnabled}
            canRunReleaseCheck={canRunReleaseCheck}
            onDiffRules={() => runWsAction("diff_agent_rules", "diff rules")}
            onSyncRules={() => runWsAction("sync_agent_rules", "sync rules")}
            {...targetSkillsShared}
            onDryRunSkills={() => runWsInstallForAgents(true, ["claude"], "install skills dry-run (claude)")}
            onInstallSkills={() => runWsInstallForAgents(false, ["claude"], "install skills (claude)")}
          />
        )}

        {view === "augment" && (
          <AugmentView
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsDirty={settingsDirty}
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
            ruleTargetsEnabled={ruleTargetsEnabled}
            canRunReleaseCheck={canRunReleaseCheck}
            onDiffRules={() => runWsAction("diff_agent_rules", "diff rules")}
            onSyncRules={() => runWsAction("sync_agent_rules", "sync rules")}
            {...targetSkillsShared}
            onDryRunSkills={() => runWsInstallForAgents(true, ["auggie"], "install skills dry-run (auggie)")}
            onInstallSkills={() => runWsInstallForAgents(false, ["auggie"], "install skills (auggie)")}
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

        {view === "settings" && (
          <Suspense fallback={<div className="view-loading">loading…</div>}>
          <SettingsView
            appSettings={appSettings}
            settingsMsg={settingsMsg}
            settingsDirty={settingsDirty}
            onSetAppearance={setAppearance}
            onSetAccentColor={setAccentColor}
            onSetBackgroundColor={setBackgroundColor}
            onSetForegroundColor={setForegroundColor}
            onSave={saveSettings}
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
