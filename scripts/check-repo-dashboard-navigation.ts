import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const toolSource = readFileSync(
  join(here, "../src/tools/repoDashboard/RepoDashboardTool.tsx"),
  "utf8",
);

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

console.log("Repo Dashboard navigation guard checks passed");
