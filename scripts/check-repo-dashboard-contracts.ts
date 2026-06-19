import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  docsSourceLabel,
  docsSourceWarning,
  filterDocsSnapshotWarnings,
} from "../src/tools/repoDashboard/model";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function cssRuleBlock(styles: string, selector: string): string | undefined {
  const needle = `${selector} {`;
  let searchFrom = 0;
  while (searchFrom < styles.length) {
    const index = styles.indexOf(needle, searchFrom);
    if (index === -1) return undefined;
    const isCanonical = index === 0 || styles[index - 1] === "\n";
    if (isCanonical) {
      const end = styles.indexOf("}", index);
      if (end === -1) return undefined;
      return styles.slice(index, end + 1);
    }
    searchFrom = index + 1;
  }
  return undefined;
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const fixtureDir = join(root, "src/tools/repoDashboard/fixtures");
try {
  const fixtureNames = readdirSync(fixtureDir);
  assert.equal(
    fixtureNames.filter(name => /^krets-.*\.md$/i.test(name)).length,
    0,
    "krets fixture markdown must not exist",
  );
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  assert.ok(code === "ENOENT", "unexpected fixtures directory state");
}

assert.equal(docsSourceLabel("remote"), "Remote default branch");
assert.equal(docsSourceLabel("cached-remote"), "Cached remote ref");
assert.equal(docsSourceLabel("local-fallback"), "Local checkout");
assert.ok(docsSourceWarning("cached-remote", true)?.includes("cached remote"));
assert.ok(docsSourceWarning("local-fallback", true)?.includes("local checkout"));
assert.equal(docsSourceWarning("remote", false), null);

const deduped = filterDocsSnapshotWarnings(
  [
    "Could not fetch latest documentation from origin — showing cached remote ref.",
    "merged pull requests capped at 2000 items",
  ],
  "cached-remote",
);
assert.equal(deduped.length, 1);
assert.ok(deduped[0].includes("merged pull requests"));

const typesSource = read("src/types.ts");
assert.match(typesSource, /docs_source:\s*RepoDocsSource/);
assert.match(typesSource, /docs_ref:\s*string/);
assert.match(typesSource, /docs_stale:\s*boolean/);

const rustSource = read("src-tauri/src/commands/repo_dashboard.rs");
assert.match(rustSource, /pub enum DocsSource/);
assert.match(rustSource, /"ls-tree"/);
assert.match(rustSource, /"show"/);
assert.doesNotMatch(rustSource, /sh\s+-c/);

const styles = read("src/styles.css");
assert.match(styles, /\.tool-field,/);
assert.match(styles, /--bg-panel:\s*color-mix\(in srgb, var\(--bg\)/);
assert.match(styles, /--bg-inset:\s*color-mix\(in srgb, var\(--bg\)/);
assert.match(styles, /var\(--bg-inset\)/);
assert.match(styles, /var\(--radius\)/);
assert.match(styles, /var\(--focus-ring\)/);
assert.match(styles, /\.repo-dashboard-card\.repo-dashboard-activity-insights/);
assert.doesNotMatch(
  styles.slice(styles.indexOf("/* ── Repo Dashboard tool ── */")),
  /\.repo-dashboard-card\s*\{[^}]*background:\s*#[0-9a-fA-F]{3,8}/,
);

const promptLoops = read("src/tools/promptLoops/PromptLoopsTool.tsx");
assert.match(promptLoops, /tool-field prompt-loops-group-select/);
assert.match(promptLoops, /tool-field prompt-loops-composer-select/);
assert.doesNotMatch(promptLoops, /repo-dashboard-field prompt-loops/);

const repoDashboardStyles = styles.slice(styles.indexOf("/* ── Repo Dashboard tool ── */"));
const promptStyles = styles.slice(styles.indexOf("/* ── Prompt Builder tool ── */"));
for (const chunk of [repoDashboardStyles, promptStyles]) {
  assert.doesNotMatch(chunk, /background:\s*#1a1a1a/);
  assert.doesNotMatch(chunk, /background:\s*#212121/);
}

const parserScript = read("scripts/check-repo-dashboard-docs-parser.ts");
assert.doesNotMatch(parserScript, /krets-/);
assert.doesNotMatch(parserScript, /repoDashboard\/fixtures/);
assert.match(parserScript, /FIXTURE_BACKLOG/);

const docsPaths = walk(join(root, "docs")).filter(path => /REPO_DASHBOARD/i.test(path));
assert.equal(docsPaths.length, 0, "stale Repo Dashboard markdown docs must not remain");

const docsWorkspace = read("src/tools/repoDashboard/RepoDocsWorkspace.tsx");
assert.match(docsWorkspace, /docsSource:\s*RepoDocsSource/);
assert.match(docsWorkspace, /docsRef:\s*string/);
assert.match(docsWorkspace, /docsStale:\s*boolean/);

const dashboardTool = read("src/tools/repoDashboard/RepoDashboardTool.tsx");
assert.match(dashboardTool, /filterDocsSnapshotWarnings/);
assert.match(dashboardTool, /workItemCanonicalSource/);

const cardRule = cssRuleBlock(repoDashboardStyles, ".repo-dashboard-card");
assert.ok(cardRule, ".repo-dashboard-card rule must exist");
assert.match(
  cardRule!,
  /border-radius:\s*var\(--radius\)/,
  ".repo-dashboard-card must use theme radius",
);

const chartRule = cssRuleBlock(repoDashboardStyles, ".repo-dashboard-activity-insights-chart");
assert.ok(chartRule, ".repo-dashboard-activity-insights-chart rule must exist");
assert.match(
  chartRule!,
  /border-radius:\s*var\(--radius\)/,
  ".repo-dashboard-activity-insights-chart must use theme radius",
);

const notSyncedBlock = dashboardTool.match(
  /<h2 className="font-mono">Not synced<\/h2>[\s\S]*?<\/p>/,
)?.[0];
assert.ok(notSyncedBlock, "Not synced empty state must exist");
assert.doesNotMatch(
  notSyncedBlock!,
  /docs by default/i,
  "Not synced copy must not describe documentation as local-first",
);
assert.match(
  notSyncedBlock!,
  /remote default branch/i,
  "Not synced copy must mention remote default branch documentation",
);
assert.match(
  notSyncedBlock!,
  /cached|fallback/i,
  "Not synced copy must mention documentation fallback",
);

console.log("Repo Dashboard contract checks passed");
