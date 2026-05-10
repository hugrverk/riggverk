/**
 * designMdHtmlGenerator.test.ts
 *
 * Tests for generated HTML safety and content rules.
 * Run with: npx tsx src/lib/designMdHtmlGenerator.test.ts
 */

import { buildSpecimen, buildBoard } from "./designMdSpecimenBuilder";
import { generateBoardHtml, generateSpecimenHtml } from "./designMdHtmlGenerator";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed += 1; }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

function assertNoForbiddenStrings(html: string): void {
  // Remove CSS blocks (which may contain font names like BlinkMacSystemFont)
  const htmlWithoutCss = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/font-family:[^;"]*/gi, "");
  const forbidden = [
    "Homes", "Experiences", "Services", "Features", "Docs", "Pricing",
    "Store", "Mac", "iPhone", "Buy", "Get started", "Deposit",
    "Explore models", "Read docs", "Sign up", "Total Balance",
    "BTC", "ETH", "BNB", "Guest favorite", "Add dates", "Add guests",
    "2 nights", "npm install design-system", "local preview ready",
    "Feature One", "Feature Two", "Feature Three",
  ];
  for (const phrase of forbidden) {
    const found = htmlWithoutCss.includes(phrase);
    assert(!found, `generated HTML must not contain "${phrase}"`);
  }
}

// ── Test: generated HTML includes CSP ──
{
  const html = generateSpecimenHtml(buildSpecimen("test", "Test", "Test description", "---\ncolors:\n  primary: '#0066cc'\n---\n# Overview\nTest overview"));
  assert(html.includes("Content-Security-Policy"), "generated HTML must include CSP meta tag");
}

// ── Test: generated HTML has no inline scripts ──
{
  const html = generateSpecimenHtml(buildSpecimen("test", "Test", "Test description", "---\ncolors:\n  primary: '#0066cc'\n---\n# Overview\nTest overview"));
  // Count <script tags (excluding CSP meta which is meta not script)
  const scriptMatches = html.match(/<script[^>]*>/g) ?? [];
  assert(scriptMatches.length === 0, "generated HTML must have no script tags");
}

// ── Test: generated HTML is deterministic (same input -> same output) ──
{
  const content = "---\ncolors:\n  primary: '#0066cc'\n  background: '#ffffff'\n  text: '#111111'\n---\n# Overview\nTest overview";
  const spec = buildSpecimen("test", "Test", "Test description", content);
  const html1 = generateSpecimenHtml(spec);
  const html2 = generateSpecimenHtml({ ...spec });
  assert(html1 === html2, "generated HTML must be deterministic");
}

// ── Test: generated HTML contains neither forbidden strings ──
{
  const html = generateSpecimenHtml(buildSpecimen("test", "Test", "Test description", "---\ncolors:\n  primary: '#0066cc'\n---"));
  assertNoForbiddenStrings(html);
}

// ── Test: weak generic component appears in source notes inventory, not as visual block ──
{
  // Create a board with a markdown-derived component (no styles)
  const content = "## Overview\nTest overview.\n\n## Components\n\n**empty-card**\n\nA weak component reference.";
  const board = buildBoard("test-no-styles", "Test", "Test desc", content);
  const html = generateBoardHtml(board, { variant: "light" });
  // Should contain source notes section with component inventory (inv-item), not visual component blocks
  assert(html.includes("inv-item") || html.includes("src-inventory"), "weak component should appear in source notes inventory as text reference");
  // Must NOT contain component-grid or sample-* patterns
  assert(!html.includes("component-grid"), "weak component must not render as component grid");
}

// ── Test: board with good button token renders hero button ──
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  surface: '#f8fafc'\n  text: '#111111'\n  border: '#e2e8f0'\ncomponents:\n  button-primary:\n    backgroundColor: '#2563eb'\n    textColor: '#ffffff'\n    rounded: '8px'\n    padding: '12px 24px'\n---\n## Overview\nA test design system";
  const board = buildBoard("test-styled", "Test Styled", "Styled system", content);
  const html = generateBoardHtml(board, { variant: "light" });
  // Button tokens should render as hero button, not as component-library samples
  assert(html.includes("hero-btn"), "styled button should render as hero button");
  assert(!html.includes("component-grid"), "must not render component grid for button tokens");
}

// ── Test: light and dark variants both generate ──
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n  dark-background: '#0b0e11'\n  on-dark: '#f8fafc'\n---\n## Overview\nTest";
  const board = buildBoard("test-both", "Test Both", "Dual variant test", content);
  const lightHtml = generateBoardHtml(board, { variant: "light" });
  const darkHtml = generateBoardHtml(board, { variant: "dark" });
  assert(lightHtml.length > 100, "light variant must generate HTML");
  assert(darkHtml.length > 100, "dark variant must generate HTML");
  assert(lightHtml !== darkHtml, "light and dark variants must differ");
}

// ── Summary ──
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
