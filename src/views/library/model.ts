import { displayPath } from "../../lib/displayPath";
import { dataFolderUnknownSentence, type DataFolderVerdict } from "../../lib/installationView";
import { isPersonalDoc } from "../../lib/libraryDirtyGuards";
import { IMPORTED_PACK, isImportedSkill, isPersonalSkill, packGroup, packNoticeLines, type PackNoticeLine } from "../../lib/packSkills";
import { harnessOfRulesSurface } from "../../lib/rulesView";
import { HARNESS_LABELS } from "../../lib/harnessInstallation";
import type { UiState } from "../../lib/uiState";
import type {
  AgentMetadataResponse,
  AgentTargetMeta,
  AnswerStyleChoice,
  AnswerStyleLevel,
  CommentPolicyChoice,
  CommentPolicyLevel,
  ConfigEditorSourceMeta,
  DocSummary,
  InstallAgent,
  PackLibrary,
  RulesFileSummary,
  RulesSurfaceId,
  SkillChoices,
  SkillSummary,
} from "../../types";

/** The Library's topics, in tab order. */
export type LibrarySourceType = "rules" | "skills" | "agents" | "docs" | "configs" | "packs";

export const LIBRARY_TOPICS: readonly { id: LibrarySourceType; label: string }[] = [
  { id: "rules", label: "Rules" },
  { id: "skills", label: "Skills" },
  { id: "agents", label: "Agents" },
  { id: "docs", label: "Docs" },
  { id: "configs", label: "Configs" },
  { id: "packs", label: "Packs" },
];

/** What a row opens in the sheet. */
export type OpenTarget =
  | { kind: "doc"; id: string }
  | { kind: "rules"; surface: RulesSurfaceId }
  | { kind: "base" }
  | { kind: "skill"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "config"; targetId: string; sourceId: string | null };

/** Identity of a row's open target: row keys, focus return and "is this the open item". */
export function targetKey(target: OpenTarget): string {
  switch (target.kind) {
    case "doc": return `doc:${target.id}`;
    case "rules": return `rules:${target.surface}`;
    case "base": return "rules:base";
    case "skill": return `skill:${target.id}`;
    case "agent": return `agent:${target.id}`;
    case "config": return `config:${target.targetId}:${target.sourceId ?? ""}`;
  }
}

export type RowAction =
  | { type: "open"; target: OpenTarget }
  /** Opens the page of a harness (the conflict is decided there). */
  | { type: "harness"; harness: InstallAgent }
  /** "Edit as my copy": `skill` is a bundled skill's name or an imported skill's id. */
  | { type: "copy"; skill: string }
  | { type: "forget"; pack: string }
  | { type: "routing"; name: string }
  | { type: "remove-import"; name: string }
  | { type: "undo-import" }
  /** Disables (asks first) or enables a skill for every harness. */
  | { type: "disable"; name: string }
  | { type: "enable"; name: string }
  /** Chooses how much agents comment code, for every harness. */
  | { type: "comment-policy"; level: CommentPolicyLevel }
  /** Chooses how agents word their answers, for every harness. */
  | { type: "answer-style"; level: AnswerStyleLevel };

export interface RowVerb {
  label: string;
  action: RowAction;
}

export type RowTagKind = "yours" | "riggverk" | "pack";

export interface LibraryRow {
  key: string;
  name: string;
  /** One line of what it is. */
  desc?: string;
  /** Mono, for a file location. Shown when there is no description. */
  path?: string;
  tag?: { kind: RowTagKind; label: string };
  /** A second, plain tag after the name ("shadowed · bundle wins"). */
  note?: string;
  /** The state ring, or the filled square for `decide`; `label` is its word. */
  state?: { state: UiState; label: string };
  indent?: boolean;
  verbs: RowVerb[];
  /** Lower-case text the search looks in. */
  haystack: string;
}

export type GroupActionId = "new-doc" | "import-skill";

export interface LibraryGroup {
  key: string;
  label: string;
  /** Muted words after the label. */
  hint?: string;
  /** A button in the group header. */
  action?: { label: string; id: GroupActionId };
  rows: LibraryRow[];
  /** Shown instead of the rows while there are none (never in search results). */
  empty?: string;
  /** A location shown beside `empty`, in mono (the packs folder). */
  emptyPath?: string;
  /** Plain lines above the rows (pack problems). */
  notes?: PackNoticeLine[];
  /** What the notes are about, for assistive technology; pack problems when absent. */
  notesLabel?: string;
}

export interface LibraryModelInput {
  dataFolderOk: boolean;
  dataFolderVerdict?: DataFolderVerdict;
  docs: DocSummary[];
  agentTemplateLoaded: boolean;
  rulesFiles: RulesFileSummary[];
  skills: SkillSummary[];
  agentSources: AgentMetadataResponse[];
  configTargets: AgentTargetMeta[];
  configEditorSources: ConfigEditorSourceMeta[];
  packLibrary: PackLibrary | null;
  packError: string | null;
  /** The disabled skills and which skills name which; null while they could not be listed. */
  skillChoices?: SkillChoices | null;
  /** Bundled and active pack skills offer Disable, disabled ones Enable. */
  canToggleSkills?: boolean;
  /** The bundled skill rows offer "Edit as my copy". */
  canCopySkill: boolean;
  /** A pack that cannot be read offers "Forget pack". */
  canForgetPack: boolean;
  /** A rules conflict offers "Open <harness> page ›". */
  canOpenHarness: boolean;
  /** The Packs group offers "Import skill…", and imported skills "Remove import" and "Undo import". */
  canImportSkill: boolean;
  /** The comment policy; null while it could not be read (the group is then left out). */
  commentPolicy?: CommentPolicyChoice | null;
  /** The levels the comment policy is not at offer "Use". */
  canSetCommentPolicy?: boolean;
  /** The answer style; null while it could not be read (the group is then left out). */
  answerStyle?: AnswerStyleChoice | null;
  /** The levels the answer style is not at offer "Use". */
  canSetAnswerStyle?: boolean;
}

const SHADOWED_TEXT = "A bundled skill has this name, so the bundle wins. Rename it in the pack to use it.";
export const PACK_FOLDER_UNREADABLE = "The pack folder cannot be read.";

function haystack(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

export function isRulesConflict(file: RulesFileSummary): boolean {
  return file.conflict !== null;
}

function rulesRow(file: RulesFileSummary, input: Pick<LibraryModelInput, "canOpenHarness">): LibraryRow {
  const harness = harnessOfRulesSurface(file.surface);
  const target: OpenTarget = { kind: "rules", surface: file.surface };
  const common = { key: targetKey(target), name: file.label, tag: { kind: "yours" as const, label: "yours" } };
  const search = haystack(file.label, file.file, "rules", harness ?? undefined);
  if (isRulesConflict(file)) {
    return {
      ...common,
      path: file.file,
      state: { state: "decide", label: "Needs your decision" },
      verbs: [
        { label: "View", action: { type: "open", target } },
        ...(harness && input.canOpenHarness ? [{ label: `Open ${HARNESS_LABELS[harness]} page ›`, action: { type: "harness", harness } as RowAction }] : []),
      ],
      haystack: search,
    };
  }
  if (!file.editable) {
    return {
      ...common,
      desc: file.reason ?? undefined,
      path: file.file,
      state: { state: "off", label: "Not editable here" },
      verbs: [{ label: "View", action: { type: "open", target } }],
      haystack: search,
    };
  }
  const hasRefinements = file.refinement_lines > 0;
  return {
    ...common,
    path: file.file,
    state: hasRefinements
      ? { state: "yours", label: `${file.refinement_lines} refinement line${file.refinement_lines === 1 ? "" : "s"}` }
      : { state: "off", label: "No refinements" },
    verbs: [{ label: hasRefinements ? "Edit refinements" : "Add refinements", action: { type: "open", target } }],
    haystack: search,
  };
}

/** The comment policy's levels, in the order shown, each said in one line. */
export const COMMENT_POLICY_LEVELS: readonly { level: CommentPolicyLevel; name: string; desc: string }[] = [
  { level: "harness_default", name: "Harness default", desc: "Adds nothing: each agent keeps its own habits and your repositories' rules." },
  { level: "minimal", name: "Minimal", desc: "Comments only what the code cannot show, such as intent, an invariant or a workaround." },
  { level: "off", name: "Off", desc: "No new comments beyond what the language, tooling or repository requires." },
];

/** The "Code comments" group: one row per level, the one in use marked, the others offering Use. */
function commentPolicyGroup(input: LibraryModelInput): LibraryGroup | null {
  const choice = input.commentPolicy;
  if (!choice) return null;
  const canSet = input.canSetCommentPolicy === true && input.dataFolderOk && !choice.problem;
  return {
    key: "rules-comments",
    label: "Code comments",
    hint: "for every harness · the next Update changes the rules",
    rows: COMMENT_POLICY_LEVELS.map(({ level, name, desc }) => {
      const inUse = !choice.problem && choice.level === level;
      return {
        key: `comments:${level}`,
        name,
        desc,
        state: inUse ? { state: "ok" as const, label: "In use" } : undefined,
        verbs: canSet && !inUse ? [{ label: "Use", action: { type: "comment-policy", level } as RowAction }] : [],
        haystack: haystack(name, desc, "code comments", "comment policy", "rules", inUse ? "in use" : undefined),
      };
    }),
    notes: choice.problem ? [{ key: "comment-policy", label: "comment policy", text: `unavailable: ${choice.problem}` }] : undefined,
    notesLabel: choice.problem ? "Comment policy problem" : undefined,
  };
}

/** The answer style's levels, in the order shown, each said in one line. */
export const ANSWER_STYLE_LEVELS: readonly { level: AnswerStyleLevel; name: string; desc: string }[] = [
  { level: "harness_default", name: "Harness default", desc: "Adds nothing: each agent keeps its own habits and your repositories' rules." },
  { level: "plain", name: "Plain", desc: "Plain asks agents for short active sentences, the answer first, and numbered steps. A repository's own rules still win." },
];

/** The "Answer style" group: one row per level, the one in use marked, the others offering Use. */
function answerStyleGroup(input: LibraryModelInput): LibraryGroup | null {
  const choice = input.answerStyle;
  if (!choice) return null;
  const canSet = input.canSetAnswerStyle === true && input.dataFolderOk && !choice.problem;
  return {
    key: "rules-answers",
    label: "Answer style",
    hint: "for every harness · the next Update changes the rules",
    rows: ANSWER_STYLE_LEVELS.map(({ level, name, desc }) => {
      const inUse = !choice.problem && choice.level === level;
      return {
        key: `answers:${level}`,
        name,
        desc,
        state: inUse ? { state: "ok" as const, label: "In use" } : undefined,
        verbs: canSet && !inUse ? [{ label: "Use", action: { type: "answer-style", level } as RowAction }] : [],
        haystack: haystack(name, desc, "answer style", "rules", inUse ? "in use" : undefined),
      };
    }),
    notes: choice.problem ? [{ key: "answer-style", label: "answer style", text: `unavailable: ${choice.problem}` }] : undefined,
    notesLabel: choice.problem ? "Answer style problem" : undefined,
  };
}

function docRow(doc: DocSummary): LibraryRow {
  const own = isPersonalDoc(doc);
  const target: OpenTarget = { kind: "doc", id: doc.id };
  return {
    key: targetKey(target),
    name: doc.title,
    path: displayPath(doc.path),
    tag: own ? { kind: "yours", label: "yours" } : { kind: "riggverk", label: "riggverk" },
    verbs: [{ label: own ? "Edit" : "Read", action: { type: "open", target } }],
    haystack: haystack(doc.title, doc.path, "doc", own ? "yours" : "riggverk"),
  };
}

type SkillRowInput = Pick<LibraryModelInput, "canCopySkill" | "canImportSkill" | "packLibrary" | "skillChoices" | "canToggleSkills">;

/** Disable and Enable apply while the choices are listed and `disabled-skills.json` can be used. */
function canToggle(input: Pick<LibraryModelInput, "skillChoices" | "canToggleSkills">): boolean {
  return input.canToggleSkills === true && !!input.skillChoices && !input.skillChoices.problem;
}

/** "named by ci-triage, security-review": the skills that point to `name`. */
function namedByText(input: Pick<LibraryModelInput, "skillChoices">, name: string): string | undefined {
  const by = input.skillChoices?.named_by[name] ?? [];
  return by.length > 0 ? `named by ${by.join(", ")}` : undefined;
}

/**
 * A bundled or active pack skill row with its Disable or Enable verb. A disabled skill says so, whether its copy is
 * still installed (the next Update removes it) and which skills name it.
 */
function withChoice(row: LibraryRow, skill: SkillSummary, input: SkillRowInput): LibraryRow {
  const choice = input.skillChoices?.disabled.find(entry => entry.name === skill.name);
  const toggle = canToggle(input);
  if (!choice) {
    return toggle ? { ...row, verbs: [...row.verbs, { label: "Disable", action: { type: "disable", name: skill.name } }] } : row;
  }
  return {
    ...row,
    desc: [namedByText(input, skill.name), row.desc].filter(Boolean).join(" · ") || undefined,
    note: choice.installed ? "removed on next Update" : row.note,
    state: { state: "off", label: "Disabled" },
    verbs: toggle ? [...row.verbs, { label: "Enable", action: { type: "enable", name: skill.name } }] : row.verbs,
    haystack: `${row.haystack} disabled`,
  };
}

/** A disabled name the catalog no longer holds: it stays disabled if it comes back, and Enable forgets it. */
function unknownDisabledRow(name: string, input: SkillRowInput): LibraryRow {
  return {
    key: `disabled:${name}`,
    name,
    desc: "Disabled · not in the catalog",
    state: { state: "off", label: "Disabled" },
    verbs: canToggle(input) ? [{ label: "Enable", action: { type: "enable", name } }] : [],
    haystack: haystack(name, "skill", "disabled"),
  };
}

function skillRow(skill: SkillSummary, input: SkillRowInput, indent = false): LibraryRow {
  const target: OpenTarget = { kind: "skill", id: skill.id };
  const verbs: RowVerb[] = [{ label: "Read", action: { type: "open", target } }];
  const common = { key: targetKey(target), name: skill.name, indent };
  if (skill.packState === undefined) {
    if (input.canCopySkill) verbs.push({ label: "Edit as my copy", action: { type: "copy", skill: skill.name } });
    return withChoice({
      ...common,
      desc: skill.description,
      tag: { kind: "riggverk", label: "riggverk" },
      verbs,
      haystack: haystack(skill.name, skill.description, skill.category, "skill", "riggverk"),
    }, skill, input);
  }
  const personal = isPersonalSkill(skill.id, skill);
  const imported = isImportedSkill(skill.id, skill);
  const tag = { kind: personal ? ("yours" as const) : ("pack" as const), label: skill.group || "pack" };
  if (personal) verbs[0] = { label: "Edit", action: { type: "open", target } };
  if (imported && input.canImportSkill) {
    // Read-only: changed as a personal copy, taken out with a backup, or the last import taken back.
    if (input.canCopySkill) verbs.push({ label: "Edit as my copy", action: { type: "copy", skill: skill.id } });
    verbs.push({ label: "Routing…", action: { type: "routing", name: skill.name } });
    verbs.push({ label: "Remove import", action: { type: "remove-import", name: skill.name } });
    const undo = input.packLibrary?.undo_import;
    if (undo && undo.action !== "remove" && undo.name === skill.name) verbs.push({ label: "Undo import", action: { type: "undo-import" } });
  }
  // Where an imported skill came from leads its line; the sheet adds the date.
  const origin = skill.provenance ? `from ${skill.provenance.source}` : undefined;
  const base = {
    ...common,
    tag,
    verbs,
    haystack: haystack(skill.name, skill.description, skill.group, "skill", personal ? "yours" : "pack", skill.provenance?.source),
  };
  if (skill.packState === "active") {
    return withChoice({ ...base, desc: [origin, skill.description].filter(Boolean).join(" · "), state: { state: "ok", label: "Active" } }, skill, input);
  }
  if (skill.packState === "shadowed") {
    return {
      ...base,
      desc: SHADOWED_TEXT,
      note: "shadowed · bundle wins",
      state: { state: "off", label: "Shadowed" },
    };
  }
  const label = skill.packState === "missing" ? "Pack missing" : "Needs a fix";
  return {
    ...base,
    desc: skill.packReason || skill.description || undefined,
    state: { state: "fix", label },
  };
}

function agentRow(agent: AgentMetadataResponse): LibraryRow {
  const target: OpenTarget = { kind: "agent", id: agent.id };
  const meta = agent.metadata;
  return {
    key: targetKey(target),
    name: agent.title,
    desc: agent.exists ? meta?.summary || meta?.role || undefined : "Not in the workspace folder.",
    tag: { kind: "riggverk", label: "riggverk" },
    state: agent.exists ? undefined : { state: "off", label: "Not in the workspace" },
    verbs: agent.exists ? [{ label: "Read", action: { type: "open", target } }] : [],
    haystack: haystack(agent.title, agent.id, meta?.role, meta?.summary, "agent", ...(meta?.targets ?? [])),
  };
}

function configRows(input: LibraryModelInput): LibraryRow[] {
  const rows: LibraryRow[] = [];
  for (const target of input.configTargets) {
    if (target.id === "opencode_config" && input.configEditorSources.length > 0) {
      for (const source of input.configEditorSources) {
        const open: OpenTarget = { kind: "config", targetId: target.id, sourceId: source.id };
        rows.push({
          key: targetKey(open),
          name: `${target.label} · ${source.label}`,
          path: source.rel_path,
          tag: { kind: "riggverk", label: "riggverk" },
          verbs: [{ label: "View", action: { type: "open", target: open } }],
          haystack: haystack(target.label, source.label, source.rel_path, "config"),
        });
      }
      continue;
    }
    const open: OpenTarget = { kind: "config", targetId: target.id, sourceId: null };
    rows.push({
      key: targetKey(open),
      name: target.label,
      path: `${target.source_rel} → ${target.target_rel}`,
      tag: { kind: "riggverk", label: "riggverk" },
      verbs: [{ label: "View", action: { type: "open", target: open } }],
      haystack: haystack(target.label, target.source_rel, target.target_rel, "config"),
    });
  }
  return rows;
}

/** True while a pack needs the user's attention: refused, unreadable, or a record the app cannot use. */
export function packsNeedAttention(library: PackLibrary | null, error: string | null): boolean {
  if (library?.packs.some(pack => pack.state !== "ok")) return true;
  return packNoticeLines(library, error).length > 0;
}

function packRows(input: LibraryModelInput): LibraryRow[] {
  const library = input.packLibrary;
  if (!library) return [];
  const rows: LibraryRow[] = [];
  for (const pack of library.packs) {
    const forgettable = pack.forgettable;
    const attention = pack.state !== "ok";
    const undo = library.undo_import;
    // An undone removal has no skill row left to carry its verb: the imported pack's row does.
    const undoRemove = pack.name === IMPORTED_PACK && input.canImportSkill && undo?.action === "remove";
    rows.push({
      key: `pack:${pack.name}`,
      name: pack.name,
      path: attention ? undefined : `${library.folder}/${pack.name}`,
      tag: { kind: "pack", label: "pack" },
      state: attention
        ? { state: "fix", label: pack.state === "missing" ? "Pack missing" : "Needs a fix" }
        : { state: "ok", label: "Loads" },
      desc: attention ? pack.reason || PACK_FOLDER_UNREADABLE : undefined,
      verbs: [
        ...(forgettable && input.canForgetPack ? [{ label: "Forget pack", action: { type: "forget", pack: pack.name } as RowAction }] : []),
        ...(undoRemove && undo ? [{ label: `Undo removal of ${undo.name}`, action: { type: "undo-import" } as RowAction }] : []),
      ],
      haystack: haystack(pack.name, packGroup(pack.name), library.folder, "pack", pack.reason),
    });
    for (const skill of input.skills.filter(candidate => candidate.group === packGroup(pack.name))) {
      rows.push(skillRow(skill, input, true));
    }
    const routing = pack.routing ?? [];
    const leftOut = pack.routing_left_out ?? 0;
    if (routing.length > 0 || leftOut > 0) {
      const leftOutText = leftOut > 0 ? `${leftOut} routing ${leftOut === 1 ? "line" : "lines"} left out: they name a disabled skill` : undefined;
      rows.push({
        key: `pack:${pack.name}:routing`,
        name: "routing.md",
        indent: true,
        desc: [routing.join(" · "), leftOutText].filter(Boolean).join(" · "),
        note: `${routing.length} ${routing.length === 1 ? "line" : "lines"} in the rules block`,
        tag: { kind: "pack", label: packGroup(pack.name) },
        state: { state: "ok", label: "Routed" },
        verbs: [],
        haystack: haystack("routing.md", "routing", "rules", pack.name, ...routing),
      });
    }
  }
  return rows;
}

/** The groups of one topic. Rows are built from what the controller already loaded; nothing is fetched here. */
export function topicGroups(topic: LibrarySourceType, input: LibraryModelInput): LibraryGroup[] {
  switch (topic) {
    case "rules": {
      const files = input.dataFolderOk ? input.rulesFiles.map(file => rulesRow(file, input)) : [];
      const baseTarget: OpenTarget = { kind: "base" };
      return [
        {
          key: "rules-files",
          label: "Your rules files",
          hint: "the base block is managed; you edit below END",
          rows: files,
          empty: input.dataFolderOk
            ? "No rules files are on."
            : dataFolderUnknownSentence(input.dataFolderVerdict) ?? "Rules files need a usable workspace folder.",
        },
        {
          key: "rules-base",
          label: "Base template",
          rows: [
            {
              key: targetKey(baseTarget),
              name: "Managed base",
              desc: input.agentTemplateLoaded
                ? "Installed between BEGIN/END in each file; replaced on Update all."
                : "Loading…",
              tag: { kind: "riggverk", label: "riggverk" },
              verbs: input.agentTemplateLoaded ? [{ label: "View", action: { type: "open", target: baseTarget } }] : [],
              haystack: haystack("managed base", "rules", "base", "template", "riggverk"),
            },
          ],
        },
        ...[commentPolicyGroup(input), answerStyleGroup(input)].filter((group): group is LibraryGroup => group !== null),
      ];
    }
    case "skills": {
      const yours = input.skills.filter(skill => skill.packState !== undefined);
      const bundled = input.skills.filter(skill => skill.packState === undefined);
      const disabled = input.skillChoices?.disabled ?? [];
      const bundledDisabled = bundled.filter(skill => disabled.some(entry => entry.name === skill.name)).length;
      const unknown = disabled.filter(entry => entry.source === "unknown");
      const problem = input.skillChoices?.problem;
      const groups: LibraryGroup[] = [
        {
          key: "skills-yours",
          label: "Yours",
          hint: "skills of your packs",
          rows: yours.map(skill => skillRow(skill, input)),
          empty: "No skills from your packs yet.",
        },
        {
          key: "skills-bundled",
          label: "Bundled",
          hint: bundledDisabled > 0 ? `${bundled.length} · ${bundledDisabled} disabled · read-only` : `${bundled.length} · read-only`,
          rows: bundled.map(skill => skillRow(skill, input)),
          empty: "No skills found.",
          notes: problem ? [{ key: "disabled-skills", label: "disabled skills", text: `unavailable: ${problem}` }] : undefined,
          notesLabel: problem ? "Disabled skills problem" : undefined,
        },
      ];
      if (unknown.length > 0) {
        groups.push({
          key: "skills-disabled-unknown",
          label: "Disabled, not in the catalog",
          hint: "they stay disabled if they come back",
          rows: unknown.map(entry => unknownDisabledRow(entry.name, input)),
        });
      }
      return groups;
    }
    case "agents":
      return [
        {
          key: "agents-bundled",
          label: "Bundled",
          hint: `${input.agentSources.length} · read-only`,
          rows: input.agentSources.map(agentRow),
          empty: "No agents found.",
        },
      ];
    case "docs": {
      const yours = input.docs.filter(isPersonalDoc);
      const bundled = input.docs.filter(doc => !isPersonalDoc(doc));
      return [
        {
          key: "docs-yours",
          label: "Yours",
          action: input.dataFolderOk ? { label: "New doc", id: "new-doc" } : undefined,
          rows: yours.map(docRow),
          empty: "No docs of your own yet.",
        },
        { key: "docs-bundled", label: "Bundled", rows: bundled.map(docRow), empty: "No bundled docs." },
      ];
    }
    case "configs":
      return [
        {
          key: "configs",
          label: "Installed configs",
          hint: "read-only",
          rows: configRows(input),
          empty: "No configs are on.",
        },
      ];
    case "packs": {
      return [
        {
          key: "packs",
          label: "Skill packs",
          hint: "the bundle wins on a name collision",
          action: input.canImportSkill && input.dataFolderOk ? { label: "Import skill…", id: "import-skill" } : undefined,
          rows: packRows(input),
          notes: packNoticeLines(input.packLibrary, input.packError),
          empty: "No packs",
          emptyPath: input.packLibrary?.folder,
        },
      ];
    }
  }
}

/** The groups for a search: every topic in tab order, only the rows that match, no empty groups. */
export function searchGroups(query: string, input: LibraryModelInput): { topic: LibrarySourceType; label: string; groups: LibraryGroup[] }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return LIBRARY_TOPICS.map(topic => ({
    topic: topic.id,
    label: topic.label,
    groups: topicGroups(topic.id, input)
      .map(group => ({ ...group, action: undefined, notes: undefined, rows: group.rows.filter(row => row.haystack.includes(q)).map(row => ({ ...row, indent: false })) }))
      .filter(group => group.rows.length > 0),
  })).filter(section => section.groups.length > 0);
}
