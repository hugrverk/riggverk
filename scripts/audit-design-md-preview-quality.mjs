#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const cacheRoot = path.join(
  os.homedir(),
  "Library/Application Support/ai.agentworkspace.app/design-catalogs/awesome-design-md/design-md",
);
const outDir = path.join(os.tmpdir(), "agent-workspace-design-md-quality-audit");
const json = process.argv.includes("--json");

const compileFiles = [
  "src/lib/designMdPreviewParser.ts",
  "src/lib/designMdSpecimenBuilder.ts",
  "src/lib/designMdHtmlGenerator.ts",
  "src/lib/designMdColorSemantics.ts",
  "src/lib/designMdRenderEligibility.ts",
  "src/lib/designMdContrast.ts",
  "src/lib/designMdDisplay.ts",
  "src/lib/designMdSourceEvidence.ts",
  "src/lib/designMdPreviewQuality.ts",
];

function compilePreviewModules() {
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
      ...compileFiles,
    ],
    { cwd: repo, stdio: "pipe" },
  );

  for (const file of fs.readdirSync(outDir).filter((name) => name.endsWith(".js"))) {
    const fullPath = path.join(outDir, file);
    const content = fs.readFileSync(fullPath, "utf8")
      .replaceAll('from "./designMdPreviewParser"', 'from "./designMdPreviewParser.js"')
      .replaceAll('from "./designMdSpecimenBuilder"', 'from "./designMdSpecimenBuilder.js"')
      .replaceAll('from "./designMdColorSemantics"', 'from "./designMdColorSemantics.js"')
      .replaceAll('from "./designMdRenderEligibility"', 'from "./designMdRenderEligibility.js"')
      .replaceAll('from "./designMdContrast"', 'from "./designMdContrast.js"')
      .replaceAll('from "./designMdDisplay"', 'from "./designMdDisplay.js"')
      .replaceAll('from "./designMdSourceEvidence"', 'from "./designMdSourceEvidence.js"')
      .replaceAll('from "./designMdPreviewQuality"', 'from "./designMdPreviewQuality.js"');
    fs.writeFileSync(fullPath, content);
  }
}

function sectionCount(markdown) {
  return (markdown.match(/^#{1,4}\s+/gm) ?? []).length;
}

function tokenKey(token) {
  return token ? `${token.key}=${token.resolvedValue}` : "none";
}

function qualityWarningNames(warnings) {
  return Object.entries(warnings).filter(([, value]) => value).map(([key]) => key);
}

function failureGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const flag of row.riskFlags) {
      if (!groups.has(flag)) groups.set(flag, []);
      groups.get(flag).push(row.slug);
    }
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

function printRows(title, rows, columns) {
  console.log(title);
  console.log("-".repeat(120));
  for (const row of rows) {
    console.log(columns.map((column) => String(row[column] ?? "").padEnd(column === "slug" ? 16 : 12)).join(" "));
  }
  console.log();
}

compilePreviewModules();

const { buildBoard } = await import(path.join(outDir, "designMdSpecimenBuilder.js"));
const { deriveLightThemeTokens, deriveDarkThemeTokens } = await import(path.join(outDir, "designMdHtmlGenerator.js"));
const { designMdDisplayTitle } = await import(path.join(outDir, "designMdDisplay.js"));

if (!fs.existsSync(cacheRoot)) {
  console.error("Design MD cache not found. Sync the catalog in the app before running this audit.");
  process.exit(1);
}

const entries = fs.readdirSync(cacheRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .sort();

const rows = [];
for (const slug of entries) {
  const file = path.join(cacheRoot, slug, "DESIGN.md");
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, "utf8");
  const board = buildBoard(slug, designMdDisplayTitle(slug), "", content);
  const light = deriveLightThemeTokens(board);
  const dark = deriveDarkThemeTokens(board);
  const colorTokens = board.colorGroups.flatMap((group) => group.tokens);
  const warnings = qualityWarningNames(board.qualityWarnings);
  const riskFlags = [
    board.qualityWarnings.primaryOveruseRisk ? "primary/accent overuse risk" : null,
    board.qualityWarnings.accentOveruseRisk ? "primary/accent overuse risk" : null,
    board.qualityWarnings.semanticOveruseRisk ? "semantic/timeline overuse risk" : null,
    board.qualityWarnings.timelineOveruseRisk ? "semantic/timeline overuse risk" : null,
    board.qualityWarnings.stateColorOveruseRisk ? "state token as base risk" : null,
    board.coverage.darkTokenCount === 0 ? "no dark source tokens" : null,
    dark.darkThemeSource?.canvas.source === "derived" ? "dark derived from weak source" : null,
    board.qualityWarnings.contrastRisk ? "low contrast risk" : null,
    board.qualityWarnings.weakTypography ? "no typography" : null,
    board.qualityWarnings.weakLayout ? "no layout notes" : null,
    !colorTokens.some((token) => token.semanticRole === "canvas") ? "no palette roles" : null,
    board.qualityWarnings.overflowRisk ? "likely oversized typography" : null,
    board.previewQuality.layoutScore < 45 ? "likely clipped layout" : null,
    board.qualityWarnings.sourceSparse ? "source too sparse" : null,
    board.previewQuality.sourceScore < 45 && board.coverage.componentCount > 8 ? "generator may be over-rendering" : null,
  ].filter(Boolean);

  rows.push({
    slug,
    displayTitle: designMdDisplayTitle(slug),
    sourceTitle: board.title,
    archetype: board.archetype,
    archetypeConfidence: board.confidence.archetype,
    colorTokenCount: board.coverage.colorsCount,
    typographyTokenCount: board.coverage.typographyCount,
    radiusTokenCount: board.coverage.radiusCount,
    spacingTokenCount: board.coverage.spacingCount,
    componentCount: board.coverage.componentCount,
    markdownSectionCount: sectionCount(content),
    lightCanvas: light.canvas,
    lightSurface: light.surface,
    lightText: light.text,
    lightPrimary: light.primary,
    darkCanvas: dark.canvas,
    darkCanvasSource: dark.darkThemeSource?.canvas.source ?? "none",
    darkSurface: dark.surface,
    darkSurfaceSource: dark.darkThemeSource?.surface.source ?? "none",
    darkText: dark.text,
    darkTextSource: dark.darkThemeSource?.text.source ?? "none",
    darkBorder: dark.border,
    darkBorderSource: dark.darkThemeSource?.border.source ?? "none",
    colorSemanticWarnings: colorTokens.flatMap((token) => token.semanticWarnings ?? []),
    darkWarnings: dark.darkThemeSource?.warnings ?? [],
    fontFallbackWarnings: board.warnings.filter((warning) => warning === "font fallback only"),
    layoutExtractionWarnings: board.qualityWarnings.weakLayout ? ["weak layout extraction"] : [],
    sourceLimitedWarnings: warnings,
    previewQualityScore: board.previewQuality.lightScore,
    darkQualityScore: board.previewQuality.darkScore,
    riskFlags: [...new Set(riskFlags)],
    lightCanvasToken: tokenKey(colorTokens.find((token) => token.resolvedValue === light.canvas)),
    lightSurfaceToken: tokenKey(colorTokens.find((token) => token.resolvedValue === light.surface)),
    lightTextToken: tokenKey(colorTokens.find((token) => token.resolvedValue === light.text)),
    lightPrimaryToken: tokenKey(colorTokens.find((token) => token.resolvedValue === light.primary)),
  });
}

if (json) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const byPreview = [...rows].sort((a, b) => a.previewQualityScore - b.previewQualityScore);
const byDark = [...rows].sort((a, b) => a.darkQualityScore - b.darkQualityScore);
const groups = failureGroups(rows);

console.log("Design MD Preview Quality Audit");
console.log("=".repeat(120));
console.log(`Entries audited: ${rows.length}`);
console.log(`Average preview score: ${Math.round(rows.reduce((sum, row) => sum + row.previewQualityScore, 0) / Math.max(1, rows.length))}`);
console.log(`Average dark score: ${Math.round(rows.reduce((sum, row) => sum + row.darkQualityScore, 0) / Math.max(1, rows.length))}`);
console.log();

console.log("Failure classes");
console.log("-".repeat(120));
for (const [flag, slugs] of groups) {
  console.log(`${String(flag).padEnd(36)} ${String(slugs.length).padStart(3)}  ${slugs.slice(0, 18).join(", ")}${slugs.length > 18 ? ", ..." : ""}`);
}
console.log();

printRows("Worst 20 by preview quality", byPreview.slice(0, 20), ["slug", "previewQualityScore", "darkQualityScore", "archetype", "colorTokenCount", "typographyTokenCount", "componentCount"]);
printRows("Worst 20 by dark quality", byDark.slice(0, 20), ["slug", "darkQualityScore", "previewQualityScore", "darkCanvasSource", "darkSurfaceSource", "darkTextSource", "darkBorderSource"]);

console.log("Accent/primary overuse candidates");
console.log("-".repeat(120));
for (const row of rows.filter((row) => row.riskFlags.includes("primary/accent overuse risk")).slice(0, 30)) {
  console.log(`${row.slug.padEnd(16)} primary=${row.lightPrimaryToken} canvas=${row.lightCanvasToken} score=${row.previewQualityScore}`);
}
console.log();

console.log("Derived/fallback dark mode");
console.log("-".repeat(120));
for (const row of rows.filter((row) => row.darkCanvasSource !== "source" || row.darkSurfaceSource !== "source").slice(0, 40)) {
  console.log(`${row.slug.padEnd(16)} canvas=${row.darkCanvas}(${row.darkCanvasSource}) surface=${row.darkSurface}(${row.darkSurfaceSource}) warnings=${row.darkWarnings.join(", ")}`);
}
console.log();

console.log("Sparse source data");
console.log("-".repeat(120));
for (const row of rows.filter((row) => row.riskFlags.includes("source too sparse")).slice(0, 30)) {
  console.log(`${row.slug.padEnd(16)} colors=${row.colorTokenCount} type=${row.typographyTokenCount} layout=${row.markdownSectionCount} components=${row.componentCount} score=${row.previewQualityScore}`);
}
console.log();

console.log("Suggested shared generator fixes");
console.log("-".repeat(120));
for (const [flag] of groups.slice(0, 8)) {
  const suggestion = {
    "no dark source tokens": "derive conservative neutral dark themes from canvas/text/surface only and keep accents sparse",
    "no typography": "prefer markdown font/table extraction and clamp source display sizes",
    "state token as base risk": "exclude active/hover/focus/disabled/loading tokens from base visuals and CTAs",
    "semantic/timeline overuse risk": "keep semantic/timeline colors in palette/source notes unless source declares them primary surfaces",
    "primary/accent overuse risk": "use primary/accent as small hero accents or source-backed buttons only",
    "likely oversized typography": "clamp display specimens and prevent single type rows from defining section height",
    "no layout notes": "extract compact layout notes from Overview, Key Characteristics, Components, and Do/Don't",
    "source too sparse": "render source-limited specimens with fewer visual claims and stronger source notes",
  }[flag] ?? "prefer a source-derived shared parser/generator rule over slug-specific fixes";
  console.log(`${flag}: ${suggestion}`);
}
