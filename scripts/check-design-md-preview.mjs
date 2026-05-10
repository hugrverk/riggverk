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
    "src/lib/designMdDisplay.ts",
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

const { parseDesignMdForPreview, resolveGeneratedFontFamily } = await import(path.join(outDir, "designMdPreviewParser.js"));
const { buildBoard } = await import(path.join(outDir, "designMdSpecimenBuilder.js"));
const { generateBoardHtml } = await import(path.join(outDir, "designMdHtmlGenerator.js"));
const { designMdDisplayTitle, designMdSearchText } = await import(path.join(outDir, "designMdDisplay.js"));

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
assert.equal(model.components.find((component) => component.name === "markets-table-card")?.kind, "market-table");

const nestedComponents = parseDesignMdForPreview(
  "nested",
  "Nested",
  "Nested component token names",
  `---
components:
  button:
    primary:
      backgroundColor: "#111111"
      textColor: "#ffffff"
  card:
    pricing:
      backgroundColor: "#ffffff"
      textColor: "#111111"
---
`,
);
assert(nestedComponents.components.some((component) => component.name === "button-primary"));
assert(nestedComponents.components.some((component) => component.name === "card-pricing"));

const clickhouse = parseDesignMdForPreview(
  "clickhouse",
  "ClickHouse",
  "Developer data product with queries, charts, metrics, and code window cards.",
  fixture,
);
assert.equal(clickhouse.archetype, "data_product");

const board = buildBoard("airbnb", "Airbnb", "Marketplace", fixture);
const html = generateBoardHtml(board, { variant: "light" });
const darkHtml = generateBoardHtml(board, { variant: "dark" });

assert.match(html, /Content-Security-Policy/);
assert.doesNotMatch(html, /<script/i);
assert.doesNotMatch(html, /@font-face|@import|url\(https?:/i);
assert.doesNotMatch(html, /Features|Docs|Pricing|Feature One|Feature Two|Feature Three/);
assert.match(html, /search-bar-pill/);
assert.match(html, /property-card/);
assert.match(html, /markets-table-card/);
assert.match(darkHtml, /Content-Security-Policy/);
assert.doesNotMatch(darkHtml, /<script/i);
assert.doesNotMatch(darkHtml, /@font-face|@import|url\(https?:/i);
assert.match(darkHtml, /#0b0e11|#1f2329|surface-card-dark/);
assert.match(darkHtml, /markets-table-card/);

const darkOnlyBoard = buildBoard(
  "dark-only",
  "Dark Only",
  "Only dark tokens are provided.",
  `---
colors:
  canvas-dark: "#010203"
  surface-dark: "#101820"
  on-dark: "#f7f7f7"
components:
  card-dark:
    backgroundColor: "#101820"
    textColor: "#f7f7f7"
---
# Overview
Dark-only product surface.
`,
);
const darkOnlyLightHtml = generateBoardHtml(darkOnlyBoard, { variant: "light" });
const darkOnlyDarkHtml = generateBoardHtml(darkOnlyBoard, { variant: "dark" });
assert.match(darkOnlyLightHtml, /body\{[^}]*background:#f7f7f7/);
assert.match(darkOnlyDarkHtml, /body\{[^}]*background:#010203/);

assert.match(resolveGeneratedFontFamily("Airbnb Cereal", "Font Substitutes: use Circular"), /"Airbnb Cereal".*Circular.*Avenir Next/);
assert.match(resolveGeneratedFontFamily("SF Pro Display", "Apple system"), /"SF Pro Display".*-apple-system.*BlinkMacSystemFont/);
assert.match(resolveGeneratedFontFamily("Geist", "developer docs"), /Geist.*Inter.*system-ui/);
assert.doesNotMatch(resolveGeneratedFontFamily("Bad; url(https://example.test/font.woff2)", "Inter"), /url|https?:|;/i);

assert.equal(designMdDisplayTitle("slack"), "Slack");
assert.equal(designMdDisplayTitle("shopify"), "Shopify");
assert.equal(designMdDisplayTitle("runwayml"), "RunwayML");
assert.equal(designMdDisplayTitle("cal"), "Cal.com");
assert.match(
  designMdSearchText({
    slug: "slack",
    title: "Slacc Inspired Design System",
    description: "Aubergine collaboration surface",
  }),
  /slacc inspired/,
);

const markdownOnly = parseDesignMdForPreview(
  "spotify",
  "Spotify",
  "Dark immersive music player with album cards and playback controls.",
  "# Design System Inspired by Spotify\n\nAlbum art, playlist cards, search input, now-playing bar, and dark player surfaces.",
);
assert.equal(markdownOnly.archetype, "music_campaign");
assert(markdownOnly.components.some((component) => component.name.startsWith("playlist-card")));
assert(markdownOnly.components.some((component) => component.name === "now-playing-bar"));

console.log("design-md preview checks passed");
