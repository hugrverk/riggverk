#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const cacheRoot = path.resolve(
  os.homedir(),
  "Library/Application Support/ai.agentworkspace.app/design-catalogs/awesome-design-md/design-md",
);
const expectedCount = 71;

function compileRuntimeModules() {
  const outDir = path.join(os.tmpdir(), "agent-workspace-design-md-dark-audit");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const runtimeFiles = fs.readdirSync(path.join(repoRoot, "src/lib"))
    .filter((name) => name.startsWith("designMd") && name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join("src/lib", name));

  execFileSync(
    path.join(repoRoot, "node_modules/typescript/bin/tsc"),
    [
      "--outDir", outDir,
      "--module", "ES2022",
      "--target", "ES2022",
      "--moduleResolution", "Bundler",
      "--skipLibCheck",
      ...runtimeFiles,
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );

  for (const file of fs.readdirSync(outDir)) {
    if (!file.endsWith(".js")) continue;
    const fullPath = path.join(outDir, file);
    let content = fs.readFileSync(fullPath, "utf8");
    content = content
      .replace(/from ([\"'])(\.\/[^\"']+)\1/g, (_match, quote, rel) => "from " + quote + rel + ".js" + quote)
      .replace(/import\(([\"'])(\.\/[^\"']+)\1\)/g, (_match, quote, rel) => "import(" + quote + rel + ".js" + quote + ")");
    fs.writeFileSync(fullPath, content);
  }

  return outDir;
}

function listDirEntries(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "DESIGN.md")))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function readDesignMd(root, slug) {
  const file = path.join(root, slug, "DESIGN.md");
  return fs.readFileSync(file, "utf8");
}

function sourceTitleFromContent(content, fallback) {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("---")) {
    const after = trimmed.slice(3);
    const closing = after.match(/\n---\s*(\n|$)/);
    if (closing && closing.index !== undefined) {
      const fm = after.slice(0, closing.index);
      const match = fm.match(/^title:\s*(.+)$/im);
      if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  return fallback;
}

function compact(values) {
  return values.filter(Boolean).join(", ");
}

function safeCount(values) {
  return values.filter((value) => !!value).length;
}

function hasPattern(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function boardColorTokens(board) {
  return board.colorGroups.flatMap((group) => group.tokens);
}

function keyParts(key) {
  return key.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean);
}

function tokenValue(token) {
  return token?.resolvedValue?.trim() ?? "";
}

function isDarkValue(value, relativeLuminance) {
  const hex = tokenValue({ resolvedValue: value });
  if (!/^#[0-9a-fA-F]{3,8}$/.test(hex)) return false;
  const luma = relativeLuminance(hex);
  return luma !== null && luma < 0.32;
}

function classifyTokens(board, helpers) {
  const tokens = boardColorTokens(board);
  const { getSectionalDarkSurfaceEvidence, getExplicitGlobalDarkCanvasEvidence, getExplicitDarkTextEvidence } = helpers;
  const globalCanvasEvidence = getExplicitGlobalDarkCanvasEvidence(board);
  const sectionalEvidence = getSectionalDarkSurfaceEvidence(board);
  const textEvidence = getExplicitDarkTextEvidence(board);

  const explicitGlobalDarkCanvas = tokens
    .filter((token) => globalCanvasEvidence.some((e) => e.tokenKey === token.key))
    .map((token) => token.key);

  const explicitSectionalDarkSurface = tokens
    .filter((token) => sectionalEvidence.some((e) => e.tokenKey === token.key))
    .map((token) => token.key);

  const blackVoidTokens = tokens
    .filter((token) => {
      const parts = keyParts(token.key);
      return parts.includes("black") && parts.some((part) => /^(surface|nav|void|bg)$/.test(part));
    })
    .filter((token) => isDarkValue(token.resolvedValue, helpers.relativeLuminance))
    .map((token) => token.key);

  const navDarkTokens = tokens
    .filter((token) => {
      const parts = keyParts(token.key);
      return parts.some((part) => /^(nav|navigation|global-nav)$/.test(part)) && parts.some((part) => /^(dark|black|night)$/.test(part));
    })
    .map((token) => token.key);

  const cardPanelTileDarkTokens = tokens
    .filter((token) => {
      const parts = keyParts(token.key);
      return (
        (parts.includes("tile") || parts.includes("card") || parts.includes("panel"))
        && parts.some((part) => /^(dark|black|night)$/.test(part))
      );
    })
    .map((token) => token.key);

  const onDarkTextTokens = tokens
    .filter((token) => textEvidence.some((e) => e.tokenKey === token.key))
    .map((token) => token.key);

  const linkOnDarkTokens = tokens
    .filter((token) => /^(primary-on-dark|link-on-dark|accent-on-dark|on-primary-dark)$/.test(token.key.toLowerCase()))
    .map((token) => token.key);

  const darkComponentNames = board.componentGroups
    .filter((group) => group.name.toLowerCase().includes("dark") || group.name.toLowerCase().includes("black"))
    .map((group) => group.name);

  const darkProseEvidence = helpers.getDarkProseEvidence(board);

  return {
    explicitGlobalDarkCanvas,
    explicitSectionalDarkSurface,
    blackVoidTokens,
    navDarkTokens,
    cardPanelTileDarkTokens,
    onDarkTextTokens,
    linkOnDarkTokens,
    darkComponentNames,
    darkProseEvidence,
  };
}

function entryWarnings(entry) {
  const warnings = [];
  const darkEvidenceExists = entry.explicitGlobalDarkCanvas.length > 0
    || entry.explicitSectionalDarkSurface.length > 0
    || entry.onDarkTextTokens.length > 0
    || entry.darkComponentNames.length > 0
    || entry.darkProseEvidence.length > 0;
  const sectionalEvidenceExists = entry.explicitSectionalDarkSurface.length >= 2
    || (entry.explicitSectionalDarkSurface.length >= 1 && (entry.darkComponentNames.length > 0 || entry.darkProseEvidence.length > 0))
    || entry.explicitSectionalDarkSurface.length >= 3;
  const strongSectionalEvidence = entry.explicitSectionalDarkSurface.length >= 3
    || (entry.explicitSectionalDarkSurface.length >= 2 && entry.onDarkTextTokens.length > 0 && (entry.darkComponentNames.length > 0 || entry.darkProseEvidence.length > 0));

  if (darkEvidenceExists && entry.mode === "darkTokenBoard") warnings.push("dark evidence exists but mode is darkTokenBoard");
  if (sectionalEvidenceExists && entry.mode !== "sectionalSourceDark") warnings.push("sectional evidence exists but not sectionalSourceDark");
  if (entry.primarySectionSurface === "surface-black" && entry.cardPanelTileDarkTokens.some((key) => /tile/i.test(key))) warnings.push("black surface selected as primary while tile surfaces exist");
  if (entry.primarySectionSourceKind === "navSurface") warnings.push("nav surface selected as primary section");
  if (entry.primarySectionSourceKind && /^(cardSurface|panelSurface|componentSurface)$/.test(entry.primarySectionSourceKind) && entry.cardPanelTileDarkTokens.some((key) => /tile/i.test(key))) warnings.push("component-local surface promoted too broadly");
  if (entry.onDarkTextTokens.length === 0 && (entry.explicitSectionalDarkSurface.length > 0 || entry.explicitGlobalDarkCanvas.length > 0)) warnings.push("on-dark text missing");
  if (entry.explicitSectionalDarkSurface.length === 0 && entry.explicitGlobalDarkCanvas.length === 0 && entry.onDarkTextTokens.length > 0) warnings.push("dark surface missing");
  if (entry.mode === "fullSourceDark" && entry.explicitGlobalDarkCanvas.length === 0) warnings.push("fullSourceDark selected without sufficient global evidence");
  if (entry.mode === "conservativeDerivedDark" && strongSectionalEvidence) warnings.push("conservativeDerivedDark selected despite strong sectional evidence");
  if (entry.sourceIntent.darkModeIntent === "lightFirstDerived" && entry.mode !== "darkTokenBoard" && !hasPattern(entry.sourceText, [/\bfull dark\b/, /\bdark theme\b/, /\bdark canvas\b/, /\bdark-native\b/])) warnings.push("source prose contradicts mode");
  if (entry.primarySectionSurface === "surface-black" && entry.explicitSectionalDarkSurface.some((key) => /tile/i.test(key))) warnings.push("likely too black");
  if (entry.mode === "darkTokenBoard" && darkEvidenceExists) warnings.push("likely too generic");
  if (entry.mode === "darkTokenBoard" && (entry.explicitSectionalDarkSurface.length > 0 || entry.onDarkTextTokens.length > 0)) warnings.push("likely underusing source dark tokens");
  return warnings;
}

async function main() {
  const outDir = compileRuntimeModules();
  const helpers = await import(path.join(outDir, "designMdDarkSurfaceEvidence.js"));
  const { buildBoard } = await import(path.join(outDir, "designMdSpecimenBuilder.js"));
  const { determineDarkPreviewMode } = await import(path.join(outDir, "designMdDarkPreviewPolicy.js"));
  const { extractDarkSurfaceSet } = await import(path.join(outDir, "designMdDarkSurfaceSet.js"));
  const { resolveDarkTokens } = await import(path.join(outDir, "designMdThemeResolver.js"));
  const { generateBoardHtml } = await import(path.join(outDir, "designMdHtmlGenerator.js"));
  const { designMdDisplayTitle } = await import(path.join(outDir, "designMdDisplay.js"));
  const { sourceIntentSummary } = await import(path.join(outDir, "designMdSourceIntent.js"));
  const { relativeLuminance } = await import(path.join(outDir, "designMdContrast.js"));

  const slugs = listDirEntries(cacheRoot);
  const results = [];
  for (const slug of slugs) {
    const content = readDesignMd(cacheRoot, slug);
    const displayTitle = designMdDisplayTitle(slug);
    const sourceTitle = sourceTitleFromContent(content, displayTitle);
    const board = buildBoard(slug, displayTitle, sourceTitle, content);
    const policy = determineDarkPreviewMode(board);
    const surfaceSet = extractDarkSurfaceSet(board);
    const theme = resolveDarkTokens(board);
    const html = generateBoardHtml(board, { variant: "dark" });
    const tokenClasses = classifyTokens(board, { ...helpers, relativeLuminance });
    const sourceText = [board.title, board.description, board.overview ?? "", board.layout ?? "", ...board.visualLanguage.phrases].join(" ").toLowerCase();

    const row = {
      slug,
      displayTitle,
      sourceTitle,
      mode: policy.mode,
      sourceIntent: sourceIntentSummary(board.sourceIntent),
      sourceText,
      explicitGlobalDarkCanvas: tokenClasses.explicitGlobalDarkCanvas,
      explicitSectionalDarkSurface: tokenClasses.explicitSectionalDarkSurface,
      blackVoidTokens: tokenClasses.blackVoidTokens,
      navDarkTokens: tokenClasses.navDarkTokens,
      cardPanelTileDarkTokens: tokenClasses.cardPanelTileDarkTokens,
      onDarkTextTokens: tokenClasses.onDarkTextTokens,
      linkOnDarkTokens: tokenClasses.linkOnDarkTokens,
      darkComponentNames: tokenClasses.darkComponentNames,
      darkProseEvidence: tokenClasses.darkProseEvidence.map((item) => `${item.source}: ${item.excerpt}`),
      selectedPageCanvas: surfaceSet.pageCanvas?.key ?? null,
      selectedPrimarySectionSurface: surfaceSet.primarySectionSurface?.key ?? null,
      selectedSecondarySectionSurface: surfaceSet.secondarySectionSurface?.key ?? null,
      selectedTertiarySectionSurface: surfaceSet.tertiarySectionSurface?.key ?? null,
      selectedBlackSurface: surfaceSet.blackSurface?.key ?? null,
      selectedNavSurface: surfaceSet.navSurface?.key ?? null,
      selectedDarkText: surfaceSet.onDarkText?.key ?? null,
      selectedDarkMutedText: surfaceSet.mutedOnDarkText?.key ?? null,
      selectedDarkLinkAccent: surfaceSet.linkOnDark?.key ?? null,
      warnings: entryWarnings({
        ...tokenClasses,
        mode: policy.mode,
        primarySectionSurface: surfaceSet.primarySectionSurface?.key ?? null,
        primarySectionSourceKind: surfaceSet.primarySectionSurface?.sourceKind ?? null,
        sourceIntent: board.sourceIntent,
        sourceText,
      }),
    };

    results.push(row);
  }

  const counts = results.reduce((acc, row) => {
    acc[row.mode] = (acc[row.mode] ?? 0) + 1;
    return acc;
  }, {});

  const strongSectionalEntries = results.filter((row) =>
    row.explicitSectionalDarkSurface.length >= 3
    || (row.explicitSectionalDarkSurface.length >= 2 && row.onDarkTextTokens.length > 0 && (row.darkComponentNames.length > 0 || row.darkProseEvidence.length > 0))
  );
  const darkSurfaceButNoOnDark = results.filter((row) => row.explicitSectionalDarkSurface.length > 0 && row.onDarkTextTokens.length === 0);
  const onDarkButNoDarkSurface = results.filter((row) => row.onDarkTextTokens.length > 0 && row.explicitSectionalDarkSurface.length === 0 && row.explicitGlobalDarkCanvas.length === 0);
  const blackOverPromoted = results.filter((row) => row.selectedPrimarySectionSurface === "surface-black" || row.selectedBlackSurface === row.selectedPrimarySectionSurface);
  const manualQa = results
    .map((row) => ({ ...row, score: row.warnings.length }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, 20);

  console.log(`Design MD dark preview audit`);
  console.log(`Catalog root: ${cacheRoot}`);
  console.log(`Total entries audited: ${results.length}`);
  if (results.length !== expectedCount) {
    console.log(`Expected count: ${expectedCount}`);
    console.log(`Actual count: ${results.length}`);
    console.log(`Count mismatch explanation: the local cache contains ${results.length} DESIGN.md entries under the synced Design MD catalog root.`);
  }
  console.log("");
  console.log("Entries per darkPreviewMode:");
  for (const [mode, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`- ${mode}: ${count}`);
  }
  console.log("");
  console.log("Top 20 mismatch risks:");
  if (manualQa.length === 0) {
    console.log("- none");
  } else {
    for (const row of manualQa) {
      console.log(`- ${row.slug}: ${row.warnings.join("; ")}`);
    }
  }
  console.log("");
  console.log(`Entries with strong sectional dark evidence: ${strongSectionalEntries.map((row) => row.slug).join(", ") || "none"}`);
  console.log(`Entries with dark surfaces but no on-dark text: ${darkSurfaceButNoOnDark.map((row) => row.slug).join(", ") || "none"}`);
  console.log(`Entries with on-dark text but no dark surfaces: ${onDarkButNoDarkSurface.map((row) => row.slug).join(", ") || "none"}`);
  console.log(`Entries where black/void was over-promoted: ${blackOverPromoted.map((row) => row.slug).join(", ") || "none"}`);
  console.log(`Entries likely needing manual QA: ${manualQa.map((row) => row.slug).join(", ") || "none"}`);
  console.log("");

  for (const row of results) {
    console.log(`ENTRY ${row.slug}`);
    console.log(`- display title: ${row.displayTitle}`);
    console.log(`- source title: ${row.sourceTitle}`);
    console.log(`- darkPreviewMode: ${row.mode}`);
    console.log(`- source intent: ${row.sourceIntent}`);
    console.log(`- explicit global dark canvas tokens: ${compact(row.explicitGlobalDarkCanvas) || "none"}`);
    console.log(`- explicit sectional dark surface tokens: ${compact(row.explicitSectionalDarkSurface) || "none"}`);
    console.log(`- black/void tokens: ${compact(row.blackVoidTokens) || "none"}`);
    console.log(`- nav dark tokens: ${compact(row.navDarkTokens) || "none"}`);
    console.log(`- card/panel/tile dark tokens: ${compact(row.cardPanelTileDarkTokens) || "none"}`);
    console.log(`- on-dark/text-on-dark/body-on-dark tokens: ${compact(row.onDarkTextTokens) || "none"}`);
    console.log(`- link-on-dark/primary-on-dark tokens: ${compact(row.linkOnDarkTokens) || "none"}`);
    console.log(`- dark component names: ${compact(row.darkComponentNames) || "none"}`);
    console.log(`- dark prose evidence: ${compact(row.darkProseEvidence) || "none"}`);
    console.log(`- selected page canvas: ${row.selectedPageCanvas ?? "none"}`);
    console.log(`- selected primary section surface: ${row.selectedPrimarySectionSurface ?? "none"}`);
    console.log(`- selected secondary section surface: ${row.selectedSecondarySectionSurface ?? "none"}`);
    console.log(`- selected tertiary section surface: ${row.selectedTertiarySectionSurface ?? "none"}`);
    console.log(`- selected black surface: ${row.selectedBlackSurface ?? "none"}`);
    console.log(`- selected nav surface: ${row.selectedNavSurface ?? "none"}`);
    console.log(`- selected dark text: ${row.selectedDarkText ?? "none"}`);
    console.log(`- selected dark muted text: ${row.selectedDarkMutedText ?? "none"}`);
    console.log(`- selected dark link/accent: ${row.selectedDarkLinkAccent ?? "none"}`);
    console.log(`- warnings: ${compact(row.warnings) || "none"}`);
    console.log("");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
