import type { InstallFlowRequest, InstallReview } from "../hooks/useInstallFlow";
import type { Tone } from "../ui/tone";
import type { AppSettings, InstallAgent, PlannedOperation, SetupResult, SetupSurfaceId } from "../types";
import { resolvePointer } from "./fileConflicts";
import {
  enabledSetupSurfaces,
  enabledSurfacesForHarness,
  HARNESS_LABELS,
  HARNESS_NAV_ORDER,
  harnessForSurface,
  WORKSPACE_SURFACES,
} from "./harnessInstallation";
import { plural } from "./plural";

/** What an install review can be about: the workspace bundle, one harness, or everything enabled. */
export type InstallTarget = "workspace" | InstallAgent | "all";

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/** The page the review is shown on (`AppView` id): the Overview for workspace/all, else the harness page. */
export type InstallScope = "start" | InstallAgent;

export function scopeForTarget(target: InstallTarget): InstallScope {
  return target === "workspace" || target === "all" ? "start" : target;
}

/**
 * The request behind `u` / `:update` / `:preview`. Surfaces are target-filtered, so a surface whose
 * target toggle is off is never previewed or applied.
 */
export function installRequestFor(
  target: InstallTarget,
  settings: EnabledSettings,
  { readOnly = false }: { readOnly?: boolean } = {},
): InstallFlowRequest {
  const surfaces =
    target === "workspace"
      ? [...WORKSPACE_SURFACES]
      : target === "all"
        ? enabledSetupSurfaces(settings)
        : enabledSurfacesForHarness(target, settings);
  return { label: `${readOnly ? "preview" : "update"} ${target}`, surfaces, readOnly };
}

/** "claude_rules" -> "claude rules", "open_code_skills" -> "opencode skills". */
export function surfaceTitle(surface: SetupSurfaceId): string {
  return surface.replace(/^open_code/, "opencode").replace(/_/g, " ");
}

export type PlanRowKind = "create" | "update" | "remove" | "conflict" | "manual" | "unavailable";

export interface PlanRow {
  /** Stable within one review: `<surface>:<n>`. */
  id: string;
  surface: SetupSurfaceId;
  kind: PlanRowKind;
  label: string;
  file: string;
  note: string;
  /** Lines shown when the row is expanded with `d`: the operation summary, conflict/manual text, detail lines. */
  detail: string[];
  /** Apply would write this row (create, update or remove). */
  safe: boolean;
  conflict: boolean;
}

export interface PlanGroup {
  surface: SetupSurfaceId;
  title: string;
  /** The surface is already in sync: a group header without rows. */
  unchanged: boolean;
  rows: PlanRow[];
}

export interface PlanCounts {
  create: number;
  update: number;
  remove: number;
  conflict: number;
  manual: number;
  unavailable: number;
  /** Surfaces already in sync. */
  unchanged: number;
}

/** The word that names each kind of row; the rows never rely on a mark or a colour alone. */
const KIND_LABEL: Record<PlanRowKind, string> = {
  create: "create",
  update: "update",
  remove: "remove",
  conflict: "conflict",
  manual: "manual",
  unavailable: "unavailable",
};

/** What a safe change does to the file and to Undo, added to a row whose details would only repeat its note. */
const KIND_EFFECT: Partial<Record<PlanRowKind, string>> = {
  create: "Nothing is there yet: Riggverk writes it, and Undo removes it again.",
  update: "The current file is backed up first; Undo puts it back.",
  remove: "The file is backed up first; Undo puts it back.",
};

/**
 * `!` marks a file that stays because the user edited it (a conflict inside an otherwise safe surface), `=` one the
 * user chose to keep (a manual step: updates never write it).
 */
const DETAIL_KIND: Record<string, PlanRowKind> = {
  "+": "create",
  "~": "update",
  "−": "remove",
  "-": "remove",
  "!": "conflict",
  "=": "manual",
};
const DETAIL_LINE = /^\s*([+~−!=-])\s+(?:(?:create|update|remove)\s+)?(.*?)\s*$/;
const TRAILING_NOTE = /^(.*?)\s*\((.+)\)$/;

function unique(lines: Array<string | null | undefined>): string[] {
  return [...new Set(lines.filter((line): line is string => Boolean(line)))];
}

function rowFor(
  surface: SetupSurfaceId,
  index: number,
  kind: PlanRowKind,
  file: string,
  note: string,
  detail: string[],
): PlanRow {
  return {
    id: `${surface}:${index}`,
    surface,
    kind,
    label: KIND_LABEL[kind],
    file,
    note,
    detail,
    safe: kind === "create" || kind === "update" || kind === "remove",
    conflict: kind === "conflict",
  };
}

/** Where a skill or agent file in conflict is resolved: the review itself only reports it. */
function resolveLines(kind: PlanRowKind, surface: SetupSurfaceId): string[] {
  const pointer = kind === "conflict" ? resolvePointer(surface) : null;
  return pointer ? [pointer] : [];
}

function rowsForOperation(op: PlannedOperation): PlanRow[] {
  const kind = op.kind as PlanRowKind;
  if (!(kind in KIND_LABEL)) return [];
  const baseDetail = [op.summary, op.conflict_description, op.manual_step];
  const lines = op.details ?? [];
  const safe = kind === "create" || kind === "update" || kind === "remove";
  if (safe && lines.length > 0) {
    return lines.map((line, index) => {
      const match = DETAIL_LINE.exec(line);
      if (!match) return rowFor(op.surface, index, kind, line, "", unique([...baseDetail, line]));
      const rowKind = DETAIL_KIND[match[1]!] ?? kind;
      const withNote = TRAILING_NOTE.exec(match[2]!);
      const file = withNote ? withNote[1]! : match[2]!;
      const note = withNote ? withNote[2]! : "";
      return rowFor(op.surface, index, rowKind, file, note, unique([...baseDetail, line, ...resolveLines(rowKind, op.surface)]));
    });
  }
  const note = op.conflict_description ?? op.manual_step ?? op.summary;
  const detail = unique([...baseDetail, ...lines, ...resolveLines(kind, op.surface)]);
  const effect = KIND_EFFECT[kind];
  const onlyNote = detail.every(line => line === note);
  return [rowFor(op.surface, 0, kind, surfaceTitle(op.surface), note, onlyNote && effect ? [...detail, effect] : detail)];
}

/** Rows grouped by surface, in request order; unchanged surfaces keep a header with no rows. */
export function buildPlanGroups(review: InstallReview): PlanGroup[] {
  const { plan, request } = review;
  const order = [...new Set([...request.surfaces, ...plan.operations.map(op => op.surface)])];
  const synced = new Set<SetupSurfaceId>(plan.synced);
  const groups: PlanGroup[] = [];
  for (const surface of order) {
    const operations = plan.operations.filter(op => op.surface === surface);
    const rows = operations.flatMap(rowsForOperation);
    const unchanged = rows.length === 0 && (synced.has(surface) || operations.some(op => op.kind === "no_change"));
    if (rows.length === 0 && !unchanged) continue;
    // Row ids must stay unique when a surface carries several operations.
    groups.push({
      surface,
      title: surfaceTitle(surface),
      unchanged,
      rows: rows.map((row, index) => ({ ...row, id: `${surface}:${index}` })),
    });
  }
  return groups;
}

export function planRows(groups: readonly PlanGroup[]): PlanRow[] {
  return groups.flatMap(group => group.rows);
}

export function countPlanRows(groups: readonly PlanGroup[]): PlanCounts {
  const counts: PlanCounts = { create: 0, update: 0, remove: 0, conflict: 0, manual: 0, unavailable: 0, unchanged: 0 };
  for (const group of groups) {
    if (group.unchanged) counts.unchanged += 1;
    for (const row of group.rows) counts[row.kind] += 1;
  }
  return counts;
}

/* ---- the plan per agent ---- */

/** Whose a row is: an agent, or `shared` for what every agent reads (`~/.agents/skills`, the workspace bundle). */
export type PlanAgentId = InstallAgent | "shared";

/** The skills surface writes into several agents' folders; its rows name the folder (`SkillRoot::display`). */
const SKILL_FOLDER_AGENT: ReadonlyArray<readonly [RegExp, InstallAgent]> = [
  [/^~\/\.claude\//, "claude"],
  [/^\$CODEX_HOME\//, "codex"],
  [/^(~\/\.config|\$XDG_CONFIG_HOME)\/opencode\//, "opencode"],
  [/^~\/\.cursor\//, "cursor"],
  [/^~\/\.gemini\//, "antigravity"],
];

/** The agent a row writes to: the surface's harness, or for the skills surface the agent whose folder the row names. */
export function planRowAgent(row: Pick<PlanRow, "surface" | "file">): PlanAgentId {
  const harness = harnessForSurface(row.surface);
  if (harness) return harness;
  if (row.surface === "skills") {
    const file = `${row.file}/`;
    for (const [pattern, agent] of SKILL_FOLDER_AGENT) if (pattern.test(file)) return agent;
  }
  return "shared";
}

export function planAgentLabel(agent: PlanAgentId): string {
  return agent === "shared" ? "Shared" : HARNESS_LABELS[agent];
}

export interface AgentPlanGroup {
  agent: PlanAgentId;
  label: string;
  /** What apply writes for the agent, and what it leaves to the user; never a conflict. */
  rows: PlanRow[];
  /** The agent's conflicts: listed once, in the skipped group at the top, and named here. */
  skipped: PlanRow[];
  /** Short names of the agent's surfaces that are already in sync ("rules", "agents"). */
  unchanged: string[];
}

export interface AgentPlan {
  /** Every conflict of the plan: apply never writes them, so they are pinned above the agents. */
  conflicts: PlanRow[];
  groups: AgentPlanGroup[];
  /** Every row in the order the table shows them, conflicts first: `j`/`k` walk this. */
  rows: PlanRow[];
}

/** Rows a kind of change: the counts a chip, a tile or a sub-line is made of. */
export interface WriteCounts {
  create: number;
  update: number;
  remove: number;
  conflict: number;
  manual: number;
}

export function writeCounts(rows: readonly PlanRow[]): WriteCounts {
  const counts: WriteCounts = { create: 0, update: 0, remove: 0, conflict: 0, manual: 0 };
  for (const row of rows) if (row.kind in counts) counts[row.kind as keyof WriteCounts] += 1;
  return counts;
}

export function writesOf(counts: WriteCounts): number {
  return counts.create + counts.update + counts.remove;
}

/**
 * The plan's rows by the agent they write to, from `buildPlanGroups`: the shared folders first, then the agents with
 * the most to write, then the rest in sidebar order. An agent with nothing to write keeps a group when any of its
 * surfaces was checked, so its unchanged surfaces are still acknowledged. Pure, so the table and the map share it.
 */
export function buildAgentPlan(groups: readonly PlanGroup[]): AgentPlan {
  const byAgent = new Map<PlanAgentId, AgentPlanGroup>();
  const groupFor = (agent: PlanAgentId) => {
    let group = byAgent.get(agent);
    if (!group) {
      group = { agent, label: planAgentLabel(agent), rows: [], skipped: [], unchanged: [] };
      byAgent.set(agent, group);
    }
    return group;
  };
  const conflicts: PlanRow[] = [];
  for (const group of groups) {
    if (group.unchanged) {
      const owner = harnessForSurface(group.surface) ?? "shared";
      // "claude_rules" -> "rules", like the Overview's rows (`surfaceShortName`).
      groupFor(owner).unchanged.push(group.surface === "workspace_bundle" ? "workspace bundle" : group.surface.slice(group.surface.lastIndexOf("_") + 1));
    }
    for (const row of group.rows) {
      const owner = groupFor(planRowAgent(row));
      if (row.conflict) {
        conflicts.push(row);
        owner.skipped.push(row);
      } else owner.rows.push(row);
    }
  }
  const navIndex = (agent: PlanAgentId) => (agent === "shared" ? -1 : HARNESS_NAV_ORDER.indexOf(agent));
  const ordered = [...byAgent.values()].sort((a, b) => {
    if (a.agent === "shared" || b.agent === "shared") return navIndex(a.agent) - navIndex(b.agent);
    return b.rows.length - a.rows.length || navIndex(a.agent) - navIndex(b.agent);
  });
  return { conflicts, groups: ordered, rows: [...conflicts, ...ordered.flatMap(group => group.rows)] };
}

const WRITE_GLYPH = { create: "+", update: "~", remove: "−" } as const;

/**
 * What apply writes along one curve of the map, in the plan's own signs: `− 1 remove`, `~ 2 update`, `+ 1 · ~ 3`, and the
 * filled square for conflicts it keeps (`■ 1 kept`). Null when nothing is written or kept.
 */
export function writeChip(counts: WriteCounts): string | null {
  const parts = (["create", "update", "remove"] as const).filter(kind => counts[kind] > 0);
  if (parts.length === 1 && counts.conflict === 0) {
    const kind = parts[0]!;
    return `${WRITE_GLYPH[kind]} ${counts[kind]} ${kind}`;
  }
  if (parts.length === 0) return counts.conflict > 0 ? `■ ${counts.conflict} kept` : null;
  const signed = parts.map(kind => `${WRITE_GLYPH[kind]} ${counts[kind]}`);
  if (counts.conflict > 0) signed.push(`■ ${counts.conflict}`);
  return signed.join(" · ");
}

/** The line under an agent in the map: "1 create · 3 update", "1 kept, skipped", "nothing to write". */
export function writeLine(counts: WriteCounts): string {
  const parts = (["create", "update", "remove"] as const).filter(kind => counts[kind] > 0).map(kind => `${counts[kind]} ${kind}`);
  if (counts.conflict > 0) parts.push(parts.length > 0 ? `${counts.conflict} kept` : `${counts.conflict} kept, skipped`);
  if (counts.manual > 0) parts.push(`${counts.manual} left to you`);
  return parts.length > 0 ? parts.join(" · ") : "nothing to write";
}

export type SummaryKind = "create" | "update" | "remove" | "conflict" | "manual" | "unchanged";

export interface SummaryTile {
  kind: SummaryKind;
  n: number;
  label: string;
  /** What the kind means for the files: "new files", "backed up first". */
  sub: string;
}

const TILE_TEXT: Record<SummaryKind, [string, string]> = {
  create: ["Create", "new files"],
  update: ["Update", "backed up first"],
  remove: ["Remove", "backed up first"],
  conflict: ["Conflict", "skipped, yours"],
  manual: ["Manual", "left to you"],
  unchanged: ["Unchanged", "already in sync"],
};

/** The count tiles of the summary band: the five kinds always, a manual tile only when the plan has a manual step. */
export function summaryTiles(counts: PlanCounts): SummaryTile[] {
  const kinds: SummaryKind[] = ["create", "update", "remove", "conflict", ...(counts.manual > 0 ? (["manual"] as const) : []), "unchanged"];
  return kinds.map(kind => ({ kind, n: counts[kind], label: TILE_TEXT[kind][0], sub: TILE_TEXT[kind][1] }));
}

const FILES_IN_NOTE = /\b(\d+) files?\b/;

/**
 * How many files the safe rows write: a row that names its file count ("17 skills, 17 files") counts that many, any
 * other row one. Only as exact as the backend's notes.
 */
export function planFileCount(rows: readonly PlanRow[]): number {
  return rows.filter(row => row.safe).reduce((total, row) => total + Number(FILES_IN_NOTE.exec(row.note)?.[1] ?? 1), 0);
}

/** The band's backup sentence: what exists and is backed up before anything is written. */
export function backupSentence(counts: PlanCounts): string {
  const existing = counts.update + counts.remove;
  if (existing > 0) return `${plural(existing, "existing file")} ${existing === 1 ? "is" : "are"} backed up before anything is written`;
  return counts.create > 0 ? "Nothing that exists is overwritten; Undo removes what is created" : "Nothing is written";
}

/**
 * The review title's request label once the plan is known: an "update <target>" whose plan only creates (nothing
 * was installed there) reads "install <target>". It is wording only; the request and the apply action keep their label.
 */
export function installReviewLabel(label: string, counts: PlanCounts): string {
  if (counts.create > 0 && counts.update === 0 && counts.remove === 0 && label.startsWith("update ")) {
    return `install ${label.slice("update ".length)}`;
  }
  return label;
}

/** The y/n question: "apply 7 safe changes, skip 1 conflict". Counts rows, so it matches the table. */
export function describePlanCounts(counts: PlanCounts): string {
  const safe = counts.create + counts.update + counts.remove;
  const extras = [
    counts.conflict > 0 ? `skip ${plural(counts.conflict, "conflict")}` : null,
    counts.manual > 0 ? `${plural(counts.manual, "manual step")} left to you` : null,
  ].filter(Boolean);
  if (safe === 0) {
    const reason = counts.conflict > 0 ? `nothing safe to apply, ${plural(counts.conflict, "conflict")}` : "nothing to apply";
    return counts.manual > 0 ? `${reason}, ${plural(counts.manual, "manual step")}` : reason;
  }
  return [`apply ${plural(safe, "safe change")}`, ...extras].join(", ");
}

export interface ApplyOutput {
  stdout: string;
  stderr: string;
}

const SHORT_FINGERPRINT = 8;

/**
 * Output-pane text for a finished apply of any kind (install, take bundled, rules conversion, Codex defaults): the
 * `plan` line, the caller's own lines (the first word of the surface line is `applied`, `rolled back` or `failed`),
 * then the manual steps, the backend message, the counts and the transaction. `applyOutputLineTone` reads this format.
 * `lines` gets that word and `pad`, which aligns a word to the column the tone parser expects.
 */
export function formatReceipt(input: {
  fingerprint: string | null | undefined;
  /** What the plan was about: "2 surfaces", "convert Pi rules". */
  subject: string;
  lines: (word: string, pad: (text: string) => string) => string[];
  result: SetupResult;
}): ApplyOutput {
  const { result } = input;
  const word = result.success ? "applied" : result.rolled_back.length > 0 ? "rolled back" : "failed";
  const pad = (text: string) => text.padEnd(13);
  const lines = [
    `plan ${(input.fingerprint ?? "").slice(0, SHORT_FINGERPRINT) || "-"} · ${input.subject} · fingerprint verified`,
    ...input.lines(word, pad),
    ...result.manual_steps.map(step => `${pad("manual")}${step}`),
    result.message,
    `applied ${result.applied.length} · failed ${result.failed.length} · rolled back ${result.rolled_back.length}`,
    result.transaction_id
      ? `transaction ${result.transaction_id} ${result.success && result.applied.length > 0 ? "recorded · rollback available" : "recorded"}`
      : "",
  ].filter(Boolean);
  const stderr = result.success ? "" : [...result.failed, ...(result.failed.length === 0 ? [result.message] : [])].join("\n");
  return { stdout: lines.join("\n"), stderr };
}

/**
 * Output-pane text for a finished apply. Surface lines come from the reviewed plan (the backend result
 * lists artifacts, not surfaces): `applied` when the run succeeded, `rolled back` or `failed` otherwise.
 */
export function formatApplyOutput(review: InstallReview, result: SetupResult): ApplyOutput {
  return formatReceipt({
    fingerprint: review.plan.plan_fingerprint,
    subject: plural(review.applySurfaces.length, "surface"),
    lines: (word, pad) => review.applySurfaces.map(surface => `${pad(word)}${surfaceTitle(surface)}`),
    result,
  });
}

/** Tone for an output line written by `formatApplyOutput` (the first word decides). */
export function applyOutputLineTone(line: string): Tone | null {
  if (/^applied\s{2,}/.test(line)) return "ok";
  if (/^failed\s{2,}/.test(line)) return "fail";
  if (/^(rolled back|manual)\s{2,}/.test(line)) return "warn";
  if (/^(plan|transaction)\s/.test(line)) return "dim";
  return null;
}
