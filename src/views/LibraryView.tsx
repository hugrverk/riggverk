import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ActionResult } from "../components/TerminalOutput";
import { redactTerminalOutput } from "../lib/redactTerminalOutput";
import { useShellState } from "../shell/ShellState";
import type {
  AgentMetadataResponse,
  AgentSourceContent,
  AgentTargetMeta,
  ConfigEditorSourceMeta,
  DocSummary,
  DocumentContent,
  InstallAgent,
  PackLibrary,
  RulesFileContent,
  RulesFileSummary,
  RulesSurfaceId,
  SkillImportPreview,
  SkillImportResult,
  SkillSummary,
} from "../types";
import { IMPORTED_SKILL_PREFIX } from "../lib/packSkills";
import { buildEntry } from "./library/entry";
import { GroupView } from "./library/LibraryGroups";
import { LibrarySheet } from "./library/LibrarySheet";
import {
  isRulesConflict,
  LIBRARY_TOPICS,
  packsNeedAttention,
  searchGroups,
  topicGroups,
  type LibraryModelInput,
  type LibraryRow,
  type LibrarySourceType,
  type OpenTarget,
  type RowVerb,
} from "./library/model";
import { CopySkillDialog } from "./library/CopySkillDialog";
import { ImportSkillDialog, type DroppedPaths } from "./library/ImportSkillDialog";
import { importDoneText } from "./library/skillImport";
import { useDroppedPaths } from "./library/useDroppedPaths";
import { NewDocDialog } from "./library/NewDocDialog";
import type { RulesMode } from "./library/RulesEditor";
import { skillCopyProblem, suggestedCopyName } from "./library/skillCopy";
import { useLibraryKeys } from "./library/useLibraryKeys";

export type { LibrarySourceType } from "./library/model";

type Maybe<T> = T | Promise<T>;

export interface LibraryViewProps {
  /** The topic on show (the tab). */
  sourceType: LibrarySourceType;
  onSetSourceType: (type: LibrarySourceType) => Maybe<void>;

  // Docs: personal docs are editable, bundled docs read-only.
  docs: DocSummary[];
  activeDoc: DocumentContent | null;
  onSelectDoc: (id: string) => Maybe<void>;
  onOpenDoc: (id: string) => void;
  docDraft: string;
  docDirty: boolean;
  docSaving: boolean;
  docSaveResult: ActionResult | null;
  onChangeDocDraft: (value: string) => void;
  onSaveDoc: () => unknown;
  onResetDoc: () => void;
  showCreateDoc: boolean;
  createDocTitle: string;
  createDocSlug: string;
  createDocError: string | null;
  createDocCreating: boolean;
  onSetShowCreateDoc: (show: boolean) => void;
  onSetCreateDocTitle: (value: string) => void;
  onSetCreateDocSlug: (value: string) => void;
  /** Creates the doc; resolves with its id when it was created, which then opens in the sheet. */
  onCreateDoc: () => Maybe<string | null | void>;

  // Rules: the bundled base is read-only; in the user's own rules files the refinements below the managed
  // block are editable.
  agentTemplate: DocumentContent | null;
  agentTargets: AgentTargetMeta[];
  rulesFiles: RulesFileSummary[];
  /** The open rules file; null while the bundled base is open. */
  activeRulesSurface: RulesSurfaceId | null;
  activeRulesFile: RulesFileContent | null;
  onSelectRulesFile: (surface: RulesSurfaceId | null) => Maybe<void>;
  onOpenRulesFile: (surface: RulesSurfaceId) => void;
  rulesDraft: string;
  rulesDirty: boolean;
  rulesSaving: boolean;
  rulesSaveResult: ActionResult | null;
  onChangeRulesDraft: (value: string) => void;
  onSaveRules: () => unknown;
  onResetRules: () => void;

  // Skills, agents and configs are read-only here, so they have no draft.
  skills: SkillSummary[];
  activeSkillContent: DocumentContent | null;
  onSelectSkillPreview: (id: string) => Maybe<void>;
  /** The open skill of the personal pack is editable: it has a draft like a personal doc. */
  skillDraft: string;
  skillDirty: boolean;
  skillSaving: boolean;
  skillSaveResult: ActionResult | null;
  onChangeSkillDraft: (value: string) => void;
  onSaveSkill: () => unknown;
  onResetSkill: () => void;
  /**
   * Copies a bundled skill into the personal pack under a new name and resolves with the copy (its id opens in the
   * sheet); rejects with the reason when the backend refuses. Without it the bundled rows and sheets offer no
   * "Edit as my copy".
   */
  onCopySkill?: (name: string, newName: string) => Promise<{ id: string }>;
  /** Skill packs: the packs, their problems and the way to forget one that cannot be read. */
  packLibrary?: PackLibrary | null;
  packError?: string | null;
  /** Resolves true once the pack is forgotten; its row is then gone and focus moves to the next one. */
  onForgetPack?: (name: string) => void | boolean | Promise<boolean | void>;
  /**
   * Skill import: preview copies the dropped or given paths into private staging; commit publishes the previewed
   * copy into pack:imported and lists the packs again. Without them there is no "Import skill…".
   */
  onPreviewImport?: (paths: string[]) => Promise<SkillImportPreview>;
  onCommitImport?: (token: string, selection: string[], renames: Record<string, string>) => Promise<SkillImportResult>;
  /** Asks first; resolves with the notice once done, or null when the user said no or it failed. */
  onRemoveImport?: (name: string) => Promise<string | null>;
  onUndoImport?: () => Promise<string | null>;

  agentSources: AgentMetadataResponse[];
  activeAgentContent: AgentSourceContent | null;
  onSelectAgent: (id: string) => Maybe<void>;

  configTemplateContent: DocumentContent | null;
  activeConfigTargetId: string;
  configTargets: AgentTargetMeta[];
  onSelectConfigTarget: (targetId: string) => void;
  configEditorSources: ConfigEditorSourceMeta[];
  activeConfigSourceType: string;
  onSelectConfigSource: (sourceType: string) => void;
  configEditorSourceContent: DocumentContent | null;

  // Common
  dataFolderOk: boolean;
  showConfigs: boolean;
  /** Goes to a harness page, where a rules conflict is decided. */
  onOpenHarnessView?: (harness: InstallAgent) => void;
  /**
   * The app's leave guard for unsaved edits: resolves true when the caller may go on (nothing was unsaved, or the
   * edits were discarded or saved), false for "Keep editing". Without it nothing is guarded.
   */
  onConfirmLeave?: () => Promise<boolean>;
  /** Why the open item could not be read; the sheet shows it in place of "Loading…". */
  itemLoadError?: string | null;
}

interface SheetState {
  target: OpenTarget;
  /** Shown in the header until the item has loaded. */
  title: string;
  /** The topic that was on show when the sheet opened: a later topic change from outside closes it, an earlier one does not. */
  topic: LibrarySourceType;
}

/**
 * Library, in the manner of System Settings: a search field, a row of topics, and the topic's items as grouped boxes
 * of rows with their verbs. Opening an item drops a sheet over the content; edits stay in the controller's drafts
 * and every way out of them goes through one guard (`onConfirmLeave`). Search crosses all topics.
 */
export function LibraryView(props: LibraryViewProps) {
  const { sourceType, dataFolderOk, showConfigs, onConfirmLeave } = props;
  const rootRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { notify } = useShellState();
  const ids = useId();

  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [rulesMode, setRulesMode] = useState<RulesMode>("refinements");
  /** The row (or group button) that opened the sheet, for focus to return to. */
  const returnKeyRef = useRef<string | null>(null);
  const newDocOpenerRef = useRef<Element | null>(null);
  const copyOpenerRef = useRef<Element | null>(null);
  /** The "Edit as my copy" dialog: the bundled skill, the name typed, the backend's refusal, and a copy under way. */
  const [copy, setCopy] = useState<{ source: string; name: string; error: string | null; busy: boolean } | null>(null);
  /** The "Import skill…" dialog, with the paths a drop opened it with. */
  const [importing, setImporting] = useState<{ dropped: DroppedPaths | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const importOpenerRef = useRef<Element | null>(null);
  const dropSeq = useRef(0);
  const searching = query.trim() !== "";

  const confirmLeave = async (): Promise<boolean> => (onConfirmLeave ? onConfirmLeave() : true);

  const input: LibraryModelInput = {
    dataFolderOk,
    docs: props.docs,
    agentTemplateLoaded: props.agentTemplate !== null,
    rulesFiles: props.rulesFiles,
    skills: props.skills,
    agentSources: props.agentSources,
    configTargets: props.configTargets,
    configEditorSources: props.configEditorSources,
    packLibrary: props.packLibrary ?? null,
    packError: props.packError ?? null,
    canCopySkill: props.onCopySkill !== undefined,
    canForgetPack: props.onForgetPack !== undefined,
    canOpenHarness: props.onOpenHarnessView !== undefined,
    canImportSkill: props.onPreviewImport !== undefined && props.onCommitImport !== undefined,
  };

  const topics = LIBRARY_TOPICS.filter(topic => topic.id !== "configs" || showConfigs);
  const topicId = topics.some(topic => topic.id === sourceType) ? sourceType : topics[0]!.id;
  const groups = searching ? [] : topicGroups(topicId, input);
  const results = searching ? searchGroups(query, input).filter(section => section.topic !== "configs" || showConfigs) : [];

  const entry = sheet ? buildEntry(props, sheet.target) : null;

  // ---- the sheet ----

  const openTarget = async (target: OpenTarget, title: string, returnKey: string | null) => {
    if (!(await confirmLeave())) return;
    returnKeyRef.current = returnKey;
    setRulesMode("refinements");
    setSheet({ target, title, topic: sourceType });
    switch (target.kind) {
      case "doc":
        void props.onSelectDoc(target.id);
        break;
      case "rules":
        void props.onSelectRulesFile(target.surface);
        break;
      case "base":
        void props.onSelectRulesFile(null);
        break;
      case "skill":
        void props.onSelectSkillPreview(target.id);
        break;
      case "agent":
        void props.onSelectAgent(target.id);
        break;
      case "config":
        if (props.activeConfigTargetId !== target.targetId) props.onSelectConfigTarget(target.targetId);
        if (target.sourceId) props.onSelectConfigSource(target.sourceId);
        break;
    }
  };

  const requestClose = async () => {
    if (!(await confirmLeave())) return;
    setSheet(null);
  };

  // Closing hands focus back to the row that opened the sheet (or the selected tab when that row is gone).
  const hadSheet = useRef(false);
  useLayoutEffect(() => {
    if (hadSheet.current && sheet === null) {
      const root = rootRef.current;
      const key = returnKeyRef.current;
      const row = key ? Array.from(root?.querySelectorAll<HTMLElement>("[data-row-key]") ?? []).find(el => el.dataset.rowKey === key) : null;
      const target = row?.querySelector<HTMLElement>("[data-row-primary]") ?? root?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]');
      target?.focus();
    }
    hadSheet.current = sheet !== null;
  }, [sheet]);

  // Forgetting a pack removes its row, and the focus on it goes with it: it moves to the row that took its place (or
  // the one before it, or the selected tab when no row is left) instead of dropping to the page. It runs once the
  // forget has finished (`forgotten` ticks after the new pack list is in), not on the prop, which a caller may mutate.
  const forgetFocusIndex = useRef<number | null>(null);
  const [forgotten, setForgotten] = useState(0);
  useEffect(() => {
    const index = forgetFocusIndex.current;
    if (index === null) return;
    forgetFocusIndex.current = null;
    const active = document.activeElement;
    // Focus still on something live (a dialog that is closing counts as gone) stays where it is.
    if (active && active !== document.body && active.isConnected && !active.closest("dialog:not([open])")) return;
    const rows = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? []);
    const target = rows[Math.min(index, rows.length - 1)]?.querySelector<HTMLElement>("[data-row-primary]") ?? rootRef.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]');
    target?.focus();
  }, [forgotten]);

  // Switching topic replaces the rows, and focus on one of them goes with it: it lands on the selected tab, so the
  // next key still reaches the Library. Focus on a tab follows the selection too.
  const previousTopicId = useRef(topicId);
  useEffect(() => {
    if (previousTopicId.current === topicId) return;
    previousTopicId.current = topicId;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || active.getAttribute("role") === "tab") {
      rootRef.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus();
    }
  }, [topicId]);

  // A topic change from outside (`:library skills`) closes the sheet; opening a config from a search result does not.
  // This runs after the commit, so a sheet opened in the meantime (it already carries the new topic) must survive it.
  const previousTopic = useRef(sourceType);
  useEffect(() => {
    if (previousTopic.current === sourceType) return;
    previousTopic.current = sourceType;
    setSheet(current => (current && current.topic !== sourceType ? null : current));
  }, [sourceType]);

  // A save that finishes is also a notice, for when the sheet has already closed (Save and continue).
  const wasSaving = useRef({ doc: false, rules: false, skill: false });
  useEffect(() => {
    const before = wasSaving.current;
    if (before.doc && !props.docSaving && props.docSaveResult?.success) {
      notify(redactTerminalOutput(props.docSaveResult.stdout) || "saved", { tone: "ok" });
    }
    if (before.rules && !props.rulesSaving && props.rulesSaveResult?.success) {
      notify(redactTerminalOutput(props.rulesSaveResult.stdout) || "saved", { tone: "ok" });
    }
    if (before.skill && !props.skillSaving && props.skillSaveResult?.success) {
      notify(props.skillSaveResult.stdout === "unchanged" ? "no changes to save" : "Saved · Update installs it", { tone: "ok" });
    }
    wasSaving.current = { doc: props.docSaving, rules: props.rulesSaving, skill: props.skillSaving };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docSaving, props.rulesSaving, props.skillSaving]);

  // ---- topics and search ----

  const focusSearch = () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  };

  const chooseTopic = async (id: LibrarySourceType) => {
    if (!(await confirmLeave())) return;
    setQuery("");
    setSheet(null);
    await props.onSetSourceType(id);
  };

  const stepTopic = (delta: number) => {
    const index = Math.max(0, topics.findIndex(topic => topic.id === topicId));
    void chooseTopic(topics[(index + delta + topics.length) % topics.length]!.id);
  };

  const openNewDoc = async () => {
    if (!(await confirmLeave())) return;
    newDocOpenerRef.current = document.activeElement;
    props.onSetCreateDocTitle("");
    props.onSetCreateDocSlug("");
    props.onSetShowCreateDoc(true);
  };

  const closeNewDoc = () => {
    props.onSetShowCreateDoc(false);
    const opener = newDocOpenerRef.current;
    newDocOpenerRef.current = null;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };

  const createDoc = async () => {
    const id = await props.onCreateDoc();
    if (typeof id !== "string") return;
    newDocOpenerRef.current = null;
    returnKeyRef.current = `docs/doc:${id}`;
    setRulesMode("refinements");
    setSheet({ target: { kind: "doc", id }, title: props.createDocTitle.trim() || "New doc", topic: sourceType });
  };

  /** `source` is a bundled skill's name or an imported skill's id (`pack:imported/<name>`). */
  const openCopy = (source: string) => {
    copyOpenerRef.current = document.activeElement;
    setCopy({ source, name: suggestedCopyName(source.replace(IMPORTED_SKILL_PREFIX, "")), error: null, busy: false });
  };

  const openImport = (dropped: DroppedPaths | null = null) => {
    importOpenerRef.current = document.activeElement;
    setImporting({ dropped });
  };

  const closeImport = () => {
    setImporting(null);
    const opener = importOpenerRef.current;
    importOpenerRef.current = null;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };

  // Paths dropped onto the window while the Packs topic (or the import dialog) is on show are previewed for import.
  const importAvailable = input.canImportSkill && dataFolderOk;
  const dropTarget = importAvailable && (importing !== null || (topicId === "packs" && !searching && sheet === null && copy === null && !props.showCreateDoc));
  useDroppedPaths(
    dropTarget,
    paths => {
      const dropped = { paths, seq: ++dropSeq.current };
      if (importing) setImporting({ dropped });
      else openImport(dropped);
    },
    setDragging,
  );

  const runImportVerb = (run: (() => Promise<string | null>) | undefined) => {
    void run?.().then(message => {
      if (message) notify(message, { tone: "ok" });
    });
  };

  const closeCopy = () => {
    if (copy?.busy) return;
    setCopy(null);
    const opener = copyOpenerRef.current;
    copyOpenerRef.current = null;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };

  const createCopy = async () => {
    if (!copy || !props.onCopySkill || copy.busy) return;
    const { source, name } = copy;
    setCopy({ ...copy, busy: true, error: null });
    try {
      const made = await props.onCopySkill(source, name);
      copyOpenerRef.current = null;
      setCopy(null);
      // The new skill opens for editing; the bundled sheet it was made from is replaced.
      setSheet(null);
      await openTarget({ kind: "skill", id: made.id }, name, `skills/skill:${made.id}`);
    } catch (error) {
      const text = String(error instanceof Error ? error.message : error);
      setCopy(current => (current ? { ...current, busy: false, error: text } : current));
    }
  };

  const { onRootKeyDown } = useLibraryKeys({
    rootRef,
    sheetRef,
    sheetOpen: sheet !== null,
    entry,
    focusSearch,
    stepTopic,
    newDoc: dataFolderOk && sheet === null ? () => void openNewDoc() : null,
    requestClose,
  });

  const runVerb = (scope: string) => (row: LibraryRow, verb: RowVerb) => {
    const action = verb.action;
    switch (action.type) {
      case "open":
        void openTarget(action.target, row.name, `${scope}/${row.key}`);
        break;
      case "harness":
        props.onOpenHarnessView?.(action.harness);
        break;
      case "copy":
        openCopy(action.skill);
        break;
      case "remove-import": {
        const name = action.name;
        runImportVerb(props.onRemoveImport && (() => props.onRemoveImport!(name)));
        break;
      }
      case "undo-import":
        runImportVerb(props.onUndoImport);
        break;
      case "forget": {
        const rows = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? []);
        forgetFocusIndex.current = Math.max(0, rows.findIndex(el => el.dataset.rowKey === `${scope}/${row.key}`));
        void Promise.resolve(props.onForgetPack?.(action.pack)).then(done => {
          if (done === true) setForgotten(count => count + 1);
          else forgetFocusIndex.current = null;
        });
        break;
      }
    }
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const edge = event.key === "Home" ? 0 : event.key === "End" ? topics.length - 1 : null;
    if (!step && edge === null) return;
    event.preventDefault();
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const current = Math.max(0, tabs.indexOf(document.activeElement as HTMLElement));
    tabs[edge ?? (current + step + tabs.length) % tabs.length]?.focus();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (query !== "") setQuery("");
      else rootRef.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      rootRef.current?.querySelector<HTMLElement>("[data-row-primary]")?.focus();
    }
  };

  const rulesAttention = dataFolderOk && props.rulesFiles.some(isRulesConflict);
  const packsAttention = packsNeedAttention(props.packLibrary ?? null, props.packError ?? null);
  const selectedTab = searching ? null : topicId;
  const focusTab = selectedTab ?? topics[0]!.id;

  return (
    <section
      ref={rootRef}
      className="screen library"
      data-pane-id="library"
      data-pane-default=""
      data-keyscope="pane"
      aria-label="Library"
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
    >
      <div className="lib-main" inert={sheet !== null}>
        <div className="lib-top">
          <input
            ref={searchRef}
            className="lib-search"
            type="search"
            value={query}
            placeholder="Search all topics"
            aria-label="Search all topics"
            autoComplete="off"
            spellCheck={false}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        <div className="lib-topics" role="tablist" aria-label="Library topics" onKeyDown={onTabKeyDown}>
          {topics.map(topic => {
            const attention = (topic.id === "rules" && rulesAttention) || (topic.id === "packs" && packsAttention);
            const noteId = `${ids}-note-${topic.id}`;
            return (
              <button
                key={topic.id}
                type="button"
                role="tab"
                id={`${ids}-tab-${topic.id}`}
                className="lib-tab"
                aria-selected={selectedTab === topic.id}
                aria-controls={`${ids}-panel`}
                aria-describedby={attention ? noteId : undefined}
                tabIndex={focusTab === topic.id ? 0 : -1}
                data-pane-primary={focusTab === topic.id ? "" : undefined}
                onClick={() => void chooseTopic(topic.id)}
              >
                {topic.label}
                {attention && <i className={topic.id === "rules" ? "lib-sq" : "lib-ring"} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        {/* What the marks on the tabs mean, for the tabs' accessible descriptions. */}
        {rulesAttention && <span id={`${ids}-note-rules`} className="visually-hidden">Needs your decision</span>}
        {packsAttention && <span id={`${ids}-note-packs`} className="visually-hidden">A pack needs attention</span>}
        {dragging && !importing && (
          <p className="lib-drop-cue" role="status">Drop to preview the import into pack:imported</p>
        )}
        <div
          className="lib-scroll"
          id={`${ids}-panel`}
          role={searching ? "region" : "tabpanel"}
          aria-label={searching ? "Search results" : undefined}
          aria-labelledby={searching ? undefined : `${ids}-tab-${topicId}`}
        >
          {searching ? (
            results.length === 0 ? (
              <p className="lib-empty" role="status">Nothing matches “{query.trim()}”.</p>
            ) : (
              results.map(section => (
                <div key={section.topic} className="lib-section">
                  <h2 className="lib-topic-head">{section.label}</h2>
                  {section.groups.map(group => (
                    <GroupView
                      key={group.key}
                      group={group}
                      scope={section.topic}
                      onVerb={runVerb(section.topic)}
                      onGroupAction={() => {}}
                    />
                  ))}
                </div>
              ))
            )
          ) : (
            groups.map(group => (
              <GroupView
                key={group.key}
                group={group}
                scope={topicId}
                onVerb={runVerb(topicId)}
                onGroupAction={id => (id === "import-skill" ? openImport() : void openNewDoc())}
              />
            ))
          )}
        </div>
      </div>

      {sheet && (
        <LibrarySheet
          title={sheet.title}
          entry={entry}
          loadError={props.itemLoadError ?? null}
          sheetRef={sheetRef}
          rulesMode={rulesMode}
          onRulesMode={setRulesMode}
          onRequestClose={() => void requestClose()}
          onCopySkill={props.onCopySkill ? openCopy : undefined}
          onOpenHarness={props.onOpenHarnessView}
        />
      )}

      {copy && (
        <CopySkillDialog
          source={copy.source.replace(IMPORTED_SKILL_PREFIX, "")}
          origin={copy.source.startsWith(IMPORTED_SKILL_PREFIX) ? "imported" : "bundled"}
          name={copy.name}
          problem={skillCopyProblem(copy.name, props.skills)}
          error={copy.error}
          creating={copy.busy}
          onChangeName={name => setCopy({ ...copy, name, error: null })}
          onCreate={() => void createCopy()}
          onClose={closeCopy}
        />
      )}

      {importing && props.onPreviewImport && props.onCommitImport && (
        <ImportSkillDialog
          dropped={importing.dropped}
          dragging={dragging}
          skills={props.skills}
          packsFolder={props.packLibrary?.folder ?? "~/.config/riggverk/packs"}
          onPreview={props.onPreviewImport}
          onCommit={props.onCommitImport}
          onDone={result => {
            closeImport();
            notify(importDoneText(result), { tone: "ok" });
          }}
          onClose={closeImport}
        />
      )}

      {props.showCreateDoc && (
        <NewDocDialog
          title={props.createDocTitle}
          slug={props.createDocSlug}
          error={props.createDocError}
          creating={props.createDocCreating}
          onChangeTitle={(title, slug) => {
            props.onSetCreateDocTitle(title);
            props.onSetCreateDocSlug(slug);
          }}
          onCreate={() => void createDoc()}
          onClose={closeNewDoc}
        />
      )}
    </section>
  );
}
