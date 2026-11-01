import type { ActionResult } from "../../components/TerminalOutput";
import { displayPath } from "../../lib/displayPath";
import { isPersonalDoc } from "../../lib/libraryDirtyGuards";
import { PACK_STATE_LABEL } from "../../lib/packSkills";
import { CONFLICT_TEXT, harnessOfRulesSurface } from "../../lib/rulesView";
import type { InstallAgent, RulesFileContent } from "../../types";
import type { KvItem } from "../../ui/Kv";
import type { Tone } from "../../ui/tone";
import type { LibraryViewProps } from "../LibraryView";
import { isImportedSkill, isPersonalSkill } from "../../lib/packSkills";
import { provenanceText } from "./skillImport";
import type { OpenTarget, RowTagKind } from "./model";

export type LibraryPreviewKind = "markdown" | "json";

/** Why a bundled item cannot be edited (the sheet's reason line). The maintainer ships changes. */
export const BUNDLED_READ_ONLY_REASON = "bundled with the app: read-only here";

/** Why a pack skill cannot be edited here: it is the user's file, in the pack folder. */
export const PACK_READ_ONLY_REASON = "from a skill pack: read-only here, edit it in the pack folder";

/** Why an imported skill cannot be edited here: the import stays as it was previewed. */
export const IMPORTED_READ_ONLY_REASON = "imported: read-only here; Edit as my copy to change it";

/**
 * The one item open in the sheet, normalised across topics so the sheet does not care whether it is a doc, a
 * rules file, a skill, an agent source or a config source.
 */
export interface LibraryEntry {
  kind: OpenTarget["kind"];
  /** Identity of the loaded item; the textarea remounts when it changes. */
  id: string;
  title: string;
  /** Where the item lives, mono, under the title. */
  path: string;
  tag: RowTagKind;
  /** Accessible name of the textarea. */
  editorLabel: string;
  /** Content as saved on disk. */
  saved: string;
  /** Working copy: the textarea's value, and what the read-only view shows. */
  draft: string;
  dirty: boolean;
  saving: boolean;
  saveResult: ActionResult | null;
  readOnly: boolean;
  /** Why the item cannot be edited here. */
  readOnlyReason: string | null;
  preview: LibraryPreviewKind;
  metaTitle: string | null;
  meta: KvItem[];
  /** A rules file of the user's: the sheet shows the modes, or the conflict card. */
  rules?: { file: RulesFileContent; harness: InstallAgent | null; conflict: boolean };
  /** A bundled skill's name or an imported skill's id: "Edit as my copy" starts from it. */
  copySkill?: string;
  /** Plain words in the footer of an editable item (what Update does with the saved text). */
  footNote?: string;
  onChange: (value: string) => void;
  onSave: () => unknown;
  onReset: () => void;
  /** Opens the item in the external editor; null for items that are not handed to an editor. */
  onOpen: (() => void) | null;
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

/** The read-only part of every entry: no draft, nothing to save. */
function readOnlyEntry(
  base: Pick<LibraryEntry, "kind" | "id" | "title" | "path" | "tag" | "editorLabel" | "preview" | "metaTitle" | "meta"> &
    Partial<Pick<LibraryEntry, "readOnlyReason" | "copySkill">>,
  content: string,
): LibraryEntry {
  return {
    readOnlyReason: BUNDLED_READ_ONLY_REASON,
    ...base,
    saved: content,
    draft: content,
    dirty: false,
    saving: false,
    saveResult: null,
    readOnly: true,
    onChange: noop,
    onSave: noop,
    onReset: noop,
    onOpen: null,
  };
}

function docEntry(props: LibraryViewProps, id: string): LibraryEntry | null {
  const doc = props.activeDoc;
  if (!doc || doc.id !== id) return null;
  const personal = isPersonalDoc(doc);
  const path = displayPath(doc.path);
  if (!personal) {
    return readOnlyEntry(
      { kind: "doc", id: doc.id, title: doc.title, path, tag: "riggverk", editorLabel: "Document", preview: "markdown", metaTitle: null, meta: [] },
      doc.content,
    );
  }
  return {
    kind: "doc",
    id: doc.id,
    title: doc.title,
    path,
    tag: "yours",
    editorLabel: "Edit document",
    saved: doc.content,
    draft: props.docDraft,
    dirty: props.docDirty,
    saving: props.docSaving,
    saveResult: props.docSaveResult,
    readOnly: false,
    readOnlyReason: null,
    preview: "markdown",
    metaTitle: null,
    meta: [],
    onChange: props.onChangeDocDraft,
    onSave: props.onSaveDoc,
    onReset: props.onResetDoc,
    onOpen: () => props.onOpenDoc(doc.id),
  };
}

function rulesFileEntry(props: LibraryViewProps, surface: string): LibraryEntry | null {
  const file = props.activeRulesFile;
  if (!file || file.surface !== surface || props.activeRulesSurface !== surface || !props.dataFolderOk) return null;
  const conflict = file.conflict !== null;
  const editable = file.editable && !conflict;
  return {
    kind: "rules",
    id: `rules:${file.surface}`,
    title: file.label,
    path: file.file,
    tag: "yours",
    editorLabel: "Refinements",
    saved: file.refinements,
    draft: props.rulesDraft,
    dirty: props.rulesDirty,
    saving: props.rulesSaving,
    saveResult: props.rulesSaveResult,
    readOnly: !editable,
    readOnlyReason: editable ? null : conflict ? CONFLICT_TEXT[file.conflict!] : file.reason ?? "read-only",
    preview: "markdown",
    metaTitle: null,
    meta: [],
    rules: { file, harness: harnessOfRulesSurface(file.surface), conflict },
    onChange: props.onChangeRulesDraft,
    onSave: props.onSaveRules,
    onReset: props.onResetRules,
    // The user's own file: the editor opens it to change what the Library does not (the text above the block).
    onOpen: file.layout === "absent" ? null : () => props.onOpenRulesFile(file.surface),
  };
}

function baseEntry(props: LibraryViewProps): LibraryEntry | null {
  const template = props.agentTemplate;
  if (!template || props.activeRulesSurface !== null) return null;
  const targets = props.agentTargets.filter(target => target.kind === "rules");
  return readOnlyEntry(
    {
      kind: "base",
      id: template.id,
      title: "Managed base",
      path: displayPath(template.path),
      tag: "riggverk",
      editorLabel: "Agent rules template",
      preview: "markdown",
      metaTitle: "installs to",
      meta: targets.map(target => ({ id: target.id, label: target.label, value: target.target_rel })),
      readOnlyReason: `${BUNDLED_READ_ONLY_REASON} · replaced on Update all`,
    },
    template.content,
  );
}

function skillEntry(props: LibraryViewProps, id: string): LibraryEntry | null {
  const content = props.activeSkillContent;
  if (!content || content.id !== id) return null;
  const skill = props.skills.find(candidate => candidate.id === content.id);
  const meta: KvItem[] = [];
  if (skill?.description) meta.push({ label: "description", value: skill.description, wrap: true });
  if (skill?.category) meta.push({ label: "category", value: skill.category });
  if (skill?.risk) meta.push({ label: "risk", value: skill.risk, tone: riskTone(skill.risk) });
  if (skill?.packState) {
    meta.push({ label: "pack", value: skill.group });
    if (skill.provenance) meta.push({ label: "source", value: provenanceText(skill.provenance), wrap: true });
    if (skill.packState !== "active") {
      meta.push({ label: "state", value: PACK_STATE_LABEL[skill.packState], tone: "warn" });
      if (skill.packReason) meta.push({ label: "why", value: skill.packReason, wrap: true });
    }
    // The rendered body leaves the frontmatter out, and Install copies it byte for byte: name what acts without asking.
    skill.privileged?.forEach((key, index) =>
      meta.push({
        id: `privileged-${index}`,
        label: key.key,
        value: key.note ? `${key.value} · ${key.note}` : key.value,
        tone: key.note ? "warn" : undefined,
        wrap: true,
      }),
    );
  }
  if (skill) {
    meta.push(...listItems("targets", skill.targets), ...listItems("related", skill.related));
  }
  const fromPack = skill?.packState !== undefined || content.id.startsWith("pack:");
  const imported = isImportedSkill(content.id, skill);
  if (isPersonalSkill(content.id, skill)) {
    return {
      kind: "skill",
      id: content.id,
      title: content.title,
      path: displayPath(content.path),
      tag: "yours",
      editorLabel: "Edit skill",
      saved: content.content,
      draft: props.skillDraft,
      dirty: props.skillDirty,
      saving: props.skillSaving,
      saveResult: props.skillSaveResult,
      readOnly: false,
      readOnlyReason: null,
      preview: "markdown",
      metaTitle: "metadata",
      meta,
      footNote: "Update installs your saved copy",
      onChange: props.onChangeSkillDraft,
      onSave: props.onSaveSkill,
      onReset: props.onResetSkill,
      onOpen: null,
    };
  }
  return readOnlyEntry(
    {
      kind: "skill",
      id: content.id,
      title: content.title,
      path: displayPath(content.path),
      tag: fromPack ? "pack" : "riggverk",
      editorLabel: "Skill source",
      preview: "markdown",
      metaTitle: "metadata",
      meta,
      readOnlyReason: imported ? IMPORTED_READ_ONLY_REASON : fromPack ? PACK_READ_ONLY_REASON : BUNDLED_READ_ONLY_REASON,
      copySkill: imported ? content.id : fromPack ? undefined : skill?.name ?? content.title,
    },
    content.content,
  );
}

function agentEntry(props: LibraryViewProps, id: string): LibraryEntry | null {
  const content = props.activeAgentContent;
  if (!content || content.id !== id) return null;
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
  return readOnlyEntry(
    {
      kind: "agent",
      id: content.id,
      title: content.title,
      path: displayPath(content.path),
      tag: "riggverk",
      editorLabel: "Agent source",
      preview: "markdown",
      metaTitle: "metadata",
      meta: rows,
    },
    content.content,
  );
}

function configEntry(props: LibraryViewProps, targetId: string, sourceId: string | null): LibraryEntry | null {
  if (props.activeConfigTargetId !== targetId) return null;
  const isOpenCode = targetId === "opencode_config";
  if (isOpenCode && sourceId !== null && props.activeConfigSourceType !== sourceId) return null;
  const content = isOpenCode ? props.configEditorSourceContent : props.configTemplateContent;
  if (!content) return null;
  const target = props.configTargets.find(candidate => candidate.id === targetId);
  const source = props.configEditorSources.find(candidate => candidate.id === props.activeConfigSourceType);
  const sourcePath = source?.rel_path ?? target?.source_rel ?? "";
  const targetPath = target?.target_rel ?? "";
  // The backend names OpenCode's folder `$XDG_CONFIG_HOME/opencode` while that variable moves it.
  const openCodeDir = targetPath.startsWith("$XDG_CONFIG_HOME/") ? "$XDG_CONFIG_HOME/opencode" : "~/.config/opencode";
  const meta: KvItem[] = isOpenCode
    ? [
        { label: "source", value: "templates/opencode.base.json + templates/opencode.policy.json", wrap: true },
        { label: "snapshot", value: `templates/opencode.json → ${openCodeDir}/opencode.json`, wrap: true },
        { label: "tui", value: `templates/tui.json → ${openCodeDir}/tui.json`, wrap: true },
        { label: "agents", value: `agents/*.md → ${openCodeDir}/agents/*.md`, wrap: true },
        { label: "bundled", value: props.agentSources.length > 0 ? `${props.agentSources.length} agents` : "agents bundled" },
      ]
    : [];
  const title = isOpenCode && source ? `${target?.label ?? "Config"} · ${source.label}` : target?.label ?? "Config";
  return readOnlyEntry(
    {
      kind: "config",
      id: isOpenCode ? `opencode_config:${props.activeConfigSourceType}` : `template:${targetId}`,
      title,
      path: [sourcePath, targetPath ? `target: ${targetPath}` : ""].filter(Boolean).join(" · "),
      tag: "riggverk",
      editorLabel: "Config source",
      preview: "json",
      metaTitle: isOpenCode ? "bundle" : null,
      meta,
    },
    content.content,
  );
}

/** The entry for `target`, or null while its content has not loaded (or belongs to another item). */
export function buildEntry(props: LibraryViewProps, target: OpenTarget): LibraryEntry | null {
  switch (target.kind) {
    case "doc": return docEntry(props, target.id);
    case "rules": return rulesFileEntry(props, target.surface);
    case "base": return baseEntry(props);
    case "skill": return skillEntry(props, target.id);
    case "agent": return agentEntry(props, target.id);
    case "config": return configEntry(props, target.targetId, target.sourceId);
  }
}
