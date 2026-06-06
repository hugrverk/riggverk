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
const stylesSource = readRepoDashboard("src/styles.css");
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
assert.ok(
  !activitySource.includes("repo-dashboard-activity-insights-meta"),
  "90-day metadata must not remain in activity header",
);
assert.ok(
  activitySource.includes("repo-dashboard-activity-chart-footer"),
  "chart footer must contain legend and metadata",
);
assert.ok(
  activitySource.includes("activityInsightsRangeFooterText"),
  "chart footer must use dynamic range metadata",
);
assert.ok(
  !activitySource.includes("90-day local git activity"),
  "chart footer must not retain fixed 90-day copy",
);
assert.ok(
  /\.repo-dashboard-activity-insights-body[\s\S]*align-items:\s*stretch/.test(stylesSource),
  "activity chart and sidebar must use stretch alignment",
);
assert.ok(
  /\.repo-dashboard-overview[\s\S]*?overflow:\s*hidden/.test(stylesSource),
  "overview must avoid page-level vertical scrolling",
);
assert.ok(
  /\.repo-dashboard-overview-lower \.repo-dashboard-recent-activity-scroll[\s\S]*overflow-y:\s*auto/.test(
    stylesSource,
  ),
  "recent activity must own a bounded scroll region",
);
assert.ok(
  /\.repo-dashboard-overview-lower \.repo-dashboard-latest-content \{[^}]*overflow:\s*hidden/.test(
    stylesSource,
  ),
  "latest change card must not scroll inside overview lower row",
);
assert.ok(!workSource.includes("laneView"), "work must not use Active/Done laneView toggle");
assert.ok(!workSource.includes("repo-dashboard-seg"), "work must not use segmented Active/Done toggle");
assert.ok(workSource.includes("repo-dashboard-work-primary-columns"), "work must use three primary columns");
assert.ok(workSource.includes('"Bugs"') || workSource.includes('"Started"'), "work must include primary column titles");
assert.ok(workSource.includes('"Verify"') || workSource.includes('"Open"'), "work must include primary column titles");
assert.ok(workSource.includes('"Enhancements"') || workSource.includes('"Done"'), "work must include primary column titles");
assert.ok(workSource.includes("canonicalMode"), "work workspace must support canonical mode");
assert.ok(workSource.includes("sourceFilter"), "canonical work must expose source filter");
assert.ok(workSource.includes("priorityFilter"), "canonical work must expose priority filter");
assert.ok(!workSource.includes("laneFilter"), "stale lane filter must be removed");
assert.ok(!workSource.includes("docLaneSummaries"), "stale doc lane summaries must be removed");
assert.ok(!workSource.includes("Active ("), "work must not render Active heading");
assert.ok(!workSource.includes("repo-dashboard-work-column-active"), "work must not use Active wrapper");
assert.ok(!workSource.includes("repo-dashboard-work-active-columns"), "work must not use Active nested columns");
assert.ok(!workSource.includes("repo-dashboard-work-subcolumn"), "work must not use nested subcolumns");
assert.ok(workSource.includes("started {partition.activeStarted.length}"), "work summary must include started count");
assert.ok(workSource.includes("open {partition.activeOpen.length}"), "work summary must include open count");
assert.ok(workSource.includes("done {partition.done.length}"), "work summary must include done count");
assert.ok(!workSource.includes("active {"), "work summary must not include active total");
assert.ok(!chartsSource.includes("scrollRef"), "heatmap must not use scrollRef");
assert.ok(!chartsSource.includes("scrollLeft"), "heatmap must not auto-scroll horizontally");
assert.ok(chartsSource.includes("sliceHeatmapCellsToWindow"), "heatmap must slice displayed weeks");
assert.ok(chartsSource.includes("HEATMAP_DISPLAY_WEEKS"), "heatmap must use fixed 26-week display window");
assert.ok(!chartsSource.includes("HEATMAP_WINDOW_WEEKS"), "heatmap must not expose interval window options");
assert.ok(!chartsSource.includes("heat-range-btn"), "heatmap must not render interval controls");
assert.ok(!chartsSource.includes("windowOverride"), "heatmap must not keep range override state");
assert.ok(!chartsSource.includes("chooseHeatmapWindowWeeks"), "heatmap must not auto-switch intervals");
assert.ok(
  activitySource.includes('aria-label="Activity range"'),
  "activity chart must expose range controls inside chart panel",
);
assert.ok(
  activitySource.includes('aria-label="Chart type"'),
  "activity chart must expose chart type controls inside chart panel",
);
assert.ok(
  activitySource.includes("repo-dashboard-activity-chart-header"),
  "activity chart must use internal chart header",
);
assert.ok(
  !activitySource.includes("repo-dashboard-activity-insights-controls"),
  "lines and bars must not remain in outer activity header",
);
assert.ok(activitySource.includes("filterCommitsForActivityInsights"), "activity insights must filter commits by selected range");
assert.ok(activitySource.includes("buildContributorActivitySeries"), "activity chart must use per-contributor series");
assert.ok(
  activitySource.includes("DEFAULT_ACTIVITY_INSIGHTS_DAYS"),
  "activity chart must default to 30-day range",
);
assert.ok(
  activitySource.includes("ACTIVITY_INSIGHTS_RANGE_DAYS"),
  "activity chart must support 7, 14, and 30 day ranges",
);
assert.ok(!activitySource.includes("<select"), "activity insights must not use single-select contributor filter");
assert.ok(activitySource.includes('useState<ActivityInsightsVisualMode>("bars")'), "bar mode must be default chart mode");
assert.ok(activitySource.includes('aria-pressed={chartMode === "lines"}'), "lines control must expose selected state");
assert.ok(activitySource.includes('aria-pressed={chartMode === "bars"}'), "bars control must expose selected state");
assert.ok(activitySource.includes("aria-pressed={visible}"), "contributor visibility must expose selected state");
assert.ok(activitySource.includes("mergeCommitCount"), "contributor insights must show merge counts");
assert.ok(
  activitySource.includes("repo-dashboard-activity-plot-hit"),
  "activity chart must expose a single plot focus target",
);
assert.ok(
  (activitySource.match(/tabIndex/g) ?? []).length === 1,
  "activity chart must use only one tab stop for date navigation",
);
assert.ok(
  !activitySource.includes("repo-dashboard-activity-point"),
  "activity chart must not render permanent point markers",
);
assert.ok(
  activitySource.includes("contributorChartColor"),
  "activity chart must use theme-aware contributor series colors",
);
assert.ok(
  activitySource.includes("activityChartKeyAction"),
  "activity chart must support keyboard date navigation",
);
assert.ok(
  !chartsSource.includes("aria-label={`${cell.date}"),
  "heatmap cells must not duplicate the parent heatmap label",
);
assert.equal((workSource.match(/<WorkColumn/g) ?? []).length, 1, "work must render three sibling columns via one column map");
assert.ok(
  workSource.includes("repo-dashboard-work-column-scroll"),
  "each work column must declare its own scroll region",
);
assert.ok(
  workSource.includes("repo-dashboard-work-item-head"),
  "work items must use a distinct item-head class from the page header",
);
assert.ok(
  !workSource.includes('className="repo-dashboard-work-head"') ||
    workSource.match(/className="repo-dashboard-work-head"/g)?.length === 1,
  "repo-dashboard-work-head must only label the page header",
);
assert.ok(
  !stylesSource.includes("repo-dashboard-work-column-active"),
  "stale Active-specific work layout classes must be removed",
);
assert.ok(
  !stylesSource.includes("repo-dashboard-work-active-columns"),
  "stale Active nested column layout must be removed",
);
assert.ok(
  !stylesSource.includes("repo-dashboard-work-subcolumn"),
  "stale nested Started/Open panel styles must be removed",
);
assert.ok(
  stylesSource.includes("grid-template-columns: repeat(3, minmax(0, 1fr))"),
  "work desktop layout must use three equal columns",
);
assert.ok(rustSource.includes("read_local_docs_rejects_readme_symlink_to_external_file"));
assert.ok(rustSource.includes("read_local_docs_rejects_backlog_symlink_to_external_file"));
assert.ok(rustSource.includes("symlink not allowed"));

console.log("Repo Dashboard navigation guard checks passed");
