import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readRepoDashboard = (relativePath: string) =>
  readFileSync(join(here, "..", relativePath), "utf8");

const toolSource = readRepoDashboard("src/tools/repoDashboard/RepoDashboardTool.tsx");
const workSource = readRepoDashboard("src/tools/repoDashboard/RepoWorkWorkspace.tsx");
const chartsSource = readRepoDashboard("src/tools/repoDashboard/RepoDashboardCharts.tsx");
const activitySource = readRepoDashboard("src/tools/repoDashboard/RepoActivityInsights.tsx");
const rustSource = readRepoDashboard("src-tauri/src/commands/repo_dashboard.rs");

const sections = ['"overview"', '"work"', '"docs"'];
for (const section of sections) {
  assert.ok(toolSource.includes(section), `missing section id ${section}`);
}

assert.ok(!toolSource.includes('"activity"'), "activity section must be removed");
assert.ok(!toolSource.includes('"sources"'), "sources section must be removed");
assert.ok(!toolSource.includes("Source health"), "source health card must be removed");
assert.ok(!toolSource.includes('section === "activity"'), "activity render branch must be removed");
assert.ok(!toolSource.includes('section === "sources"'), "sources render branch must be removed");
assert.ok(toolSource.includes("RepoDocsWorkspace"), "docs workspace must be rendered");
assert.ok(toolSource.includes("RepoWorkWorkspace"), "work workspace must be rendered");
assert.equal((toolSource.match(/id: "overview"/g) ?? []).length >= 1, true);
assert.equal((toolSource.match(/id: "work"/g) ?? []).length >= 1, true);
assert.equal((toolSource.match(/id: "docs"/g) ?? []).length >= 1, true);

assert.ok(!toolSource.includes("Open work by doc"), "overview must not render Open work by doc");
assert.ok(!toolSource.includes("DocLaneSummaryPanel"), "overview doc lane panel must be removed");
assert.ok(toolSource.includes("RepoActivityInsights"), "overview must use combined activity insights");
assert.ok(activitySource.includes("ActivityHeatmap"), "heatmap must render inside activity insights");
assert.ok(activitySource.includes("repo-dashboard-activity-sidebar"), "activity insights must use right sidebar stack");
assert.ok(activitySource.includes("repo-dashboard-heatmap-panel"), "heatmap must use inset panel in activity sidebar");
assert.ok(activitySource.includes('density="default"'), "activity sidebar heatmap must use default density");
assert.ok(!toolSource.includes("repo-dashboard-heat-card"), "overview must not render standalone heatmap card");
assert.ok(toolSource.includes("repo-dashboard-overview-lower"), "overview must use lower information grid");
assert.ok(toolSource.includes("repo-dashboard-recent-activity-card"), "overview must render recent activity card");
assert.ok(!toolSource.includes("repo-dashboard-overview-mid"), "overview must not use legacy mid row layout");
assert.ok(!toolSource.includes("repo-dashboard-overview-full"), "overview must not use legacy full-width recent row");
assert.ok(toolSource.includes("LatestChangeCard"), "overview must render enriched latest change card");
assert.ok(
  toolSource.includes("RECENT_ACTIVITY_LOAD_CAP = 30"),
  "recent activity must load exactly 30 commits",
);
assert.ok(
  !toolSource.includes("RECENT_ACTIVITY_VISIBLE_ROWS"),
  "recent activity must not use visible-row height cap",
);
assert.ok(!workSource.includes("laneView"), "work must not use Active/Done laneView toggle");
assert.ok(!workSource.includes("repo-dashboard-seg"), "work must not use segmented Active/Done toggle");
assert.ok(workSource.includes("repo-dashboard-work-primary-columns"), "work must use primary Active/Done columns");
assert.ok(workSource.includes("Started ("), "active column must include Started group");
assert.ok(workSource.includes("Done ("), "work must include Done column");
assert.ok(!chartsSource.includes("scrollRef"), "heatmap must not use scrollRef");
assert.ok(!chartsSource.includes("scrollLeft"), "heatmap must not auto-scroll horizontally");
assert.ok(chartsSource.includes("sliceHeatmapCellsToWindow"), "heatmap must slice displayed weeks");
assert.ok(chartsSource.includes("HEATMAP_DISPLAY_WEEKS"), "heatmap must use fixed 26-week display window");
assert.ok(!chartsSource.includes("HEATMAP_WINDOW_WEEKS"), "heatmap must not expose interval window options");
assert.ok(!chartsSource.includes("heat-range-btn"), "heatmap must not render interval controls");
assert.ok(!chartsSource.includes("windowOverride"), "heatmap must not keep range override state");
assert.ok(!chartsSource.includes("chooseHeatmapWindowWeeks"), "heatmap must not auto-switch intervals");
assert.ok(!activitySource.includes("TIME_RANGES"), "activity insights must not expose time-range selector");
assert.ok(!activitySource.includes("Activity time range"), "activity insights must not label a time-range control");
assert.ok(activitySource.includes("filterCommitsForActivityInsights"), "activity insights must use fixed 90-day filter");
assert.ok(activitySource.includes("buildContributorActivitySeries"), "activity chart must use per-contributor 90-day series");
assert.ok(!activitySource.includes("<select"), "activity insights must not use single-select contributor filter");
assert.ok(activitySource.includes('useState<ActivityInsightsVisualMode>("lines")'), "line mode must be default chart mode");
assert.ok(activitySource.includes('aria-pressed={chartMode === "lines"}'), "lines control must expose selected state");
assert.ok(activitySource.includes('aria-pressed={chartMode === "bars"}'), "bars control must expose selected state");
assert.ok(activitySource.includes("aria-pressed={visible}"), "contributor visibility must expose selected state");
assert.ok(activitySource.includes("mergeCommitCount"), "contributor insights must show merge counts");
assert.ok(
  !activitySource.includes("tabIndex"),
  "activity chart must not expose per-point keyboard tab stops",
);
assert.ok(
  !chartsSource.includes("aria-label={`${cell.date}"),
  "heatmap cells must not duplicate the parent heatmap label",
);
assert.ok(workSource.includes("repo-dashboard-work-active-columns"), "active column must use sibling Started/Open subcolumns");
assert.ok(workSource.includes("repo-dashboard-work-subcolumn-scroll"), "started and open must have independent scroll regions");
assert.equal((workSource.match(/repo-dashboard-work-subcolumn-scroll/g) ?? []).length, 2, "started and open need two scroll regions");
assert.ok(workSource.includes("repo-dashboard-work-column-scroll"), "done must have its own scroll region");
assert.ok(
  workSource.includes("repo-dashboard-work-item-head"),
  "work items must use a distinct item-head class from the page header",
);
assert.ok(
  !workSource.includes('className="repo-dashboard-work-head"') ||
    workSource.match(/className="repo-dashboard-work-head"/g)?.length === 1,
  "repo-dashboard-work-head must only label the page header",
);
{
  const activeSection =
    workSource.match(
      /className="repo-dashboard-work-column repo-dashboard-work-column-active"[\s\S]*?<\/section>/,
    )?.[0] ?? "";
  assert.ok(
    !activeSection.includes("repo-dashboard-work-column-scroll"),
    "active must not use a shared outer scroll wrapping started and open",
  );
}
assert.ok(rustSource.includes("read_local_docs_rejects_readme_symlink_to_external_file"));
assert.ok(rustSource.includes("read_local_docs_rejects_backlog_symlink_to_external_file"));
assert.ok(rustSource.includes("symlink not allowed"));

console.log("Repo Dashboard navigation guard checks passed");
