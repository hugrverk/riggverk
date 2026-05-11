#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(
  process.env.HOME || "",
  "Library/Application Support/ai.agentworkspace.app/design-catalogs/awesome-design-md/design-md",
);
const outputJson = process.argv.includes("--json");

const tmp = await mkdtemp(path.join(tmpdir(), "design-md-token-roles-"));
const runner = path.join(tmp, "runner.ts");
const bundle = path.join(tmp, "runner.mjs");

mkdirSync(tmp, { recursive: true });
writeFileSync(runner, `
import fs from "node:fs";
import path from "node:path";
import { buildBoard } from ${JSON.stringify(path.join(repoRoot, "src/lib/designMdSpecimenBuilder.ts"))};
import { deriveDarkThemeTokens, deriveLightThemeTokens } from ${JSON.stringify(path.join(repoRoot, "src/lib/designMdHtmlGenerator.ts"))};
import { sourceIntentSummary } from ${JSON.stringify(path.join(repoRoot, "src/lib/designMdSourceIntent.ts"))};

const cacheRoot = ${JSON.stringify(cacheRoot)};
const watchRe = /body|canvas|background|page|surface|card|panel|ink|text|foreground/i;

function safeTitle(slug, content) {
  return (content.match(/^name:\\s*([^\\n]+)/m)?.[1] || content.match(/^#\\s+Design System Inspired by\\s+(.+)$/m)?.[1] || slug)
    .replace(/["']/g, "")
    .trim();
}

function description(content) {
  return (content.match(/^description:\\s*([\\s\\S]*?)(?:\\n\\w+:|\\n---)/m)?.[1] || "")
    .replace(/\\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function allColors(board) {
  return board.colorGroups.flatMap((group) => group.tokens);
}

function findByValue(board, value) {
  const normalized = String(value || "").trim().toLowerCase();
  return allColors(board).find((token) => token.resolvedValue.trim().toLowerCase() === normalized) || null;
}

function tokenRef(token) {
  return token ? token.key + "=" + token.resolvedValue + " role=" + token.resolvedRole + "/" + token.roleConfidence : "derived/fallback";
}

function auditEntry(slug) {
  const file = path.join(cacheRoot, slug, "DESIGN.md");
  const content = fs.readFileSync(file, "utf8");
  const board = buildBoard(slug, safeTitle(slug, content), description(content), content);
  const light = deriveLightThemeTokens(board);
  const dark = deriveDarkThemeTokens(board);
  const tokens = allColors(board);
  const watched = tokens
    .filter((token) => watchRe.test(token.key))
    .map((token) => ({
      key: token.key,
      value: token.resolvedValue,
      group: token.group,
      role: token.resolvedRole || "unknown",
      confidence: token.roleConfidence || "fallback",
      warnings: token.roleWarnings || [],
      evidence: (token.roleEvidence || []).slice(0, 4),
      source: token.sourceEvidence?.sourcePath || token.source || "unknown",
    }));

  const lightCanvasToken = findByValue(board, light.canvas);
  const lightSurfaceToken = findByValue(board, light.surface);
  const lightTextToken = findByValue(board, light.text);
  const darkCanvasToken = findByValue(board, dark.canvas);
  const darkSurfaceToken = findByValue(board, dark.surface);
  const darkTextToken = findByValue(board, dark.text);

  const flags = [];
  const bodyTokens = watched.filter((token) => /body/i.test(token.key));
  const surfaceTokens = watched.filter((token) => /surface|card|panel|tile/i.test(token.key));
  if (bodyTokens.some((token) => token.warnings.length > 0)) flags.push("body ambiguous");
  if (lightCanvasToken?.key.includes("body") && !["high", "medium"].includes(lightCanvasToken.roleConfidence || "")) flags.push("body selected as canvas with low confidence");
  if (lightTextToken?.key.includes("body") && !["high", "medium"].includes(lightTextToken.roleConfidence || "")) flags.push("body selected as text with low confidence");
  if (/card|panel|tile/i.test(lightCanvasToken?.key || "") || /card|panel|tile/i.test(darkCanvasToken?.key || "")) flags.push("card/panel/tile selected as canvas");
  if ((lightCanvasToken?.key === "surface" || darkCanvasToken?.key === "surface") && !["globalCanvas", "pageBackground", "bodyBackground"].includes(lightCanvasToken?.resolvedRole || darkCanvasToken?.resolvedRole || "")) flags.push("surface selected as canvas without evidence");
  if (lightCanvasToken?.resolvedRole === "bodyText" || (dark.darkThemeSource?.canvas?.source === "source" && darkCanvasToken?.resolvedRole === "bodyText")) flags.push("body text likely used as canvas");
  if (lightTextToken?.resolvedRole === "bodyBackground" || darkTextToken?.resolvedRole === "bodyBackground") flags.push("body background likely used as text");
  if (["cardSurface", "panelSurface", "componentSurface"].includes(darkCanvasToken?.resolvedRole || "")) flags.push("dark canvas selected from component surface");
  if (board.sourceIntent.darkModeIntent === "lightFirstDerived" && dark.darkThemeSource?.canvas?.source === "source" && /black|surface-dark|card-dark|panel-dark/i.test(dark.darkThemeSource?.canvas?.matchedKey || "")) flags.push("source intent contradicts selected theme");

  const ambiguityScore = flags.length * 10
    + bodyTokens.length * 2
    + surfaceTokens.length
    + watched.filter((token) => token.confidence === "low" || token.confidence === "fallback").length * 3;

  return {
    slug,
    title: board.title,
    sourceIntent: sourceIntentSummary(board.sourceIntent),
    watched,
    selected: {
      light: {
        canvas: { value: light.canvas, token: tokenRef(lightCanvasToken) },
        surface: { value: light.surface, token: tokenRef(lightSurfaceToken) },
        text: { value: light.text, token: tokenRef(lightTextToken) },
      },
      dark: {
        canvas: { value: dark.canvas, token: tokenRef(darkCanvasToken), source: dark.darkThemeSource?.canvas?.source || "unknown" },
        surface: { value: dark.surface, token: tokenRef(darkSurfaceToken), source: dark.darkThemeSource?.surface?.source || "unknown" },
        text: { value: dark.text, token: tokenRef(darkTextToken), source: dark.darkThemeSource?.text?.source || "unknown" },
      },
    },
    flags,
    ambiguityScore,
  };
}

if (!fs.existsSync(cacheRoot)) {
  console.error("Design MD cache not found. Sync the catalog in the app first.");
  process.exit(1);
}

const rows = fs.readdirSync(cacheRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(cacheRoot, entry.name, "DESIGN.md")))
  .map((entry) => auditEntry(entry.name))
  .sort((a, b) => b.ambiguityScore - a.ambiguityScore || a.slug.localeCompare(b.slug));

function list(title, items, format) {
  console.log("\\n" + title);
  if (items.length === 0) {
    console.log("- none");
    return;
  }
  for (const item of items) console.log("- " + format(item));
}

const worst = rows.filter((row) => row.ambiguityScore > 0).slice(0, 20);
const bodyCanvas = rows.filter((row) => /body/i.test(row.selected.light.canvas.token) || (row.selected.dark.canvas.source === "source" && /body/i.test(row.selected.dark.canvas.token)));
const bodyText = rows.filter((row) => /body/i.test(row.selected.light.text.token) || /body/i.test(row.selected.dark.text.token));
const surfaceCanvas = rows.filter((row) => row.flags.some((flag) => /surface|card|panel|tile/.test(flag)) || /surface|card|panel|tile/i.test(row.selected.light.canvas.token + row.selected.dark.canvas.token));
const darkWrong = rows.filter((row) => row.flags.some((flag) => /dark canvas|contradicts/.test(flag)));
const manual = rows.filter((row) => row.ambiguityScore >= 15 || row.flags.length > 0).slice(0, 24);

console.log("Design MD token role audit");
console.log("Entries: " + rows.length);
list("Worst entries by body/surface ambiguity", worst, (row) => row.slug + " [" + row.ambiguityScore + "] " + (row.flags.join("; ") || "watch tokens: " + row.watched.length));
list("Entries where body is selected as canvas", bodyCanvas, (row) => row.slug + " light=" + row.selected.light.canvas.token + " dark=" + row.selected.dark.canvas.token);
list("Entries where body is selected as text", bodyText, (row) => row.slug + " light=" + row.selected.light.text.token + " dark=" + row.selected.dark.text.token);
list("Entries where surface/card/panel affects canvas/surface", surfaceCanvas.slice(0, 30), (row) => row.slug + " light " + row.selected.light.canvas.token + " / " + row.selected.light.surface.token + " dark " + row.selected.dark.canvas.token + " / " + row.selected.dark.surface.token);
list("Entries where dark canvas is likely wrong", darkWrong, (row) => row.slug + " " + row.selected.dark.canvas.token + " flags=" + row.flags.join("; "));
list("Entries needing manual QA", manual, (row) => row.slug + " [" + row.ambiguityScore + "] light " + row.selected.light.canvas.value + "/" + row.selected.light.surface.value + " dark " + row.selected.dark.canvas.value + "/" + row.selected.dark.surface.value);

if (${JSON.stringify(outputJson)}) {
  console.log("\\nJSON");
  console.log(JSON.stringify({ count: rows.length, worst, bodyCanvas, bodyText, surfaceCanvas, darkWrong, manual }, null, 2));
}
`);

try {
  await esbuild.build({
    entryPoints: [runner],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
  });
  await import(pathToFileURL(bundle).href);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
