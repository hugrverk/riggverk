import assert from "node:assert/strict";
import type { RepoCommitEntry } from "../src/types";
import {
  buildActivityActorMap,
  buildHeatmapCells,
  buildHeatmapMonthLabels,
  buildHeatmapWeeks,
  buildLineChartData,
  buildRemainingByType,
  commitActor,
  eventsFromCommits,
  normalizeRepoPathForCompare,
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

console.log("Repo Dashboard model checks passed");
