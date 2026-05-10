#!/usr/bin/env node

/**
 * Audit script for Design MD preview quality.
 *
 * Reads DESIGN.md files from the Tauri cache and reports:
 * - token counts (colors, dark, typography, radius, spacing, components)
 * - section presence (palette, typography, radius/spacing, layout, source notes)
 * - dark mode source/derived status
 * - risk flags
 *
 * Usage:
 *   node scripts/audit-design-md-previews.mjs
 *   node scripts/audit-design-md-previews.mjs --slug bmw-m
 *   node scripts/audit-design-md-previews.mjs --json
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const CACHE_ROOT = resolve(
  homedir(),
  "Library/Application Support/ai.agentworkspace.app/design-catalogs/awesome-design-md/design-md"
);

const args = process.argv.slice(2);
const filterSlug = args.includes("--slug") ? args[args.indexOf("--slug") + 1] : null;
const outputJson = args.includes("--json");

// ── Parsing helpers ──

function parseFlatFrontmatter(content) {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return new Map();

  const afterOpen = trimmed.slice(3).replace(/^\s*\n/, "");
  const closing = afterOpen.match(/\n---\s*(\n|$)/);
  const fmStr = closing && closing.index !== undefined ? afterOpen.slice(0, closing.index) : afterOpen;

  const map = new Map();
  const lines = fmStr.split("\n");
  let currentPath = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trimEnd();
    const indent = rawLine.length - rawLine.trimStart().length;
    const content = trimmed.trim();
    if (!content || content.startsWith("#")) continue;

    // Adjust nesting stack
    while (currentPath.length > 0 && indent <= currentPath[currentPath.length - 1].indent) {
      currentPath.pop();
    }

    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) continue;

    const key = content.slice(0, colonIdx).trim();
    const rawVal = content.slice(colonIdx + 1).trim();

    if (rawVal === "|" || rawVal === "|-" || rawVal === ">" || rawVal === ">-") {
      currentPath.push({ indent, key });
      continue;
    }

    if (!rawVal) {
      currentPath.push({ indent, key });
      continue;
    }

    const path = [...currentPath.map((f) => f.key), key].join(".");
    map.set(path, rawVal.replace(/^["']|["']$/g, ""));
  }

  return map;
}

function getFrontmatterBody(content) {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return content;
  const afterOpen = trimmed.slice(3);
  const closing = afterOpen.match(/\n---\s*(\n|$)/);
  if (!closing || closing.index === undefined) return "";
  return afterOpen.slice(closing.index + closing[0].length);
}

function countSafeColors(map) {
  let count = 0;
  for (const [key, value] of map) {
    if (key.startsWith("colors.") && /^#[0-9a-fA-F]{3,8}$/.test(value.trim())) {
      count++;
    }
  }
  return count;
}

function countDarkTokens(map) {
  let count = 0;
  for (const [key, value] of map) {
    if (!key.startsWith("colors.")) continue;
    const k = key.toLowerCase();
    if (/dark|black|night|inverse|charcoal|slate|on-dark|on-black|aubergine|canvas-dark|background-dark|surface-dark/.test(k)) {
      count++;
    }
  }
  return count;
}

function countTypographyTokens(map) {
  let count = 0;
  const seen = new Set();
  for (const key of map.keys()) {
    if (!key.startsWith("typography.")) continue;
    const rest = key.slice("typography.".length);
    const parts = rest.split(".");
    const base = parts[0];
    if (!seen.has(base)) {
      seen.add(base);
      count++;
    }
  }
  return count;
}

function countRadiusTokens(map) {
  let count = 0;
  for (const key of map.keys()) {
    if (key.startsWith("rounded.") || key.startsWith("radius.")) {
      count++;
    }
  }
  return count;
}

function countSpacingTokens(map) {
  let count = 0;
  for (const key of map.keys()) {
    if (key.startsWith("spacing.") || key.startsWith("space.")) {
      count++;
    }
  }
  return count;
}

function countComponentTokens(map) {
  let count = 0;
  const seen = new Set();
  for (const key of map.keys()) {
    if (!key.startsWith("components.")) continue;
    const rest = key.slice("components.".length);
    const parts = rest.split(".");
    const base = parts[0];
    if (!seen.has(base)) {
      seen.add(base);
      count++;
    }
  }
  return count;
}

function extractSection(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^#{1,3}\\s+${escaped}:?\\s*$`, "im"),
    new RegExp(`^#{1,3}\\s+\\d+\\.?\\s*${escaped}:?\\s*$`, "im"),
    new RegExp(`^#{1,3}\\s+[^#\\n]*\\b${escaped}\\b[^#\\n]*:?\\s*$`, "im"),
  ];
  for (const re of patterns) {
    const match = body.match(re);
    if (match && match.index !== undefined) {
      const after = body.slice(match.index + match[0].length);
      const nextHeading = after.match(/\n#{1,3}\s/);
      return (nextHeading && nextHeading.index !== undefined ? after.slice(0, nextHeading.index) : after).trim();
    }
  }
  return null;
}

function hasLayoutSection(body) {
  return extractSection(body, "Layout") !== null || extractSection(body, "Overview") !== null;
}

function extractDoDontItems(body) {
  const doSection = extractSection(body, "Do");
  const dontSection = extractSection(body, "Don't") || extractSection(body, "Don\\'t") || extractSection(body, "Don't");
  const dos = doSection ? doSection.split(/\n\s*-\s*/).filter(Boolean).slice(0, 8) : [];
  const donts = dontSection ? dontSection.split(/\n\s*-\s*/).filter(Boolean).slice(0, 8) : [];
  return { dos, donts };
}

function findFontSubstitutes(body) {
  for (const heading of ["Font Substitutes", "Font Substitute", "Note on Font Substitutes", "Font Notes"]) {
    const section = extractSection(body, heading);
    if (section) return section;
  }
  return null;
}

function countMarkdownColors(body) {
  const matches = body.match(/#[0-9a-fA-F]{3,8}/g);
  return matches ? new Set(matches.map((m) => m.toLowerCase())).size : 0;
}

function countMarkdownComponents(body) {
  const componentSectionRe = /^#{1,4}\s+[^#\n]*(?:components?\s+stylings?|components?\s+library|key\s+components)[^#\n]*$/im;
  const match = body.match(componentSectionRe);
  if (!match || match.index === undefined) return 0;
  const after = body.slice(match.index + match[0].length);
  const nextSection = after.match(/\n#{1,2}\s/);
  const section = nextSection && nextSection.index !== undefined ? after.slice(0, nextSection.index) : after;
  // Count bold or ### headings as component names
  const subHeadings = section.matchAll(/(?:^#{3,4}\s+|\*\*)([^*#\n]{2,40})(?:\*\*|\s*$)/gm);
  return Array.from(subHeadings).length;
}

function hasButtonTokens(map) {
  for (const key of map.keys()) {
    if (key.startsWith("components.") && /button/i.test(key)) return true;
  }
  return false;
}

// ── Forbidden string check ──

const FORBIDDEN_STRINGS = [
  "Homes", "Experiences", "Services", "Features", "Docs", "Pricing", "Store",
  "Mac", "iPhone", "Buy", "Get started", "Deposit", "Explore models", "Read docs",
  "Sign up", "Total Balance", "BTC", "ETH", "BNB", "Guest favorite", "Add dates",
  "Add guests", "2 nights", "npm install design-system", "local preview ready",
  "Feature One", "Feature Two", "Feature Three",
];

function scanForbiddenStrings(html) {
  const found = [];
  for (const str of FORBIDDEN_STRINGS) {
    if (html.includes(str)) found.push(str);
  }
  return found;
}

// ── Main audit ──

function auditDesignMd(slug) {
  const dir = join(CACHE_ROOT, slug);
  const file = join(dir, "DESIGN.md");
  if (!existsSync(file)) return null;

  const content = readFileSync(file, "utf-8");
  const fm = parseFlatFrontmatter(content);
  const body = getFrontmatterBody(content);

  const colorsCount = countSafeColors(fm);
  const darkTokenCount = countDarkTokens(fm);
  const typographyCount = countTypographyTokens(fm);
  const radiusCount = countRadiusTokens(fm);
  const spacingCount = countSpacingTokens(fm);
  const componentCount = countComponentTokens(fm);
  const mdColorsCount = countMarkdownColors(body);
  const mdComponentCount = countMarkdownComponents(body);
  const totalColors = Math.max(colorsCount, mdColorsCount);
  const totalComponents = Math.max(componentCount, mdComponentCount);

  const layoutPresent = hasLayoutSection(body);
  const { dos, donts } = extractDoDontItems(body);
  const doDontPresent = dos.length > 0 || donts.length > 0;
  const fontSubstitutes = findFontSubstitutes(body);
  const hasFontSubstitutes = fontSubstitutes !== null;
  const hasButtonTokensFlag = hasButtonTokens(fm);

  // Dark mode analysis
  const darkHasExplicitTokens = darkTokenCount > 0;
  const darkDerived = !darkHasExplicitTokens;

  // Preview completeness
  let previewScore = 0;
  if (totalColors >= 4) previewScore += 3;
  else if (totalColors >= 2) previewScore += 1;
  if (typographyCount >= 2) previewScore += 2;
  else if (typographyCount >= 1) previewScore += 1;
  if (radiusCount >= 1 || spacingCount >= 1) previewScore += 1;
  if (layoutPresent) previewScore += 1;
  if (doDontPresent) previewScore += 1;
  if (totalComponents >= 3) previewScore += 1;
  if (!darkDerived) previewScore += 1;
  const completeness = previewScore >= 7 ? "high" : previewScore >= 4 ? "medium" : "low";

  // Missing sections
  const missingSections = [];
  if (totalColors === 0) missingSections.push("palette");
  if (typographyCount === 0) missingSections.push("typography");
  if (radiusCount === 0 && spacingCount === 0) missingSections.push("radius/spacing");
  if (!layoutPresent) missingSections.push("layout notes");
  if (!doDontPresent && componentCount === 0 && !fontSubstitutes) missingSections.push("source notes");
  if (darkDerived) missingSections.push("dark colors (derived)");

  // Risk flags
  const risks = [];
  if (totalColors < 2 && typographyCount < 1) risks.push("source too sparse");
  if (darkDerived) risks.push("dark derived");
  if (!hasFontSubstitutes) risks.push("no font substitutes");
  if (typographyCount === 0) risks.push("likely overflow risk (no structured typography)");

  return {
    slug,
    colorsCount: totalColors,
    structuredColors: colorsCount,
    markdownColors: mdColorsCount,
    darkTokenCount,
    darkDerived,
    typographyCount,
    radiusCount,
    spacingCount,
    componentCount: totalComponents,
    structuredComponents: componentCount,
    layoutPresent,
    doDontPresent,
    hasFontSubstitutes,
    hasButtonTokens: hasButtonTokensFlag,
    fontSubstitutes: fontSubstitutes ? fontSubstitutes.slice(0, 120) : null,
    completeness,
    previewScore,
    missingSections,
    risks,
  };
}

function main() {
  const entries = readdirSync(CACHE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const slugs = filterSlug ? [filterSlug] : entries.sort();

  const results = [];
  for (const slug of slugs) {
    const result = auditDesignMd(slug);
    if (result) results.push(result);
  }

  if (outputJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Summary
  const total = results.length;
  const high = results.filter((r) => r.completeness === "high").length;
  const medium = results.filter((r) => r.completeness === "medium").length;
  const low = results.filter((r) => r.completeness === "low").length;
  const darkDerivedCount = results.filter((r) => r.darkDerived).length;
  const withPalette = results.filter((r) => r.colorsCount >= 2).length;
  const withTypography = results.filter((r) => r.typographyCount >= 1).length;
  const withRadiusSpacing = results.filter((r) => r.radiusCount >= 1 || r.spacingCount >= 1).length;
  const withLayout = results.filter((r) => r.layoutPresent).length;
  const withSourceNotes = results.filter((r) => r.doDontPresent).length;

  console.log("Design MD Preview Audit");
  console.log("=".repeat(60));
  console.log(`Total entries: ${total}`);
  console.log(`Completeness: high=${high} medium=${medium} low=${low}`);
  console.log(`Dark derived: ${darkDerivedCount} (${darkDerivedCount > 0 ? Math.round((darkDerivedCount / total) * 100) : 0}%)`);
  console.log();
  console.log(`Section coverage:`);
  console.log(`  Palette (>=2 colors): ${withPalette}/${total}`);
  console.log(`  Typography (>=1):     ${withTypography}/${total}`);
  console.log(`  Radius/Spacing:       ${withRadiusSpacing}/${total}`);
  console.log(`  Layout:               ${withLayout}/${total}`);
  console.log(`  Source notes:         ${withSourceNotes}/${total}`);
  console.log();

  // Low completeness entries
  if (low > 0) {
    console.log("Source-limited entries:");
    for (const r of results.filter((r) => r.completeness === "low")) {
      console.log(`  ${r.slug}: colors=${r.colorsCount} type=${r.typographyCount} radius=${r.radiusCount} spacing=${r.spacingCount} components=${r.componentCount} risks=[${r.risks.join(", ")}]`);
    }
    console.log();
  }

  // Entries without dark tokens
  if (darkDerivedCount > 0) {
    console.log("Entries with derived dark mode:");
    for (const r of results.filter((r) => r.darkDerived)) {
      console.log(`  ${r.slug}: darkTokens=${r.darkTokenCount} colors=${r.colorsCount}`);
    }
    console.log();
  }

  // Entries with no font substitutes
  const noFont = results.filter((r) => !r.hasFontSubstitutes);
  if (noFont.length > 0) {
    console.log(`Entries without font substitutes: ${noFont.length}`);
    if (noFont.length <= 15) {
      for (const r of noFont) console.log(`  ${r.slug}`);
    }
    console.log();
  }

  // Per-entry detail for priority entries
  const prioritySlugs = new Set([
    "airbnb", "apple", "binance", "bmw-m", "bugatti", "clickhouse", "coinbase",
    "kraken", "lamborghini", "lovable", "mastercard", "runwayml", "sanity",
    "shopify", "slack", "spotify", "starbucks", "supabase", "tesla", "theverge",
    "together.ai", "uber", "vercel", "vodafone", "voltagent", "warp", "webflow",
    "wired", "wise", "x.ai", "zapier",
  ]);

  const priority = results.filter((r) => prioritySlugs.has(r.slug));
  if (priority.length > 0) {
    console.log("Priority entries detail:");
    console.log("-".repeat(80));
    console.log("slug          | colors | dark | type | rad | spc | comp | layout | notes | score | risks");
    console.log("-".repeat(80));
    for (const r of priority) {
      const s = r.slug.padEnd(13);
      const c = String(r.colorsCount).padStart(6);
      const d = String(r.darkTokenCount).padStart(4);
      const t = String(r.typographyCount).padStart(4);
      const rad = String(r.radiusCount).padStart(3);
      const spc = String(r.spacingCount).padStart(3);
      const comp = String(r.componentCount).padStart(4);
      const lay = r.layoutPresent ? "  yes" : "   no";
      const notes = r.doDontPresent ? "  yes" : "   no";
      const score = String(r.previewScore).padStart(5);
      const riskStr = r.risks.slice(0, 3).join(", ") || "none";
      console.log(`${s} |${c} |${d} |${t} |${rad} |${spc} |${comp} |${lay} |${notes} |${score} | ${riskStr}`);
    }
    console.log();
  }
}

main();
