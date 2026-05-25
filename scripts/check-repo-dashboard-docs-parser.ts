import assert from "node:assert/strict";
import type { RepoDocFile, RepoGhIssue } from "../src/types";
import { mergeWorkItems, parseDocWorkItems } from "../src/tools/repoDashboard/docsParser";

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
assert.equal(items.length, 4);
assert.equal(items[0].status, "open");
assert.equal(items[2].status, "done");
assert.equal(items[3].type, "gap");

const issues: RepoGhIssue[] = [
  { number: 1, title: "Bug fix", state: "OPEN", labels: ["bug"] },
];
const merged = mergeWorkItems([doc], issues);
assert.equal(merged.length, 5);
const dupMerged = mergeWorkItems(
  [doc],
  [...issues, { number: 1, title: "Bug fix", state: "OPEN", labels: ["bug"] }],
);
assert.equal(dupMerged.length, 5);
const again = mergeWorkItems([doc], issues);
assert.equal(again.length, merged.length);

const emptyDoc: RepoDocFile = { path: "missing.md", found: false, content: "" };
assert.deepEqual(parseDocWorkItems([emptyDoc]), []);

console.log("Repo Dashboard docs parser checks passed");
