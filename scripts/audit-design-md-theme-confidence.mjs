#!/usr/bin/env node
/**
 * audit-design-md-theme-confidence.mjs
 *
 * Audits Design MD board dark theme classification.
 * Reports per-entry evidence and mode assignments.
 *
 * Since this script runs outside the TS/TSX runtime and we cannot import
 * .ts modules directly, this is a DOCUMENTATION and ANALYSIS script that
 * defines the expected audit patterns and test vectors.
 *
 * Run the actual classification tests via:
 *   npx tsx src/lib/designMdHtmlGenerator.test.ts
 *
 * This file documents the expected audit output format and serves as
 * a reference for the classification rules.
 */

const ENTRIES = [
  {
    slug: "apple",
    title: "Apple",
    expectedMode: "sectionalSourceDark",
    tokens: [
      "canvas: #f5f5f7",         // light canvas (globalCanvas)
      "surface-tile-1: #1d1d1f", // dark tile surface
      "surface-tile-2: #2d2d2f", // dark tile surface
      "surface-tile-3: #3d3d3f", // dark tile surface
      "surface-black: #000000",  // dark black surface
      "on-dark: #f5f5f7",        // on-dark text
      "body-on-dark: #f5f5f7",   // on-dark body text
      "primary-on-dark: #2997ff",// on-dark accent
      "ink: #1d1d1f",           // light text
      "global-nav: #000000",     // dark navigation
      "product-tile-dark: #1d1d1f",   // dark product tile
      "product-tile-dark-2: #2d2d2f", // dark product tile
      "product-tile-dark-3: #3d3d3f", // dark product tile
    ],
    prose: "Alternating light and dark canvases. Light hero → dark product tile → light utility tile → dark tile → parchment footer.",
    notes: [
      "No global dark canvas token → NOT fullSourceDark",
      "surface-tile-* tokens + surface-black + on-dark text + dark component names",
      "Prose clearly describes alternating dark/light sections",
      "→ sectionalSourceDark",
    ],
  },
  {
    slug: "claude",
    title: "Claude",
    expectedMode: "darkTokenBoard",
    tokens: [
      "canvas: #faf9f5",        // warm cream canvas
      "surface-dark: #181715",  // single dark surface
      "on-dark: #faf9f5",       // on-dark text
      "ink: #141413",           // warm dark ink
      "surface-soft: #f5f0e8",  // soft surface
    ],
    prose: "Warm-canvas editorial interface anchored on a tinted cream canvas.",
    notes: [
      "Warm cream canvas → light-first → darkTokenBoard (correct)",
      "surface-dark exists but alone → insufficient for sectionalSourceDark",
      "on-dark text exists but surface-dark is component-local, not multiple sections",
      "Mode stays correct",
    ],
  },
  {
    slug: "cursor",
    title: "Cursor",
    expectedMode: "darkTokenBoard",
    tokens: [
      "canvas: #f7f7f4",        // warm cream canvas
      "primary: #f54e00",       // orange CTA
      "ink: #26251e",           // warm near-black
      "surface-card: #ffffff",  // light card surface
    ],
    prose: "Warm-cream editorial canvas instead of the typical dark IDE atmosphere.",
    notes: [
      "Warm cream canvas + light-first → darkTokenBoard (correct)",
      "No dark surfaces → NOT sectionalSourceDark",
      "Mode stays correct",
    ],
  },
  {
    slug: "airbnb",
    title: "Airbnb",
    expectedMode: "darkTokenBoard",
    tokens: [
      "canvas: #ffffff",
      "ink: #222222",
      "primary: #ff385c",
    ],
    prose: "Clean white canvas with vibrant accent.",
    notes: [
      "Light design with no dark evidence → darkTokenBoard (correct)",
    ],
  },
  {
    slug: "binance",
    title: "Binance",
    expectedMode: "fullSourceDark",
    tokens: [
      "canvas-dark: #0b0e11",
      "surface-dark: #1e2329",
      "card-dark: #2b3139",
      "on-dark: #f5f5f5",
      "body-on-dark: #eaecef",
      "yellow: #f0b90b",
    ],
    prose: "Dark trading platform.",
    notes: [
      "Has canvas-dark + on-dark → fullSourceDark",
    ],
  },
  {
    slug: "slack",
    title: "Slack",
    expectedMode: "darkTokenBoard",
    tokens: [
      "canvas: '#ffffff'",
      "primary: '#611f69'",
    ],
    prose: "Light UI with purple brand accent.",
    notes: [
      "Light design with no dark evidence → darkTokenBoard (correct)",
    ],
  },
  {
    slug: "vercel",
    title: "Vercel",
    expectedMode: "conservativeDerivedDark",
    tokens: [
      "canvas: '#ffffff'",
      "ink: '#000000'",
      "primary: '#000000'",
      "secondary: '#666666'",
      "surface: '#fafafa'",
      "border: '#eaeaea'",
    ],
    prose: "Minimal black-and-white design.",
    notes: [
      "No explicit dark canvas, but neutral palette allows safe derivation",
      "→ conservativeDerivedDark (correct)",
    ],
  },
  {
    slug: "warp",
    title: "Warp",
    expectedMode: "sectionalSourceDark",
    tokens: [
      "canvas: '#fafafa'",
      "ink: '#111111'",
      "surface-card: '#ffffff'",
      "surface-dark: '#1a1a2e'",
      "terminal-dark: '#0d0d1a'",
      "on-dark: '#e0e0ff'",
    ],
    prose: "Terminal-inspired dark surfaces with light main canvas.",
    notes: [
      "No global dark canvas but has dark surfaces + on-dark text",
      "Terminal dark surfaces → sectionalSourceDark",
    ],
  },
  {
    slug: "wise",
    title: "Wise",
    expectedMode: "darkTokenBoard",
    tokens: [
      "canvas: '#ffffff'",
      "ink: '#0a1628'",
      "primary: '#00a86b'",
    ],
    prose: "Clean light design.",
    notes: [
      "Light design with no dark evidence → darkTokenBoard (correct)",
    ],
  },
  {
    slug: "kraken",
    title: "Kraken",
    expectedMode: "sectionalSourceDark",
    tokens: [
      "canvas: '#ffffff'",
      "surface-dark: '#13161a'",
      "card-dark: '#1e2329'",
      "on-dark: '#e0e4e8'",
      "body-on-dark: '#f0f2f5'",
      "primary-on-dark: '#3182ce'",
    ],
    prose: "Dark trading surfaces and cards.",
    notes: [
      "No global dark canvas but surface-dark + card-dark + on-dark",
      "→ sectionalSourceDark",
    ],
  },
  {
    slug: "spotify",
    title: "Spotify",
    expectedMode: "sectionalSourceDark",
    tokens: [
      "canvas: '#ffffff'",
      "ink: '#121212'",
      "surface-dark: '#282828'",
      "card-dark: '#1e1e1e'",
      "on-dark: '#ffffff'",
      "primary: '#1db954'",
    ],
    prose: "Dark card surfaces for playlist cards.",
    notes: [
      "No global dark canvas but multiple dark surfaces + on-dark",
      "→ sectionalSourceDark",
    ],
  },
  {
    slug: "tesla",
    title: "Tesla",
    expectedMode: "sectionalSourceDark",
    tokens: [
      "canvas: '#ffffff'",
      "ink: '#171a20'",
      "surface-dark: '#171a20'",
      "panel-dark: '#2a2d34'",
      "on-dark: '#ffffff'",
      "primary-on-dark: '#e82127'",
    ],
    prose: "Dark configurator panels on a light page.",
    notes: [
      "No global dark canvas but dark panels + on-dark text",
      "→ sectionalSourceDark",
    ],
  },
  {
    slug: "the-verge",
    title: "The Verge",
    expectedMode: "darkTokenBoard",
    tokens: [
      "canvas: '#ffffff'",
      "ink: '#000000'",
      "primary: '#196c9b'",
    ],
    prose: "Clean editorial design.",
    notes: [
      "Light editorial design with no dark evidence → darkTokenBoard (correct)",
    ],
  },
  {
    slug: "mastercard",
    title: "Mastercard",
    expectedMode: "darkTokenBoard",
    tokens: [
      "canvas: '#ffffff'",
      "primary: '#ff5f00'",
      "secondary: '#000000'",
    ],
    prose: "Light brand design.",
    notes: [
      "Light design with no dark evidence → darkTokenBoard (correct)",
    ],
  },
  {
    slug: "bmw-m",
    title: "BMW M",
    expectedMode: "sectionalSourceDark",
    tokens: [
      "canvas: '#ffffff'",
      "surface-dark: '#1a1c20'",
      "panel-dark: '#2a2d33'",
      "card-dark: '#141518'",
      "on-dark: '#ffffff'",
      "primary-on-dark: '#0066ff'",
      "ink: '#1a1c20'",
    ],
    prose: "Dark performance section panels on a light page.",
    notes: [
      "No global dark canvas but multiple dark surfaces + on-dark",
      "→ sectionalSourceDark",
    ],
  },
  {
    slug: "shopify",
    title: "Shopify",
    expectedMode: "darkTokenBoard",
    tokens: [
      "canvas: '#ffffff'",
      "primary: '#008060'",
      "ink: '#212326'",
    ],
    prose: "Clean commerce design.",
    notes: [
      "Light design with no dark evidence → darkTokenBoard (correct)",
    ],
  },
  {
    slug: "supabase",
    title: "Supabase",
    expectedMode: "sectionalSourceDark",
    tokens: [
      "canvas: '#ffffff'",
      "ink: '#111111'",
      "surface-dark: '#1c1c1c'",
      "card-dark: '#242424'",
      "on-dark: '#ededed'",
      "primary: '#3ecf8e'",
      "primary-on-dark: '#3ecf8e'",
    ],
    prose: "Dark code editor surface and cards.",
    notes: [
      "No global dark canvas but dark surfaces + on-dark text",
      "→ sectionalSourceDark",
    ],
  },
  {
    slug: "coinbase",
    title: "Coinbase",
    expectedMode: "conservativeDerivedDark",
    tokens: [
      "canvas: '#ffffff'",
      "ink: '#050f19'",
      "primary: '#0052ff'",
      "surface: '#f6f7f9'",
      "border: '#e3e8ee'",
    ],
    prose: "Clean blue-and-white finance design.",
    notes: [
      "No dark surfaces or on-dark text",
      "Neutral palette allows conservative derived dark",
      "→ conservativeDerivedDark (correct)",
    ],
  },
];

// ── Report ──

function printLine(char = "─", width = 60) {
  console.log(char.repeat(width));
}

console.log("\n  Design MD Theme Confidence Audit");
console.log("  =================================");
printLine();
console.log();

const byMode = {};

for (const entry of ENTRIES) {
  byMode[entry.expectedMode] = byMode[entry.expectedMode] || [];
  byMode[entry.expectedMode].push(entry.slug);

  console.log(`  ${entry.slug.padEnd(20)} → ${entry.expectedMode.padEnd(22)} ${entry.title}`);
  for (const note of entry.notes) {
    console.log(`    ${note}`);
  }
  console.log();
}

printLine();
console.log();

console.log("  By mode:");
for (const [mode, slugs] of Object.entries(byMode)) {
  console.log(`    ${mode.padEnd(22)}: ${slugs.join(", ")}`);
}

console.log();
printLine();
console.log();

// Summary counts
const fullSourceDark = (byMode["fullSourceDark"] || []).length;
const sectionalSourceDark = (byMode["sectionalSourceDark"] || []).length;
const conservativeDerivedDark = (byMode["conservativeDerivedDark"] || []).length;
const darkTokenBoard = (byMode["darkTokenBoard"] || []).length;

console.log(`  Summary:`);
console.log(`    fullSourceDark:         ${fullSourceDark} entries`);
console.log(`    sectionalSourceDark:    ${sectionalSourceDark} entries`);
console.log(`    conservativeDerivedDark: ${conservativeDerivedDark} entries`);
console.log(`    darkTokenBoard:         ${darkTokenBoard} entries`);
console.log(`    Total:                  ${ENTRIES.length} entries`);
console.log();

// Warnings
console.log("  Warnings by category:");
const warnings = {
  noGlobalCanvas: ENTRIES.filter((e) => e.expectedMode !== "fullSourceDark"),
  sectionalSelected: ENTRIES.filter((e) => e.expectedMode === "sectionalSourceDark"),
  noOnDark: ENTRIES.filter((e) => !e.tokens.some((t) => t.includes("on-dark") || t.includes("on-dark"))),
};
console.log(`    No global dark canvas:      ${warnings.noGlobalCanvas.length} entries`);
console.log(`    Sectional dark selected:    ${warnings.sectionalSelected.length} entries`);
console.log(`    No on-dark text:            ${warnings.noOnDark.length} entries`);
console.log();

printLine();
console.log("\n  NOTE: This is a documentation/analysis script.");
console.log("  Run actual classification via:");
console.log("    npx tsx src/lib/designMdHtmlGenerator.test.ts");
console.log();
