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
assert.ok(toolSource.includes("repo-dashboard-overview-full"), "recent activity must be full-width");
assert.ok(toolSource.includes("LatestChangeCard"), "overview must render enriched latest change card");
assert.ok(!workSource.includes("laneView"), "work must not use Active/Done laneView toggle");
assert.ok(!workSource.includes("repo-dashboard-seg"), "work must not use segmented Active/Done toggle");
assert.ok(workSource.includes("repo-dashboard-work-primary-columns"), "work must use primary Active/Done columns");
assert.ok(workSource.includes("Started ("), "active column must include Started group");
assert.ok(workSource.includes("Done ("), "work must include Done column");
assert.ok(!chartsSource.includes("scrollRef"), "heatmap must not use scrollRef");
assert.ok(!chartsSource.includes("scrollLeft"), "heatmap must not auto-scroll horizontally");
assert.ok(chartsSource.includes("sliceHeatmapCellsToWindow"), "heatmap must slice displayed weeks");
assert.ok(chartsSource.includes("HEATMAP_WINDOW_WEEKS"), "heatmap must expose 13/26/53 week windows");
assert.ok(activitySource.includes("mergeCommitCount"), "contributor insights must show merge counts");
assert.ok(rustSource.includes("read_local_docs_rejects_readme_symlink_to_external_file"));
assert.ok(rustSource.includes("read_local_docs_rejects_backlog_symlink_to_external_file"));
assert.ok(rustSource.includes("symlink not allowed"));

console.log("Repo Dashboard navigation guard checks passed");
