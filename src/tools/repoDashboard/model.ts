import type {
  RepoChangedFile,
  RepoCommitEntry,
  RepoDashboardWorkItem,
  RepoDashboardWorkType,
  RepoDashboardCanonicalSource,
  RepoDocFile,
  RepoDocsSource,
} from "../../types";
import { isOptionalDocPath } from "./docsParser";
import { classifyDocRole, detectCanonicalWorkCanon, isActiveWorkDocRole } from "./docRoles";

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

/** Fixed overview heatmap display window — always the latest 26 weeks. */
export const HEATMAP_DISPLAY_WEEKS = 26;

export function sliceHeatmapCellsToWindow(cells: HeatmapCell[]): HeatmapCell[] {
  const maxCells = HEATMAP_DISPLAY_WEEKS * 7;
  if (cells.length <= maxCells) return cells;
  return cells.slice(cells.length - maxCells);
}

export function computeHeatmapCellSizePx(
  containerWidthPx: number,
  weekCount: number,
  options?: {
    dayLabelPx?: number;
    paddingPx?: number;
    gapPx?: number;
    minPx?: number;
    maxPx?: number;
  },
): number {
  const dayLabelPx = options?.dayLabelPx ?? 30;
  const paddingPx = options?.paddingPx ?? 16;
  const gapPx = options?.gapPx ?? 2;
  const minPx = options?.minPx ?? 8;
  const maxPx = options?.maxPx ?? 14;
  const weeks = Math.max(1, weekCount);
  const available = Math.max(0, containerWidthPx - dayLabelPx - paddingPx);
  const weekWidth = (available - Math.max(0, weeks - 1) * gapPx) / weeks;
  return Math.min(maxPx, Math.max(minPx, Math.floor(weekWidth)));
}

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

export type ActivityTimeRange = "30d" | "90d" | "1y" | "all";
export type ActivityChartMode = "period" | "cumulative";
export type ActivityInsightsVisualMode = "lines" | "bars";

/** Theme-aware CSS custom properties for per-contributor activity series. */
export const CONTRIBUTOR_CHART_SERIES_TOKENS = [
  "--repo-chart-series-1",
  "--repo-chart-series-2",
  "--repo-chart-series-3",
  "--repo-chart-series-4",
  "--repo-chart-series-5",
  "--repo-chart-series-6",
  "--repo-chart-series-7",
  "--repo-chart-series-8",
] as const;

export function contributorChartColorToken(colorIndex: number): string {
  const tokens = CONTRIBUTOR_CHART_SERIES_TOKENS;
  return tokens[((colorIndex % tokens.length) + tokens.length) % tokens.length];
}

export function contributorChartColor(colorIndex: number): string {
  return `var(${contributorChartColorToken(colorIndex)})`;
}

const CONTRIBUTOR_CHART_COLOR_ALIASES: ReadonlyArray<{
  aliases: readonly string[];
  colorIndex: number;
}> = [];

function contributorMatchesAlias(id: string, displayName: string, aliases: readonly string[]): boolean {
  const haystack = `${id} ${displayName}`.toLowerCase();
  return aliases.some(alias => haystack.includes(alias));
}

/** Stable chart colors for known contributors; falls back to list order. */
export function contributorColorIndexFor(
  id: string,
  displayName: string,
  fallbackIndex: number,
): number {
  for (const entry of CONTRIBUTOR_CHART_COLOR_ALIASES) {
    if (contributorMatchesAlias(id, displayName, entry.aliases)) return entry.colorIndex;
  }
  return fallbackIndex;
}

export function clampActiveDayIndex(index: number, dayCount: number): number {
  if (dayCount <= 0) return 0;
  return Math.max(0, Math.min(dayCount - 1, Math.trunc(index)));
}

export type ActivityChartKeyAction = "prev" | "next" | "first" | "last" | "clear";

export function activityChartKeyAction(key: string): ActivityChartKeyAction | null {
  switch (key) {
    case "ArrowLeft":
      return "prev";
    case "ArrowRight":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Escape":
      return "clear";
    default:
      return null;
  }
}

export function applyActivityChartKeyAction(
  current: number | null,
  action: ActivityChartKeyAction,
  dayCount: number,
): number | null {
  if (dayCount <= 0) return null;
  switch (action) {
    case "prev":
      return current === null ? dayCount - 1 : clampActiveDayIndex(current - 1, dayCount);
    case "next":
      return current === null ? 0 : clampActiveDayIndex(current + 1, dayCount);
    case "first":
      return 0;
    case "last":
      return dayCount - 1;
    case "clear":
      return null;
  }
}

export function activityChartDayX(
  index: number,
  dayCount: number,
  plotLeft: number,
  plotRight: number,
  plotWidth: number,
  mode: ActivityInsightsVisualMode,
): number {
  const innerWidth = plotWidth - plotLeft - plotRight;
  if (mode === "bars") {
    const slotWidth = dayCount > 0 ? innerWidth / dayCount : 0;
    return plotLeft + index * slotWidth + slotWidth / 2;
  }
  return dayCount === 1 ? plotLeft + innerWidth / 2 : plotLeft + (index * innerWidth) / (dayCount - 1);
}

export function nearestActivityDayIndex(
  svgX: number,
  dayCount: number,
  plotLeft: number,
  plotRight: number,
  plotWidth: number,
  mode: ActivityInsightsVisualMode,
): number {
  if (dayCount <= 0) return 0;
  const innerWidth = plotWidth - plotLeft - plotRight;
  if (mode === "bars") {
    const slotWidth = innerWidth / dayCount;
    return clampActiveDayIndex(Math.floor((svgX - plotLeft) / slotWidth), dayCount);
  }
  let nearest = 0;
  let minDist = Infinity;
  for (let i = 0; i < dayCount; i++) {
    const x = activityChartDayX(i, dayCount, plotLeft, plotRight, plotWidth, mode);
    const dist = Math.abs(svgX - x);
    if (dist < minDist) {
      minDist = dist;
      nearest = i;
    }
  }
  return nearest;
}

export interface ContributorDailyPoint {
  date: string;
  commitCount: number;
}

export interface ContributorActivitySeries {
  id: string;
  displayName: string;
  colorIndex: number;
  totalCommits: number;
  points: ContributorDailyPoint[];
}

export type ActivityInsightsRangeDays = 7 | 14 | 30;

export const DEFAULT_ACTIVITY_INSIGHTS_DAYS: ActivityInsightsRangeDays = 30;

export const ACTIVITY_INSIGHTS_RANGE_DAYS: readonly ActivityInsightsRangeDays[] = [7, 14, 30];

export function isActivityInsightsRangeDays(
  value: number,
): value is ActivityInsightsRangeDays {
  return value === 7 || value === 14 || value === 30;
}

export function filterCommitsForActivityInsights(
  commits: RepoCommitEntry[],
  days: ActivityInsightsRangeDays = DEFAULT_ACTIVITY_INSIGHTS_DAYS,
  now = new Date(),
): RepoCommitEntry[] {
  const cutoff = dayStart(now);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffSecs = Math.floor(cutoff.getTime() / 1000);
  return commits.filter(c => Number.isFinite(c.authored_at) && c.authored_at >= cutoffSecs);
}

export function activityInsightsRangeFooterText(days: ActivityInsightsRangeDays): string {
  return `${days}-day local git activity`;
}

export function activityInsightsChartTitle(days: ActivityInsightsRangeDays): string {
  return `Contributor commits per day — last ${days} days`;
}

export function activityInsightsChartDescription(
  days: ActivityInsightsRangeDays,
  mode: ActivityInsightsVisualMode,
): string {
  const chartKind = mode === "lines" ? "Line chart" : "Grouped bar chart";
  return `${chartKind} of daily commits per contributor over the last ${days} days. Use arrow keys to move between dates when the chart plot is focused.`;
}

/** Deterministic x-axis label indices; always includes first and last day. */
export function activityChartXAxisLabelIndices(dayCount: number): number[] {
  if (dayCount <= 0) return [];
  if (dayCount === 1) return [0];

  const step =
    dayCount <= 7 ? 1 : dayCount <= 14 ? 2 : Math.ceil(dayCount / 7);

  const indices: number[] = [];
  for (let index = 0; index < dayCount; index += step) {
    indices.push(index);
  }
  if (indices[indices.length - 1] !== dayCount - 1) {
    indices.push(dayCount - 1);
  }
  return indices;
}

export function reconcileActiveDayIndexOnRangeChange(
  activeIndex: number | null,
  nextDayCount: number,
): number | null {
  if (activeIndex === null || nextDayCount <= 0) return null;
  if (activeIndex >= nextDayCount) return null;
  return activeIndex;
}

export function activityTimeRangeCutoffSecs(
  range: ActivityTimeRange,
  now = new Date(),
): number | null {
  if (range === "all") return null;
  const days = range === "30d" ? 30 : range === "90d" ? 90 : 365;
  const cutoff = dayStart(now);
  cutoff.setDate(cutoff.getDate() - days);
  return Math.floor(cutoff.getTime() / 1000);
}

export function filterCommitsByTimeRange(
  commits: RepoCommitEntry[],
  range: ActivityTimeRange,
  now = new Date(),
): RepoCommitEntry[] {
  const cutoff = activityTimeRangeCutoffSecs(range, now);
  if (cutoff == null) return commits;
  return commits.filter(c => Number.isFinite(c.authored_at) && c.authored_at >= cutoff);
}

export function filterCommitsByContributor(
  commits: RepoCommitEntry[],
  contributorId: "all" | string,
): RepoCommitEntry[] {
  if (contributorId === "all") return commits;
  return commits.filter(c => authorIdentity(c) === contributorId);
}

export interface ActivityInsightsPoint {
  date: string;
  commitCount: number;
  cumulativeCount: number;
}

export function activityInsightsChartValue(
  point: ActivityInsightsPoint,
  mode: ActivityChartMode,
): number {
  return mode === "cumulative" ? point.cumulativeCount : point.commitCount;
}

export function buildActivityInsightsSeries(
  commits: RepoCommitEntry[],
): ActivityInsightsPoint[] {
  const dated = commits
    .filter(c => Number.isFinite(c.authored_at))
    .sort((a, b) => a.authored_at - b.authored_at);
  if (!dated.length) return [];

  const counts = new Map<string, number>();
  for (const commit of dated) {
    const key = isoDay(new Date(commit.authored_at * 1000));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const start = dayStart(new Date(dated[0].authored_at * 1000));
  const lastCommit = dayStart(new Date(dated[dated.length - 1].authored_at * 1000));
  const today = dayStart(new Date());
  const rangeEnd = lastCommit > today ? lastCommit : today;

  const points: ActivityInsightsPoint[] = [];
  let cumulative = 0;
  for (let cursor = new Date(start); cursor <= rangeEnd; cursor.setDate(cursor.getDate() + 1)) {
    const key = isoDay(cursor);
    const commitCount = counts.get(key) ?? 0;
    cumulative += commitCount;
    points.push({ date: key, commitCount, cumulativeCount: cumulative });
  }
  return points;
}

/** Fixed calendar window ending today, including zero-commit days. */
export function buildActivityInsightsSeriesForDays(
  commits: RepoCommitEntry[],
  days: ActivityInsightsRangeDays = DEFAULT_ACTIVITY_INSIGHTS_DAYS,
  now = new Date(),
): ActivityInsightsPoint[] {
  const rangeEnd = dayStart(now);
  const start = new Date(rangeEnd);
  start.setDate(start.getDate() - (days - 1));

  const counts = new Map<string, number>();
  for (const commit of commits) {
    if (!Number.isFinite(commit.authored_at)) continue;
    const key = isoDay(new Date(commit.authored_at * 1000));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const points: ActivityInsightsPoint[] = [];
  let cumulative = 0;
  for (let cursor = new Date(start); cursor <= rangeEnd; cursor.setDate(cursor.getDate() + 1)) {
    const key = isoDay(cursor);
    const commitCount = counts.get(key) ?? 0;
    cumulative += commitCount;
    points.push({ date: key, commitCount, cumulativeCount: cumulative });
  }
  return points;
}

function buildFixedDayKeys(
  days: number,
  now: Date,
): string[] {
  const rangeEnd = dayStart(now);
  const start = new Date(rangeEnd);
  start.setDate(start.getDate() - (days - 1));
  const keys: string[] = [];
  for (let cursor = new Date(start); cursor <= rangeEnd; cursor.setDate(cursor.getDate() + 1)) {
    keys.push(isoDay(cursor));
  }
  return keys;
}

/** One independent series per contributor, zero-filled per day. */
export function buildContributorActivitySeries(
  commits: RepoCommitEntry[],
  days: ActivityInsightsRangeDays = DEFAULT_ACTIVITY_INSIGHTS_DAYS,
  now = new Date(),
): ContributorActivitySeries[] {
  const stats = buildContributorStats(commits);
  if (!stats.length) return [];

  const dayKeys = buildFixedDayKeys(days, now);
  const countsByContributor = new Map<string, Map<string, number>>();

  for (const commit of commits) {
    if (!Number.isFinite(commit.authored_at)) continue;
    const id = authorIdentity(commit);
    const key = isoDay(new Date(commit.authored_at * 1000));
    const bucket = countsByContributor.get(id) ?? new Map<string, number>();
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
    countsByContributor.set(id, bucket);
  }

  return stats.map((stat, index) => {
    const colorIndex = contributorColorIndexFor(stat.id, stat.displayName, index);
    const daily = countsByContributor.get(stat.id);
    const points = dayKeys.map(date => ({
      date,
      commitCount: daily?.get(date) ?? 0,
    }));
    const totalCommits = points.reduce((sum, point) => sum + point.commitCount, 0);
    return {
      id: stat.id,
      displayName: stat.displayName,
      colorIndex,
      totalCommits,
      points,
    };
  });
}

export function filterContributorActivitySeries(
  series: ContributorActivitySeries[],
  visibleIds: ReadonlySet<string> | readonly string[],
): ContributorActivitySeries[] {
  const ids = visibleIds instanceof Set ? visibleIds : new Set(visibleIds);
  return series.filter(entry => ids.has(entry.id));
}

export function defaultVisibleContributorIds(series: ContributorActivitySeries[]): string[] {
  return series.map(entry => entry.id);
}

/** Drop stale IDs; if none remain, select all currently available contributors. */
export function reconcileVisibleContributorIds(
  visibleIds: readonly string[],
  availableIds: readonly string[],
): string[] {
  const available = new Set(availableIds);
  const pruned = visibleIds.filter(id => available.has(id));
  if (!pruned.length && availableIds.length) return [...availableIds];
  return pruned;
}

export function visibleContributorSeriesMax(series: ContributorActivitySeries[]): number {
  let max = 0;
  for (const entry of series) {
    for (const point of entry.points) {
      if (point.commitCount > max) max = point.commitCount;
    }
  }
  return Math.max(1, max);
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

/** Documentation source lanes (source file), not generic parser types. */
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


export function authorLabel(commit: RepoCommitEntry): string {
  return commit.author_name || commit.author_email || "unknown";
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
  const canonical = detectCanonicalWorkCanon(docs);
  return docs.map(doc => {
    const role = classifyDocRole(doc.path, doc.content);
    const fromDoc = workItems.filter(i => i.source === "docs" && i.path === doc.path);
    const openCount = fromDoc.filter(i => i.status !== "done").length;
    const contributes =
      doc.found &&
      doc.readable &&
      fromDoc.length > 0 &&
      (!canonical || isActiveWorkDocRole(role));
    return {
      path: doc.path,
      found: doc.found,
      readable: doc.readable,
      truncated: doc.truncated,
      optional: isOptionalDocPath(doc.path),
      itemCount: fromDoc.length,
      openCount,
      contributes,
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

export function docsSourceLabel(source: RepoDocsSource): string {
  switch (source) {
    case "remote":
      return "Remote default branch";
    case "cached-remote":
      return "Cached remote ref";
    case "local-fallback":
      return "Local checkout";
  }
}

export function docsSourceWarning(source: RepoDocsSource, stale: boolean): string | null {
  if (source === "cached-remote" && stale) {
    return "Documentation loaded from cached remote ref — fetch failed.";
  }
  if (source === "local-fallback" && stale) {
    return "Documentation loaded from local checkout — remote ref unavailable.";
  }
  return null;
}

/** Omit repository warnings duplicated by structured docs source metadata. */
export function filterDocsSnapshotWarnings(
  warnings: readonly string[],
  docsSource: RepoDocsSource,
): string[] {
  const skip = new Set<string>();
  if (docsSource === "cached-remote") {
    skip.add("Could not fetch latest documentation from origin — showing cached remote ref.");
  }
  if (docsSource === "local-fallback") {
    skip.add("No remote documentation ref available — using local checkout.");
  }
  return warnings.filter(w => !skip.has(w));
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

export const CONVENTIONAL_COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "test",
  "chore",
  "refactor",
  "perf",
  "build",
  "ci",
] as const;

export type ConventionalCommitType = (typeof CONVENTIONAL_COMMIT_TYPES)[number] | "other";

export interface ParsedConventionalSubject {
  type: ConventionalCommitType;
  scope: string | null;
}

const CONVENTIONAL_SUBJECT_RE = /^([a-z]+)(?:\(([a-z0-9._-]+)\))?!?:\s/i;

export function parseConventionalCommitSubject(subject: string): ParsedConventionalSubject {
  const match = subject.match(CONVENTIONAL_SUBJECT_RE);
  if (!match) return { type: "other", scope: null };
  const rawType = match[1].toLowerCase();
  const type = (CONVENTIONAL_COMMIT_TYPES as readonly string[]).includes(rawType)
    ? (rawType as ConventionalCommitType)
    : "other";
  return { type, scope: match[2] ?? null };
}

function emptyTypeCounts(): Record<ConventionalCommitType, number> {
  return {
    feat: 0,
    fix: 0,
    docs: 0,
    test: 0,
    chore: 0,
    refactor: 0,
    perf: 0,
    build: 0,
    ci: 0,
    other: 0,
  };
}

export interface ContributorStat {
  id: string;
  displayName: string;
  commitCount: number;
  percentage: number;
  firstCommitAt: number | null;
  latestCommitAt: number | null;
  mergeCommitCount: number;
  typeCounts: Record<ConventionalCommitType, number>;
  scopeCounts: Record<string, number>;
}

function topCountLabels(counts: Record<string, number>, limit = 3): string {
  const ranked = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked.slice(0, limit).map(([label, count]) => `${label} ${count}`).join(", ");
}

export function contributorTopTypes(stat: ContributorStat): string {
  return topCountLabels(stat.typeCounts as Record<string, number>);
}

export function buildContributorStats(commits: RepoCommitEntry[]): ContributorStat[] {
  if (!commits.length) return [];

  type Bucket = {
    names: Map<string, number>;
    commitCount: number;
    mergeCommitCount: number;
    firstCommitAt: number | null;
    latestCommitAt: number | null;
    typeCounts: Record<ConventionalCommitType, number>;
    scopeCounts: Record<string, number>;
  };

  const buckets = new Map<string, Bucket>();

  for (const commit of commits) {
    const id = authorIdentity(commit);
    const bucket =
      buckets.get(id) ??
      {
        names: new Map<string, number>(),
        commitCount: 0,
        mergeCommitCount: 0,
        firstCommitAt: null,
        latestCommitAt: null,
        typeCounts: emptyTypeCounts(),
        scopeCounts: {},
      };

    const label = authorLabel(commit);
    bucket.names.set(label, (bucket.names.get(label) ?? 0) + 1);
    bucket.commitCount += 1;
    if (commit.is_merge) bucket.mergeCommitCount += 1;

    const authoredAt = commit.authored_at;
    if (Number.isFinite(authoredAt)) {
      bucket.firstCommitAt =
        bucket.firstCommitAt == null ? authoredAt : Math.min(bucket.firstCommitAt, authoredAt);
      bucket.latestCommitAt =
        bucket.latestCommitAt == null ? authoredAt : Math.max(bucket.latestCommitAt, authoredAt);
    }

    const parsed = parseConventionalCommitSubject(commit.subject);
    bucket.typeCounts[parsed.type] += 1;
    if (parsed.scope) {
      bucket.scopeCounts[parsed.scope] = (bucket.scopeCounts[parsed.scope] ?? 0) + 1;
    }

    buckets.set(id, bucket);
  }

  const total = commits.length;
  const stats: ContributorStat[] = [...buckets.entries()].map(([id, bucket]) => {
    const displayName =
      [...bucket.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
      id;
    return {
      id,
      displayName,
      commitCount: bucket.commitCount,
      percentage: Math.round((bucket.commitCount / total) * 1000) / 10,
      firstCommitAt: bucket.firstCommitAt,
      latestCommitAt: bucket.latestCommitAt,
      mergeCommitCount: bucket.mergeCommitCount,
      typeCounts: bucket.typeCounts,
      scopeCounts: bucket.scopeCounts,
    };
  });

  return stats.sort((a, b) => {
    if (b.commitCount !== a.commitCount) return b.commitCount - a.commitCount;
    const latestA = a.latestCommitAt ?? 0;
    const latestB = b.latestCommitAt ?? 0;
    if (latestB !== latestA) return latestB - latestA;
    return a.displayName.localeCompare(b.displayName);
  });
}

export interface WorkPartition {
  activeStarted: RepoDashboardWorkItem[];
  activeOpen: RepoDashboardWorkItem[];
  done: RepoDashboardWorkItem[];
}

export function compareWorkItems(
  a: RepoDashboardWorkItem,
  b: RepoDashboardWorkItem,
): number {
  const laneOrder = DOC_WORK_LANE_ORDER.indexOf(workItemDocLane(a)) -
    DOC_WORK_LANE_ORDER.indexOf(workItemDocLane(b));
  if (laneOrder !== 0) return laneOrder;
  const pathCmp = a.path.localeCompare(b.path);
  if (pathCmp !== 0) return pathCmp;
  const lineCmp = (a.line ?? 0) - (b.line ?? 0);
  if (lineCmp !== 0) return lineCmp;
  return a.text.localeCompare(b.text);
}

export function partitionWorkItems(items: RepoDashboardWorkItem[]): WorkPartition {
  const activeStarted = items.filter(i => i.status === "started").sort(compareWorkItems);
  const activeOpen = items.filter(i => i.status === "open").sort(compareWorkItems);
  const done = items.filter(i => i.status === "done").sort(compareWorkItems);
  return { activeStarted, activeOpen, done };
}

export function activeWorkCount(partition: WorkPartition): number {
  return partition.activeStarted.length + partition.activeOpen.length;
}

// --- Canonical work queue ---

export function isCanonicalWorkMode(docs: readonly RepoDocFile[]): boolean {
  return detectCanonicalWorkCanon(docs);
}

export function workItemCanonicalSource(
  item: RepoDashboardWorkItem,
): RepoDashboardCanonicalSource | "other" {
  if (item.canonicalSource) return item.canonicalSource;
  if (item.source === "issue") return "github";
  return "other";
}

export interface CanonicalWorkPartition {
  bugs: RepoDashboardWorkItem[];
  verify: RepoDashboardWorkItem[];
  enhancements: RepoDashboardWorkItem[];
  other: RepoDashboardWorkItem[];
}

export function partitionCanonicalWorkItems(
  items: RepoDashboardWorkItem[],
): CanonicalWorkPartition {
  const sort = (list: RepoDashboardWorkItem[]) =>
    [...list].sort((a, b) => {
      const pri = comparePriority(a.priority, b.priority);
      if (pri !== 0) return pri;
      const idCmp = (a.workId ?? a.text).localeCompare(b.workId ?? b.text);
      if (idCmp !== 0) return idCmp;
      return (a.line ?? 0) - (b.line ?? 0);
    });

  const bugs = sort(items.filter(i => i.classification === "bug"));
  const verify = sort(items.filter(i => i.classification === "verify"));
  const enhancements = sort(items.filter(i => i.classification === "enhancement"));
  const other = sort(
    items.filter(
      i =>
        i.classification !== "bug" &&
        i.classification !== "verify" &&
        i.classification !== "enhancement",
    ),
  );
  return { bugs, verify, enhancements, other };
}

const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function comparePriority(a?: string, b?: string): number {
  const pa = (a ?? "").trim().toLowerCase();
  const pb = (b ?? "").trim().toLowerCase();
  const oa = PRIORITY_ORDER[pa] ?? 3;
  const ob = PRIORITY_ORDER[pb] ?? 3;
  if (oa !== ob) return oa - ob;
  return pa.localeCompare(pb);
}

export type CanonicalSourceFilter = RepoDashboardCanonicalSource | "all";
export type PriorityFilter = "all" | "high" | "medium" | "low" | "unspecified";

export function normalizePriorityValue(priority?: string): PriorityFilter {
  const low = (priority ?? "").trim().toLowerCase();
  if (low === "high" || low === "medium" || low === "low") return low;
  return "unspecified";
}

export function filterWorkItemsByCanonicalSource(
  items: RepoDashboardWorkItem[],
  source: CanonicalSourceFilter,
): RepoDashboardWorkItem[] {
  if (source === "all") return items;
  return items.filter(i => workItemCanonicalSource(i) === source);
}

export function filterWorkItemsByPriority(
  items: RepoDashboardWorkItem[],
  priority: PriorityFilter,
): RepoDashboardWorkItem[] {
  if (priority === "all") return items;
  return items.filter(i => normalizePriorityValue(i.priority) === priority);
}

export interface CanonicalWorkSummary {
  displayed: number;
  total: number;
  bugs: number;
  verify: number;
  enhancements: number;
  other: number;
}

export function buildCanonicalWorkSummary(
  allItems: RepoDashboardWorkItem[],
  displayedItems: RepoDashboardWorkItem[],
): CanonicalWorkSummary {
  const partition = partitionCanonicalWorkItems(allItems);
  return {
    displayed: displayedItems.length,
    total: allItems.length,
    bugs: partition.bugs.length,
    verify: partition.verify.length,
    enhancements: partition.enhancements.length,
    other: partition.other.length,
  };
}

export function activeDocWorkCount(items: RepoDashboardWorkItem[]): number {
  return items.filter(i => i.source === "docs" && i.status !== "done").length;
}

export { docRoleLabel, classifyDocRole, compareDocsByRole } from "./docRoles";
export type { DocRole } from "./docRoles";

export type ChangedFileStatusKind = "added" | "modified" | "deleted" | "other";

export interface HeadFileStatusBreakdown {
  added: number;
  modified: number;
  deleted: number;
  other: number;
  total: number;
}

export function classifyChangedFileStatus(status: string): ChangedFileStatusKind {
  const code = status.trim().charAt(0).toUpperCase();
  if (code === "A") return "added";
  if (code === "M") return "modified";
  if (code === "D") return "deleted";
  return "other";
}

export function buildHeadFileStatusBreakdown(files: RepoChangedFile[]): HeadFileStatusBreakdown {
  const breakdown: HeadFileStatusBreakdown = {
    added: 0,
    modified: 0,
    deleted: 0,
    other: 0,
    total: files.length,
  };
  for (const file of files) {
    breakdown[classifyChangedFileStatus(file.status)] += 1;
  }
  return breakdown;
}

export function summarizeHeadFileBreakdown(breakdown: HeadFileStatusBreakdown): string {
  if (!breakdown.total) return "none";
  const parts: string[] = [];
  if (breakdown.added) parts.push(`${breakdown.added} added`);
  if (breakdown.modified) parts.push(`${breakdown.modified} modified`);
  if (breakdown.deleted) parts.push(`${breakdown.deleted} deleted`);
  if (breakdown.other) parts.push(`${breakdown.other} other`);
  return parts.join(" · ") || `${breakdown.total} files`;
}

export function formatAheadBehind(ahead: number | null, behind: number | null): string | null {
  if (ahead == null && behind == null) return null;
  const a = ahead ?? 0;
  const b = behind ?? 0;
  if (!a && !b) return "up to date with upstream";
  const parts: string[] = [];
  if (a) parts.push(`${a} ahead`);
  if (b) parts.push(`${b} behind`);
  return parts.join(", ");
}

export function formatRelativeAgeFromMs(ms: number, now = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  if (diffSec < 2_629_800) return `${Math.floor(diffSec / 604800)}w ago`;
  return `${Math.floor(diffSec / 2_629_800)}mo ago`;
}

export function formatRelativeAgeFromUnix(sec: number, now = Date.now()): string {
  return formatRelativeAgeFromMs(sec * 1000, now);
}

export function formatRelativeAgeFromIso(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return formatRelativeAgeFromMs(ms, now);
}

export function prBodyExcerpt(body: string, limit = 240): string {
  const trimmed = body.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}…`;
}
