import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ActionResult } from "./components/TerminalOutput";
import { AppHeaderNav } from "./components/AppHeaderNav";
import { confirmLeaveDirtyEditor } from "./lib/editorGuards";
import { buildBrainSetupBlock } from "./lib/brainSetup";
import { useBackups } from "./lib/useBackups";
import { useWorkspaceActions } from "./lib/useWorkspaceActions";
import { useWorkspaceGeneration } from "./lib/useWorkspaceGeneration";
import { useAppSettingsController } from "./hooks/useAppSettingsController";
import { isLibrarySourceTypeDirty } from "./lib/libraryDirtyGuards";
import { CodexView } from "./views/CodexView";
import { CursorView } from "./views/CursorView";
import { ClaudeView } from "./views/ClaudeView";
import { OpenCodeView } from "./views/OpenCodeView";
import { deriveInstallState, StartView } from "./views/StartView";
import { ToolsView } from "./views/ToolsView";
const LibraryView = lazy(() => import("./views/LibraryView").then(m => ({ default: m.LibraryView })));
import type { LibrarySourceType } from "./views/LibraryView";
const SettingsView = lazy(() => import("./views/SettingsView").then(m => ({ default: m.SettingsView })));
import type { AgentMetadataListResponse, AgentMetadataResponse, AgentSourceContent, BrainSetupSeedResult, ConfigEditorSourceMeta, CursorProfileHealth, DocsHealth, DocSummary, DocumentContent, InitializeWorkspaceResult, OpenCodeRuntimeHealth, RepairWorkspaceResult, SkillSummary, StatusData, WorkspaceDiagnostics } from "./types";

const INVALID_WORKSPACE_TEXT = "invalid workspace path";
const NO_WORKSPACE_TEXT = "no workspace selected";
const EDITABLE_CONFIG_TARGET_IDS = new Set(["opencode_config"]);

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
  const [status, setStatus] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("start");
  const appliedWorkspacePathRef = useRef<string | null | undefined>(undefined);

  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [docsHealth, setDocsHealth] = useState<DocsHealth | null>(null);
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
  const activeConfigSourceTypeRef = useRef(activeConfigSourceType);
  const configSourceLoadSeqRef = useRef(0);
  const configDraftIdentityRef = useRef<string | null>(null);

  // backup history state
  const { backups, loadBackups, openBackupsFolder } = useBackups(setError);

  // workspace resource generation
  const { workspaceLoadGenerationRef, isWorkspaceLoadCurrent, beginWorkspaceLoadGeneration } = useWorkspaceGeneration();

  // workspace operations state (moved to hook)
  const [workspaceDiagnostics, setWorkspaceDiagnostics] = useState<WorkspaceDiagnostics | null>(null);

  // opencode runtime health
  const [opencodeRuntimeHealth, setOpencodeRuntimeHealth] = useState<OpenCodeRuntimeHealth | null>(null);
  const [cursorProfileHealth, setCursorProfileHealth] = useState<CursorProfileHealth | null>(null);
  const [brainSetupSeed, setBrainSetupSeed] = useState<BrainSetupSeedResult | null>(null);

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

  const [workspaceInstallRunning, setWorkspaceInstallRunning] = useState(false);

  const fetchStatus = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const data = await invoke<StatusData>("get_status");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setStatus(data);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setStatus(null);
      if (!isInvalidWorkspaceError(e)) setError(`Status error: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  const isLibrarySourceDirty = useCallback((sourceType: LibrarySourceType): boolean => {
    return isLibrarySourceTypeDirty(sourceType, docDirty, agentTemplateDirty, agentDirty, configDirty);
  }, [docDirty, agentTemplateDirty, agentDirty, configDirty]);

  const setGuardedLibrarySourceType = useCallback((type: LibrarySourceType) => {
    if (type === librarySourceType) return;
    if (isLibrarySourceDirty(librarySourceType) && !confirmLeaveDirtyEditor()) return;
    setLibrarySourceType(type);
    if (type === "configs") fetchStatus();
  }, [librarySourceType, isLibrarySourceDirty, fetchStatus]);

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
      const listPromise = invoke<DocSummary[]>("list_docs");
      const healthPromise = invoke<DocsHealth>("get_docs_health").catch(() => null);
      const [list, health] = await Promise.all([listPromise, healthPromise]);
      if (!isWorkspaceLoadCurrent(generation)) return;
      setDocs(list);
      setDocsHealth(health);
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
      setDocsHealth(null);
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
      if (activeDocIdRef.current !== id) return;
      setActiveDoc(doc);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (activeDocIdRef.current !== id) return;
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
          const docId = activeDoc.id;
          const updated = await invoke<DocumentContent>("read_doc", { id: docId });
          if (activeDocIdRef.current !== docId) return;
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
    if (targetId === "opencode_config") return;
    const loadSeq = ++configSourceLoadSeqRef.current;
    try {
      const content = await invoke<DocumentContent>("read_config_template", { targetId });
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (configSourceLoadSeqRef.current !== loadSeq) return;
      if (activeConfigTargetId !== targetId) return;
      setConfigTemplateContent(content);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (configSourceLoadSeqRef.current !== loadSeq) return;
      setError(`Config: ${e}`);
    }
  }, [activeConfigTargetId, isWorkspaceLoadCurrent]);

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
    const loadSeq = ++configSourceLoadSeqRef.current;
    activeConfigSourceTypeRef.current = sourceType;
    try {
      const content = await invoke<DocumentContent>("read_opencode_config_source", { sourceType });
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (configSourceLoadSeqRef.current !== loadSeq) return;
      if (activeConfigSourceTypeRef.current !== sourceType) return;
      if (activeConfigTargetId !== "opencode_config") return;
      setConfigEditorSourceContent(content);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (configSourceLoadSeqRef.current !== loadSeq) return;
      setError(`Config source: ${e}`);
    }
  }, [activeConfigTargetId, isWorkspaceLoadCurrent]);

  const onSaveConfig = useCallback(async () => {
    if (!activeConfigTargetId) return;
    setConfigSaving(true);
    setConfigSaveResult(null);
    setConfigEditorSourceSaveMessage("");

    // For opencode_config, use the source-aware save command
    if (activeConfigTargetId === "opencode_config") {
      const draftIdentity = `opencode_config:${activeConfigSourceType}`;
      if (configDraftIdentityRef.current !== draftIdentity) {
        setConfigSaveResult({
          success: false,
          action: "save_opencode_config_source",
          stdout: "",
          stderr: "config source changed before save",
          exit_code: null,
        });
        setConfigSaving(false);
        return;
      }
      try {
        const result = await invoke<ActionResult>("save_opencode_config_source", {
          sourceType: activeConfigSourceType,
          content: configDraft,
        });
        setConfigSaveResult(result);
        if (result.success) {
          if (result.stdout !== "unchanged") {
            const sourceType = activeConfigSourceType;
            const reloaded = await invoke<DocumentContent>("read_opencode_config_source", {
              sourceType,
            });
            if (configDraftIdentityRef.current !== `opencode_config:${sourceType}`) return;
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

    setConfigSaveResult({
      success: false,
      action: "save_config",
      stdout: "",
      stderr: "no editable config target selected",
      exit_code: null,
    });
    setConfigSaving(false);
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
      fetchStatus(generation).catch(() => {}),
      loadOpenCodeRuntimeHealth(generation).catch(() => {}),
      loadCursorProfileHealth(generation).catch(() => {}),
    ]);
  }, [loadSkills, loadDocs, loadAgentSources, fetchStatus, loadOpenCodeRuntimeHealth, loadCursorProfileHealth]);

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
    setStatus(null);
    setWorkspaceDiagnostics(null);
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

  const selectAgent = useCallback(async (id: string) => {
    if (agentDirty && id !== activeAgentId && !confirmLeaveDirtyEditor()) return;
    activeAgentIdRef.current = id;
    setActiveAgentId(id);
    const generation = workspaceLoadGenerationRef.current;
    try {
      const content = await invoke<AgentSourceContent>("read_agent_source", { filename: id });
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (activeAgentIdRef.current !== id) return;
      setActiveAgentContent(content);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (activeAgentIdRef.current !== id) return;
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
          const agentId = activeAgentId;
          const updated = await invoke<AgentSourceContent>("read_agent_source", { filename: agentId });
          if (activeAgentIdRef.current !== agentId) return;
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

  useEffect(() => {
    activeConfigSourceTypeRef.current = activeConfigSourceType;
  }, [activeConfigSourceType]);

  // load config template and editor sources when library configs view is active
  useEffect(() => {
    if ((view === "library" && librarySourceType === "configs") && activeConfigTargetId) {
      configSourceLoadSeqRef.current += 1;
      setConfigTemplateContent(null);
      setConfigEditorSourceContent(null);
      configDraftIdentityRef.current = null;
      if (activeConfigTargetId === "opencode_config") {
        loadConfigEditorSources();
        setActiveConfigSourceType("base");
      } else {
        loadConfigTemplate(activeConfigTargetId);
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
      const identity = `opencode_config:${activeConfigSourceType}`;
      configDraftIdentityRef.current = identity;
      setConfigDraft(configEditorSourceContent.content);
      setConfigDirty(false);
      setConfigSaveResult(null);
      setConfigEditorSourceSaveMessage("");
      setConfigMode("preview");
    }
  }, [configEditorSourceContent?.id, activeConfigTargetId, activeConfigSourceType]);

  useEffect(() => {
    if (activeConfigTargetId === "opencode_config") return;
    if (configTemplateContent) {
      configDraftIdentityRef.current = `template:${activeConfigTargetId}`;
      setConfigDraft(configTemplateContent.content);
      setConfigDirty(false);
      setConfigSaveResult(null);
      setConfigMode("preview");
    } else if (activeConfigTargetId) {
      configDraftIdentityRef.current = null;
      setConfigDraft("");
      setConfigDirty(false);
      setConfigSaveResult(null);
      setConfigMode("preview");
    }
  }, [configTemplateContent?.id, activeConfigTargetId]);

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
      if (activeSkillIdRef.current !== id) return;
      activeSkillContentIdRef.current = id;
      setActiveSkillContent(content);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (activeSkillIdRef.current !== id) return;
      setError(`Read skill: ${e}`);
    }
  }, [isWorkspaceLoadCurrent]);

  const openInstallScript = useCallback(() => {
    invoke<ActionResult>("open_install_skills_script").catch(e => setError(`Open: ${e}`));
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
    else if (v === "library") { loadDocs(); loadSkills(); loadAgentSources(); loadAgentTemplate(); fetchStatus(); }
    else if (v === "settings" && !settingsDirty && !settingsSaving) { loadSettings(); }
  }, [view, librarySourceType, isLibrarySourceDirty, settingsDirty, settingsSaving, loadSkills, loadDocs, loadAgentTemplate, loadAgentSources, loadWorkspaceDiagnostics, loadCursorProfileHealth, loadOpenCodeRuntimeHealth, loadSettings, fetchStatus, clearSettingsMsg]);

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
    onSelectAllSkills: selectAll,
    onClearSelectionSkills: clearSelection,
    onSetSkillSearch: setSkillSearch,
    onOpenInstallScript: openInstallScript,
  };

  const brainSetupText = useMemo(() => {
    if (brainSetupSeed?.status === "found" && brainSetupSeed.content.trim()) {
      return brainSetupSeed.content;
    }
    return buildBrainSetupBlock();
  }, [brainSetupSeed]);

  const brainSetupSource = brainSetupSeed?.status === "found" && brainSetupSeed.content.trim()
    ? brainSetupSeed.source
    : "generated fallback";

  return (
      <div className="app-shell">
      <AppHeaderNav
        view={view}
        libraryDirty={docDirty || agentTemplateDirty || configDirty || agentDirty}
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
