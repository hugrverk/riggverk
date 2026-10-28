import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActionResult } from "../components/TerminalOutput";
import { focusPaneById } from "../keyboard/focus";
import { useStatusContext } from "../shell/ShellState";
import { Pane } from "../ui/Pane";
import type {
  AgentMetadataResponse,
  AgentSourceContent,
  AgentTargetMeta,
  ConfigEditorSourceMeta,
  DocSummary,
  DocumentContent,
  PackLibrary,
  RulesFileContent,
  RulesFileSummary,
  RulesSurfaceId,
  SkillSummary,
} from "../types";
import { AgentItemList } from "./library/AgentItemList";
import { ConfigItemList } from "./library/ConfigItemList";
import { CreateDocForm } from "./library/CreateDocForm";
import { DocItemList } from "./library/DocItemList";
import { DocumentPane } from "./library/DocumentPane";
import { buildEntry, emptyStateHint } from "./library/entry";
import { PackNotice } from "./library/PackNotice";
import { RULES_LIST_KEY, rulesFileKey, RulesItemList } from "./library/RulesItemList";
import { SkillItemList } from "./library/SkillItemList";
import { SourceSwitcher, type LibrarySourceTab } from "./library/SourceSwitcher";
import { useLibraryKeys } from "./library/useLibraryKeys";

export type LibrarySourceType = "docs" | "rules" | "skills" | "agents" | "configs";

const SOURCE_TYPES: { id: LibrarySourceType; label: string; title: string }[] = [
  { id: "docs", label: "docs", title: "Docs" },
  { id: "rules", label: "rules", title: "Rules" },
  { id: "skills", label: "skills", title: "Skills" },
  { id: "agents", label: "agents", title: "Runtime agents" },
  { id: "configs", label: "configs", title: "Configs" },
];

/** A pending "open it for editing" request outlives the open item it waits for only this long. */
const FOCUS_REQUEST_MS = 2000;

export interface LibraryViewProps {
  sourceType: LibrarySourceType;
  onSetSourceType: (type: LibrarySourceType) => void;

  // Docs: personal docs are editable, bundled docs read-only.
  docs: DocSummary[];
  activeDoc: DocumentContent | null;
  onSelectDoc: (id: string) => void;
  onOpenDoc: (id: string) => void;
  docDraft: string;
  docDirty: boolean;
  docSaving: boolean;
  docSaveResult: ActionResult | null;
  docMode: "preview" | "edit";
  onSetDocMode: (mode: "preview" | "edit") => void;
  onChangeDocDraft: (value: string) => void;
  onSaveDoc: () => void;
  onResetDoc: () => void;
  showCreateDoc: boolean;
  createDocTitle: string;
  createDocSlug: string;
  createDocError: string | null;
  createDocCreating: boolean;
  onSetShowCreateDoc: (show: boolean) => void;
  onSetCreateDocTitle: (value: string) => void;
  onSetCreateDocSlug: (value: string) => void;
  onCreateDoc: () => void;

  // Rules: the bundled base is read-only; in the user's own rules files the refinements below the managed
  // block are editable.
  agentTemplate: DocumentContent | null;
  agentTargets: AgentTargetMeta[];
  rulesFiles: RulesFileSummary[];
  /** The open rules file; null while the bundled base row is open. */
  activeRulesSurface: RulesSurfaceId | null;
  activeRulesFile: RulesFileContent | null;
  onSelectRulesFile: (surface: RulesSurfaceId | null) => void | Promise<void>;
  onOpenRulesFile: (surface: RulesSurfaceId) => void;
  rulesDraft: string;
  rulesDirty: boolean;
  rulesSaving: boolean;
  rulesSaveResult: ActionResult | null;
  onChangeRulesDraft: (value: string) => void;
  onSaveRules: () => void;
  onResetRules: () => void;

  // Skills, agents and configs are bundled with the app: read-only here, so they have no draft.

  // Skills
  skills: SkillSummary[];
  activeSkillId: string | null;
  activeSkillContent: DocumentContent | null;
  skillSearch: string;
  onSetSkillSearch: (value: string) => void;
  onSelectSkillPreview: (id: string) => void;
  /** Skill packs: those whose installed skills are kept while the pack cannot be read, and the way to forget one. */
  packLibrary?: PackLibrary | null;
  onForgetPack?: (name: string) => void;

  // Agents
  agentSources: AgentMetadataResponse[];
  activeAgentId: string | null;
  activeAgentContent: AgentSourceContent | null;
  onSelectAgent: (id: string) => void;

  // Configs
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
}

function sourceCount(props: LibraryViewProps, type: LibrarySourceType): number | undefined {
  const count = (() => {
    switch (type) {
      case "docs": return props.docs.length;
      case "skills": return props.skills.length;
      case "agents": return props.agentSources.length;
      case "configs": return props.configTargets.length;
      default: return 0;
    }
  })();
  return count > 0 ? count : undefined;
}

/**
 * Library: [1] item list of the active source (with the source switcher), [2] the open item as one document
 * pane: the working copy rendered, or its source textarea while editing.
 *
 * The preview/edit mode props (`docMode`, ...) stay in the contract with the controller; the pane keeps its
 * own view/edit state (below), which resets with the open item, so they are not needed.
 */
export function LibraryView(props: LibraryViewProps) {
  const { sourceType, onSetSourceType, dataFolderOk, showConfigs } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [docSearch, setDocSearch] = useState("");
  const [agentSearch, setAgentSearch] = useState("");
  const [focusRequest, setFocusRequest] = useState<string | null>(null);

  const entry = buildEntry(props);
  const followCursor = !(entry?.dirty ?? false);

  // Edit mode belongs to one open item: switching to another (or to none) returns to the rendered view.
  const [editingId, setEditingId] = useState<string | null>(null);
  const entryId = entry?.id ?? null;
  if (editingId !== null && editingId !== entryId) setEditingId(null);
  const editing = entry !== null && !entry.readOnly && editingId === entry.id;

  const sources: LibrarySourceTab[] = SOURCE_TYPES
    .filter(source => source.id !== "configs" || showConfigs)
    .map(source => ({ ...source, count: sourceCount(props, source.id) }));
  const activeSource = SOURCE_TYPES.find(source => source.id === sourceType) ?? SOURCE_TYPES[0]!;
  const activeCount = sourceCount(props, sourceType);

  const startEdit = () => {
    if (!entry || entry.readOnly) return;
    // Already in edit mode (focus was elsewhere): there is no mode change for the effect below to follow.
    if (textareaRef.current) textareaRef.current.focus();
    else setEditingId(entry.id);
  };
  const stopEdit = () => setEditingId(null);

  // Entering edit mode puts the cursor in the textarea; leaving it hands focus back to the rendered pane,
  // unless focus already went somewhere on purpose (`:q` sends it to the list).
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (editing) textareaRef.current?.focus();
    else if (wasEditing.current) {
      const active = document.activeElement;
      if (!active || active === document.body) focusPaneById("editor", rootRef.current ?? document);
    }
    wasEditing.current = editing;
  }, [editing]);

  useStatusContext(activeSource.label);
  const { close } = useLibraryKeys({
    rootRef,
    textareaRef,
    entry,
    sourceType,
    sourceIds: sources.map(source => source.id),
    dataFolderOk,
    onSetSourceType,
    showCreateDoc: props.showCreateDoc,
    onSetShowCreateDoc: props.onSetShowCreateDoc,
    startEdit,
    stopEdit,
  });

  // Switching source replaces the list, which takes focus with it: put it back on the new list.
  const previousSource = useRef(sourceType);
  useEffect(() => {
    if (previousSource.current === sourceType) return;
    previousSource.current = sourceType;
    const active = document.activeElement;
    if (!active || active === document.body) focusPaneById("items", rootRef.current ?? document);
  }, [sourceType]);

  // Enter on a row opens it and moves into it once that item has loaded: the textarea for an editable item,
  // the rendered document for a read-only one.
  const entryKey = entry?.listKey ?? null;
  useEffect(() => {
    if (focusRequest === null) return;
    if (entry && entryKey === focusRequest) {
      if (entry.readOnly) focusPaneById("editor", rootRef.current ?? document);
      else startEdit();
      setFocusRequest(null);
      return;
    }
    const timer = setTimeout(() => setFocusRequest(null), FOCUS_REQUEST_MS);
    return () => clearTimeout(timer);
  }, [focusRequest, entryKey]);

  const onActivate = (key: string) => {
    setFocusRequest(key);
  };

  let list: React.ReactNode;
  switch (sourceType) {
    case "docs":
      list = (
        <DocItemList
          docs={props.docs}
          activeKey={props.activeDoc?.id ?? null}
          followCursor={followCursor}
          onSelect={props.onSelectDoc}
          onActivate={onActivate}
          search={docSearch}
          onSearchChange={setDocSearch}
          activateHint={entry && !entry.readOnly ? "edit" : "read"}
        />
      );
      break;
    case "rules":
      list = (
        <RulesItemList
          agentTemplate={props.agentTemplate}
          rulesFiles={dataFolderOk ? props.rulesFiles : []}
          activeKey={
            props.activeRulesSurface !== null
              ? rulesFileKey(props.activeRulesSurface)
              : props.agentTemplate
                ? RULES_LIST_KEY
                : null
          }
          followCursor={followCursor}
          onSelect={props.onSelectRulesFile}
          onActivate={onActivate}
          activateHint={entry && !entry.readOnly ? "edit" : "read"}
        />
      );
      break;
    case "skills":
      list = (
        <SkillItemList
          skills={props.skills}
          activeKey={props.activeSkillId}
          followCursor={followCursor}
          onSelect={props.onSelectSkillPreview}
          onActivate={onActivate}
          search={props.skillSearch}
          onSearchChange={props.onSetSkillSearch}
        />
      );
      break;
    case "agents":
      list = (
        <AgentItemList
          agents={props.agentSources}
          activeKey={props.activeAgentId}
          followCursor={followCursor}
          onSelect={props.onSelectAgent}
          onActivate={onActivate}
          search={agentSearch}
          onSearchChange={setAgentSearch}
        />
      );
      break;
    case "configs":
      list = (
        <ConfigItemList
          configTargets={props.configTargets}
          activeTargetId={props.activeConfigTargetId}
          configEditorSources={props.configEditorSources}
          activeSourceType={props.activeConfigSourceType}
          followCursor={followCursor}
          onSelectTarget={props.onSelectConfigTarget}
          onSelectSource={props.onSelectConfigSource}
          onActivate={onActivate}
        />
      );
      break;
  }

  // Opening the form from `n` or its status-bar hint puts the cursor in its title field.
  const createForm =
    sourceType === "docs" && props.showCreateDoc ? (
      <CreateDocForm
        title={props.createDocTitle}
        slug={props.createDocSlug}
        error={props.createDocError}
        creating={props.createDocCreating}
        onSetShow={props.onSetShowCreateDoc}
        onSetTitle={props.onSetCreateDocTitle}
        onSetSlug={props.onSetCreateDocSlug}
        onCreate={props.onCreateDoc}
      />
    ) : undefined;

  return (
    <div className="screen library" ref={rootRef}>
      <Pane
        id="items"
        label="Library items"
        title={activeSource.label}
        meta={activeCount !== undefined ? `· ${activeCount}` : undefined}
        defaultFocus
        bodyClassName="lib-list-body"
      >
        <SourceSwitcher
          sources={sources}
          activeId={sourceType}
          onSelect={type => void onSetSourceType(type)}
        />
        {sourceType === "skills" && props.onForgetPack && (
          <PackNotice library={props.packLibrary ?? null} onForgetPack={props.onForgetPack} />
        )}
        {list}
      </Pane>

      <DocumentPane
        entry={entry}
        emptyHint={
          sourceType === "configs" && props.activeConfigTargetId === "opencode_config"
            ? "Loading config source…"
            : emptyStateHint(sourceType)
        }
        editing={editing}
        textareaRef={textareaRef}
        top={createForm}
        onClose={close}
      />
    </div>
  );
}
