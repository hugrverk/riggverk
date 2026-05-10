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

const tmp = await mkdtemp(path.join(tmpdir(), "design-md-source-intent-"));
const runner = path.join(tmp, "runner.ts");
const bundle = path.join(tmp, "runner.mjs");

mkdirSync(tmp, { recursive: true });
writeFileSync(runner, `
import fs from "node:fs";
import path from "node:path";
import { buildBoard } from ${JSON.stringify(path.join(repoRoot, "src/lib/designMdSpecimenBuilder.ts"))};
import { deriveDarkThemeTokens, deriveLightThemeTokens } from ${JSON.stringify(path.join(repoRoot, "src/lib/designMdHtmlGenerator.ts"))};
import { sourceIntentSummary } from ${JSON.stringify(path.join(repoRoot, "src/lib/designMdSourceIntent.ts"))};
import { relativeLuminance } from ${JSON.stringify(path.join(repoRoot, "src/lib/designMdContrast.ts"))};

const cacheRoot = ${JSON.stringify(cacheRoot)};

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

function explicitDarkTokens(board) {
  return allColors(board).filter((token) => /dark|on-dark|night|black|inverse|charcoal|slate/i.test(token.key));
}

function colorLuma(color) {
  return relativeLuminance(color) ?? 0;
}

function isThemeScopedColor(value, board) {
  const normalized = String(value || "").trim().toLowerCase();
  const token = allColors(board).find((candidate) => candidate.resolvedValue.trim().toLowerCase() === normalized);
  return !!token && ["semantic", "status", "timeline", "state"].includes(token.semanticRole || "");
}

function auditEntry(slug) {
  const file = path.join(cacheRoot, slug, "DESIGN.md");
  const content = fs.readFileSync(file, "utf8");
  const title = safeTitle(slug, content);
  const board = buildBoard(slug, title, description(content), content);
  const light = deriveLightThemeTokens(board);
  const dark = deriveDarkThemeTokens(board);
  const colors = allColors(board);
  const primary = colors.find((token) => token.semanticRole === "primaryAction" || token.semanticRole === "brandAccent") || null;
  const explicitDark = explicitDarkTokens(board);
  const warnings = [];
  const lightFirst = board.sourceIntent.darkModeIntent === "lightFirstDerived";
  const sparseAccent = board.sourceIntent.accentIntent.some((intent) => ["sparse", "ctaOnly", "wordmarkOnly", "semanticOnly", "timelineOnly", "decorativeOnly"].includes(intent));
  const darkLuma = colorLuma(dark.canvas);

  if (lightFirst && darkLuma < 0.02) warnings.push("light-first but dark canvas too black");
  if (sparseAccent && primary) warnings.push("accent sparse; verify footprint remains small");
  if (primary && [light.canvas, light.surface, dark.canvas, dark.surface].map(String).some((value) => value.toLowerCase() === primary.resolvedValue.toLowerCase())) warnings.push("primary used as canvas/surface");
  if (isThemeScopedColor(light.canvas, board) || isThemeScopedColor(light.surface, board) || isThemeScopedColor(dark.canvas, board) || isThemeScopedColor(dark.surface, board)) warnings.push("semantic/timeline/state used in theme");
  if (dark.darkThemeSource?.canvas?.source !== "source") warnings.push("dark derived from weak source");
  if (explicitDark.length === 0) warnings.push("no explicit dark tokens");
  if (board.sourceIntent.sourceEvidence.length === 0) warnings.push("no source intent extracted");
  if (lightFirst && board.sourceIntent.mood.includes("soft") && darkLuma < 0.035) warnings.push("source prose contradicts harsh dark theme");

  const priority =
    warnings.length * 10
    + (warnings.includes("semantic/timeline/state used in theme") ? 25 : 0)
    + (warnings.includes("primary used as canvas/surface") ? 25 : 0)
    + (warnings.includes("light-first but dark canvas too black") ? 20 : 0)
    + (warnings.includes("source prose contradicts harsh dark theme") ? 18 : 0)
    + (warnings.includes("no explicit dark tokens") ? 8 : 0);

  return {
    slug,
    title,
    sourceIntent: sourceIntentSummary(board.sourceIntent),
    explicitLightTokens: colors.filter((token) => /canvas|background|surface|card|text|ink|body|foreground/i.test(token.key) && !/dark|night|black|inverse/i.test(token.key)).map((token) => token.key).slice(0, 8),
    explicitDarkTokens: explicitDark.map((token) => token.key).slice(0, 8),
    light: { canvas: light.canvas, surface: light.surface, text: light.text },
    dark: { canvas: dark.canvas, surface: dark.surface, text: dark.text, source: dark.darkThemeSource?.canvas?.source || "unknown" },
    primary: primary ? { key: primary.key, value: primary.resolvedValue, role: primary.semanticRole, intent: primary.usageIntensity } : null,
    darkModeIntent: board.sourceIntent.darkModeIntent,
    warnings,
    priority,
  };
}

if (!fs.existsSync(cacheRoot)) {
  console.error("Design MD cache not found. Sync the catalog in the app first.");
  process.exit(1);
}

const rows = fs.readdirSync(cacheRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(cacheRoot, entry.name, "DESIGN.md")))
  .map((entry) => auditEntry(entry.name))
  .sort((a, b) => b.priority - a.priority || a.slug.localeCompare(b.slug));

const worst = rows.filter((row) => row.priority > 0).slice(0, 20);
const tooDark = rows.filter((row) => row.warnings.includes("light-first but dark canvas too black") || row.warnings.includes("source prose contradicts harsh dark theme"));
const accent = rows.filter((row) => row.warnings.some((warning) => warning.includes("accent sparse") || warning.includes("primary used")));
const noDark = rows.filter((row) => row.warnings.includes("no explicit dark tokens"));
const manual = rows.filter((row) => row.priority >= 30).slice(0, 24);

function printList(title, list, mapper) {
  console.log("\\n" + title);
  if (list.length === 0) {
    console.log("- none");
    return;
  }
  for (const item of list) console.log("- " + mapper(item));
}

console.log("Design MD source intent audit");
console.log("Entries: " + rows.length);
printList("Worst 20 source-intent mismatch risks", worst, (row) => row.slug + " [" + row.priority + "] " + row.warnings.join("; "));
printList("Entries with dark mode likely too dark", tooDark, (row) => row.slug + " " + row.dark.canvas + " " + row.sourceIntent);
printList("Entries with accent overuse risk", accent, (row) => row.slug + " " + (row.primary ? row.primary.key + "=" + row.primary.value : "no primary") + " " + row.warnings.join("; "));
printList("Entries with no explicit dark tokens", noDark, (row) => row.slug + " derived=" + row.dark.canvas);
printList("Entries needing manual visual QA", manual, (row) => row.slug + " [" + row.priority + "] light " + row.light.canvas + "/" + row.light.surface + " dark " + row.dark.canvas + "/" + row.dark.surface);

console.log("\\nJSON");
console.log(JSON.stringify({ count: rows.length, worst, tooDark, accent, noDark, manual }, null, 2));
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
