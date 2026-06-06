import assert from "node:assert/strict";
import type { RepoDocFile } from "../src/types";
import {
  docDisplayTitle,
  filterDocsForSearch,
  pickReadableDocPath,
} from "../src/tools/repoDashboard/RepoDocsWorkspace";
import { shouldIncludeDocInDashboardList } from "../src/tools/repoDashboard/docsParser";
import {
  docsSourceLabel,
  filterDocsSnapshotWarnings,
} from "../src/tools/repoDashboard/model";

function doc(overrides: Partial<RepoDocFile> & Pick<RepoDocFile, "path">): RepoDocFile {
  return {
    found: true,
    readable: true,
    truncated: false,
    content: "# x",
    ...overrides,
  };
}

assert.equal(docDisplayTitle("docs/BACKLOG.md"), "BACKLOG");
assert.equal(docDisplayTitle("README.md"), "README");

const docs = [
  doc({ path: "docs/BACKLOG.md" }),
  doc({ path: "README.md" }),
  doc({ path: "docs/TODO.md", found: false, readable: false, content: "" }),
];

assert.equal(pickReadableDocPath(docs, null), "README.md");
assert.equal(pickReadableDocPath(docs, "docs/BACKLOG.md"), "docs/BACKLOG.md");
assert.equal(pickReadableDocPath(docs, "missing.md"), "README.md");

const filtered = filterDocsForSearch(docs, "backlog");
assert.equal(filtered.length, 1);
assert.equal(filtered[0].path, "docs/BACKLOG.md");

assert.equal(shouldIncludeDocInDashboardList(docs[2]), false);
assert.equal(filterDocsForSearch(docs, "").length, 2);

assert.equal(docsSourceLabel("remote"), "Remote default branch");
assert.deepEqual(
  filterDocsSnapshotWarnings(
    ["No remote documentation ref available — using local checkout.", "other"],
    "local-fallback",
  ),
  ["other"],
);

console.log("Repo Dashboard docs workspace checks passed");
