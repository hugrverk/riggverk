import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoDocFile, RepoGhIssue } from "../src/types";
import {
  isOptionalDocPath,
  mergeWorkItems,
  mergeWorkItemsDetailed,
  parseDocWorkItems,
  parseDocWorkItemsDetailed,
} from "../src/tools/repoDashboard/docsParser";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(here, "../src/tools/repoDashboard/fixtures", name), "utf8");

const doc: RepoDocFile = {
  path: "docs/TODO.md",
  found: true,
  content: [
    "## Section",
    "- [ ] First task",
    "- [ ] First task",
    "- [x] Done task",
    "1. Numbered gap item",
  ].join("\n"),
};

const items = parseDocWorkItems([doc]);
assert.equal(items.length, 4, "actionable TODO bullets including duplicate lines");
assert.ok(items.some(i => i.text === "First task" && i.status === "open"));
assert.ok(items.some(i => i.text === "Done task" && i.status === "done"));
assert.ok(items.some(i => i.type === "gap" && i.text.includes("gap")));

const gaps: RepoDocFile = {
  path: "docs/KNOWN_GAPS.md",
  found: true,
  content: fixture("krets-known-gaps.md"),
};
const gapItems = parseDocWorkItems([gaps]);
assert.ok(gapItems.length >= 4, "table rows from KNOWN_GAPS");
assert.ok(gapItems.some(i => i.text.includes("BOM")), "gap title present");
const openGap = gapItems.find(i => i.text.includes("Lint"));
assert.ok(openGap && openGap.status === "open", "Open status in table");

const backlog: RepoDocFile = {
  path: "docs/BACKLOG.md",
  found: true,
  content: fixture("krets-backlog.md"),
};
const backlogItems = parseDocWorkItems([backlog]);
assert.ok(backlogItems.some(i => i.text.includes("BL-002") && i.status === "open"));
assert.ok(backlogItems.some(i => i.text.includes("BL-099") && i.status === "done"));
assert.ok(
  !backlogItems.some(i => i.text.includes("Session save")),
  "reference-only table skipped",
);

const todoFixture: RepoDocFile = {
  path: "docs/TODO.md",
  found: true,
  content: fixture("krets-todo.md"),
};
const todoItems = parseDocWorkItems([todoFixture]);
assert.equal(todoItems.filter(i => i.status === "open").length, 2);
assert.ok(!todoItems.some(i => i.text.includes("keep README")), "meta bullets skipped");

const features: RepoDocFile = {
  path: "docs/product/FEATURES.md",
  found: true,
  content: fixture("krets-features-snippet.md"),
};
const featureItems = parseDocWorkItems([features]);
assert.ok(featureItems.some(i => i.type === "feature" && i.status === "done"));
assert.ok(featureItems.some(i => i.status === "started"));

assert.equal(isOptionalDocPath("docs/TODO.md"), true);
assert.equal(isOptionalDocPath("docs/BACKLOG.md"), false);

const issues: RepoGhIssue[] = [
  { number: 1, title: "Bug fix", state: "OPEN", labels: ["bug"] },
];
const merged = mergeWorkItems([doc], issues);
assert.equal(merged.length, 5);
const detailed = mergeWorkItemsDetailed([doc], issues);
assert.ok(Array.isArray(detailed.parserWarnings));

const emptyDoc: RepoDocFile = { path: "missing.md", found: false, content: "" };
assert.deepEqual(parseDocWorkItemsDetailed([emptyDoc]).items, []);

console.log("Repo Dashboard docs parser checks passed");
