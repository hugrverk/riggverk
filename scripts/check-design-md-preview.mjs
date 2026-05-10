import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const outDir = "/tmp/agent-workspace-design-md-preview-check";

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

execFileSync(
  path.join(repo, "node_modules/.bin/tsc"),
  [
    "--outDir",
    outDir,
    "--module",
    "ES2022",
    "--target",
    "ES2022",
    "--moduleResolution",
    "Bundler",
    "--skipLibCheck",
    "src/lib/designMdPreviewParser.ts",
    "src/lib/designMdSpecimenBuilder.ts",
    "src/lib/designMdHtmlGenerator.ts",
  ],
  { cwd: repo, stdio: "pipe" },
);

for (const file of ["designMdSpecimenBuilder.js", "designMdHtmlGenerator.js"]) {
  const fullPath = path.join(outDir, file);
  const content = fs.readFileSync(fullPath, "utf8")
    .replaceAll('from "./designMdPreviewParser"', 'from "./designMdPreviewParser.js"')
    .replaceAll('from "./designMdSpecimenBuilder"', 'from "./designMdSpecimenBuilder.js"');
  fs.writeFileSync(fullPath, content);
}

const { parseDesignMdForPreview } = await import(path.join(outDir, "designMdPreviewParser.js"));
const { buildBoard } = await import(path.join(outDir, "designMdSpecimenBuilder.js"));
const { generateBoardHtml } = await import(path.join(outDir, "designMdHtmlGenerator.js"));

const fixture = `---
colors:
  primary: "#ff385c"
  canvas:
    light: "#ffffff"
  surface:
    card: "{colors.canvas.light}"
typography:
  display:
    fontSize: 48px
    fontWeight: "700"
components:
  search-bar-pill:
    backgroundColor: "{colors.canvas.light}"
    textColor: "#111111"
    rounded: 999px
  property-card:
    backgroundColor: "{colors.surface.card}"
    textColor: "#111111"
    rounded: 18px
  markets-table-card:
    backgroundColor: "#1e2329"
    textColor: "#ffffff"
---

# Overview
Marketplace design with property listings, guest favorites, a search bar, and booking cards.
`;

const model = parseDesignMdForPreview("airbnb", "Airbnb", "Marketplace", fixture);
assert.equal(model.archetype, "marketplace");
assert.equal(model.palette.reduce((sum, group) => sum + group.tokens.length, 0), 3);
assert.equal(model.typography.length, 1);
assert.deepEqual(model.components.map((component) => component.name), [
  "search-bar-pill",
  "property-card",
  "markets-table-card",
]);
assert.equal(model.components.find((component) => component.name === "markets-table-card")?.kind, "card");

const clickhouse = parseDesignMdForPreview(
  "clickhouse",
  "ClickHouse",
  "Developer data product with queries, charts, metrics, and code window cards.",
  fixture,
);
assert.equal(clickhouse.archetype, "data_product");

const board = buildBoard("airbnb", "Airbnb", "Marketplace", fixture);
const html = generateBoardHtml(board);

assert.match(html, /Content-Security-Policy/);
assert.doesNotMatch(html, /<script/i);
assert.doesNotMatch(html, /Features|Docs|Pricing|Feature One|Feature Two|Feature Three/);
assert.match(html, /search-bar-pill/);
assert.match(html, /property-card/);
assert.match(html, /markets-table-card/);

console.log("design-md preview checks passed");
