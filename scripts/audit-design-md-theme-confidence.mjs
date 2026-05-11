#!/usr/bin/env node
/**
 * audit-design-md-theme-confidence.mjs
 *
 * Run with: npx tsx scripts/audit-design-md-theme-confidence.mjs
 *
 * Audits all Design MD fixture entries for dark theme classification,
 * surface extraction, and rendering confidence.
 *
 * Safe: no network calls, no mutations, deterministic.
 *
 * All filesystem operations use built-in Node modules only.
 */

import { readFileSync, readdirSync } from "fs";

// ── Fixture directory path ──
const FIXTURES_DIR = new URL("../src/lib/__fixtures__/design-md", import.meta.url).pathname;

// ── Inline imports (handled via dynamic import for tsx compat) ──
async function loadModules() {
  const { buildBoard } = await import("../src/lib/designMdSpecimenBuilder.ts");
  const { determineDarkPreviewMode } = await import("../src/lib/designMdDarkPreviewPolicy.ts");
  const { extractDarkSurfaceSet, darkSurfaceSetSummary } = await import("../src/lib/designMdDarkSurfaceSet.ts");
  const { resolveDarkTokens } = await import("../src/lib/designMdThemeResolver.ts");
  return { buildBoard, determineDarkPreviewMode, extractDarkSurfaceSet, darkSurfaceSetSummary, resolveDarkTokens };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function classifyShort(mode) {
  const labels = {
    fullSourceDark: "FULL",
    sectionalSourceDark: "SECT",
    conservativeDerivedDark: "CONS",
    darkTokenBoard: "BOARD",
  };
  return labels[mode] ?? mode;
}

function bullet(items) {
  return items.map((i) => `    - ${i}`).join("\n");
}

function findFixtureFiles(dir) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => ({ name: e.name.replace(/\.md$/, ""), path: `${dir}/${e.name}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// ─── Main audit ───────────────────────────────────────────────────────

async function main() {
  const {
    buildBoard,
    determineDarkPreviewMode,
    extractDarkSurfaceSet,
    darkSurfaceSetSummary,
    resolveDarkTokens,
  } = await loadModules();

  const files = findFixtureFiles(FIXTURES_DIR);

  if (files.length === 0) {
    console.log("No fixture files found in:", FIXTURES_DIR);
    console.log("Run with src fixtures present.");
    process.exit(0);
  }

  const results = [];
  const warnings = [];

  for (const { name: slug, path: file } of files) {
    const content = readFileSync(file, "utf-8");
    const title = slug.charAt(0).toUpperCase() + slug.slice(1);

    const board = buildBoard(slug, title, title, content);
    const policy = determineDarkPreviewMode(board);
    const surfaceSet = extractDarkSurfaceSet(board);
    const darkTokens = resolveDarkTokens(board);

    const entry = {
      slug,
      title,
      darkPreviewMode: policy.mode,
      darkPreviewReason: policy.reason,
      darkPreviewEvidence: policy.evidence,
      darkPreviewWarnings: policy.warnings,
      surfaceSetMode: surfaceSet.mode,
      globalCanvas: surfaceSet.pageCanvas?.key ?? null,
      primarySection: surfaceSet.primarySectionSurface?.key ?? null,
      secondarySection: surfaceSet.secondarySectionSurface?.key ?? null,
      tertiarySection: surfaceSet.tertiarySectionSurface?.key ?? null,
      blackSurface: surfaceSet.blackSurface?.key ?? null,
      onDarkText: surfaceSet.onDarkText?.key ?? null,
      linkOnDark: surfaceSet.linkOnDark?.key ?? null,
      surfaceCount: surfaceSet.allSurfaces.length,
      textTokenCount: surfaceSet.allTextTokens.length,
      surfaceSetWarnings: surfaceSet.warnings,
      surfaceSetSummary: darkSurfaceSetSummary(surfaceSet),
      selectedCanvas: darkTokens.canvas,
      selectedSurface: darkTokens.surface,
      selectedText: darkTokens.text,
    };

    results.push(entry);

    // Collect warnings
    if (surfaceSet.mode === "sectional" && surfaceSet.allSurfaces.length < 2) {
      warnings.push(`${slug}: sectional mode but only ${surfaceSet.allSurfaces.length} surface(s)`);
    }
  }

  // ─── Report ─────────────────────────────────────────────────────────

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║        Design MD Theme Confidence Audit                 ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Per-entry detail
  for (const entry of results) {
    const short = classifyShort(entry.darkPreviewMode);
    const summary = entry.surfaceSetSummary;
    console.log(`  ${short}  ${entry.slug.padEnd(16)} ${entry.title}`);
    console.log(`       Mode: ${entry.darkPreviewMode}`);
    console.log(`       Surface set: ${summary}`);
    console.log(`       Canvas: ${entry.selectedCanvas}  Surface: ${entry.selectedSurface}  Text: ${entry.selectedText}`);
    if (entry.darkPreviewEvidence.length > 0) {
      console.log(`       Evidence:\n${bullet(entry.darkPreviewEvidence)}`);
    }
    console.log("");
  }

  // ─── Mode summary ───────────────────────────────────────────────────

  console.log("── Mode summary ──\n");

  const modes = {};
  for (const entry of results) {
    const m = entry.darkPreviewMode;
    if (!modes[m]) modes[m] = [];
    modes[m].push(entry.slug);
  }

  for (const [mode, slugs] of Object.entries(modes).sort()) {
    console.log(`  ${classifyShort(mode)} (${mode}): ${slugs.join(", ")}`);
  }

  console.log("");

  // ─── Cross-checks ───────────────────────────────────────────────────

  console.log("── Cross-checks ──\n");

  const sectionalEntries = results.filter((r) => r.darkPreviewMode === "sectionalSourceDark");
  if (sectionalEntries.length > 0) {
    console.log("  ✓ Sectional dark entries:");
    for (const r of sectionalEntries) {
      const surfaces = [r.primarySection, r.secondarySection, r.tertiarySection, r.blackSurface]
        .filter(Boolean).join(", ");
      console.log(`    ${r.slug}: ${surfaces}`);
    }
  }

  const fullEntries = results.filter((r) => r.darkPreviewMode === "fullSourceDark");
  if (fullEntries.length > 0) {
    console.log("  ✓ Full dark entries:");
    for (const r of fullEntries) {
      console.log(`    ${r.slug}: canvas="${r.globalCanvas}"`);
    }
  }

  const boardEntries = results.filter((r) => r.darkPreviewMode === "darkTokenBoard");
  if (boardEntries.length > 0) {
    console.log("  📋 Token board entries:");
    for (const r of boardEntries) {
      const reason = r.darkPreviewReason.length > 80
        ? r.darkPreviewReason.slice(0, 77) + "..."
        : r.darkPreviewReason;
      console.log(`    ${r.slug}: ${reason}`);
    }
  }

  // ─── Warnings ───────────────────────────────────────────────────────

  if (warnings.length > 0) {
    console.log("\n── Potential issues ──\n");
    for (const w of warnings) {
      console.log(`  ⚠ ${w}`);
    }
    console.log("");
  }

  // ─── Final stats ────────────────────────────────────────────────────

  console.log(`── Stats ──\n`);
  console.log(`  ${results.length} entries audited`);
  console.log(`  ${sectionalEntries.length} sectional source dark`);
  console.log(`  ${fullEntries.length} full source dark`);
  console.log(`  ${results.filter((r) => r.darkPreviewMode === "conservativeDerivedDark").length} conservative derived dark`);
  console.log(`  ${boardEntries.length} dark token board`);
  console.log(`  ${warnings.length} warnings`);
  console.log("");

  // Exit with status if there are warnings about classification
  const criticalWarnings = warnings.filter((w) =>
    w.includes("sectional mode but only")
  );
  if (criticalWarnings.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
