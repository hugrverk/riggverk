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
assert.match(styles, /var\(--bg-inset\)/);
assert.match(styles, /var\(--radius\)/);
assert.match(styles, /var\(--focus-ring\)/);
assert.doesNotMatch(
  styles.slice(styles.indexOf("/* ── Repo Dashboard tool ── */")),
  /\.repo-dashboard-card\s*\{[^}]*background:\s*#[0-9a-fA-F]{3,8}/,
);

const promptLoops = read("src/tools/promptLoops/PromptLoopsTool.tsx");
assert.match(promptLoops, /tool-field prompt-loops-group-select/);
assert.match(promptLoops, /tool-field prompt-loops-composer-select/);
assert.doesNotMatch(promptLoops, /repo-dashboard-field prompt-loops/);

const repoDashboardStyles = styles.slice(styles.indexOf("/* ── Repo Dashboard tool ── */"));
const promptStyles = styles.slice(styles.indexOf("/* ── Prompt Loops tool ── */"));
for (const chunk of [repoDashboardStyles, promptStyles]) {
  assert.doesNotMatch(chunk, /background:\s*#1a1a1a/);
  assert.doesNotMatch(chunk, /background:\s*#212121/);
}

const parserScript = read("scripts/check-repo-dashboard-docs-parser.ts");
assert.doesNotMatch(parserScript, /krets-/);
assert.doesNotMatch(parserScript, /fixtures/);

const docsPaths = walk(join(root, "docs")).filter(path => /REPO_DASHBOARD/i.test(path));
assert.equal(docsPaths.length, 0, "stale Repo Dashboard markdown docs must not remain");

console.log("Repo Dashboard contract checks passed");
