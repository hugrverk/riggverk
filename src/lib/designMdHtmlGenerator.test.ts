/**
 * designMdHtmlGenerator.test.ts
 *
 * Tests for generated HTML safety and content rules.
 * Run with: npx tsx src/lib/designMdHtmlGenerator.test.ts
 */

import { buildBoard } from "./designMdSpecimenBuilder";
import { generateBoardHtml, deriveDarkThemeTokens, deriveLightThemeTokens } from "./designMdHtmlGenerator";
import { relativeLuminance } from "./designMdContrast";

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
  const board = buildBoard("test", "Test", "Test description", "---\ncolors:\n  primary: '#0066cc'\n---\n# Overview\nTest overview");
  const html = generateBoardHtml(board, { variant: "light" });
  assert(html.includes("Content-Security-Policy"), "generated HTML must include CSP meta tag");
}

// ── Test: generated HTML has no inline scripts ──
{
  const board = buildBoard("test", "Test", "Test description", "---\ncolors:\n  primary: '#0066cc'\n---\n# Overview\nTest overview");
  const html = generateBoardHtml(board, { variant: "light" });
  // Count <script tags (excluding CSP meta which is meta not script)
  const scriptMatches = html.match(/<script[^>]*>/g) ?? [];
  assert(scriptMatches.length === 0, "generated HTML must have no script tags");
}

// ── Test: generated HTML is deterministic (same input -> same output) ──
{
  const content = "---\ncolors:\n  primary: '#0066cc'\n  background: '#ffffff'\n  text: '#111111'\n---\n# Overview\nTest overview";
  const board = buildBoard("test", "Test", "Test description", content);
  const html1 = generateBoardHtml(board, { variant: "light" });
  const html2 = generateBoardHtml({ ...board }, { variant: "light" });
  assert(html1 === html2, "generated HTML must be deterministic");
}

// ── Test: generated HTML contains neither forbidden strings ──
{
  const board = buildBoard("test", "Test", "Test description", "---\ncolors:\n  primary: '#0066cc'\n---");
  const html = generateBoardHtml(board, { variant: "light" });
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
  assert(html.includes('<button class="hero-btn"'), "styled button should render as hero button element");
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

// ── Dark theme resolver tests (Pass 6) ──

function colorIsDark(hex: string): boolean {
  const luma = relativeLuminance(hex);
  return luma !== null && luma < 0.25;
}

function colorIsNotWhite(hex: string): boolean {
  const luma = relativeLuminance(hex);
  return luma !== null && luma < 0.85;
}

// Test: dark variant uses explicit dark canvas token over fallback
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n  background-dark: '#0d1117'\n  on-dark: '#f0f2f5'\n---\n## Overview\nTest with explicit dark canvas";
  const board = buildBoard("test-dark-canvas", "Dark Canvas", "Explicit dark canvas test", content);
  const colors = deriveDarkThemeTokens(board);
  assert(colors.canvas === "#0d1117", "dark variant must use explicit background-dark token as canvas");
  assert(colors.darkThemeSource?.canvas.source === "source", "dark canvas must be source-derived when explicit token exists");
}

// Test: dark variant uses source dark border before derived fallback
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n  background-dark: '#0d1117'\n  on-dark: '#f0f2f5'\n  border-dark: '#30363d'\n---\n## Overview\nTest with explicit dark border";
  const board = buildBoard("test-dark-border", "Dark Border", "Explicit dark border test", content);
  const colors = deriveDarkThemeTokens(board);
  assert(colors.border === "#30363d", "dark variant must use explicit border-dark token as border");
  assert(colors.darkThemeSource?.border.source === "source", "dark border must be source-derived when explicit token exists");
}

// Test: dark fallback derives from darkest palette when no dark tokens exist
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n---\n## Overview\nNo dark tokens at all";
  const board = buildBoard("test-no-dark", "No Dark", "No dark tokens test", content);
  const colors = deriveDarkThemeTokens(board);
  assert(colorIsDark(colors.canvas), "dark canvas must be a dark color even with no dark tokens");
  assert(colors.darkThemeSource?.canvas.source !== "fallback", "dark canvas should be derived from palette, not hard fallback");
}

// Test: border fallback does not create white outlines
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n  background-dark: '#111827'\n  on-dark: '#f3f4f6'\n---\n## Overview\nNo border tokens — verify derived border is not white";
  const board = buildBoard("test-dark-border-derived", "Derived Border", "Derived border test", content);
  const colors = deriveDarkThemeTokens(board);
  assert(colorIsNotWhite(colors.border), "derived dark border must NOT be white or near-white");
  assert(colorIsDark(colors.border), "derived dark border must be a dark subtle color");
  const borderLuma = relativeLuminance(colors.border);
  const surfaceLuma = relativeLuminance(colors.surface);
  assert(borderLuma !== null && surfaceLuma !== null && borderLuma < 0.5,
    "derived dark border must have luma < 0.5 (not visible white outline)");
}

// Test: generated HTML includes all fixed sections when source data exists
{
  const content = [
    "---",
    "colors:",
    "  primary: '#2563eb'",
    "  background: '#ffffff'",
    "  surface: '#f8fafc'",
    "  text: '#111111'",
    "  border: '#e2e8f0'",
    "typography:",
    "  display:",
    "    fontFamily: 'Inter'",
    "    fontSize: '40px'",
    "    fontWeight: '700'",
    "  body:",
    "    fontFamily: 'Inter'",
    "    fontSize: '16px'",
    "    fontWeight: '400'",
    "rounded:",
    "  md: '8px'",
    "spacing:",
    "  md: '16px'",
    "---",
    "## Overview",
    "A complete design system.",
    "## Layout",
    "Grid-based layout with max-width 1200px.",
  ].join("\n");
  const board = buildBoard("test-sections", "Sections Test", "Full sections", content);
  const html = generateBoardHtml(board, { variant: "light" });
  assert(html.includes("Hero") || html.includes("hero"), "generated HTML must include hero section");
  assert(html.includes("Palette") || html.includes("palette"), "generated HTML must include palette section");
  assert(html.includes("Typography") || html.includes("typography"), "generated HTML must include typography section");
  assert(html.includes("Radius") || html.includes("Spacing") || html.includes("radius"), "generated HTML must include radius/spacing section");
  assert(html.includes("Layout") || html.includes("layout"), "generated HTML must include layout section");
  assert(html.includes("Source notes") || html.includes("source-notes"), "generated HTML must include source notes section");
}

// Test: generated HTML has no fake app content
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n---\n## Overview\nTest overview.";
  const board = buildBoard("test-no-fake", "No Fake", "No fake content test", content);
  const html = generateBoardHtml(board, { variant: "light" });
  // Fake app nav
  assert(!html.includes("Features"), "HTML must not contain fake nav label 'Features'");
  assert(!html.includes("Pricing"), "HTML must not contain fake nav label 'Pricing'");
  assert(!html.includes("Docs"), "HTML must not contain fake nav label 'Docs'");
  assert(!html.includes("Store"), "HTML must not contain fake nav label 'Store'");
  // Fake CTA
  assert(!html.includes("Get started"), "HTML must not contain fake CTA");
  assert(!html.includes("Sign up"), "HTML must not contain fake CTA");
  // Fake metrics
  assert(!html.includes("Total Balance"), "HTML must not contain fake metrics");
  // Fake product data
  assert(!html.includes("2 nights"), "HTML must not contain fake product data");
  assert(!html.includes("Guest favorite"), "HTML must not contain fake product data");
  // Fake command examples
  assert(!html.includes("npm install design-system"), "HTML must not contain fake command examples");
}

// Test: CSP exists and no script tags
{
  const board = buildBoard("test-csp", "CSP Test", "Security test", "---\ncolors:\n  primary: '#2563eb'\n---\n## Overview\nSecurity check.");
  const html = generateBoardHtml(board, { variant: "dark" });
  assert(html.includes("Content-Security-Policy"), "generated HTML must include CSP meta tag");
  const scriptCount = (html.match(/<script[^>]*>/g) ?? []).length;
  assert(scriptCount === 0, "generated HTML must have no script tags");
}

// Test: dark variant diagnostics are present
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n  background-dark: '#0d1117'\n  on-dark: '#f0f2f5'\n  surface-dark: '#161b22'\n  border-dark: '#30363d'\n---\n## Overview\nDiagnostics test";
  const board = buildBoard("test-diag", "Diag Test", "Diagnostics", content);
  const html = generateBoardHtml(board, { variant: "dark" });
  assert(html.includes("Design MD dark theme source"), "dark HTML must include diagnostic comment");
  assert(html.includes("source"), "diagnostic comment must mention source type");
}

// ── Hero button color source rules (Pass 2) ──

// Test: button with backgroundColor + textColor renders hero button
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\ncomponents:\n  button-primary:\n    backgroundColor: '#2563eb'\n    textColor: '#ffffff'\n    rounded: '8px'\n    padding: '12px 24px'\n---\n## Overview\nTest with styled button";
  const board = buildBoard("test-btn-styled", "Styled Button", "Button color test", content);
  const html = generateBoardHtml(board, { variant: "light" });
  const heroBtnMatch = html.includes('<button class="hero-btn"');
  assert(heroBtnMatch, "button with source bg+fg must render hero button element");
}

// Test: button with only radius + padding does NOT render hero button
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\ncomponents:\n  button-weak:\n    rounded: '8px'\n    padding: '12px 24px'\n---\n## Overview\nTest with weak button (no colors)";
  const board = buildBoard("test-btn-weak", "Weak Button", "Button without colors", content);
  const html = generateBoardHtml(board, { variant: "light" });
  const heroBtnMatch = html.includes('<button class="hero-btn"');
  assert(!heroBtnMatch, "button with only radius+padding must NOT render hero button element");
}

// Test: button with borderColor + textColor renders outline hero button
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\ncomponents:\n  button-outline:\n    borderColor: '#2563eb'\n    textColor: '#2563eb'\n    rounded: '8px'\n    padding: '10px 20px'\n---\n## Overview\nTest with outline button";
  const board = buildBoard("test-btn-outline", "Outline Button", "Outline button test", content);
  const html = generateBoardHtml(board, { variant: "light" });
  assert(html.includes("hero-btn-outline"), "button with border+fg must render outline hero button class");
  assert(html.includes('<button class="hero-btn hero-btn-outline"'), "outline button must have hero-btn-outline class on button element");
}

// Test: button missing source color does NOT fallback to global primary
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  on-primary: '#ffffff'\n  background: '#ffffff'\n  text: '#111111'\ncomponents:\n  button-no-color:\n    rounded: '8px'\n    padding: '12px 24px'\n---\n## Overview\nTest button with no color - should not fallback";
  const board = buildBoard("test-btn-no-fallback", "No Fallback", "Button without color fallback test", content);
  const html = generateBoardHtml(board, { variant: "light" });
  const heroBtnMatch = html.includes('<button class="hero-btn"');
  assert(!heroBtnMatch, "button without source colors must NOT fallback to primary for hero button");
}

// Test: button with backgroundColor only (no textColor) does NOT render
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\ncomponents:\n  button-bg-only:\n    backgroundColor: '#2563eb'\n    rounded: '8px'\n---\n## Overview\nTest button with only bg";
  const board = buildBoard("test-btn-bg-only", "BG Only Button", "Button with only bg test", content);
  const html = generateBoardHtml(board, { variant: "light" });
  const heroBtnMatch = html.includes('<button class="hero-btn"');
  assert(!heroBtnMatch, "button with bg only (no fg) must NOT render hero button");
}

// Test: light variant does not include dark diagnostics

// ── Dark/light theme edge cases (Pass 3) ──

// Test: black token is NOT chosen as canvas when canvas-dark exists
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n  black: '#000000'\n  canvas-dark: '#111827'\n  on-dark: '#f3f4f6'\n---\n## Overview\nBlack should lose to canvas-dark";
  const board = buildBoard("test-black-vs-canvas", "Black vs Canvas", "Source priority test", content);
  const colors = deriveDarkThemeTokens(board);
  assert(colors.canvas !== "#000000", "dark canvas must NOT be plain black when canvas-dark token exists");
  assert(colors.canvas === "#111827", "dark canvas must use explicit canvas-dark over black token");
}

// Test: light theme does not pick dark-named token as canvas
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background-dark: '#111827'\n  canvas-dark: '#0d1117'\n  text: '#111111'\n---\n## Overview\nLight should ignore dark tokens";
  const board = buildBoard("test-light-ignore-dark", "Light Ignores Dark", "Light token selection test", content);
  const colors = deriveLightThemeTokens(board);
  const lightCanvas = colors.canvas;
  // dark-named tokens (background-dark, canvas-dark) must NOT be used for light canvas
  assert(lightCanvas !== "#111827", "light canvas must not use background-dark token");
  assert(lightCanvas !== "#0d1117", "light canvas must not use canvas-dark token");
  // When no light canvas tokens exist, fallback should be safe (brand or white)
  assert(lightCanvas === "#2563eb" || lightCanvas === "#ffffff", "light canvas fallback must be brand color or white, not a dark background token");
}

// Test: source dark border wins over derived fallback
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n  background-dark: '#0d1117'\n  on-dark: '#f0f2f5'\n  border-dark: '#3a3f47'\n  divider-dark: '#2a2e35'\n---\n## Overview\nExplicit dark border test";
  const board = buildBoard("test-dark-border-source", "Dark Border Source", "Source border priority", content);
  const colors = deriveDarkThemeTokens(board);
  // border-dark should be used, not divider-dark (first match wins in order)
  assert(colors.border === "#3a3f47", "dark border must use first explicit border-dark token");
  assert(colors.darkThemeSource?.border.source === "source", "dark border source must be 'source' when explicit");
}

// Test: dark canvas derivation never picks non-dark surface token
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  surface: '#fafbfc'\n  canvas: '#ffffff'\n---\n## Overview\nNo dark tokens — derive from palette";
  const board = buildBoard("test-dark-no-dark-tokens", "No Dark Tokens", "Pure derivation test", content);
  const colors = deriveDarkThemeTokens(board);
  // Even with only light tokens, dark canvas should derive from the darkest available
  assert(colorIsDark(colors.canvas), "dark canvas must be dark even when palette has only light tokens");
  // The derivation should find at least one dark-ish color from mixing
}
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n---\n## Overview\nLight only";
  const board = buildBoard("test-light-diag", "Light Diag", "Light no diagnostics", content);
  const html = generateBoardHtml(board, { variant: "light" });
  assert(!html.includes("Design MD dark theme source"), "light HTML must NOT include dark diagnostic comment");
}

// ── Summary ──
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
