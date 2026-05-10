#!/usr/bin/env node
/**
 * audit-design-md-previews.mjs
 *
 * Audit all Design MD entries for render eligibility, source coverage,
 * and broken-rendering risk without generating HTML or mutating the catalog.
 *
 * Usage: node scripts/audit-design-md-previews.mjs [--json] [--slug <slug>]
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// ── Lightweight reimplementations (no TS/React dependency) ──

function parseFrontmatter(content) {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return new Map();
  const afterOpen = trimmed.slice(3).replace(/^\s*\n/, "");
  const closing = afterOpen.match(/\n---\s*(\n|$)/);
  const fmStr = closing && closing.index !== undefined ? afterOpen.slice(0, closing.index) : afterOpen;
  const map = new Map();
  for (const line of fmStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && value) map.set(key, value);
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

function isSafeColor(value) {
  if (!value) return false;
  return /^#[0-9a-fA-F]{3,8}$/.test(value.trim())
    || /^rgba?\(\s*[\d.\s,%]+\)$/.test(value.trim())
    || /^hsla?\(\s*[\d.\s,%]+\)$/.test(value.trim())
    || value.trim() === "transparent";
}

function isSafeSize(value) {
  if (!value) return false;
  return /^-?\d+(\.\d+)?(px|rem|em|%|ch|vh|vw|pt)?$/.test(value.trim());
}

function countComponents(fm) {
  const groups = new Set();
  for (const key of fm.keys()) {
    if (!key.startsWith("components.")) continue;
    const rest = key.slice("components.".length);
    const dotIdx = rest.indexOf(".");
    if (dotIdx === -1) continue;
    const name = rest.slice(0, dotIdx);
    if (name) groups.add(name);
  }
  return groups.size;
}

function countStructuredColors(fm) {
  let count = 0;
  for (const [key, value] of fm) {
    if (!key.startsWith("colors.")) continue;
    if (isSafeColor(value)) count += 1;
  }
  return count;
}

function countStructuredTypography(fm) {
  const names = new Set();
  for (const key of fm.keys()) {
    if (!key.startsWith("typography.")) continue;
    const rest = key.slice("typography.".length);
    const parts = rest.split(".");
    names.add(parts.length > 1 ? parts.slice(0, -1).join(".") : rest);
  }
  return names.size;
}

function countRadiusTokens(fm) {
  let count = 0;
  for (const [key] of fm) {
    if (key.startsWith("rounded.") || key.startsWith("radius.")) count += 1;
  }
  return count;
}

function countSpacingTokens(fm) {
  let count = 0;
  for (const [key] of fm) {
    if (key.startsWith("spacing.")) count += 1;
  }
  return count;
}

function countMarkdownColors(body) {
  const seen = new Set();
  for (const line of body.split("\n")) {
    const match = line.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))/);
    if (match && !seen.has(match[1].toLowerCase())) {
      seen.add(match[1].toLowerCase());
    }
  }
  return seen.size;
}

function hasDarkTokens(fm, body) {
  const darkRe = /dark|black|night|inverse|charcoal|slate|on-dark|on-black|terminal|code panel|cinematic|aubergine/i;
  for (const key of fm.keys()) {
    if (darkRe.test(key)) return true;
  }
  return darkRe.test(body.slice(0, 5000));
}

function inferArchetype(slug, fm, body) {
  const text = [slug, body.slice(0, 2000)].join(" ").toLowerCase();
  if (/bmw|bugatti|ferrari|lamborghini|tesla|automotive|vehicle|model-card/.test(text)) return "luxury_automotive";
  if (/spotify|music|playlist|album|audio|track|listening/.test(text)) return "music_campaign";
  if (/starbucks|coffee|beverage|cafe|drink|food|menu/.test(text)) return "retail_food";
  if (/airbnb|marketplace|property|listing|guest|booking|home/.test(text)) return "marketplace";
  if (/binance|coinbase|kraken|trading|crypto|finance|balance|deposit/.test(text)) return "finance_dashboard";
  if (/vercel|supabase|sanity|developer|docs|api|cli|infrastructure/.test(text)) return "developer_product";
  if (/runway|together\.ai|x\.ai|ai|prompt|llm|language model/.test(text)) return "ai_product";
  if (/the.?verge|wired|editorial|magazine|news|publication/.test(text)) return "media_editorial";
  if (/webflow|framer|creative|no-code|visual development|design tool/.test(text)) return "creative_tool";
  if (/mastercard|wise|stripe|payment|card network|finance/.test(text)) return "payment_finance";
  if (/uber|mobility|ride/.test(text)) return "marketplace";
  if (/zapier|automation|workflow|zap|pipeline/.test(text)) return "automation_workflow";
  if (/warp|terminal|command line/.test(text)) return "terminal_tool";
  if (/clickhouse|cohere|mongodb|analytics|database|data product/.test(text)) return "data_product";
  if (/slack|messaging|collaboration/.test(text)) return "collaboration_saas";
  if (/vodafone|telecom|mobile network|service provider/.test(text)) return "telecom_service";
  if (/shopify|nike|retail brand/.test(text)) return "retail_brand";
  if (/lovable|voltagent/.test(text)) return "ai_agent_product";
  if (/apple/.test(slug)) return "product_gallery";
  return "generic_system";
}

function componentSourceQuality(fm) {
  const count = countComponents(fm);
  const structured = count > 0;
  // Check if components have style properties
  let styleProps = 0;
  for (const key of fm.keys()) {
    if (!key.startsWith("components.")) continue;
    const prop = key.split(".").pop();
    if (/(background|color|rounded|border|padding|margin|height|width)/i.test(prop)) styleProps += 1;
  }
  return { count, structured, styleProps };
}

function auditEntry(slug, entry) {
  const fm = parseFrontmatter(entry.content);
  const body = getFrontmatterBody(entry.content);

  const structuredColors = countStructuredColors(fm);
  const mdColors = countMarkdownColors(body);
  const totalColors = Math.max(structuredColors, mdColors);
  const structuredTypo = countStructuredTypography(fm);
  const radiusCount = countRadiusTokens(fm);
  const spacingCount = countSpacingTokens(fm);
  const comp = componentSourceQuality(fm);
  const darkSignal = hasDarkTokens(fm, body);
  const archetype = inferArchetype(entry.slug, fm, body);

  // Render eligibility estimation
  let graphicalEligible = 0;
  let compactOnly = 0;
  const componentNames = new Set();
  for (const key of fm.keys()) {
    if (!key.startsWith("components.")) continue;
    const rest = key.slice("components.".length);
    const dotIdx = rest.indexOf(".");
    if (dotIdx === -1) continue;
    componentNames.add(rest.slice(0, dotIdx));
  }
  for (const name of componentNames) {
    const prefix = `components.${name}.`;
    let hasBg = false, hasBorder = false, hasText = false;
    for (const [key, value] of fm) {
      if (!key.startsWith(prefix)) continue;
      const prop = key.slice(prefix.length).toLowerCase();
      if (/(background|background-color|backgroundcolor)/.test(prop) && isSafeColor(value)) hasBg = true;
      if (/(border|bordercolor|border-color)/.test(prop) && (isSafeColor(value) || isSafeSize(value))) hasBorder = true;
      if (/(color|textcolor|text-color)/.test(prop) && isSafeColor(value)) hasText = true;
    }
    const canGraphic = (hasBg || hasBorder) && hasText;
    if (canGraphic) graphicalEligible += 1;
    else compactOnly += 1;
  }

  // Broken render risk scoring
  let riskScore = 0;
  const failures = [];
  if (graphicalEligible === 0 && comp.count > 0) { riskScore += 3; failures.push("no-graphical-components-eligible"); }
  if (compactOnly > 3) { riskScore += 2; failures.push("too-many-compact-only"); }
  if (structuredColors === 0 && mdColors === 0) { riskScore += 2; failures.push("no-structured-colors"); }
  if (structuredTypo === 0) { riskScore += 1; failures.push("no-typography"); }
  if (!darkSignal) { riskScore += 1; failures.push("dark-only-derived"); }
  if (archetype === "generic_system") { riskScore += 1; failures.push("generic-archetype"); }
  if (comp.count === 0 && structuredColors === 0 && structuredTypo === 0) { riskScore += 3; failures.push("low-source-evidence"); }
  // Simple contrast risk: light bg + light text
  if (structuredColors >= 2 && mdColors <= 2) { riskScore += 1; failures.push("likely-contrast-risk"); }
  if (componentNames.size > 0 && graphicalEligible === 0 && structuredColors < 2) { riskScore += 1; failures.push("invented-content-risk"); }

  // Source-derived score (0-10)
  const sourceScore = Math.min(10,
    (structuredColors >= 4 ? 3 : structuredColors >= 2 ? 2 : structuredColors >= 1 ? 1 : 0)
    + (structuredTypo >= 2 ? 2 : structuredTypo >= 1 ? 1 : 0)
    + (graphicalEligible >= 3 ? 3 : graphicalEligible >= 1 ? 2 : 0)
    + (radiusCount >= 2 ? 1 : 0)
    + (spacingCount >= 2 ? 1 : 0)
  );

  return {
    slug: entry.slug,
    title: entry.title,
    archetype,
    archetypeConfidence: structuredColors + structuredTypo > 0 ? "medium" : "low",
    componentCount: comp.count,
    graphicalEligibleCount: graphicalEligible,
    compactOnlyCount: compactOnly,
    skippedCount: componentNames.size - graphicalEligible - compactOnly,
    colorTokenCount: totalColors,
    typographyTokenCount: structuredTypo,
    darkTokenCount: darkSignal ? 1 : 0,
    darkComponentCount: 0,
    lightPreviewConfidence: graphicalEligible >= 2 ? "medium" : structuredColors >= 2 ? "medium" : "low",
    darkPreviewConfidence: darkSignal ? "medium" : "low",
    sourceDerivedScore: sourceScore,
    brokenRenderRiskScore: riskScore,
    failures,
    structuredColorCount: structuredColors,
    markdownColorCount: mdColors,
    radiusCount,
    spacingCount,
  };
}

// ── Main ──

function loadCatalog() {
  // Try common cache locations
  const cacheFile = join(projectRoot, "src-tauri", "design-md-cache.json");
  if (existsSync(cacheFile)) {
    try {
      const raw = readFileSync(cacheFile, "utf-8");
      const catalog = JSON.parse(raw);
      if (Array.isArray(catalog)) return catalog;
      if (catalog.entries && Array.isArray(catalog.entries)) return catalog.entries;
    } catch (e) {
      console.error("Failed to parse cache file:", e.message);
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const slugFilter = args.includes("--slug") ? args[args.indexOf("--slug") + 1] : null;

  const entries = loadCatalog();
  if (!entries) {
    console.error("No Design MD catalog found. Run Design MD sync first.");
    process.exit(1);
  }

  const filtered = slugFilter ? entries.filter(e => e.slug === slugFilter) : entries;
  if (filtered.length === 0) {
    console.error("No entries match filter:", slugFilter || "all");
    process.exit(1);
  }

  const results = filtered.map(e => auditEntry(e.slug, e));

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Console summary
  const byFailures = {};
  for (const r of results) {
    for (const f of r.failures) {
      if (!byFailures[f]) byFailures[f] = [];
      byFailures[f].push(r.slug);
    }
  }

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Design MD Preview Audit                    ║`);
  console.log(`║  ${results.length} entries                         ${" ".repeat(Math.max(0, 22 - String(results.length).length))}║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);

  console.log("── Failure breakdown ──");
  for (const [failure, slugs] of Object.entries(byFailures).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${failure.padEnd(32)} ${slugs.length} entries`);
    if (slugs.length <= 10) {
      console.log(`    ${slugs.join(", ")}`);
    }
  }

  console.log("\n── Top 10 by broken-render risk ──");
  const byRisk = [...results].sort((a, b) => b.brokenRenderRiskScore - a.brokenRenderRiskScore).slice(0, 10);
  for (const r of byRisk) {
    console.log(`  ${r.slug.padEnd(22)} risk=${r.brokenRenderRiskScore}  score=${r.sourceDerivedScore}/10  gfx=${r.graphicalEligibleCount}  compact=${r.compactOnlyCount}  failures=[${r.failures.join(", ")}]`);
  }

  console.log("\n── Bottom 10 by source-derived score ──");
  const byScore = [...results].sort((a, b) => a.sourceDerivedScore - b.sourceDerivedScore).slice(0, 10);
  for (const r of byScore) {
    console.log(`  ${r.slug.padEnd(22)} score=${r.sourceDerivedScore}/10  risk=${r.brokenRenderRiskScore}  colors=${r.structuredColorCount}+${r.markdownColorCount}md  typo=${r.typographyTokenCount}  comps=${r.componentCount}/${r.graphicalEligibleCount}gfx`);
  }

  console.log("\n── Overall stats ──");
  const avgScore = (results.reduce((s, r) => s + r.sourceDerivedScore, 0) / results.length).toFixed(1);
  const avgRisk = (results.reduce((s, r) => s + r.brokenRenderRiskScore, 0) / results.length).toFixed(1);
  const totalGfx = results.reduce((s, r) => s + r.graphicalEligibleCount, 0);
  const totalComps = results.reduce((s, r) => s + r.componentCount, 0);
  console.log(`  Average source score: ${avgScore}/10`);
  console.log(`  Average risk score:   ${avgRisk}`);
  console.log(`  Total graphics-eligible: ${totalGfx}/${totalComps}`);
  console.log(`  Generic archetypes:   ${results.filter(r => r.archetype === "generic_system").length}`);
  console.log(`  Dark-signaled:        ${results.filter(r => r.darkTokenCount > 0).length}`);
  console.log();
}

main();
