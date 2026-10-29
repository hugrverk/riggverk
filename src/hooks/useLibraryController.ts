import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ActionResult } from "../components/TerminalOutput";
import { invokeOpen } from "../lib/invokeOpen";
import { useConfirm, useConfirmChoice } from "../components/ConfirmDialog";
import { createSaveOperationTracker } from "../lib/editorSaveOperation";
import { isLibraryDirty, isPersonalDoc } from "../lib/libraryDirtyGuards";
import { PERSONAL_SKILL_PREFIX, packSkillSummaries } from "../lib/packSkills";
import type { LibrarySourceType } from "../views/LibraryView";
import type {
  AgentMetadataListResponse,
  AgentMetadataResponse,
  AgentSourceContent,
  ConfigEditorSourceMeta,
  DocSummary,
  DocumentContent,
  PackLibrary,
  PackSkillCopy,
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
  view: string;
}

export function useLibraryController({
  setError,
  workspaceLoadGenerationRef,
  isWorkspaceLoadCurrent,
  isInvalidWorkspaceError,
  view,
}: LibraryControllerDeps) {
  const confirm = useConfirm();
  const choose = useConfirmChoice();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [packLibrary, setPackLibrary] = useState<PackLibrary | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [activeSkillContent, setActiveSkillContent] = useState<DocumentContent | null>(null);
  const activeSkillIdRef = useRef<string | null>(null);
  const activeSkillContentIdRef = useRef<string | null>(null);
  // The open skill of the user's own pack is the third item with a draft.
  const [skillDraft, setSkillDraft] = useState("");
  const [skillDirty, setSkillDirtyState] = useState(false);
  const skillDirtyRef = useRef(false);
  const setSkillDirty = useCallback((value: boolean) => {
    skillDirtyRef.current = value;
    setSkillDirtyState(value);
  }, []);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillSaveResult, setSkillSaveResult] = useState<ActionResult | null>(null);
  const skillSaveOpRef = useRef(createSaveOperationTracker());

  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [activeDoc, setActiveDoc] = useState<DocumentContent | null>(null);
  const activeDocIdRef = useRef<string | null>(null);
  const [docDraft, setDocDraft] = useState("");
  const [docDirty, setDocDirtyState] = useState(false);
  // The guards read the refs: a discard or a save that has just settled must not ask a second time while React has
  // not rendered the new state yet.
  const docDirtyRef = useRef(false);
  const setDocDirty = useCallback((value: boolean) => {
    docDirtyRef.current = value;
    setDocDirtyState(value);
  }, []);
  const [docSaving, setDocSaving] = useState(false);
  const [docSaveResult, setDocSaveResult] = useState<ActionResult | null>(null);
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
  const [rulesDirty, setRulesDirtyState] = useState(false);
  const rulesDirtyRef = useRef(false);
  const setRulesDirty = useCallback((value: boolean) => {
    rulesDirtyRef.current = value;
    setRulesDirtyState(value);
  }, []);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesSaveResult, setRulesSaveResult] = useState<ActionResult | null>(null);
  const rulesSaveOpRef = useRef(createSaveOperationTracker());

  const [librarySourceType, setLibrarySourceType] = useState<LibrarySourceType>("rules");

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

  // A doc opens with nothing unsaved. Another doc starts a new draft; the same doc read again (after an edit made
  // elsewhere) refreshes the draft too, unless the user has unsaved edits, which a read never takes away.
  const draftDocIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = activeDoc?.id ?? null;
    const another = draftDocIdRef.current !== id;
    draftDocIdRef.current = id;
    if (!another && docDirtyRef.current) return;
    setDocDraft(activeDoc?.content ?? "");
    setDocDirty(false);
    if (another) setDocSaveResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDoc]);

  // The same for a skill: the draft belongs to the skill that is open and follows each finished read while clean.
  const draftSkillIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = activeSkillContent?.id ?? null;
    const another = draftSkillIdRef.current !== id;
    draftSkillIdRef.current = id;
    if (!another && skillDirtyRef.current) return;
    setSkillDraft(activeSkillContent?.content ?? "");
    setSkillDirty(false);
    if (another) setSkillSaveResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSkillContent]);

  useEffect(() => {
    activeConfigSourceTypeRef.current = activeConfigSourceType;
  }, [activeConfigSourceType]);

  const libraryDirty = isLibraryDirty(docDirty, rulesDirty, skillDirty);

  /**
   * The user confirmed leaving with unsaved changes: both drafts go back to what is saved, so nothing stays marked
   * as unsaved (the sidebar's Library dot) and nothing comes back when the Library is opened again.
   */
  const discardDrafts = useCallback(() => {
    setDocDraft(activeDoc?.content ?? "");
    setDocDirty(false);
    setDocSaveResult(null);
    setRulesDraft(activeRulesFile?.refinements ?? "");
    setRulesDirty(false);
    setRulesSaveResult(null);
    setSkillDraft(activeSkillContent?.content ?? "");
    setSkillDirty(false);
    setSkillSaveResult(null);
  }, [activeDoc, activeRulesFile, activeSkillContent, setDocDirty, setRulesDirty, setSkillDirty]);

  // Set below, once the saves exist: "Save and continue" writes the draft that is unsaved.
  const saveDirtyDraftRef = useRef<() => Promise<boolean>>(async () => true);

  /**
   * The one leave guard of the Library, for everything that would drop the open draft (another item, another topic,
   * closing the sheet, leaving the page). With nothing unsaved it says yes at once. Otherwise it asks:
   * Discard drops the draft, Save and continue writes it first, Keep editing stays. Resolves true when the caller may
   * go on, and the draft is then already settled.
   */
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!docDirtyRef.current && !rulesDirtyRef.current && !skillDirtyRef.current) return true;
    const name = docDirtyRef.current ? activeDoc?.title : rulesDirtyRef.current ? activeRulesFile?.label : activeSkillContent?.title;
    const choice = await choose({
      title: "Unsaved changes",
      message: `${name ?? "This item"} has changes you have not saved.`,
      alternateLabel: "Discard",
      cancelLabel: "Keep editing",
      confirmLabel: "Save and continue",
    });
    if (choice === "cancel") return false;
    if (choice === "alternate") {
      discardDrafts();
      return true;
    }
    const saved = await saveDirtyDraftRef.current();
    if (!saved) {
      // The caller stays where it is, with the editor in view: make sure it says why nothing was written.
      const failed: ActionResult = { success: false, action: "save", stdout: "", stderr: "could not be saved: your changes are still here", exit_code: null };
      if (docDirtyRef.current) setDocSaveResult(result => (result && !result.success ? result : failed));
      else if (rulesDirtyRef.current) setRulesSaveResult(result => (result && !result.success ? result : failed));
      else if (skillDirtyRef.current) setSkillSaveResult(result => (result && !result.success ? result : failed));
    }
    return saved;
  }, [activeDoc?.title, activeRulesFile?.label, activeSkillContent?.title, choose, discardDrafts]);

  const setGuardedLibrarySourceType = useCallback(async (type: LibrarySourceType) => {
    if (type === librarySourceType) return;
    if (!(await confirmLeave())) return;
    setLibrarySourceType(type);
  }, [librarySourceType, confirmLeave]);

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
  }, [loadAgentSources, loadAgentTemplate, loadDocs, loadRulesFiles, loadSkills]);

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
    if (surface === current && rulesDirtyRef.current) return;
    if (surface !== current && !(await confirmLeave())) return;
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
  }, [applyRulesFile, clearActiveRulesFile, confirmLeave, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const openRulesFile = useCallback(
    (surface: RulesSurfaceId) => invokeOpen("open_rules_file", { surface }, "Open rules file", setError),
    [setError],
  );

  const onChangeRulesDraft = useCallback((value: string) => {
    setRulesDraft(value);
    setRulesDirty(value !== (activeRulesFile?.refinements ?? ""));
  }, [activeRulesFile, setRulesDirty]);

  const onResetRules = useCallback(() => {
    if (!activeRulesFile) return;
    setRulesDraft(activeRulesFile.refinements);
    setRulesDirty(false);
    setRulesSaveResult(null);
  }, [activeRulesFile, setRulesDirty]);

  const onSaveRules = useCallback(async (): Promise<boolean> => {
    // Only the refinements of a file the backend called editable are sent; it checks everything again.
    const file = activeRulesFile;
    if (!file || !file.editable || file.conflict !== null || file.revision === null) return false;
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
      if (!isCurrent()) return false;
      setRulesSaveResult(result);
      if (!result.success) return false;
      if (result.stdout === "unchanged") {
        setRulesDirty(false);
        return true;
      }
      const updated = await invoke<RulesFileContent>("read_rules_file", { surface });
      if (!isCurrent()) return false;
      applyRulesFile(updated);
      return true;
    } catch (e) {
      if (!isCurrent()) return false;
      const message = String(e);
      if (!message.includes(RULES_CHANGED_ON_DISK)) {
        setRulesSaveResult(failed(message));
        return false;
      }
      // The file changed elsewhere: show it as it is now and keep the draft, which a second save then writes.
      try {
        const updated = await invoke<RulesFileContent>("read_rules_file", { surface });
        if (!isCurrent()) return false;
        setActiveRulesFile(updated);
        setRulesSaveResult(failed("changed on disk: reloaded, save again to overwrite"));
      } catch (reloadError) {
        if (!isCurrent()) return false;
        setRulesSaveResult(failed(String(reloadError)));
      }
      return false;
    } finally {
      setRulesSaving(false);
    }
  }, [activeRulesFile, applyRulesFile, isWorkspaceLoadCurrent, rulesDraft, setRulesDirty, workspaceLoadGenerationRef]);

  const selectDoc = useCallback(async (id: string) => {
    if (id !== activeDoc?.id && !(await confirmLeave())) return;
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
  }, [activeDoc?.id, confirmLeave, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const openDocEditor = useCallback(
    (id: string) => invokeOpen("open_doc", { id }, "Open doc", setError),
    [setError],
  );

  const onSaveDoc = useCallback(async (): Promise<boolean> => {
    // Only personal docs are saved; the backend refuses bundled ids too.
    if (!activeDoc || !isPersonalDoc(activeDoc)) return false;
    const saveOpId = docSaveOpRef.current.capture();
    const docId = activeDoc.id;
    const generation = workspaceLoadGenerationRef.current;
    setDocSaving(true);
    setDocSaveResult(null);
    try {
      const result = await invoke<ActionResult>("save_doc", {
        id: docId,
        content: docDraft,
        expectedRevision: activeDoc.revision,
      });
      if (!docSaveOpRef.current.isCurrent(saveOpId)) return false;
      if (!isWorkspaceLoadCurrent(generation)) return false;
      if (activeDocIdRef.current !== docId) return false;
      setDocSaveResult(result);
      if (result.success) {
        if (result.stdout !== "unchanged") {
          const updated = await invoke<DocumentContent>("read_doc", { id: docId });
          if (!docSaveOpRef.current.isCurrent(saveOpId)) return false;
          if (!isWorkspaceLoadCurrent(generation)) return false;
          if (activeDocIdRef.current !== docId) return false;
          setActiveDoc(updated);
          setDocDraft(updated.content);
        }
        setDocDirty(false);
      }
      return result.success;
    } catch (e) {
      const isCurrent = () =>
        docSaveOpRef.current.isCurrent(saveOpId) &&
        isWorkspaceLoadCurrent(generation) &&
        activeDocIdRef.current === docId;
      const failed = (stderr: string) =>
        setDocSaveResult({ success: false, action: "save_doc", stdout: "", stderr, exit_code: null });
      if (!isCurrent()) return false;
      const message = String(e);
      if (!message.includes(RULES_CHANGED_ON_DISK)) {
        failed(message);
        return false;
      }
      // Changed elsewhere, as for rules: show the file as it is now and keep the draft, which a second save writes.
      try {
        const updated = await invoke<DocumentContent>("read_doc", { id: docId });
        if (!isCurrent()) return false;
        setActiveDoc(updated);
        failed("changed on disk: reloaded, save again to overwrite");
      } catch (reloadError) {
        if (isCurrent()) failed(String(reloadError));
      }
      return false;
    } finally {
      setDocSaving(false);
    }
  }, [activeDoc, docDraft, isWorkspaceLoadCurrent, setDocDirty, workspaceLoadGenerationRef]);

  const onResetDoc = useCallback(() => {
    if (activeDoc) {
      setDocDraft(activeDoc.content);
      setDocDirty(false);
      setDocSaveResult(null);
    }
  }, [activeDoc, setDocDirty]);

  const onChangeDocDraft = useCallback((value: string) => {
    setDocDraft(value);
    setDocDirty(value !== (activeDoc?.content ?? ""));
  }, [activeDoc, setDocDirty]);

  /** Creates the doc from the title and slug; resolves with its id (it is then the open doc), or null when it was not created. */
  const onCreateDoc = useCallback(async (): Promise<string | null> => {
    if (!(await confirmLeave())) return null;
    const title = createDocTitle.trim();
    const slug = createDocSlug.trim();
    if (!title || !slug) {
      setCreateDocError("Title and slug are required");
      return null;
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
      return doc.id;
    } catch (e) {
      setCreateDocError(String(e));
      return null;
    } finally {
      setCreateDocCreating(false);
    }
  }, [createDocSlug, createDocTitle, confirmLeave, loadDocs]);

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
    if (id !== activeSkillIdRef.current && !(await confirmLeave())) return;
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
  }, [confirmLeave, isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const onChangeSkillDraft = useCallback((value: string) => {
    setSkillDraft(value);
    setSkillDirty(value !== (activeSkillContent?.content ?? ""));
  }, [activeSkillContent, setSkillDirty]);

  const onResetSkill = useCallback(() => {
    setSkillDraft(activeSkillContent?.content ?? "");
    setSkillDirty(false);
    setSkillSaveResult(null);
  }, [activeSkillContent, setSkillDirty]);

  /** Saves the open skill of the personal pack (the backend refuses every other id); true once it is on disk. */
  const onSaveSkill = useCallback(async (): Promise<boolean> => {
    const skill = activeSkillContent;
    if (!skill || !skill.id.startsWith(PERSONAL_SKILL_PREFIX)) return false;
    const saveOpId = skillSaveOpRef.current.capture();
    const generation = workspaceLoadGenerationRef.current;
    const isCurrent = () =>
      skillSaveOpRef.current.isCurrent(saveOpId) &&
      isWorkspaceLoadCurrent(generation) &&
      activeSkillIdRef.current === skill.id;
    setSkillSaving(true);
    setSkillSaveResult(null);
    try {
      const result = await invoke<ActionResult>("save_pack_skill", {
        id: skill.id,
        content: skillDraft,
        expectedRevision: skill.revision,
      });
      if (!isCurrent()) return false;
      setSkillSaveResult(result);
      if (!result.success) return false;
      if (result.stdout !== "unchanged") {
        const updated = await invoke<DocumentContent>("read_skill", { id: skill.id });
        if (!isCurrent()) return false;
        activeSkillContentIdRef.current = updated.id;
        setActiveSkillContent(updated);
        setSkillDraft(updated.content);
      }
      setSkillDirty(false);
      return true;
    } catch (e) {
      if (!isCurrent()) return false;
      const failed = (stderr: string) =>
        setSkillSaveResult({ success: false, action: "save_pack_skill", stdout: "", stderr, exit_code: null });
      const message = String(e);
      if (!message.includes(RULES_CHANGED_ON_DISK)) {
        failed(message);
        return false;
      }
      // Changed elsewhere, as for rules: show the file as it is now and keep the draft, which a second save writes.
      try {
        const updated = await invoke<DocumentContent>("read_skill", { id: skill.id });
        if (!isCurrent()) return false;
        activeSkillContentIdRef.current = updated.id;
        setActiveSkillContent(updated);
        failed("changed on disk: reloaded, save again to overwrite");
      } catch (reloadError) {
        if (isCurrent()) failed(String(reloadError));
      }
      return false;
    } finally {
      setSkillSaving(false);
    }
  }, [activeSkillContent, isWorkspaceLoadCurrent, setSkillDirty, skillDraft, workspaceLoadGenerationRef]);

  /**
   * Copies a bundled skill into the personal pack under `newName`, then lists the packs again so the copy shows. The
   * backend's refusal (a taken name, a refused pack) is thrown for the caller to show; nothing else changes.
   */
  const copySkillToPack = useCallback(async (name: string, newName: string): Promise<PackSkillCopy> => {
    const copy = await invoke<PackSkillCopy>("copy_skill_to_pack", { name, newName });
    await loadSkills();
    return copy;
  }, [loadSkills]);

  // The configs load whenever the Library is open, not only on their topic: a search result can open one from any topic.
  // Choosing a target resets the source itself, so only a new visit or a workspace reload sends it back to the base.
  const configSourceVisitRef = useRef("");
  useEffect(() => {
    if (view === "library" && activeConfigTargetId) {
      configSourceLoadSeqRef.current += 1;
      setConfigTemplateContent(null);
      setConfigEditorSourceContent(null);
      // Every run notes the visit, whatever the target: a source chosen together with a switch to OpenCode's target
      // (a search result) is not a first visit and keeps its source.
      const visit = `${view}:${libraryReloadEpoch}`;
      const firstOfVisit = configSourceVisitRef.current !== visit;
      configSourceVisitRef.current = visit;
      if (activeConfigTargetId === "opencode_config") {
        void loadConfigEditorSources();
        if (firstOfVisit) setActiveConfigSourceType("base");
      } else {
        void loadConfigTemplate(activeConfigTargetId);
      }
    }
  }, [view, activeConfigTargetId, libraryReloadEpoch, loadConfigTemplate, loadConfigEditorSources]);

  useEffect(() => {
    if (activeConfigTargetId === "opencode_config" && activeConfigSourceType && view === "library") {
      void loadConfigEditorSourceContent(activeConfigSourceType);
    }
  }, [activeConfigTargetId, activeConfigSourceType, view, libraryReloadEpoch, loadConfigEditorSourceContent]);

  saveDirtyDraftRef.current = () => (docDirtyRef.current ? onSaveDoc() : rulesDirtyRef.current ? onSaveRules() : onSaveSkill());

  return {
    skills,
    skillsLoaded,
    packLibrary,
    packError,
    forgetPack,
    activeSkillId,
    activeSkillContent,
    readSkill,
    skillDraft,
    skillDirty,
    skillSaving,
    skillSaveResult,
    onChangeSkillDraft,
    onSaveSkill,
    onResetSkill,
    copySkillToPack,
    docs,
    activeDoc,
    docDraft,
    docDirty,
    docSaving,
    docSaveResult,
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
    confirmLeave,
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
