import assert from "node:assert/strict";
import type { RepoCommitEntry } from "../src/types";
import {
  buildActivityActorMap,
  buildActivityLegend,
  buildDocSourceSummaries,
  buildHeatmapCells,
  buildHeatmapMonthLabels,
  buildHeatmapWeeks,
  buildLineChartData,
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
}

console.log("Repo Dashboard model checks passed");
