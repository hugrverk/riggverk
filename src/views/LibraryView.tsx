import { useEffect, useRef, useState } from "react";
import type { ActionResult } from "../components/TerminalOutput";
import { focusPaneById } from "../keyboard/focus";
import { useStatusContext } from "../shell/ShellState";
import { Pane } from "../ui/Pane";
import type {
  AgentMetadataResponse,
  AgentSourceContent,
  AgentTargetMeta,
  ConfigEditorSourceMeta,
  DocsHealth,
  DocSummary,
  DocumentContent,
  SkillSummary,
} from "../types";
import { AgentItemList } from "./library/AgentItemList";
import { BrainItemList } from "./library/BrainItemList";
import { BrainPane } from "./library/BrainPane";
import { ConfigItemList } from "./library/ConfigItemList";
import { CreateDocForm } from "./library/CreateDocForm";
import { DocItemList } from "./library/DocItemList";
import { EditorPane } from "./library/EditorPane";
import { buildEntry, emptyStateHint } from "./library/entry";
import { PreviewPane } from "./library/PreviewPane";
import { RULES_LIST_KEY, RulesItemList } from "./library/RulesItemList";
import { SkillItemList } from "./library/SkillItemList";
import { SourceSwitcher, type LibrarySourceTab } from "./library/SourceSwitcher";
import { useLibraryKeys } from "./library/useLibraryKeys";

export type LibrarySourceType = "docs" | "rules" | "skills" | "agents" | "configs" | "brain";

const SOURCE_TYPES: { id: LibrarySourceType; label: string; title: string }[] = [
  { id: "docs", label: "docs", title: "Docs" },
  { id: "rules", label: "rules", title: "Rules" },
  { id: "skills", label: "skills", title: "Skills" },
  { id: "agents", label: "agents", title: "Runtime agents" },
  { id: "configs", label: "configs", title: "Configs" },
  { id: "brain", label: "brain", title: "Brain Setup" },
];

/** A pending "move into the editor" request outlives the open item it waits for only this long. */
const FOCUS_REQUEST_MS = 2000;

export interface LibraryViewProps {
  sourceType: LibrarySourceType;
  onSetSourceType: (type: LibrarySourceType) => void;

  // Docs
  docs: DocSummary[];
  docsHealth: DocsHealth | null;
  onGoToWorkspaceRepair: () => void;
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

  // Rules
  agentTemplate: DocumentContent | null;
  onOpenTemplate: () => void;
  agentTemplateDraft: string;
  agentTemplateDirty: boolean;
  agentTemplateSaving: boolean;
  agentTemplateSaveResult: ActionResult | null;
  agentTemplateMode: "preview" | "edit";
  onSetAgentTemplateMode: (mode: "preview" | "edit") => void;
  onChangeAgentTemplateDraft: (value: string) => void;
  onSaveAgentTemplate: () => void;
  onResetAgentTemplate: () => void;
  agentTargets: AgentTargetMeta[];

  // Skills
  skills: SkillSummary[];
  activeSkillId: string | null;
  activeSkillContent: DocumentContent | null;
  skillSearch: string;
  onSetSkillSearch: (value: string) => void;
  onSelectSkillPreview: (id: string) => void;
  onOpenSkill: (id: string) => void;

  // Agents
  agentSources: AgentMetadataResponse[];
  activeAgentId: string | null;
  activeAgentContent: AgentSourceContent | null;
  onSelectAgent: (id: string) => void;
  onOpenAgent: (id: string) => void;
  agentDraft: string;
  agentDirty: boolean;
  agentSaving: boolean;
  agentSaveResult: ActionResult | null;
  agentMode: "preview" | "edit";
  onSetAgentMode: (mode: "preview" | "edit") => void;
  onChangeAgentDraft: (value: string) => void;
  onSaveAgent: () => void;
  onResetAgent: () => void;

  // Configs
  configTemplateContent: DocumentContent | null;
  activeConfigTargetId: string;
  configTargets: AgentTargetMeta[];
  onSelectConfigTarget: (targetId: string) => void;
  onOpenConfig: () => void;
  configDraft: string;
  configDirty: boolean;
  configSaving: boolean;
  configSaveResult: ActionResult | null;
  configMode: "preview" | "edit";
  onSetConfigMode: (mode: "preview" | "edit") => void;
  onChangeConfigDraft: (value: string) => void;
  onSaveConfig: () => void;
  onResetConfig: () => void;
  configEditorSources: ConfigEditorSourceMeta[];
  activeConfigSourceType: string;
  onSelectConfigSource: (sourceType: string) => void;
  configEditorSourceSaveMessage: string;
  configEditorSourceContent: DocumentContent | null;

  // Brain Setup
  brainSetupText: string;
  brainSetupSource: string;

  // Common
  workspaceValid: boolean;
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
 * Library: [1] item list of the active source (with the source switcher), [2] editor, [3] preview of the
 * working copy. Brain Setup has no editor, so it is a list plus one copy-block pane.
 *
 * The preview/edit mode props (`docMode`, ...) stay in the contract with the controller; the panes no
 * longer need them because the preview is always on and the editor is a pane of its own.
 */
export function LibraryView(props: LibraryViewProps) {
  const { sourceType, onSetSourceType, workspaceValid, showConfigs } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [docSearch, setDocSearch] = useState("");
  const [agentSearch, setAgentSearch] = useState("");
  const [focusRequest, setFocusRequest] = useState<string | null>(null);

  const entry = buildEntry(props);
  const isBrain = sourceType === "brain";
  const followCursor = !(entry?.dirty ?? false);

  const sources: LibrarySourceTab[] = SOURCE_TYPES
    .filter(source => source.id !== "configs" || showConfigs)
    .map(source => ({ ...source, count: sourceCount(props, source.id) }));
  const activeSource = SOURCE_TYPES.find(source => source.id === sourceType) ?? SOURCE_TYPES[0]!;
  const activeCount = sourceCount(props, sourceType);

  useStatusContext(activeSource.label);
  const { close } = useLibraryKeys({
    rootRef,
    textareaRef,
    entry,
    sourceType,
    sourceIds: sources.map(source => source.id),
    workspaceValid,
    onSetSourceType,
    showCreateDoc: props.showCreateDoc,
    onSetShowCreateDoc: props.onSetShowCreateDoc,
  });

  // Switching source replaces the list, which takes focus with it: put it back on the new list.
  const previousSource = useRef(sourceType);
  useEffect(() => {
    if (previousSource.current === sourceType) return;
    previousSource.current = sourceType;
    const active = document.activeElement;
    if (!active || active === document.body) focusPaneById("items", rootRef.current ?? document);
  }, [sourceType]);

  // Enter on a row opens it and moves into the editor once that item has loaded.
  const entryKey = entry?.listKey ?? null;
  useEffect(() => {
    if (focusRequest === null) return;
    if (entryKey === focusRequest && textareaRef.current) {
      textareaRef.current.focus();
      setFocusRequest(null);
      return;
    }
    const timer = setTimeout(() => setFocusRequest(null), FOCUS_REQUEST_MS);
    return () => clearTimeout(timer);
  }, [focusRequest, entryKey]);

  const onActivate = (key: string) => {
    if (isBrain) {
      focusPaneById("editor", rootRef.current ?? document);
      return;
    }
    setFocusRequest(key);
  };

  let list: React.ReactNode;
  switch (sourceType) {
    case "docs":
      list = (
        <DocItemList
          docs={props.docs}
          docsHealth={props.docsHealth}
          workspaceValid={workspaceValid}
          activeKey={props.activeDoc?.id ?? null}
          followCursor={followCursor}
          onSelect={props.onSelectDoc}
          onActivate={onActivate}
          onGoToWorkspaceRepair={props.onGoToWorkspaceRepair}
          search={docSearch}
          onSearchChange={setDocSearch}
        />
      );
      break;
    case "rules":
      list = (
        <RulesItemList
          agentTemplate={props.agentTemplate}
          activeKey={props.agentTemplate ? RULES_LIST_KEY : null}
          followCursor={followCursor}
          onActivate={onActivate}
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
    case "brain":
      list = (
        <BrainItemList
          brainSetupSource={props.brainSetupSource}
          workspaceValid={workspaceValid}
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
    <div className={isBrain ? "screen library library-pair" : "screen library"} ref={rootRef}>
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
        {list}
      </Pane>

      {isBrain ? (
        <BrainPane
          workspaceValid={workspaceValid}
          brainSetupText={props.brainSetupText}
          brainSetupSource={props.brainSetupSource}
        />
      ) : (
        <>
          <EditorPane
            entry={entry}
            emptyHint={
              sourceType === "configs" && props.activeConfigTargetId === "opencode_config" && workspaceValid
                ? "Loading config source..."
                : emptyStateHint(sourceType, workspaceValid)
            }
            textareaRef={textareaRef}
            top={createForm}
            onClose={close}
          />
          <PreviewPane entry={entry} />
        </>
      )}
    </div>
  );
}
