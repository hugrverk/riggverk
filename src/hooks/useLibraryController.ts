import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ActionResult } from "../components/TerminalOutput";
import { confirmLeaveDirtyEditor } from "../lib/editorGuards";
import { isLibrarySourceTypeDirty } from "../lib/libraryDirtyGuards";
import type { LibrarySourceType } from "../views/LibraryView";
import type {
  AgentMetadataListResponse,
  AgentMetadataResponse,
  AgentSourceContent,
  ConfigEditorSourceMeta,
  DocsHealth,
  DocSummary,
  DocumentContent,
  SkillSummary,
} from "../types";

const EDITABLE_CONFIG_TARGET_IDS = new Set(["opencode_config"]);

export interface LibraryControllerDeps {
  setError: (message: string | null) => void;
  workspaceLoadGenerationRef: MutableRefObject<number>;
  isWorkspaceLoadCurrent: (generation: number) => boolean;
  isInvalidWorkspaceError: (e: unknown) => boolean;
  fetchStatus: (generation?: number) => Promise<void>;
  view: string;
}

export function useLibraryController({
  setError,
  workspaceLoadGenerationRef,
  isWorkspaceLoadCurrent,
  isInvalidWorkspaceError,
  fetchStatus,
  view,
}: LibraryControllerDeps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const skillsSelectionTouched = useRef(false);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [activeSkillContent, setActiveSkillContent] = useState<DocumentContent | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const activeSkillIdRef = useRef<string | null>(null);
  const activeSkillContentIdRef = useRef<string | null>(null);

  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [docsHealth, setDocsHealth] = useState<DocsHealth | null>(null);
  const [activeDoc, setActiveDoc] = useState<DocumentContent | null>(null);
  const activeDocIdRef = useRef<string | null>(null);
  const [docDraft, setDocDraft] = useState("");
  const [docDirty, setDocDirty] = useState(false);
  const [docSaving, setDocSaving] = useState(false);
  const [docSaveResult, setDocSaveResult] = useState<ActionResult | null>(null);
  const [docMode, setDocMode] = useState<"preview" | "edit">("preview");
  const [showCreateDoc, setShowCreateDoc] = useState(false);
  const [createDocTitle, setCreateDocTitle] = useState("");
  const [createDocSlug, setCreateDocSlug] = useState("");
  const [createDocError, setCreateDocError] = useState<string | null>(null);
  const [createDocCreating, setCreateDocCreating] = useState(false);

  const [agentTemplate, setAgentTemplate] = useState<DocumentContent | null>(null);
  const [agentTemplateDraft, setAgentTemplateDraft] = useState("");
  const [agentTemplateDirty, setAgentTemplateDirty] = useState(false);
  const [agentTemplateSaving, setAgentTemplateSaving] = useState(false);
  const [agentTemplateSaveResult, setAgentTemplateSaveResult] = useState<ActionResult | null>(null);
  const [agentTemplateMode, setAgentTemplateMode] = useState<"preview" | "edit">("preview");

  const [librarySourceType, setLibrarySourceType] = useState<LibrarySourceType>("docs");

  const [agentSources, setAgentSources] = useState<AgentMetadataResponse[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeAgentContent, setActiveAgentContent] = useState<AgentSourceContent | null>(null);
  const [agentDraft, setAgentDraft] = useState("");
  const [agentDirty, setAgentDirty] = useState(false);
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentSaveResult, setAgentSaveResult] = useState<ActionResult | null>(null);
  const [agentMode, setAgentMode] = useState<"preview" | "edit">("preview");
  const activeAgentIdRef = useRef<string | null>(null);

  const [configTemplateContent, setConfigTemplateContent] = useState<DocumentContent | null>(null);
  const [activeConfigTargetId, setActiveConfigTargetId] = useState<string>("");
  const [configDraft, setConfigDraft] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaveResult, setConfigSaveResult] = useState<ActionResult | null>(null);
  const [configMode, setConfigMode] = useState<"preview" | "edit">("preview");
  const [configEditorSources, setConfigEditorSources] = useState<ConfigEditorSourceMeta[]>([]);
  const [activeConfigSourceType, setActiveConfigSourceType] = useState<string>("base");
  const [configEditorSourceContent, setConfigEditorSourceContent] = useState<DocumentContent | null>(null);
  const [configEditorSourceSaveMessage, setConfigEditorSourceSaveMessage] = useState<string>("");
  const activeConfigSourceTypeRef = useRef(activeConfigSourceType);
  const configSourceLoadSeqRef = useRef(0);
  const configDraftIdentityRef = useRef<string | null>(null);

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

  useEffect(() => {
    activeConfigSourceTypeRef.current = activeConfigSourceType;
  }, [activeConfigSourceType]);

  const isLibrarySourceDirty = useCallback((sourceType: LibrarySourceType): boolean => {
    return isLibrarySourceTypeDirty(sourceType, docDirty, agentTemplateDirty, agentDirty, configDirty);
  }, [docDirty, agentTemplateDirty, agentDirty, configDirty]);

  const libraryDirty = docDirty || agentTemplateDirty || configDirty || agentDirty;

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
  }, [isInvalidWorkspaceError, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

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
  }, [isInvalidWorkspaceError, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

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
  }, [isInvalidWorkspaceError, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const loadAgentTemplate = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const template = await invoke<DocumentContent>("read_agent_template");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setAgentTemplate(template);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Template: ${e}`);
    }
  }, [isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const loadWorkspaceLibraryResources = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    await Promise.all([
      loadSkills(generation).catch(() => {}),
      loadDocs(generation).catch(() => {}),
      loadAgentSources(generation).catch(() => {}),
    ]);
  }, [loadAgentSources, loadDocs, loadSkills, workspaceLoadGenerationRef]);

  const loadLibraryView = useCallback(() => {
    void loadDocs();
    void loadSkills();
    void loadAgentSources();
    void loadAgentTemplate();
    void fetchStatus();
  }, [fetchStatus, loadAgentSources, loadAgentTemplate, loadDocs, loadSkills]);

  const resetLibraryState = useCallback(() => {
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
  }, []);

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
  }, [activeDoc?.id, docDirty, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const openDocEditor = useCallback(async (id: string) => {
    try { await invoke<ActionResult>("open_doc", { id }); } catch (e) { setError(`Open doc: ${e}`); }
  }, [setError]);

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
  }, [createDocSlug, createDocTitle, docDirty, loadDocs]);

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
  }, [activeAgentId, agentDirty, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const openAgent = useCallback(async (id: string) => {
    try { await invoke<ActionResult>("open_agent_source", { filename: id }); } catch (e) { setError(`Open agent: ${e}`); }
  }, [setError]);

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
  }, [activeConfigTargetId, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const loadConfigEditorSources = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const sources = await invoke<ConfigEditorSourceMeta[]>("list_opencode_config_editor_sources");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setConfigEditorSources(sources);
    } catch {
      // non-critical
    }
  }, [isWorkspaceLoadCurrent, workspaceLoadGenerationRef]);

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
  }, [activeConfigTargetId, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const onChangeConfigDraft = useCallback((value: string) => {
    setConfigDraft(value);
    const baseline = activeConfigTargetId === "opencode_config"
      ? (configEditorSourceContent?.content ?? "")
      : (configTemplateContent?.content ?? "");
    setConfigDirty(value !== baseline);
  }, [activeConfigTargetId, configEditorSourceContent, configTemplateContent]);

  const onSaveConfig = useCallback(async () => {
    if (!activeConfigTargetId) return;
    setConfigSaving(true);
    setConfigSaveResult(null);
    setConfigEditorSourceSaveMessage("");

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
            const reloaded = await invoke<DocumentContent>("read_opencode_config_source", { sourceType });
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
  }, [activeConfigSourceType, activeConfigTargetId, configDraft]);

  const onResetConfig = useCallback(() => {
    const baseline = activeConfigTargetId === "opencode_config"
      ? configEditorSourceContent
      : configTemplateContent;
    if (baseline) {
      setConfigDraft(baseline.content);
      setConfigDirty(false);
      setConfigSaveResult(null);
    }
  }, [activeConfigTargetId, configEditorSourceContent, configTemplateContent]);

  const selectConfigTarget = useCallback((targetId: string) => {
    if (configDirty && targetId !== activeConfigTargetId && !confirmLeaveDirtyEditor()) return;
    setActiveConfigTargetId(targetId);
    setActiveConfigSourceType("base");
    setConfigEditorSourceContent(null);
    setConfigEditorSourceSaveMessage("");
  }, [activeConfigTargetId, configDirty]);

  const selectConfigSourceType = useCallback((sourceType: string) => {
    if (configDirty && sourceType !== activeConfigSourceType && !confirmLeaveDirtyEditor()) return;
    setActiveConfigSourceType(sourceType);
    setConfigEditorSourceContent(null);
    setConfigEditorSourceSaveMessage("");
    setConfigMode("preview");
    setConfigSaveResult(null);
  }, [activeConfigSourceType, configDirty]);

  const toggleSkill = useCallback((name: string) => {
    skillsSelectionTouched.current = true;
    setSelectedSkills(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const selectAllSkills = useCallback(() => {
    skillsSelectionTouched.current = true;
    setSelectedSkills(new Set(skills.map(s => s.name)));
  }, [skills]);

  const clearSkillSelection = useCallback(() => {
    skillsSelectionTouched.current = true;
    setSelectedSkills(new Set());
  }, []);

  const openSkill = useCallback((id: string) => {
    invoke<ActionResult>("open_skill", { id }).catch(err => setError(`Open: ${err}`));
  }, [setError]);

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
  }, [isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const openInstallScript = useCallback(() => {
    invoke<ActionResult>("open_install_skills_script").catch(e => setError(`Open: ${e}`));
  }, [setError]);

  useEffect(() => {
    if ((view === "library" && librarySourceType === "configs") && activeConfigTargetId) {
      configSourceLoadSeqRef.current += 1;
      setConfigTemplateContent(null);
      setConfigEditorSourceContent(null);
      configDraftIdentityRef.current = null;
      if (activeConfigTargetId === "opencode_config") {
        void loadConfigEditorSources();
        setActiveConfigSourceType("base");
      } else {
        void loadConfigTemplate(activeConfigTargetId);
      }
    }
  }, [view, librarySourceType, activeConfigTargetId, loadConfigTemplate, loadConfigEditorSources]);

  useEffect(() => {
    if (activeConfigTargetId === "opencode_config" && activeConfigSourceType && view === "library" && librarySourceType === "configs") {
      void loadConfigEditorSourceContent(activeConfigSourceType);
    }
  }, [activeConfigTargetId, activeConfigSourceType, view, librarySourceType, loadConfigEditorSourceContent]);

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

  return {
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
    loadSkills,
    loadDocs,
    loadAgentSources,
    loadAgentTemplate,
    loadWorkspaceLibraryResources,
    loadLibraryView,
    resetLibraryState,
  };
}

export { EDITABLE_CONFIG_TARGET_IDS };
