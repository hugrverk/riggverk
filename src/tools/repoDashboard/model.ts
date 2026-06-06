import type {
  RepoCommitEntry,
  RepoDashboardSnapshot,
  RepoDashboardWorkItem,
  RepoDashboardWorkType,
  RepoDocFile,
} from "../../types";
import { isOptionalDocPath } from "./docsParser";

export type ActivityActor = "primary" | "secondary" | "other";

export interface ActivityEvent {
  actor: ActivityActor;
  date: Date;
}

export interface LineChartSeries {
  days: string[];
  primary: number[];
  secondary: number[];
  totals: { primary: number; secondary: number; other: number };
}

export interface HeatmapCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatmapMonthLabel {
  col: number;
  label: string;
}

export function buildHeatmapWeeks(cells: HeatmapCell[]): HeatmapCell[][] {
  const weeks: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

export function buildHeatmapMonthLabels(
  weeks: HeatmapCell[][],
  minGapCols = 3,
): HeatmapMonthLabel[] {
  const monthFirstCol = new Map<string, HeatmapMonthLabel>();

  weeks.forEach((week, col) => {
    for (const cell of week) {
      const d = new Date(`${cell.date}T12:00:00`);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const label = d.toLocaleString("en-US", { month: "short" });
      const existing = monthFirstCol.get(key);
      if (!existing || (d.getDate() === 1 && col < existing.col)) {
        monthFirstCol.set(key, { col, label });
      }
    }
  });

  const sorted = [...monthFirstCol.values()].sort((a, b) => a.col - b.col);
  const filtered: HeatmapMonthLabel[] = [];
  for (const item of sorted) {
    if (!filtered.length || item.col - filtered[filtered.length - 1].col >= minGapCols) {
      filtered.push(item);
    }
  }
  return filtered;
}

export interface SourceHealthRow {
  label: string;
  value: string;
}

export interface RemainingByType {
  type: RepoDashboardWorkType;
  open: number;
  done: number;
  needsPlan: number;
  total: number;
  pctLeft: number;
}

export const WORK_TYPE_COLORS: Record<RepoDashboardWorkType, string> = {
  roadmap: "#7fa786",
  feature: "#7e9ecf",
  gap: "#71b8b3",
  todo: "#9b87c7",
  fix: "#c3a767",
  note: "#9a9a9a",
};

export const ACTIVITY_BLUE = "#58a6ff";
export const ACTIVITY_GREEN = "#56d364";

export function authorIdentity(commit: RepoCommitEntry): string {
  const email = (commit.author_email || "").trim().toLowerCase();
  const name = (commit.author_name || "").trim().toLowerCase();
  return email || name || "unknown";
}

/** Map commit authors to primary/secondary by commit volume (top two). */
export function buildActivityActorMap(commits: RepoCommitEntry[]): Map<string, ActivityActor> {
  const counts = new Map<string, number>();
  for (const commit of commits) {
    const id = authorIdentity(commit);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const map = new Map<string, ActivityActor>();
  for (let i = 0; i < ranked.length; i += 1) {
    const [id] = ranked[i];
    if (i === 0) map.set(id, "primary");
    else if (i === 1) map.set(id, "secondary");
    else map.set(id, "other");
  }
  return map;
}

export function commitActor(
  commit: RepoCommitEntry,
  actorMap: Map<string, ActivityActor>,
): ActivityActor {
  return actorMap.get(authorIdentity(commit)) ?? "other";
}

export function eventsFromCommits(commits: RepoCommitEntry[]): ActivityEvent[] {
  const actorMap = buildActivityActorMap(commits);
  return commits
    .map(c => ({
      actor: commitActor(c, actorMap),
      date: new Date(c.authored_at * 1000),
    }))
    .filter(e => !Number.isNaN(e.date.getTime()));
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function buildLineChartData(events: ActivityEvent[]): LineChartSeries | null {
  const tracked = events.filter(e => e.actor === "primary" || e.actor === "secondary");
  if (!tracked.length) return null;

  const sorted = [...tracked].sort((a, b) => a.date.getTime() - b.date.getTime());
  const start = dayStart(sorted[0].date);
  const end = dayStart(sorted[sorted.length - 1].date);
  const days: string[] = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(isoDay(cursor));
  }

  const raw: Record<"primary" | "secondary", Record<string, number>> = {
    primary: {},
    secondary: {},
  };

  for (const event of tracked) {
    if (event.actor === "other") continue;
    const key = isoDay(event.date);
    raw[event.actor][key] = (raw[event.actor][key] ?? 0) + 1;
  }

  const primary: number[] = [];
  const secondary: number[] = [];
  let uTotal = 0;
  let hTotal = 0;
  for (const day of days) {
    uTotal += raw.primary[day] ?? 0;
    hTotal += raw.secondary[day] ?? 0;
    primary.push(uTotal);
    secondary.push(hTotal);
  }

  const other = events.filter(e => e.actor === "other").length;

  return {
    days,
    primary,
    secondary,
    totals: { primary: uTotal, secondary: hTotal, other },
  };
}

const HEATMAP_MIN_WEEKS = 53;
/** Up to ~10 years of weeks when loaded commits span longer than one year. */
const HEATMAP_MAX_WEEKS = 520;
const MS_PER_DAY = 86_400_000;

function heatmapWeekEndSaturday(d: Date): Date {
  const end = dayStart(d);
  end.setDate(end.getDate() + (6 - end.getDay()));
  return end;
}

export function buildHeatmapCells(commits: RepoCommitEntry[]): HeatmapCell[] {
  const dated = commits
    .map(c => new Date(c.authored_at * 1000))
    .filter(d => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (!dated.length) return [];

  const counts = new Map<string, number>();
  for (const d of dated) {
    const key = isoDay(d);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const firstCommit = dayStart(dated[0]);
  const lastCommit = dayStart(dated[dated.length - 1]);
  const today = dayStart(new Date());
  const rangeEnd = lastCommit > today ? lastCommit : today;
  const end = heatmapWeekEndSaturday(rangeEnd);

  let weeks = HEATMAP_MIN_WEEKS;
  let start = new Date(end);
  start.setDate(start.getDate() - (weeks * 7 - 1));

  if (firstCommit < start) {
    const daySpan = Math.floor((end.getTime() - firstCommit.getTime()) / MS_PER_DAY) + 1;
    weeks = Math.min(
      HEATMAP_MAX_WEEKS,
      Math.max(HEATMAP_MIN_WEEKS, Math.ceil(daySpan / 7)),
    );
    start = new Date(end);
    start.setDate(start.getDate() - (weeks * 7 - 1));
  }

  const cells: HeatmapCell[] = [];
  const values: number[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = isoDay(d);
    const count = counts.get(key) ?? 0;
    values.push(count);
    cells.push({ date: key, count, level: 0 });
  }

  const max = Math.max(1, ...values);
  return cells.map(cell => {
    if (cell.count === 0) return cell;
    const ratio = cell.count / max;
    const level = ratio > 0.75 ? 4 : ratio > 0.45 ? 3 : ratio > 0.2 ? 2 : 1;
    return { ...cell, level: level as HeatmapCell["level"] };
  });
}

export function buildRemainingByType(items: RepoDashboardWorkItem[]): RemainingByType[] {
  const types: RepoDashboardWorkType[] = ["roadmap", "feature", "gap", "todo", "fix", "note"];
  return types.map(type => {
    const all = items.filter(i => i.type === type);
    const open = all.filter(i => i.status !== "done");
    const done = all.filter(i => i.status === "done");
    const needsPlan = all.filter(i => i.needsPlan);
    const n = open.length;
    const pctLeft = all.length ? Math.round((n / all.length) * 100) : 0;
    return { type, open: n, done: done.length, needsPlan: needsPlan.length, total: all.length, pctLeft };
  });
}

/** Kretsverket-style doc lanes (source file), not generic parser types. */
export type DocWorkLaneId =
  | "backlog"
  | "known-gaps"
  | "roadmap"
  | "product"
  | "validation"
  | "github"
  | "other";

export const DOC_WORK_LANE_ORDER: DocWorkLaneId[] = [
  "backlog",
  "known-gaps",
  "roadmap",
  "product",
  "validation",
  "github",
  "other",
];

const DOC_LANE_META: Record<
  DocWorkLaneId,
  { label: string; description: string; pathHint: string; color: string }
> = {
  backlog: {
    label: "Backlog",
    description: "BL queue and actionable rows",
    pathHint: "docs/BACKLOG.md",
    color: WORK_TYPE_COLORS.todo,
  },
  "known-gaps": {
    label: "Known gaps",
    description: "Product & validation gaps",
    pathHint: "docs/KNOWN_GAPS.md",
    color: WORK_TYPE_COLORS.gap,
  },
  roadmap: {
    label: "Roadmap",
    description: "Phases and milestones",
    pathHint: "docs/ROADMAP.md",
    color: WORK_TYPE_COLORS.roadmap,
  },
  product: {
    label: "Product",
    description: "Feature specs under docs/product",
    pathHint: "docs/product/*.md",
    color: WORK_TYPE_COLORS.feature,
  },
  validation: {
    label: "Validation",
    description: "Checks and audit follow-ups",
    pathHint: "docs/VALIDATION.md",
    color: WORK_TYPE_COLORS.fix,
  },
  github: {
    label: "GitHub",
    description: "Open issues via gh CLI",
    pathHint: "gh issue list",
    color: "#58a6ff",
  },
  other: {
    label: "Other",
    description: "Misc parsed markers",
    pathHint: "other docs",
    color: WORK_TYPE_COLORS.note,
  },
};

export function workItemDocLane(item: RepoDashboardWorkItem): DocWorkLaneId {
  if (item.source === "issue") return "github";
  const path = item.path.toLowerCase();
  if (path.includes("known_gaps")) return "known-gaps";
  if (path.includes("backlog")) return "backlog";
  if (path.includes("roadmap")) return "roadmap";
  if (path.includes("validation")) return "validation";
  if (path.includes("docs/product/") || path.includes("features.md")) return "product";
  return "other";
}

export interface DocWorkLaneSummary {
  id: DocWorkLaneId;
  label: string;
  description: string;
  pathHint: string;
  color: string;
  open: number;
  started: number;
  done: number;
  needsPlan: number;
  total: number;
}

export function buildDocLaneSummaries(items: RepoDashboardWorkItem[]): DocWorkLaneSummary[] {
  return DOC_WORK_LANE_ORDER.map(id => {
    const laneItems = items.filter(i => workItemDocLane(i) === id);
    const open = laneItems.filter(i => i.status === "open").length;
    const started = laneItems.filter(i => i.status === "started").length;
    const done = laneItems.filter(i => i.status === "done").length;
    const needsPlan = laneItems.filter(i => i.needsPlan && i.status !== "done").length;
    const meta = DOC_LANE_META[id];
    return {
      id,
      label: meta.label,
      description: meta.description,
      pathHint: meta.pathHint,
      color: meta.color,
      open,
      started,
      done,
      needsPlan,
      total: laneItems.length,
    };
  }).filter(row => row.total > 0);
}

export function buildSourceHealth(
  snapshot: RepoDashboardSnapshot,
  workItems: RepoDashboardWorkItem[],
): SourceHealthRow[] {
  const done = workItems.filter(i => i.status === "done").length;
  const started = workItems.filter(i => i.status === "started").length;
  const open = workItems.filter(i => i.status === "open").length;
  const docsFound = snapshot.docs.filter(d => d.found).length;

  return [
    { label: "Repository", value: snapshot.is_repo ? "ok" : "not git" },
    { label: "Git CLI", value: snapshot.git_available ? "ok" : "missing" },
    { label: "Branch", value: snapshot.branch || "unknown" },
    { label: "Default branch", value: snapshot.default_branch ?? "unknown" },
    { label: "Dirty", value: snapshot.dirty ? "yes" : "no" },
    {
      label: "Remote sync",
      value:
        snapshot.ahead != null && snapshot.behind != null
          ? `+${snapshot.ahead}/-${snapshot.behind}`
          : "n/a",
    },
    { label: "Commits loaded", value: String(snapshot.commits.length) },
    { label: "Docs", value: `${docsFound}/${snapshot.docs.length}` },
    {
      label: "gh CLI",
      value: snapshot.gh.available
        ? snapshot.gh.authenticated
          ? "authenticated"
          : "not authenticated"
        : "not installed",
    },
    { label: "Done", value: String(done) },
    { label: "Started", value: String(started) },
    { label: "Open", value: String(open) },
    { label: "Warnings", value: String(snapshot.warnings.length) },
  ];
}

export function authorLabel(commit: RepoCommitEntry): string {
  return commit.author_name || commit.author_email || "unknown";
}

export function countByAuthor(commits: RepoCommitEntry[]): [string, number][] {
  const map = new Map<string, number>();
  for (const commit of commits) {
    const label = authorLabel(commit);
    map.set(label, (map.get(label) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

export function commitDateRangeLabel(commits: RepoCommitEntry[]): string | null {
  if (!commits.length) return null;
  const times = commits
    .map(c => c.authored_at * 1000)
    .filter(t => Number.isFinite(t));
  if (!times.length) return null;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const fmt = (t: number) =>
    new Date(t).toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });
  return min === max ? fmt(min) : `${fmt(min)} → ${fmt(max)}`;
}

/** Normalize repo paths for comparing user input to snapshot path. */
export function normalizeRepoPathForCompare(path: string): string {
  return path.trim().replace(/\/+$/, "");
}

export interface WorkStatusCounts {
  all: number;
  open: number;
  started: number;
  done: number;
}

export function buildWorkStatusCounts(items: RepoDashboardWorkItem[]): WorkStatusCounts {
  const counts: WorkStatusCounts = { all: items.length, open: 0, started: 0, done: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

export interface DocSourceSummary {
  path: string;
  found: boolean;
  readable: boolean;
  truncated: boolean;
  optional: boolean;
  itemCount: number;
  openCount: number;
  contributes: boolean;
  readError?: string;
}

export function buildDocSourceSummaries(
  docs: RepoDocFile[],
  workItems: RepoDashboardWorkItem[],
): DocSourceSummary[] {
  return docs.map(doc => {
    const fromDoc = workItems.filter(i => i.source === "docs" && i.path === doc.path);
    const openCount = fromDoc.filter(i => i.status !== "done").length;
    return {
      path: doc.path,
      found: doc.found,
      readable: doc.readable,
      truncated: doc.truncated,
      optional: isOptionalDocPath(doc.path),
      itemCount: fromDoc.length,
      openCount,
      contributes: doc.found && doc.readable && fromDoc.length > 0,
      readError: doc.read_error ?? undefined,
    };
  });
}

export interface ActivityLegendEntry {
  role: ActivityActor;
  label: string;
  commits: number;
}

/** Map primary/secondary roles to top commit author display names. */
export function buildActivityLegend(commits: RepoCommitEntry[]): ActivityLegendEntry[] {
  const actorMap = buildActivityActorMap(commits);
  const byRole = new Map<ActivityActor, { label: string; commits: number }>();

  for (const commit of commits) {
    const role = commitActor(commit, actorMap);
    if (role === "other") continue;
    const label = authorLabel(commit);
    const existing = byRole.get(role);
    if (!existing) {
      byRole.set(role, { label, commits: 1 });
    } else {
      existing.commits += 1;
    }
  }

  const order: ActivityActor[] = ["primary", "secondary"];
  return order
    .filter(role => byRole.has(role))
    .map(role => {
      const entry = byRole.get(role)!;
      return { role, label: entry.label, commits: entry.commits };
    });
}

export function repoDashboardBrandLabel(repoPath: string): string {
  const trimmed = repoPath.trim().replace(/\/+$/, "");
  if (!trimmed) return "repo.dashboard";
  const segment = trimmed.split("/").pop() || "repository";
  return `${segment}.repo.state`;
}

export function ghIssuesKpiLabel(ghAvailable: boolean, ghAuthenticated: boolean): string {
  if (!ghAvailable) return "gh issues (n/a)";
  if (!ghAuthenticated) return "gh issues (local-only)";
  return "open issues (gh)";
}
