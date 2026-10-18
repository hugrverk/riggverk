import type { ActionResult } from "../../components/TerminalOutput";
import { displayPath } from "../../lib/displayPath";
import type { Tone } from "../../ui/tone";
import type { KvItem } from "../../ui/Kv";
import type { LibrarySourceType, LibraryViewProps } from "../LibraryView";
import { configListKey } from "./ConfigItemList";
import { RULES_LIST_KEY } from "./RulesItemList";

export type LibraryPreviewKind = "markdown" | "json";

/**
 * The one item open in the document pane, normalised across sources so the pane does not care whether it is
 * a doc, a rules template, a skill, an agent source or a config source.
 */
export interface LibraryEntry {
  source: LibrarySourceType;
  /** Identity of the loaded item; the textarea remounts and edit mode ends when it changes. */
  id: string;
  /** Key of the list row that opens this item (compared with the row a user asks to edit). */
  listKey: string;
  title: string;
  /** Where the item lives, as shown in the pane title. */
  path: string;
  /** The single path "Copy path" puts on the clipboard. */
  copyPath: string;
  /** Accessible name of the textarea. */
  editorLabel: string;
  /** Content as saved on disk. */
  saved: string;
  /** Working copy: the textarea's value, and what the rendered view shows. */
  draft: string;
  dirty: boolean;
  saving: boolean;
  saveResult: ActionResult | null;
  saveMessage: string;
  readOnly: boolean;
  /** Why the item cannot be edited here (pane footer, disabled edit hint). */
  readOnlyReason: string | null;
  /** Footer note about what a save touches ("template only"). */
  note: string | null;
  preview: LibraryPreviewKind;
  metaTitle: string | null;
  meta: KvItem[];
  onChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
  onOpen: () => void;
}

const noop = () => {};

export function riskTone(risk: string): Tone | undefined {
  switch (risk.toLowerCase()) {
    case "low": return "ok";
    case "medium": return "warn";
    case "high": return "fail";
    default: return undefined;
  }
}

function listItems(label: string, values: readonly string[]): KvItem[] {
  return values.length > 0 ? [{ label, value: values.join(", "), wrap: true }] : [];
}

function docEntry(props: LibraryViewProps): LibraryEntry | null {
  const doc = props.activeDoc;
  if (!doc) return null;
  return {
    source: "docs",
    id: doc.id,
    listKey: doc.id,
    title: doc.title,
    path: displayPath(doc.path),
    copyPath: displayPath(doc.path),
    editorLabel: "Edit document",
    saved: doc.content,
    draft: props.docDraft,
    dirty: props.docDirty,
    saving: props.docSaving,
    saveResult: props.docSaveResult,
    saveMessage: "",
    readOnly: false,
    readOnlyReason: null,
    note: null,
    preview: "markdown",
    metaTitle: null,
    meta: [],
    onChange: props.onChangeDocDraft,
    onSave: props.onSaveDoc,
    onReset: props.onResetDoc,
    onOpen: () => props.onOpenDoc(doc.id),
  };
}

function rulesEntry(props: LibraryViewProps): LibraryEntry | null {
  const template = props.agentTemplate;
  if (!template) return null;
  const targets = props.agentTargets.filter(target => target.kind === "rules");
  return {
    source: "rules",
    id: template.id,
    listKey: RULES_LIST_KEY,
    title: "Global Rules",
    path: displayPath(template.path),
    copyPath: displayPath(template.path),
    editorLabel: "Edit agent rules template",
    saved: template.content,
    draft: props.agentTemplateDraft,
    dirty: props.agentTemplateDirty,
    saving: props.agentTemplateSaving,
    saveResult: props.agentTemplateSaveResult,
    saveMessage: "",
    readOnly: false,
    readOnlyReason: null,
    note: "template only",
    preview: "markdown",
    metaTitle: "installs to",
    meta: targets.map(target => ({ id: target.id, label: target.label, value: target.target_rel })),
    onChange: props.onChangeAgentTemplateDraft,
    onSave: props.onSaveAgentTemplate,
    onReset: props.onResetAgentTemplate,
    onOpen: props.onOpenTemplate,
  };
}

function skillEntry(props: LibraryViewProps): LibraryEntry | null {
  const content = props.activeSkillContent;
  if (!content) return null;
  const skill = props.skills.find(candidate => candidate.id === content.id);
  const meta: KvItem[] = [];
  if (skill?.description) meta.push({ label: "description", value: skill.description, wrap: true });
  if (skill?.category) meta.push({ label: "category", value: skill.category });
  if (skill?.risk) meta.push({ label: "risk", value: skill.risk, tone: riskTone(skill.risk) });
  if (skill) {
    meta.push(...listItems("targets", skill.targets), ...listItems("related", skill.related));
  }
  return {
    source: "skills",
    id: content.id,
    listKey: content.id,
    title: content.title,
    path: displayPath(content.path),
    copyPath: displayPath(content.path),
    editorLabel: "Skill source",
    saved: content.content,
    draft: content.content,
    dirty: false,
    saving: false,
    saveResult: null,
    saveMessage: "",
    readOnly: true,
    readOnlyReason: "skills are edited as files: open it in your editor",
    note: null,
    preview: "markdown",
    metaTitle: "metadata",
    meta,
    onChange: noop,
    onSave: noop,
    onReset: noop,
    onOpen: () => props.onOpenSkill(content.id),
  };
}

function agentEntry(props: LibraryViewProps): LibraryEntry | null {
  const content = props.activeAgentContent;
  if (!content) return null;
  const meta = props.agentSources.find(source => source.id === content.id)?.metadata ?? null;
  const rows: KvItem[] = [];
  if (meta) {
    if (meta.role) rows.push({ label: "role", value: meta.role });
    if (meta.summary) rows.push({ label: "summary", value: meta.summary, wrap: true });
    if (meta.risk) rows.push({ label: "risk", value: meta.risk, tone: riskTone(meta.risk) });
    rows.push(...listItems("targets", meta.targets), ...listItems("default skills", meta.default_skills));
    if (!meta.safe_to_edit_runtime) {
      rows.push({ label: "edit safety", value: "runtime-sensitive: edit with care", tone: "warn", wrap: true });
    }
    meta.notes.forEach((note, index) => rows.push({ id: `note-${index}`, label: index === 0 ? "notes" : "", value: note, wrap: true }));
  }
  return {
    source: "agents",
    id: content.id,
    listKey: content.id,
    title: content.title,
    path: displayPath(content.path),
    copyPath: displayPath(content.path),
    editorLabel: "Edit agent source",
    saved: content.content,
    draft: props.agentDraft,
    dirty: props.agentDirty,
    saving: props.agentSaving,
    saveResult: props.agentSaveResult,
    saveMessage: "",
    readOnly: !content.exists,
    readOnlyReason: content.exists ? null : "not in workspace: nothing to save yet",
    note: "workspace source",
    preview: "markdown",
    metaTitle: "metadata",
    meta: rows,
    onChange: props.onChangeAgentDraft,
    onSave: props.onSaveAgent,
    onReset: props.onResetAgent,
    onOpen: () => props.onOpenAgent(content.id),
  };
}

function configEntry(props: LibraryViewProps): LibraryEntry | null {
  const isOpenCode = props.activeConfigTargetId === "opencode_config";
  const content = isOpenCode ? props.configEditorSourceContent : props.configTemplateContent;
  if (!content) return null;
  const target = props.configTargets.find(candidate => candidate.id === props.activeConfigTargetId);
  const source = props.configEditorSources.find(candidate => candidate.id === props.activeConfigSourceType);
  const sourcePath = source?.rel_path ?? target?.source_rel ?? "";
  const targetPath = target?.target_rel ?? "";
  // Only opencode_config has a save path; every other target is a template preview.
  const readOnly = !isOpenCode || (source ? !source.editable : false);
  let readOnlyReason: string | null = null;
  if (readOnly) {
    if (!isOpenCode) readOnlyReason = "template preview";
    else if (props.activeConfigSourceType === "snapshot") readOnlyReason = "generated snapshot: edit Base or Policy instead";
    else readOnlyReason = source?.helper || "read-only source";
  }
  const meta: KvItem[] = isOpenCode
    ? [
        { label: "source", value: "templates/opencode.base.json + templates/opencode.policy.json", wrap: true },
        { label: "snapshot", value: "templates/opencode.json → ~/.config/opencode/opencode.json", wrap: true },
        { label: "tui", value: "templates/tui.json → ~/.config/opencode/tui.json", wrap: true },
        { label: "agents", value: "agents/*.md → ~/.config/opencode/agents/*.md", wrap: true },
        { label: "bundled", value: props.agentSources.length > 0 ? `${props.agentSources.length} agents` : "agents bundled" },
      ]
    : [];
  return {
    source: "configs",
    id: isOpenCode ? `opencode_config:${props.activeConfigSourceType}` : `template:${props.activeConfigTargetId}`,
    listKey: configListKey(props.activeConfigTargetId, props.activeConfigSourceType, isOpenCode && props.configEditorSources.length > 0),
    title: target?.label ?? "Config",
    path: [sourcePath, targetPath ? `target: ${targetPath}` : ""].filter(Boolean).join(" · "),
    copyPath: sourcePath || targetPath,
    editorLabel: "Edit config source",
    saved: content.content,
    draft: readOnly ? content.content : props.configDraft,
    dirty: props.configDirty,
    saving: props.configSaving,
    saveResult: props.configSaveResult,
    saveMessage: props.configEditorSourceSaveMessage,
    readOnly,
    readOnlyReason,
    note: null,
    preview: "json",
    metaTitle: isOpenCode ? "bundle" : null,
    meta,
    onChange: props.onChangeConfigDraft,
    onSave: props.onSaveConfig,
    onReset: props.onResetConfig,
    onOpen: props.onOpenConfig,
  };
}

export function buildEntry(props: LibraryViewProps): LibraryEntry | null {
  switch (props.sourceType) {
    case "docs": return docEntry(props);
    case "rules": return rulesEntry(props);
    case "skills": return skillEntry(props);
    case "agents": return agentEntry(props);
    case "configs": return configEntry(props);
  }
}

/** Text shown in the document pane while no item is open. */
export function emptyStateHint(source: LibrarySourceType, workspaceValid: boolean): string {
  if (!workspaceValid) return "No valid workspace selected";
  switch (source) {
    case "docs": return "Select a document to preview";
    case "rules": return "Rules template is loading";
    case "skills": return "Select a skill to preview";
    case "agents": return "Select an agent to preview";
    case "configs": return "Select a config target to preview";
  }
}
