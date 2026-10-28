import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ActionResult } from "../components/TerminalOutput";
import { LEAVE_DIRTY_MESSAGE } from "../lib/editorGuards";
import { invokeOpen } from "../lib/invokeOpen";
import { useConfirm } from "../components/ConfirmDialog";
import { createSaveOperationTracker } from "../lib/editorSaveOperation";
import { isLibrarySourceTypeDirty, isPersonalDoc } from "../lib/libraryDirtyGuards";
import { packSkillSummaries } from "../lib/packSkills";
import type { LibrarySourceType } from "../views/LibraryView";
import type {
  AgentMetadataListResponse,
  AgentMetadataResponse,
  AgentSourceContent,
  ConfigEditorSourceMeta,
  DocSummary,
  DocumentContent,
  PackLibrary,
  RulesFileContent,
  RulesFileSummary,
  RulesSurfaceId,
  SkillSummary,
} from "../types";

/** What the backend says when the user's text in a rules file changed after it was opened. */
const RULES_CHANGED_ON_DISK = "changed on disk";

const BUNDLED_CONFIG_TARGET_IDS = new Set(["opencode_config"]);

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
  const confirm = useConfirm();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [packLibrary, setPackLibrary] = useState<PackLibrary | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [activeSkillContent, setActiveSkillContent] = useState<DocumentContent | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const activeSkillIdRef = useRef<string | null>(null);
  const activeSkillContentIdRef = useRef<string | null>(null);

  const [docs, setDocs] = useState<DocSummary[]>([]);
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

  // The bundled rules base, agents and configs are read-only in the Library: loaded, never drafted.
  const [agentTemplate, setAgentTemplate] = useState<DocumentContent | null>(null);

  // The user's rules files: only the refinements below the managed block are drafted and saved.
  const [rulesFiles, setRulesFiles] = useState<RulesFileSummary[]>([]);
  /** The open rules file; null while the bundled base row is open. */
  const [activeRulesSurface, setActiveRulesSurface] = useState<RulesSurfaceId | null>(null);
  const activeRulesSurfaceRef = useRef<RulesSurfaceId | null>(null);
  const [activeRulesFile, setActiveRulesFile] = useState<RulesFileContent | null>(null);
  const [rulesDraft, setRulesDraft] = useState("");
  const [rulesDirty, setRulesDirty] = useState(false);
  const rulesDirtyRef = useRef(false);
  rulesDirtyRef.current = rulesDirty;
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesSaveResult, setRulesSaveResult] = useState<ActionResult | null>(null);
  const rulesSaveOpRef = useRef(createSaveOperationTracker());

  const [librarySourceType, setLibrarySourceType] = useState<LibrarySourceType>("docs");

  const [agentSources, setAgentSources] = useState<AgentMetadataResponse[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeAgentContent, setActiveAgentContent] = useState<AgentSourceContent | null>(null);
  const activeAgentIdRef = useRef<string | null>(null);

  const [configTemplateContent, setConfigTemplateContent] = useState<DocumentContent | null>(null);
  const [activeConfigTargetId, setActiveConfigTargetId] = useState<string>("");
  const [configEditorSources, setConfigEditorSources] = useState<ConfigEditorSourceMeta[]>([]);
  const [activeConfigSourceType, setActiveConfigSourceType] = useState<string>("base");
  const [configEditorSourceContent, setConfigEditorSourceContent] = useState<DocumentContent | null>(null);
  const activeConfigSourceTypeRef = useRef(activeConfigSourceType);
  const configSourceLoadSeqRef = useRef(0);
  const docSaveOpRef = useRef(createSaveOperationTracker());
  // Bumped when a workspace switch reloads the Library, so the config source effects refetch for the new workspace.
  const [libraryReloadEpoch, setLibraryReloadEpoch] = useState(0);

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
    activeConfigSourceTypeRef.current = activeConfigSourceType;
  }, [activeConfigSourceType]);

  const isLibrarySourceDirty = useCallback((sourceType: LibrarySourceType): boolean => {
    return isLibrarySourceTypeDirty(sourceType, docDirty, rulesDirty);
  }, [docDirty, rulesDirty]);

  const libraryDirty = docDirty || rulesDirty;

  const setGuardedLibrarySourceType = useCallback(async (type: LibrarySourceType) => {
    if (type === librarySourceType) return;
    if (isLibrarySourceDirty(librarySourceType)) {
      const ok = await confirm(LEAVE_DIRTY_MESSAGE);
      if (!ok) return;
    }
    setLibrarySourceType(type);
    if (type === "configs") fetchStatus();
  }, [librarySourceType, isLibrarySourceDirty, fetchStatus, confirm]);

  const loadSkills = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const bundled = await invoke<SkillSummary[]>("list_skills");
      // The skills of the user's packs follow the bundled ones. A pack problem never hides the bundle.
      let packs: PackLibrary | null = null;
      let packFailure: string | null = null;
      try {
        packs = await invoke<PackLibrary>("list_pack_skills");
      } catch (e) {
        packFailure = String(e);
      }
      const loaded = [...bundled, ...packSkillSummaries(packs)];
      if (!isWorkspaceLoadCurrent(generation)) return;
      setPackLibrary(packs);
      setPackError(packFailure);
      setSkills(loaded);
      setSkillsLoaded(true);
      if (loaded.length > 0) {
        const persistedId = activeSkillIdRef.current;
        const stillExists = persistedId && loaded.some(s => s.id === persistedId);
        const alreadyLoaded = persistedId && activeSkillContentIdRef.current === persistedId;
        if (stillExists && persistedId) {
          setActiveSkillId(persistedId);
          if (!alreadyLoaded) {
            const content = await invoke<DocumentContent>("read_skill", { id: persistedId });
            if (!isWorkspaceLoadCurrent(generation)) return;
            if (activeSkillIdRef.current !== persistedId) return;
            activeSkillContentIdRef.current = persistedId;
            setActiveSkillContent(content);
          }
        } else {
          const first = loaded[0];
          activeSkillIdRef.current = first.id;
          setActiveSkillId(first.id);
          const content = await invoke<DocumentContent>("read_skill", { id: first.id });
          if (!isWorkspaceLoadCurrent(generation)) return;
          if (activeSkillIdRef.current !== first.id) return;
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
          if (activeDocIdRef.current !== persistedId) return;
          setActiveDoc(doc);
        } else {
          const first = list[0];
          activeDocIdRef.current = first.id;
          const doc = await invoke<DocumentContent>("read_doc", { id: first.id });
          if (!isWorkspaceLoadCurrent(generation)) return;
          if (activeDocIdRef.current !== first.id) return;
          setActiveDoc(doc);
        }
      }
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setDocs([]);
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
          if (activeAgentIdRef.current !== persistedId) return;
          setActiveAgentContent(content);
        } else if (firstExisting) {
          activeAgentIdRef.current = firstExisting.id;
          setActiveAgentId(firstExisting.id);
          const content = await invoke<AgentSourceContent>("read_agent_source", { filename: firstExisting.id });
          if (!isWorkspaceLoadCurrent(generation)) return;
          if (activeAgentIdRef.current !== firstExisting.id) return;
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

  /** Shows one rules file: its refinements become the draft, with nothing unsaved. */
  const applyRulesFile = useCallback((file: RulesFileContent) => {
    setActiveRulesFile(file);
    setRulesDraft(file.refinements);
    setRulesDirty(false);
    // The list row follows what the file holds now (its refinement count, its state), never its text.
    const { layout, conflict, malformed, refinement_lines, editable, reason } = file;
    setRulesFiles(list =>
      list.map(row =>
        row.surface === file.surface ? { ...row, layout, conflict, malformed, refinement_lines, editable, reason } : row,
      ),
    );
  }, []);

  const clearActiveRulesFile = useCallback(() => {
    rulesSaveOpRef.current.invalidate();
    activeRulesSurfaceRef.current = null;
    setActiveRulesSurface(null);
    setActiveRulesFile(null);
    setRulesDraft("");
    setRulesDirty(false);
    setRulesSaveResult(null);
  }, []);

  const loadRulesFiles = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const list = await invoke<RulesFileSummary[]>("list_rules_files");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setRulesFiles(list);
      const surface = activeRulesSurfaceRef.current;
      if (surface === null) return;
      // Its harness or rules target was switched off: back to the bundled base.
      if (!list.some(file => file.surface === surface)) {
        clearActiveRulesFile();
        return;
      }
      // Unsaved refinements keep the revision they were opened with, so a save still notices an outside change.
      if (rulesDirtyRef.current) return;
      const file = await invoke<RulesFileContent>("read_rules_file", { surface });
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (activeRulesSurfaceRef.current !== surface || rulesDirtyRef.current) return;
      applyRulesFile(file);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setRulesFiles([]);
      if (!isInvalidWorkspaceError(e)) setError(`Rules files: ${e}`);
    }
  }, [applyRulesFile, clearActiveRulesFile, isInvalidWorkspaceError, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const loadWorkspaceLibraryResources = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    await Promise.all([
      loadSkills(generation).catch(() => {}),
      loadDocs(generation).catch(() => {}),
      loadAgentSources(generation).catch(() => {}),
      loadAgentTemplate(generation),
      loadRulesFiles(generation),
    ]);
    setLibraryReloadEpoch(epoch => epoch + 1);
  }, [loadAgentSources, loadAgentTemplate, loadDocs, loadRulesFiles, loadSkills, workspaceLoadGenerationRef]);

  const loadLibraryView = useCallback(() => {
    void loadDocs();
    void loadSkills();
    void loadAgentSources();
    void loadAgentTemplate();
    void loadRulesFiles();
    void fetchStatus();
  }, [fetchStatus, loadAgentSources, loadAgentTemplate, loadDocs, loadRulesFiles, loadSkills]);

  const resetLibraryState = useCallback(() => {
    docSaveOpRef.current.invalidate();
    clearActiveRulesFile();
    setRulesFiles([]);
    setSkills([]);
    setSkillsLoaded(false);
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

    // A config source load still running belongs to the old workspace.
    configSourceLoadSeqRef.current += 1;
    setConfigTemplateContent(null);
    setConfigEditorSources([]);
    setConfigEditorSourceContent(null);
  }, [clearActiveRulesFile]);

  /** Opens a rules file (or, with null, the bundled base row); asks first when it would drop unsaved refinements. */
  const selectRulesFile = useCallback(async (surface: RulesSurfaceId | null) => {
    const current = activeRulesSurfaceRef.current;
    if (surface === current && rulesDirty) return;
    if (surface !== current && rulesDirty) {
      const ok = await confirm(LEAVE_DIRTY_MESSAGE);
      if (!ok) return;
    }
    clearActiveRulesFile();
    if (surface === null) return;
    activeRulesSurfaceRef.current = surface;
    setActiveRulesSurface(surface);
    const generation = workspaceLoadGenerationRef.current;
    try {
      const file = await invoke<RulesFileContent>("read_rules_file", { surface });
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (activeRulesSurfaceRef.current !== surface) return;
      applyRulesFile(file);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (activeRulesSurfaceRef.current !== surface) return;
      setError(`Read rules file: ${e}`);
    }
  }, [applyRulesFile, clearActiveRulesFile, confirm, isWorkspaceLoadCurrent, rulesDirty, setError, workspaceLoadGenerationRef]);

  const openRulesFile = useCallback(
    (surface: RulesSurfaceId) => invokeOpen("open_rules_file", { surface }, "Open rules file", setError),
    [setError],
  );

  const onChangeRulesDraft = useCallback((value: string) => {
    setRulesDraft(value);
    setRulesDirty(value !== (activeRulesFile?.refinements ?? ""));
  }, [activeRulesFile]);

  const onResetRules = useCallback(() => {
    if (!activeRulesFile) return;
    setRulesDraft(activeRulesFile.refinements);
    setRulesDirty(false);
    setRulesSaveResult(null);
  }, [activeRulesFile]);

  const onSaveRules = useCallback(async () => {
    // Only the refinements of a file the backend called editable are sent; it checks everything again.
    const file = activeRulesFile;
    if (!file || !file.editable || file.revision === null) return;
    const saveOpId = rulesSaveOpRef.current.capture();
    const surface = file.surface;
    const generation = workspaceLoadGenerationRef.current;
    const isCurrent = () =>
      rulesSaveOpRef.current.isCurrent(saveOpId) &&
      isWorkspaceLoadCurrent(generation) &&
      activeRulesSurfaceRef.current === surface;
    const failed = (stderr: string): ActionResult => ({
      success: false,
      action: "save_rules_refinements",
      stdout: "",
      stderr,
      exit_code: null,
    });
    setRulesSaving(true);
    setRulesSaveResult(null);
    try {
      const result = await invoke<ActionResult>("save_rules_refinements", {
        surface,
        content: rulesDraft,
        expectedRevision: file.revision,
      });
      if (!isCurrent()) return;
      setRulesSaveResult(result);
      if (!result.success) return;
      if (result.stdout === "unchanged") {
        setRulesDirty(false);
        return;
      }
      const updated = await invoke<RulesFileContent>("read_rules_file", { surface });
      if (!isCurrent()) return;
      applyRulesFile(updated);
    } catch (e) {
      if (!isCurrent()) return;
      const message = String(e);
      if (!message.includes(RULES_CHANGED_ON_DISK)) {
        setRulesSaveResult(failed(message));
        return;
      }
      // The file changed elsewhere: show it as it is now and keep the draft, which a second save then writes.
      try {
        const updated = await invoke<RulesFileContent>("read_rules_file", { surface });
        if (!isCurrent()) return;
        setActiveRulesFile(updated);
        setRulesSaveResult(failed("changed on disk: reloaded, save again to overwrite"));
      } catch (reloadError) {
        if (!isCurrent()) return;
        setRulesSaveResult(failed(String(reloadError)));
      }
    } finally {
      setRulesSaving(false);
    }
  }, [activeRulesFile, applyRulesFile, isWorkspaceLoadCurrent, rulesDraft, workspaceLoadGenerationRef]);

  const selectDoc = useCallback(async (id: string) => {
    if (docDirty && id !== activeDoc?.id) {
      const ok = await confirm(LEAVE_DIRTY_MESSAGE);
      if (!ok) return;
    }
    docSaveOpRef.current.invalidate();
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
  }, [activeDoc?.id, docDirty, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef, confirm]);

  const openDocEditor = useCallback(
    (id: string) => invokeOpen("open_doc", { id }, "Open doc", setError),
    [setError],
  );

  const onSaveDoc = useCallback(async () => {
    // Only personal docs are saved; the backend refuses bundled ids too.
    if (!activeDoc || !isPersonalDoc(activeDoc)) return;
    const saveOpId = docSaveOpRef.current.capture();
    const docId = activeDoc.id;
    const generation = workspaceLoadGenerationRef.current;
    setDocSaving(true);
    setDocSaveResult(null);
    try {
      const result = await invoke<ActionResult>("save_doc", { id: docId, content: docDraft });
      if (!docSaveOpRef.current.isCurrent(saveOpId)) return;
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (activeDocIdRef.current !== docId) return;
      setDocSaveResult(result);
      if (result.success) {
        if (result.stdout !== "unchanged") {
          const updated = await invoke<DocumentContent>("read_doc", { id: docId });
          if (!docSaveOpRef.current.isCurrent(saveOpId)) return;
          if (!isWorkspaceLoadCurrent(generation)) return;
          if (activeDocIdRef.current !== docId) return;
          setActiveDoc(updated);
          setDocDraft(updated.content);
        }
        setDocDirty(false);
      }
    } catch (e) {
      if (!docSaveOpRef.current.isCurrent(saveOpId)) return;
      if (!isWorkspaceLoadCurrent(generation)) return;
      if (activeDocIdRef.current !== docId) return;
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
  }, [activeDoc, docDraft, isWorkspaceLoadCurrent, workspaceLoadGenerationRef]);

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
    if (docDirty) {
      const ok = await confirm(LEAVE_DIRTY_MESSAGE);
      if (!ok) return;
    }
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
  }, [createDocSlug, createDocTitle, docDirty, loadDocs, confirm]);

  const selectAgent = useCallback(async (id: string) => {
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
  }, [isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

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

  const selectConfigTarget = useCallback((targetId: string) => {
    setActiveConfigTargetId(targetId);
    setActiveConfigSourceType("base");
    setConfigEditorSourceContent(null);
  }, []);

  const selectConfigSourceType = useCallback((sourceType: string) => {
    setActiveConfigSourceType(sourceType);
    setConfigEditorSourceContent(null);
  }, []);

  /** Stops holding the installed skills of a pack that is gone; the next Install removes them (with a backup). */
  const forgetPack = useCallback(async (name: string) => {
    const ok = await confirm({
      title: `Forget pack ${name}?`,
      message: `The skills installed from ${name} are no longer kept. The next Install removes the copies Riggverk installed, with a backup. Your own files in the pack folder are not touched.`,
      confirmLabel: "Forget pack",
      destructive: true,
    });
    if (!ok) return;
    try {
      await invoke<number>("forget_pack", { name });
      await loadSkills();
    } catch (e) {
      setError(`Forget pack: ${e}`);
    }
  }, [confirm, loadSkills, setError]);

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

  useEffect(() => {
    if ((view === "library" && librarySourceType === "configs") && activeConfigTargetId) {
      configSourceLoadSeqRef.current += 1;
      setConfigTemplateContent(null);
      setConfigEditorSourceContent(null);
      if (activeConfigTargetId === "opencode_config") {
        void loadConfigEditorSources();
        setActiveConfigSourceType("base");
      } else {
        void loadConfigTemplate(activeConfigTargetId);
      }
    }
  }, [view, librarySourceType, activeConfigTargetId, libraryReloadEpoch, loadConfigTemplate, loadConfigEditorSources]);

  useEffect(() => {
    if (activeConfigTargetId === "opencode_config" && activeConfigSourceType && view === "library" && librarySourceType === "configs") {
      void loadConfigEditorSourceContent(activeConfigSourceType);
    }
  }, [activeConfigTargetId, activeConfigSourceType, view, librarySourceType, libraryReloadEpoch, loadConfigEditorSourceContent]);

  return {
    skills,
    skillsLoaded,
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
    loadRulesFiles,
    librarySourceType,
    setGuardedLibrarySourceType,
    isLibrarySourceDirty,
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
    loadSkills,
    loadDocs,
    loadAgentSources,
    loadAgentTemplate,
    loadWorkspaceLibraryResources,
    loadLibraryView,
    resetLibraryState,
  };
}

export { BUNDLED_CONFIG_TARGET_IDS };
