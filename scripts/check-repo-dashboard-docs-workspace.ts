import assert from "node:assert/strict";
import type { RepoDocFile } from "../src/types";
import {
  docDisplayTitle,
  filterDocsForSearch,
  pickReadableDocPath,
} from "../src/tools/repoDashboard/RepoDocsWorkspace";

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

console.log("Repo Dashboard docs workspace checks passed");
