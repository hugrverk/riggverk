import assert from "node:assert/strict";
import type { RepoCommitEntry } from "../src/types";
import {
  buildActivityActorMap,
  buildActivityLegend,
  buildDocSourceSummaries,
  buildHeatmapCells,
  buildHeatmapMonthLabels,
  buildHeatmapWeeks,
  computeHeatmapCellSizePx,
  filterCommitsForActivityInsights,
  HEATMAP_DISPLAY_WEEKS,
  ACTIVITY_INSIGHTS_DAYS,
  sliceHeatmapCellsToWindow,
  buildLineChartData,
  buildActivityInsightsSeries,
  buildActivityInsightsSeriesForDays,
  buildContributorActivitySeries,
  filterContributorActivitySeries,
  defaultVisibleContributorIds,
  reconcileVisibleContributorIds,
  visibleContributorSeriesMax,
  contributorChartColor,
  filterCommitsByContributor,
  filterCommitsByTimeRange,
  activityInsightsChartValue,
  buildDocLaneSummaries,
  buildRemainingByType,
  workItemDocLane,
  buildWorkStatusCounts,
  commitActor,
  eventsFromCommits,
  ghIssuesKpiLabel,
  normalizeRepoPathForCompare,
  repoDashboardBrandLabel,
  buildContributorStats,
  parseConventionalCommitSubject,
  partitionWorkItems,
  compareWorkItems,
  activeWorkCount,
  contributorTopTypes,
  buildHeadFileStatusBreakdown,
  classifyChangedFileStatus,
  formatAheadBehind,
  formatRelativeAgeFromUnix,
  prBodyExcerpt,
} from "../src/tools/repoDashboard/model";

function commit(
  overrides: Partial<RepoCommitEntry> & Pick<RepoCommitEntry, "authored_at">,
): RepoCommitEntry {
  return {
    sha: "abc",
    short_sha: "abc",
    author_name: "Alice",
    author_email: "alice@example.com",
    subject: "test",
    is_merge: false,
    ...overrides,
  };
}

// Dynamic authors: two distinct authors produce a chart (not hardcoded regex).
{
  const commits = [
    commit({ authored_at: 1_700_000_000, author_name: "Alice", author_email: "a@x.com" }),
    commit({ authored_at: 1_700_086_400, author_name: "Bob", author_email: "b@x.com" }),
  ];
  const events = eventsFromCommits(commits);
  assert.ok(events.some(e => e.actor === "primary"));
  assert.ok(events.some(e => e.actor === "secondary"));
  const chart = buildLineChartData(events);
  assert.ok(chart);
  assert.ok(chart!.days.length >= 1);
}

// Single author still charts as primary.
{
  const commits = [commit({ authored_at: 1_700_000_000 })];
  const chart = buildLineChartData(eventsFromCommits(commits));
  assert.ok(chart);
  assert.equal(chart!.totals.primary, 1);
}

// Invalid timestamps are dropped.
{
  const events = eventsFromCommits([
    commit({ authored_at: Number.NaN }),
    commit({ authored_at: 1_700_000_000 }),
  ]);
  assert.equal(events.length, 1);
}

// Empty commits: heatmap empty, line chart null.
assert.deepEqual(buildHeatmapCells([]), []);
assert.equal(buildLineChartData([]), null);

// Heatmap month labels tolerate short week grids.
{
  const cells = buildHeatmapCells([commit({ authored_at: 1_700_000_000 })]);
  const weeks = buildHeatmapWeeks(cells);
  assert.ok(buildHeatmapMonthLabels(weeks).length >= 0);
}

// Heatmap defaults to one year ending at today for recent commits.
{
  const nowSec = Math.floor(Date.now() / 1000);
  const cells = buildHeatmapCells([commit({ authored_at: nowSec })]);
  assert.equal(cells.length, 53 * 7);
}

{
  const nowSec = Math.floor(Date.now() / 1000);
  const yearAgo = nowSec - 400 * 86_400;
  const cells = buildHeatmapCells([
    commit({ authored_at: yearAgo }),
    commit({ authored_at: nowSec }),
  ]);
  assert.ok(cells.length > 53 * 7, "year-spanning commits should extend past 53 weeks");
  assert.ok(cells.length <= 520 * 7, "heatmap week grid has an upper bound");
  assert.equal(cells[cells.length - 1].date.slice(0, 4), new Date(nowSec * 1000).getFullYear().toString());
}

{
  const cells = buildHeatmapCells([commit({ authored_at: 1_700_000_000 })]);
  const sliced = sliceHeatmapCellsToWindow(cells);
  assert.equal(HEATMAP_DISPLAY_WEEKS, 26);
  assert.equal(sliced.length, 26 * 7);
  const newestWeek = buildHeatmapWeeks(sliced).at(-1);
  assert.ok(newestWeek?.length === 7);
  assert.equal(buildHeatmapWeeks(sliced).length, 26, "display window keeps exactly 26 week columns");
  const fullWeeks = buildHeatmapWeeks(cells);
  const slicedWeeks = buildHeatmapWeeks(sliced);
  assert.deepEqual(
    slicedWeeks.at(-1)?.map(cell => cell.date),
    fullWeeks.at(-1)?.map(cell => cell.date),
    "newest week is retained when slicing to the display window",
  );
  const cellSize = computeHeatmapCellSizePx(400, 26);
  assert.ok(cellSize >= 8);
  assert.ok(cellSize <= 14);
  assert.ok(computeHeatmapCellSizePx(320, 26) >= 6);
  const gridWidth =
    26 * cellSize + Math.max(0, 26 - 1) * 2 + 30 + 24;
  assert.ok(gridWidth <= 400, "26-week square grid fits without horizontal scroll contract");
}

{
  const nowSec = Math.floor(Date.now() / 1000);
  const commits = [
    commit({ authored_at: nowSec - 10 * 86_400 }),
    commit({ authored_at: nowSec - 100 * 86_400 }),
  ];
  const filtered = filterCommitsForActivityInsights(commits);
  assert.equal(filtered.length, 1);
  const windowSeries = buildActivityInsightsSeriesForDays(filtered, ACTIVITY_INSIGHTS_DAYS);
  assert.equal(windowSeries.length, ACTIVITY_INSIGHTS_DAYS);
  assert.equal(windowSeries[0].commitCount, 0);
  assert.ok(windowSeries.some(point => point.commitCount > 0));
}

// Remaining-by-type handles empty input without NaN.
for (const row of buildRemainingByType([])) {
  assert.equal(Number.isFinite(row.pctLeft), true);
}

// Actor map ranks by volume.
{
  const commits = [
    commit({ authored_at: 1, author_email: "heavy@x.com" }),
    commit({ authored_at: 2, author_email: "heavy@x.com" }),
    commit({ authored_at: 3, author_email: "light@x.com" }),
  ];
  const map = buildActivityActorMap(commits);
  assert.equal(commitActor(commits[0], map), "primary");
  assert.equal(commitActor(commits[2], map), "secondary");
}

assert.equal(normalizeRepoPathForCompare("/repo/"), "/repo");

assert.equal(repoDashboardBrandLabel("/Users/me/Kretsverket"), "Kretsverket.repo.state");
assert.equal(repoDashboardBrandLabel(""), "repo.dashboard");
assert.equal(ghIssuesKpiLabel(false, false), "gh issues (n/a)");

{
  const counts = buildWorkStatusCounts([
    {
      source: "docs",
      path: "a",
      text: "x",
      type: "todo",
      status: "open",
      needsPlan: false,
    },
    {
      source: "docs",
      path: "a",
      text: "y",
      type: "todo",
      status: "done",
      needsPlan: false,
    },
  ]);
  assert.equal(counts.open, 1);
  assert.equal(counts.done, 1);
}

{
  const legend = buildActivityLegend([
    commit({ authored_at: 1, author_name: "Alice", author_email: "a@x.com" }),
    commit({ authored_at: 2, author_name: "Bob", author_email: "b@x.com" }),
  ]);
  assert.equal(legend.length, 2);
  assert.equal(legend[0].label, "Alice");
}

{
  const item = {
    source: "docs" as const,
    path: "docs/BACKLOG.md",
    text: "BL-1",
    type: "todo" as const,
    status: "open" as const,
    needsPlan: false,
  };
  assert.equal(workItemDocLane(item), "backlog");
  const lanes = buildDocLaneSummaries([item]);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].label, "Backlog");
}

{
  const parsed = parseConventionalCommitSubject("feat(repo-dashboard): add docs");
  assert.equal(parsed.type, "feat");
  assert.equal(parsed.scope, "repo-dashboard");
  assert.equal(parseConventionalCommitSubject("misc update").type, "other");
  assert.equal(parseConventionalCommitSubject("fix: plain").scope, null);
}

{
  const commits = [
    commit({ authored_at: 10, author_name: "Alice", author_email: "a@x.com", subject: "feat: one" }),
    commit({ authored_at: 20, author_name: "Alice", author_email: "a@x.com", subject: "fix(ui): two" }),
    commit({ authored_at: 15, author_name: "Bob", author_email: "b@x.com", subject: "Merge pull request", is_merge: true }),
  ];
  const stats = buildContributorStats(commits);
  assert.equal(stats.length, 2);
  assert.equal(stats[0].displayName, "Alice");
  assert.equal(stats[0].commitCount, 2);
  assert.equal(stats[0].percentage, 66.7);
  assert.ok(contributorTopTypes(stats[0]).includes("feat"));
}

{
  const items = [
    { source: "docs" as const, path: "a", text: "open", type: "todo" as const, status: "open" as const, needsPlan: false },
    { source: "docs" as const, path: "b", text: "started", type: "todo" as const, status: "started" as const, needsPlan: true },
    { source: "docs" as const, path: "c", text: "done", type: "todo" as const, status: "done" as const, needsPlan: false },
  ];
  const partition = partitionWorkItems(items);
  assert.equal(partition.activeStarted.length, 1);
  assert.equal(partition.activeOpen.length, 1);
  assert.equal(partition.done.length, 1);
  assert.equal(activeWorkCount(partition), 2);
  assert.equal(partition.activeStarted[0].text, "started");
  assert.ok(compareWorkItems(partition.activeOpen[0], partition.activeStarted[0]) !== 0);
  const keys = (list: typeof items) =>
    list.map(item => `${item.source}:${item.path}:${item.line ?? 0}:${item.text}`);
  const overlap = keys(partition.activeStarted).filter(key =>
    keys(partition.activeOpen).includes(key),
  );
  assert.equal(overlap.length, 0, "started and open must not share items");
  assert.equal(
    keys(partition.done).filter(key => keys(partition.activeStarted).includes(key)).length,
    0,
    "done must not share items with started",
  );
}

{
  assert.equal(classifyChangedFileStatus("M"), "modified");
  assert.equal(classifyChangedFileStatus("A"), "added");
  assert.equal(classifyChangedFileStatus("D"), "deleted");
  assert.equal(classifyChangedFileStatus("R100"), "other");
  const breakdown = buildHeadFileStatusBreakdown([
    { path: "a.ts", status: "A" },
    { path: "b.ts", status: "M" },
    { path: "c.ts", status: "D" },
  ]);
  assert.equal(breakdown.total, 3);
  assert.equal(breakdown.added, 1);
  assert.equal(formatAheadBehind(2, 0), "2 ahead");
  assert.equal(formatAheadBehind(0, 0), "up to date with upstream");
  assert.ok(formatRelativeAgeFromUnix(Math.floor(Date.now() / 1000) - 120).includes("m ago"));
  assert.ok(prBodyExcerpt("x".repeat(300)).endsWith("…"));
}

{
  const nowSec = Math.floor(Date.now() / 1000);
  const commits = [
    commit({ authored_at: nowSec - 5 * 86_400, author_email: "a@x.com", author_name: "Alice" }),
    commit({ authored_at: nowSec - 2 * 86_400, author_email: "b@x.com", author_name: "Bob" }),
    commit({ authored_at: nowSec - 400 * 86_400, author_email: "a@x.com", author_name: "Alice" }),
  ];
  const recent = filterCommitsByTimeRange(commits, "30d");
  assert.equal(recent.length, 2);
  const aliceOnly = filterCommitsByContributor(recent, "a@x.com");
  assert.equal(aliceOnly.length, 1);
  const series = buildActivityInsightsSeries(aliceOnly);
  assert.ok(series.length >= 1);
  assert.equal(activityInsightsChartValue(series[series.length - 1], "cumulative"), 1);
  assert.equal(activityInsightsChartValue(series[series.length - 1], "period"), 0);
}

{
  const fixedNow = new Date("2026-06-06T12:00:00");
  const nowSec = Math.floor(fixedNow.getTime() / 1000);
  const commits = [
    commit({ authored_at: nowSec - 2 * 86_400, author_email: "a@x.com", author_name: "Alice" }),
    commit({ authored_at: nowSec - 2 * 86_400, author_email: "a@x.com", author_name: "Alice" }),
    commit({ authored_at: nowSec - 5 * 86_400, author_email: "b@x.com", author_name: "Bob" }),
  ];
  const allSeries = buildContributorActivitySeries(commits, ACTIVITY_INSIGHTS_DAYS, fixedNow);
  assert.equal(allSeries.length, 2, "one series per contributor");
  assert.equal(allSeries[0].displayName, "Alice");
  assert.equal(allSeries[1].displayName, "Bob");
  assert.equal(allSeries[0].points.length, ACTIVITY_INSIGHTS_DAYS);
  assert.equal(allSeries[1].points.length, ACTIVITY_INSIGHTS_DAYS);
  assert.deepEqual(
    allSeries[0].points.map(point => point.date),
    allSeries[1].points.map(point => point.date),
    "identical date domains",
  );
  const aliceDay = allSeries[0].points.find(point => point.commitCount === 2);
  assert.ok(aliceDay, "zero-filled days retain commit spikes");
  assert.ok(allSeries[0].points.some(point => point.commitCount === 0), "zero-commit days included");
  assert.equal(allSeries[0].colorIndex, 0);
  assert.equal(allSeries[1].colorIndex, 1);
  assert.equal(contributorChartColor(0), contributorChartColor(allSeries[0].colorIndex));
  assert.notEqual(contributorChartColor(0), contributorChartColor(1));

  const visible = defaultVisibleContributorIds(allSeries);
  assert.deepEqual(visible, ["a@x.com", "b@x.com"], "all contributors visible by default");
  const filtered = filterContributorActivitySeries(allSeries, new Set(["b@x.com"]));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].displayName, "Bob");
  assert.equal(filtered[0].colorIndex, 1, "color index stable when filtered");
  assert.equal(visibleContributorSeriesMax(filtered), 1);

  const reconciled = reconcileVisibleContributorIds(["stale@x.com"], ["a@x.com", "b@x.com"]);
  assert.deepEqual(reconciled, ["a@x.com", "b@x.com"]);
  const pruned = reconcileVisibleContributorIds(["a@x.com"], ["b@x.com"]);
  assert.deepEqual(pruned, ["b@x.com"]);
}

{
  const fixedNow = new Date("2026-06-06T12:00:00");
  const nowSec = Math.floor(fixedNow.getTime() / 1000);
  const single = buildContributorActivitySeries(
    [commit({ authored_at: nowSec, author_name: "Solo" })],
    ACTIVITY_INSIGHTS_DAYS,
    fixedNow,
  );
  assert.equal(single.length, 1);
  assert.equal(single[0].totalCommits, 1);
}

{
  const fixedNow = new Date("2026-06-06T12:00:00");
  assert.deepEqual(buildContributorActivitySeries([], ACTIVITY_INSIGHTS_DAYS, fixedNow), []);
}

{
  const fixedNow = new Date("2026-06-06T12:00:00");
  const nowSec = Math.floor(fixedNow.getTime() / 1000);
  const commits = [
    commit({ authored_at: nowSec, author_name: "", author_email: "" }),
    commit({ authored_at: nowSec - 86_400, author_name: "NameOnly", author_email: "" }),
  ];
  const series = buildContributorActivitySeries(commits, ACTIVITY_INSIGHTS_DAYS, fixedNow);
  assert.equal(series.length, 2);
  assert.ok(series.some(entry => entry.id === "unknown"));
  assert.ok(series.some(entry => entry.id === "nameonly"));
}

{
  const sidebarWidth = 280;
  const cellSize = computeHeatmapCellSizePx(sidebarWidth, HEATMAP_DISPLAY_WEEKS, {
    dayLabelPx: 26,
    gapPx: 2,
    minPx: 6,
    maxPx: 12,
    paddingPx: 24,
  });
  assert.equal(HEATMAP_DISPLAY_WEEKS, 26);
  const gridWidth = HEATMAP_DISPLAY_WEEKS * cellSize + 25 * 2 + 26;
  assert.ok(gridWidth <= sidebarWidth, "embedded sidebar heatmap fits without horizontal scroll");
  assert.ok(cellSize >= 6 && cellSize <= 12, "embedded sidebar uses compact square cell size");
}

console.log("Repo Dashboard model checks passed");
