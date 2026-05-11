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

const tmp = await mkdtemp(path.join(tmpdir(), "design-md-theme-confidence-"));
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

  const lightCanvasToken = findByValue(board, light.canvas);
  const lightSurfaceToken = findByValue(board, light.surface);
  const lightTextToken = findByValue(board, light.text);
  const darkCanvasToken = findByValue(board, dark.canvas);
  const darkSurfaceToken = findByValue(board, dark.surface);
  const darkTextToken = findByValue(board, dark.text);

  const darkMode = dark.darkPreviewMode || "unknown";
  const darkNote = dark.darkPreviewNote || "";

  // Find explicit dark tokens
  const darkKeyRe = /dark|night|inverse|black/i;
  const explicitDarkCanvas = tokens.filter((t) =>
    darkKeyRe.test(t.key) && (t.resolvedRole === "globalCanvas" || t.resolvedRole === "pageBackground" || t.resolvedRole === "bodyBackground")
    && (t.roleConfidence === "high" || t.roleConfidence === "medium")
  );
  const explicitDarkSurface = tokens.filter((t) =>
    darkKeyRe.test(t.key) && (t.resolvedRole === "sectionSurface" || t.resolvedRole === "cardSurface" || t.resolvedRole === "panelSurface")
    && (t.roleConfidence === "high" || t.roleConfidence === "medium")
  );
  const explicitOnDark = tokens.filter((t) =>
    /on-dark|on-dark|text-on-dark|on-night|on-black/.test(t.key.toLowerCase())
  );

  // Body/surface ambiguity checks
  const bodyTokens = tokens.filter((t) => /body/i.test(t.key));
  const surfaceTokens = tokens.filter((t) => /^(surface|card|panel|tile)$/i.test(t.key) || /surface-card|card-surface/i.test(t.key));
  const bodyAmbiguityWarnings = bodyTokens.flatMap((t) => (t.roleWarnings || []).filter((w) => /ambiguous|weak evidence/i.test(w)));
  const surfaceAmbiguityWarnings = surfaceTokens.flatMap((t) => (t.roleWarnings || []).filter((w) => /ambiguous|weak evidence|must not become/i.test(w)));

  const flags = [];
  if (bodyAmbiguityWarnings.length > 0) flags.push("body ambiguous");
  if (surfaceAmbiguityWarnings.length > 0) flags.push("surface/card/panel ambiguous");

  // Detection of over-inference patterns
  if (darkMode === "fullSourceDark" && explicitDarkCanvas.length === 0) flags.push("full dark without explicit dark canvas");
  if (darkMode === "fullSourceDark" && board.sourceIntent.darkModeIntent === "lightFirstDerived") flags.push("light-first source but full dark rendered");
  if (darkMode !== "darkTokenBoard" && board.sourceIntent.canvasIntent === "cream") flags.push("cream canvas but dark theme derived");
  if (darkMode !== "darkTokenBoard" && board.sourceIntent.canvasIntent === "offWhite") flags.push("off-white canvas but dark theme derived");
  if (darkMode !== "darkTokenBoard" && board.sourceIntent.canvasIntent === "warmLight") flags.push("warm-light canvas but dark theme derived");
  if (darkCanvasToken?.resolvedRole === "bodyText" || darkCanvasToken?.resolvedRole === "foregroundText") flags.push("text token used as dark canvas");
  if (["cardSurface", "panelSurface", "componentSurface"].includes(darkCanvasToken?.resolvedRole || "")) flags.push("component surface used as dark canvas");
  if (darkCanvasToken && (darkCanvasToken.resolvedRole === "primaryAction" || darkCanvasToken.resolvedRole === "brandAccent")) flags.push("primary/accent used as dark canvas");

  return {
    slug,
    title: board.title,
    sourceIntent: sourceIntentSummary(board.sourceIntent),
    darkPreviewMode: darkMode,
    darkPreviewNote: darkNote,
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
    explicitDarkCanvas: explicitDarkCanvas.map((t) => t.key),
    explicitDarkSurface: explicitDarkSurface.map((t) => t.key),
    explicitOnDark: explicitOnDark.map((t) => t.key),
    bodyAmbiguityWarnings,
    surfaceAmbiguityWarnings,
    flags,
  };
}

if (!fs.existsSync(cacheRoot)) {
  console.error("Design MD cache not found. Sync the catalog in the app first.");
  process.exit(1);
}

const rows = fs.readdirSync(cacheRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(cacheRoot, entry.name, "DESIGN.md")))
  .map((entry) => auditEntry(entry.name))
  .sort((a, b) => a.slug.localeCompare(b.slug));

// Classification buckets
const fullSourceDark = rows.filter((r) => r.darkPreviewMode === "fullSourceDark");
const conservativeDerivedDark = rows.filter((r) => r.darkPreviewMode === "conservativeDerivedDark");
const darkTokenBoard = rows.filter((r) => r.darkPreviewMode === "darkTokenBoard");
const unknown = rows.filter((r) => r.darkPreviewMode === "unknown");

console.log("╔═══════════════════════════════════════════════╗");
console.log("║  Design MD Theme Confidence Audit             ║");
console.log("╚═══════════════════════════════════════════════╝");
console.log("\\nTotal entries: " + rows.length);
console.log("");

function list(title, items, format) {
  console.log(title + " (" + items.length + "):");
  if (items.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const item of items) console.log("  - " + format(item));
  console.log("");
}

// ── Dark Preview Mode Distribution ──
list("■ fullSourceDark — explicit dark canvas with supporting evidence", fullSourceDark,
  (r) => r.slug + " | " + r.sourceIntent + " | canvas: " + r.selected.dark.canvas.value + " [" + r.selected.dark.canvas.token + "]");

list("■ conservativeDerivedDark — derived from neutral tokens", conservativeDerivedDark,
  (r) => r.slug + " | " + r.sourceIntent + " | canvas: " + r.selected.dark.canvas.value + " [" + r.selected.dark.canvas.token + "]");

list("■ darkTokenBoard — no explicit dark theme; token board only", darkTokenBoard,
  (r) => r.slug + " | " + r.sourceIntent + " | note: " + r.darkPreviewNote);

if (unknown.length > 0) {
  list("■ unknown mode", unknown, (r) => r.slug);
}

// ── Body/surface ambiguity ──
const ambiguityRows = rows
  .filter((r) => r.bodyAmbiguityWarnings.length > 0 || r.surfaceAmbiguityWarnings.length > 0)
  .sort((a, b) => (b.bodyAmbiguityWarnings.length + b.surfaceAmbiguityWarnings.length) - (a.bodyAmbiguityWarnings.length + a.surfaceAmbiguityWarnings.length));

list("■ Worst body/surface ambiguity entries", ambiguityRows.slice(0, 15),
  (r) => r.slug + " [" + r.darkPreviewMode + "] body-warnings=" + r.bodyAmbiguityWarnings.length + " surface-warnings=" + r.surfaceAmbiguityWarnings.length +
    " | " + r.bodyAmbiguityWarnings.concat(r.surfaceAmbiguityWarnings).slice(0, 3).join("; "));

// ── Flagged entries ──
const flaggedEntries = rows.filter((r) => r.flags.length > 0).sort((a, b) => b.flags.length - a.flags.length);

list("■ Entries with over-inference or misuse flags", flaggedEntries.slice(0, 20),
  (r) => r.slug + " [" + r.darkPreviewMode + "] flags=" + r.flags.join("; "));

// ── Manual QA candidates ──
const manualQA = rows
  .filter((r) => r.darkPreviewMode === "fullSourceDark" && r.explicitDarkCanvas.length === 0)
  .concat(rows.filter((r) => r.flags.length >= 2))
  .concat(rows.filter((r) => r.darkPreviewMode === "conservativeDerivedDark" && r.bodyAmbiguityWarnings.length > 0))
  .filter((r, i, arr) => arr.indexOf(r) === i)
  .slice(0, 20);

list("■ Entries needing manual QA", manualQA,
  (r) => r.slug + " [" + r.darkPreviewMode + "] " + r.sourceIntent +
    " | light=" + r.selected.light.canvas.value + "/" + r.selected.light.text.value +
    " | dark=" + r.selected.dark.canvas.value + "/" + r.selected.dark.text.value +
    " | flags=" + (r.flags.join("; ") || "none"));

// ── Mismatch summary ──
console.log("\\n╔═══════════════════════════════════════════════╗");
console.log("║  Mismatch Risk Summary                         ║");
console.log("╚═══════════════════════════════════════════════╝");

const risks = {
  "body ambiguous": rows.filter((r) => r.bodyAmbiguityWarnings.length > 0).length,
  "surface/card/panel ambiguous": rows.filter((r) => r.surfaceAmbiguityWarnings.length > 0).length,
  "light-first but full dark rendered": rows.filter((r) => r.flags.includes("light-first source but full dark rendered")).length,
  "cream/warm/off-white canvas but dark derived": rows.filter((r) => r.flags.some((f) => /cream|off-white|warm-light/.test(f))).length,
  "text token as dark canvas": rows.filter((r) => r.flags.includes("text token used as dark canvas")).length,
  "component surface as dark canvas": rows.filter((r) => r.flags.includes("component surface used as dark canvas")).length,
  "primary/accent as dark canvas": rows.filter((r) => r.flags.includes("primary/accent used as dark canvas")).length,
};

for (const [risk, count] of Object.entries(risks)) {
  console.log("  " + risk + ": " + count);
}

if (${JSON.stringify(outputJson)}) {
  console.log("\\n--- JSON ---");
  console.log(JSON.stringify({
    total: rows.length,
    fullSourceDark: fullSourceDark.length,
    conservativeDerivedDark: conservativeDerivedDark.length,
    darkTokenBoard: darkTokenBoard.length,
    unknown: unknown.length,
    ambiguityRows: ambiguityRows.map((r) => r.slug),
    flaggedSlugs: flaggedEntries.map((r) => ({ slug: r.slug, mode: r.darkPreviewMode, flags: r.flags })),
    manualQA: manualQA.map((r) => r.slug),
    risks,
  }, null, 2));
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
