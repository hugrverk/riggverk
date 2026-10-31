import { displayPath } from "../../lib/displayPath";
import { isPersonalDoc } from "../../lib/libraryDirtyGuards";
import { isPersonalSkill, packGroup, packNoticeLines, type PackNoticeLine } from "../../lib/packSkills";
import { harnessOfRulesSurface } from "../../lib/rulesView";
import { HARNESS_LABELS } from "../../lib/harnessInstallation";
import type { UiState } from "../../lib/uiState";
import type {
  AgentMetadataResponse,
  AgentTargetMeta,
  ConfigEditorSourceMeta,
  DocSummary,
  InstallAgent,
  PackLibrary,
  RulesFileSummary,
  RulesSurfaceId,
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
  | { type: "copy"; skill: string }
  | { type: "forget"; pack: string };

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

export interface LibraryGroup {
  key: string;
  label: string;
  /** Muted words after the label. */
  hint?: string;
  /** A button in the group header. */
  action?: { label: string; id: "new-doc" };
  rows: LibraryRow[];
  /** Shown instead of the rows while there are none (never in search results). */
  empty?: string;
  /** A location shown beside `empty`, in mono (the packs folder). */
  emptyPath?: string;
  /** Plain lines above the rows (pack problems). */
  notes?: PackNoticeLine[];
}

export interface LibraryModelInput {
  dataFolderOk: boolean;
  docs: DocSummary[];
  agentTemplateLoaded: boolean;
  rulesFiles: RulesFileSummary[];
  skills: SkillSummary[];
  agentSources: AgentMetadataResponse[];
  configTargets: AgentTargetMeta[];
  configEditorSources: ConfigEditorSourceMeta[];
  packLibrary: PackLibrary | null;
  packError: string | null;
  /** The bundled skill rows offer "Edit as my copy". */
  canCopySkill: boolean;
  /** A pack that cannot be read offers "Forget pack". */
  canForgetPack: boolean;
  /** A rules conflict offers "Open <harness> view ›". */
  canOpenHarness: boolean;
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
        ...(harness && input.canOpenHarness ? [{ label: `Open ${HARNESS_LABELS[harness]} view ›`, action: { type: "harness", harness } as RowAction }] : []),
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

function skillRow(skill: SkillSummary, input: Pick<LibraryModelInput, "canCopySkill">, indent = false): LibraryRow {
  const target: OpenTarget = { kind: "skill", id: skill.id };
  const verbs: RowVerb[] = [{ label: "Read", action: { type: "open", target } }];
  const common = { key: targetKey(target), name: skill.name, indent };
  if (skill.packState === undefined) {
    if (input.canCopySkill) verbs.push({ label: "Edit as my copy", action: { type: "copy", skill: skill.name } });
    return {
      ...common,
      desc: skill.description,
      tag: { kind: "riggverk", label: "riggverk" },
      verbs,
      haystack: haystack(skill.name, skill.description, skill.category, "skill", "riggverk"),
    };
  }
  const personal = isPersonalSkill(skill.id, skill);
  const tag = { kind: personal ? ("yours" as const) : ("pack" as const), label: skill.group || "pack" };
  if (personal) verbs[0] = { label: "Edit", action: { type: "open", target } };
  const base = { ...common, tag, verbs, haystack: haystack(skill.name, skill.description, skill.group, "skill", personal ? "yours" : "pack") };
  if (skill.packState === "active") {
    return { ...base, desc: skill.description, state: { state: "ok", label: "Active" } };
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
    rows.push({
      key: `pack:${pack.name}`,
      name: pack.name,
      desc: attention ? pack.reason || PACK_FOLDER_UNREADABLE : undefined,
      path: attention ? undefined : `${library.folder}/${pack.name}`,
      tag: { kind: "pack", label: "pack" },
      state: attention
        ? { state: "fix", label: pack.state === "missing" ? "Pack missing" : "Needs a fix" }
        : { state: "ok", label: "Loads" },
      verbs: forgettable && input.canForgetPack ? [{ label: "Forget pack", action: { type: "forget", pack: pack.name } }] : [],
      haystack: haystack(pack.name, packGroup(pack.name), library.folder, "pack", pack.reason),
    });
    for (const skill of input.skills.filter(candidate => candidate.group === packGroup(pack.name))) {
      rows.push(skillRow(skill, { canCopySkill: false }, true));
    }
    const routing = pack.routing ?? [];
    if (routing.length > 0) {
      rows.push({
        key: `pack:${pack.name}:routing`,
        name: "routing.md",
        indent: true,
        desc: routing.join(" · "),
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
          empty: input.dataFolderOk ? "No rules files are on." : "Rules files need a usable workspace folder.",
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
      ];
    }
    case "skills": {
      const yours = input.skills.filter(skill => skill.packState !== undefined);
      const bundled = input.skills.filter(skill => skill.packState === undefined);
      return [
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
          hint: `${bundled.length} · read-only`,
          rows: bundled.map(skill => skillRow(skill, input)),
          empty: "No skills found.",
        },
      ];
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
