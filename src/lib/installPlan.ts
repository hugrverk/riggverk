import type { InstallFlowRequest, InstallReview } from "../hooks/useInstallFlow";
import type { Tone } from "../ui/tone";
import type { AppSettings, InstallAgent, PlannedOperation, SetupResult, SetupSurfaceId } from "../types";
import { resolvePointer } from "./fileConflicts";
import {
  enabledSetupSurfaces,
  enabledSurfacesForHarness,
  WORKSPACE_SURFACES,
} from "./harnessInstallation";
import { plural } from "./plural";

/** What an install review can be about: the workspace bundle, one harness, or everything enabled. */
export type InstallTarget = "workspace" | InstallAgent | "all";

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/** The page the review is shown on (`AppView` id): the workspace page for workspace/all, else the harness page. */
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
  return [rowFor(op.surface, 0, kind, surfaceTitle(op.surface), note, unique([...baseDetail, ...lines, ...resolveLines(kind, op.surface)]))];
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
 * Output-pane text for a finished apply. Surface lines come from the reviewed plan (the backend result
 * lists artifacts, not surfaces): `applied` when the run succeeded, `rolled back` or `failed` otherwise.
 */
export function formatApplyOutput(review: InstallReview, result: SetupResult): ApplyOutput {
  const fingerprint = review.plan.plan_fingerprint ?? "";
  const surfaceStatus = result.success ? "applied" : result.rolled_back.length > 0 ? "rolled back" : "failed";
  const pad = (word: string) => word.padEnd(13);
  const lines = [
    `plan ${fingerprint.slice(0, SHORT_FINGERPRINT) || "-"} · ${review.applySurfaces.length} surface${review.applySurfaces.length === 1 ? "" : "s"} · fingerprint verified`,
    ...review.applySurfaces.map(surface => `${pad(surfaceStatus)}${surfaceTitle(surface)}`),
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

/** Tone for an output line written by `formatApplyOutput` (the first word decides). */
export function applyOutputLineTone(line: string): Tone | null {
  if (/^applied\s{2,}/.test(line)) return "ok";
  if (/^failed\s{2,}/.test(line)) return "fail";
  if (/^(rolled back|manual)\s{2,}/.test(line)) return "warn";
  if (/^(plan|transaction)\s/.test(line)) return "dim";
  return null;
}
