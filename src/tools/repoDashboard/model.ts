import type {
  RepoCommitEntry,
  RepoDashboardSnapshot,
  RepoDashboardWorkItem,
  RepoDashboardWorkType,
} from "../../types";

export type ActivityActor = "uxsmedjan" | "PRIVATE" | "other";

export interface ActivityEvent {
  actor: ActivityActor;
  date: Date;
}

export interface LineChartSeries {
  days: string[];
  uxsmedjan: number[];
  PRIVATE: number[];
  totals: { uxsmedjan: number; PRIVATE: number; other: number };
}

export interface HeatmapCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
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

export function normalizeAuthor(value: string): ActivityActor {
  const v = value.toLowerCase();
  if (/hellq|PRIVATE|hellquist413/.test(v)) return "PRIVATE";
  if (/uxsmedjan|uxsme|PRIVATE|PRIVATE|c\.PRIVATE/.test(v)) return "uxsmedjan";
  return "other";
}

export function commitActor(commit: RepoCommitEntry): ActivityActor {
  return normalizeAuthor([commit.author_name, commit.author_email].filter(Boolean).join(" "));
}

export function eventsFromCommits(commits: RepoCommitEntry[]): ActivityEvent[] {
  return commits
    .map(c => ({ actor: commitActor(c), date: new Date(c.authored_at * 1000) }))
    .filter(e => !Number.isNaN(e.date.getTime()));
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function buildLineChartData(events: ActivityEvent[]): LineChartSeries | null {
  const tracked = events.filter(e => e.actor === "uxsmedjan" || e.actor === "PRIVATE");
  if (!tracked.length) return null;

  const sorted = [...tracked].sort((a, b) => a.date.getTime() - b.date.getTime());
  const start = dayStart(sorted[0].date);
  const end = dayStart(sorted[sorted.length - 1].date);
  const days: string[] = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(isoDay(cursor));
  }

  const raw: Record<"uxsmedjan" | "PRIVATE", Record<string, number>> = {
    uxsmedjan: {},
    PRIVATE: {},
  };

  for (const event of tracked) {
    if (event.actor === "other") continue;
    const key = isoDay(event.date);
    raw[event.actor][key] = (raw[event.actor][key] ?? 0) + 1;
  }

  const uxsmedjan: number[] = [];
  const PRIVATE: number[] = [];
  let uTotal = 0;
  let hTotal = 0;
  for (const day of days) {
    uTotal += raw.uxsmedjan[day] ?? 0;
    hTotal += raw.PRIVATE[day] ?? 0;
    uxsmedjan.push(uTotal);
    PRIVATE.push(hTotal);
  }

  const other = events.filter(e => e.actor === "other").length;

  return {
    days,
    uxsmedjan,
    PRIVATE,
    totals: { uxsmedjan: uTotal, PRIVATE: hTotal, other },
  };
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

  const end = dayStart(dated[dated.length - 1]);
  end.setDate(end.getDate() + (6 - end.getDay()));
  const weeks = 53;
  const start = new Date(end);
  start.setDate(start.getDate() - (weeks * 7 - 1));

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
