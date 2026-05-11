/**
 * designMdHtmlGenerator.test.ts
 *
 * Tests for generated HTML safety and content rules.
 * Run with: npx tsx src/lib/designMdHtmlGenerator.test.ts
 */

import { buildBoard } from "./designMdSpecimenBuilder";
import { generateBoardHtml, deriveDarkThemeTokens, deriveLightThemeTokens } from "./designMdHtmlGenerator";
import { relativeLuminance } from "./designMdContrast";
import { analyzeDesignMdSourceIntent } from "./designMdSourceIntent";

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

// ── Test: generated light and dark variants both include local sandbox-safe output ──
{
  const content = "---\ncolors:\n  canvas: '#ffffff'\n  ink: '#111111'\n  primary: '#2563eb'\n---\n## Overview\nLocal deterministic preview.";
  const board = buildBoard("variants", "Variants", "Variant generation", content);
  const lightHtml = generateBoardHtml(board, { variant: "light" });
  const darkHtml = generateBoardHtml(board, { variant: "dark" });
  assert(lightHtml.includes("<!DOCTYPE html>") && darkHtml.includes("<!DOCTYPE html>"), "light/dark variants must be complete HTML documents");
  assert(!/@import|@font-face|url\(|https?:\/\//i.test(lightHtml), "light HTML must not include external assets or font loading");
  assert(!/@import|@font-face|url\(|https?:\/\//i.test(darkHtml), "dark HTML must not include external assets or font loading");
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

// ── Test: preview quality metadata exists and drives source-limited rendering ──
{
  const content = "## Overview\nOnly one sentence and one color.\n\n- Accent `#ff6600`";
  const board = buildBoard("sparse-quality", "Sparse Quality", "Sparse", content);
  assert(typeof board.previewQuality.lightScore === "number", "board must expose preview quality scores");
  assert(board.qualityWarnings.sourceSparse, "sparse sources must be marked sourceSparse");
  const html = generateBoardHtml(board, { variant: "light" });
  assert(html.includes("source-limited"), "source-limited boards must disclose conservative preview state");
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

function allColorTokens(board: ReturnType<typeof buildBoard>) {
  return board.colorGroups.flatMap((group) => group.tokens);
}

function luma(hex: string): number {
  return relativeLuminance(hex) ?? 0;
}

// ── Body/surface token role regression tests ──

{
  const content = "---\ncolors:\n  canvas: '#fbfaf6'\n  body: '#24211d'\n---\n## Overview\nCanvas is the page background. Body is paragraph text.";
  const board = buildBoard("body-as-text", "Body As Text", "Body token is text", content);
  const colors = deriveLightThemeTokens(board);
  const body = allColorTokens(board).find((token) => token.key === "body");
  assert(colors.canvas === "#fbfaf6", "body text must not override explicit canvas");
  assert(colors.text === "#24211d", "body text may be selected as readable text");
  assert(body?.resolvedRole === "bodyText", "body token with prose/text group resolves as bodyText");
}

{
  const content = "---\ncolors:\n  body-background: '#f6f1e8'\n  ink: '#181716'\n---\n## Overview\nBody background is the app body background. Ink is foreground text.";
  const board = buildBoard("body-as-background", "Body As Background", "Body background token", content);
  const colors = deriveLightThemeTokens(board);
  assert(colors.canvas === "#f6f1e8", "body-background is eligible as light canvas");
  assert(colors.text === "#181716", "ink remains text when body-background is canvas");
}

{
  const content = "---\ncolors:\n  body: '#f7f4ed'\n  text: '#191919'\n---\n## Overview\nA light page with readable text.";
  const board = buildBoard("plain-body-ambiguous", "Plain Body", "Ambiguous body", content);
  const body = allColorTokens(board).find((token) => token.key === "body");
  assert(body?.roleWarnings?.some((warning) => warning.includes("body token is ambiguous")), "plain body exposes ambiguity warning");
  assert(body?.roleConfidence === "low" || body?.roleConfidence === "medium", "plain body uses weak confidence, not high confidence");
}

{
  const content = "---\ncolors:\n  canvas: '#ffffff'\n  surface: '#f4f5f7'\n  text: '#111111'\n---\n## Overview\nCanvas is page background and surface is section surface.";
  const board = buildBoard("surface-section", "Surface Section", "Surface section", content);
  const colors = deriveLightThemeTokens(board);
  assert(colors.canvas === "#ffffff", "surface must not override explicit canvas");
  assert(colors.surface === "#f4f5f7", "plain surface is selected as section surface");
}

{
  const content = "---\ncolors:\n  background: '#faf8f2'\n  card: '#ffffff'\n  text: '#111111'\n---\n## Overview\nBackground is page background. Card is a component surface.";
  const board = buildBoard("card-not-canvas", "Card Not Canvas", "Card is local", content);
  const colors = deriveLightThemeTokens(board);
  assert(colors.canvas === "#faf8f2", "card token must never become page canvas when background exists");
  assert(colors.surface === "#ffffff", "card may be used as surface fallback");
}

{
  const content = "---\ncolors:\n  canvas: '#fbfaf6'\n  ink: '#211f1b'\n  surface-dark: '#101010'\n  on-dark: '#f6f1e8'\n---\n## Overview\nLight-first warm editorial canvas. Surface dark is for product cards, not the page canvas.";
  const board = buildBoard("surface-dark-not-canvas", "Surface Dark", "Surface dark component", content);
  const dark = deriveDarkThemeTokens(board);
  assert(dark.canvas !== "#101010", "surface-dark must not become dark page canvas for light-first source");
  assert(dark.surface === "#101010" || dark.darkThemeSource?.surface.source === "derived", "surface-dark may affect dark surface only");
}

{
  const content = "---\ncolors:\n  body-dark: '#101820'\n  body-on-dark: '#f8fafc'\n  background: '#ffffff'\n---\n## Overview\nBody dark is the page body background for dark mode.";
  const board = buildBoard("body-dark-canvas", "Body Dark Canvas", "Body dark background", content);
  const dark = deriveDarkThemeTokens(board);
  assert(dark.canvas === "#101820", "body-dark with background prose is dark canvas");
}

{
  const content = "---\ncolors:\n  canvas: '#ffffff'\n  text: '#111111'\n  body-on-dark: '#f8fafc'\n  surface-dark: '#1f2937'\n---\n## Overview\nBody on dark is text on dark surfaces.";
  const board = buildBoard("body-dark-text", "Body Dark Text", "Body dark text", content);
  const dark = deriveDarkThemeTokens(board);
  assert(dark.text === "#f8fafc", "body-on-dark is selected as dark text");
  assert(dark.canvas !== "#f8fafc", "body-on-dark must not become dark canvas");
}

{
  const content = "---\ncolors:\n  primary: '#ff6600'\n  accent: '#0066ff'\n  success: '#22c55e'\n  timeline-blue: '#4f8cff'\n  text: '#111111'\n---\n## Overview\nPrimary and accent are for actions. Success is semantic. Timeline blue is only for timeline visualizations.";
  const board = buildBoard("accent-exclusion", "Accent Exclusion", "No canvas colors", content);
  const light = deriveLightThemeTokens(board);
  const dark = deriveDarkThemeTokens(board);
  for (const forbidden of ["#ff6600", "#0066ff", "#22c55e", "#4f8cff"]) {
    assert(light.canvas !== forbidden && light.surface !== forbidden, `light theme excludes scoped color ${forbidden}`);
    assert(dark.canvas !== forbidden && dark.surface !== forbidden, `dark theme excludes scoped color ${forbidden}`);
  }
}

// ── Source intent tests ──

{
  const intent = analyzeDesignMdSourceIntent(
    "---\ndescription: Warm cream editorial canvas. Orange is reserved for primary CTA and wordmark. Not a dark IDE.\n---",
    "Cursor",
    "Warm cream editorial canvas. Orange is reserved for primary CTA and wordmark. Not a dark IDE.",
  );
  assert(intent.canvasIntent === "cream" || intent.canvasIntent === "warmLight", "source intent detects warm cream canvas");
  assert(intent.darkModeIntent === "lightFirstDerived", "source intent detects light-first derived dark mode");
  assert(intent.accentIntent.includes("sparse") && intent.accentIntent.includes("ctaOnly"), "source intent detects sparse CTA accent");
}

{
  const intent = analyzeDesignMdSourceIntent(
    "## Overview\nDark native terminal interface on a black canvas with high contrast.",
    "Terminal",
    "",
  );
  assert(intent.darkModeIntent === "darkNative", "source intent detects dark-native terminal designs");
  assert(intent.canvasIntent === "black" || intent.canvasIntent === "dark", "source intent detects black/dark canvas");
  assert(intent.contrastIntent === "high", "source intent detects high contrast");
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
  // When no light canvas tokens exist, fallback should be safe (not a dark background token)
  const luma = relativeLuminance(lightCanvas);
  assert(luma !== null && luma > 0.5, `light canvas must be light (got ${lightCanvas}, luma ${luma?.toFixed(2)})`);
}

// ── Cursor-like regression tests (Pass 6) ──

// Simulated Cursor DESIGN.md token structure:
//   canvas: #f7f7f4 (warm cream, canvas/surface group)
//   primary: #f54e00 (Cursor Orange, brand/accent group)
//   ink: #26251e (warm near-black, text/ink group)
//   surface-card: #ffffff (text/ink group — body = black is ambiguous)
//   No explicit dark tokens.

// Test: Cursor-like — dark canvas does NOT become primary orange
{
  const cursorContent = "---\ncolors:\n  canvas: '#f7f7f4'\n  primary: '#f54e00'\n  primary-active: '#d44400'\n  ink: '#26251e'\n  surface-card: '#ffffff'\n  hairline: '#e5e5e0'\n  surface: '#fafaf8'\n---\n## Overview\nCursor design system. Warm cream canvas, orange CTA only.";
  const board = buildBoard("cursor", "Cursor", "AI code editor", cursorContent);
  const colors = deriveDarkThemeTokens(board);

  // CRITICAL: dark canvas must NOT be primary orange #f54e00
  assert(colors.canvas !== "#f54e00",
    "Cursor dark canvas must NOT be primary orange #f54e00");
  assert(colors.canvas !== "#d44400",
    "Cursor dark canvas must NOT be primary-active #d44400");

  // Dark canvas should be derived from neutral dark tones, not brand/accent
  const canvasLuma = relativeLuminance(colors.canvas);
  assert(canvasLuma !== null && canvasLuma < 0.4,
    `Cursor dark canvas must be dark (got ${colors.canvas}, luma ${canvasLuma?.toFixed(3)})`);

  // Dark canvas source should be derived (no explicit dark tokens)
  assert(colors.darkThemeSource?.canvas.source !== "fallback",
    "Cursor dark canvas should be derived from palette, not hardcoded fallback");
}

// Test: Cursor-like prose prevents harsh fake IDE black and keeps orange sparse
{
  const cursorContent = "---\ncolors:\n  canvas: '#f7f7f4'\n  primary: '#f54e00'\n  primary-active: '#d04200'\n  ink: '#26251e'\n  surface-card: '#ffffff'\n  hairline: '#e6e5e0'\n  timeline-read: '#9fbbe0'\ncomponents:\n  button-primary:\n    backgroundColor: '#f54e00'\n    textColor: '#ffffff'\n    rounded: '8px'\n    padding: '10px 18px'\n  button-primary-active:\n    backgroundColor: '#d04200'\n    textColor: '#ffffff'\n    rounded: '8px'\n    padding: '10px 18px'\n---\n## Overview\nAn AI-first code editor with a warm-cream editorial canvas instead of the typical dark IDE atmosphere. Cursor Orange is reserved for primary CTAs and the wordmark. Timeline colors are only inside in-product timeline visualizations.";
  const board = buildBoard("cursor-intent", "Cursor", "Warm cream editorial canvas; orange reserved for CTA; not a dark IDE.", cursorContent);
  const light = deriveLightThemeTokens(board);
  const dark = deriveDarkThemeTokens(board);
  assert(light.canvas === "#f7f7f4", "Cursor intent light canvas uses warm cream");
  assert(dark.canvas !== "#f54e00" && dark.canvas !== "#d04200" && dark.canvas !== "#9fbbe0", "Cursor intent dark canvas excludes primary, state, and timeline colors");
  assert(luma(dark.canvas) > 0.02, `Cursor intent dark canvas must not be harsh black (got ${dark.canvas})`);
  assert(board.sourceIntent.darkModeIntent === "lightFirstDerived", "Cursor intent is light-first derived");
  const html = generateBoardHtml(board, { variant: "light" });
  const heroButtons = html.match(/<button class="hero-btn[^>]*>[\s\S]*?<\/button>/g) ?? [];
  assert(heroButtons.length <= 1, "sparse Cursor accent renders at most one primary-like hero button");
  assert(!heroButtons.some((button) => button.includes("button-primary-active")), "Cursor primary-active remains state-only");
}

// Test: Claude-like warm editorial source gets a softer derived dark fallback
{
  const claudeContent = "---\ncolors:\n  primary: '#cc785c'\n  primary-active: '#a9583e'\n  ink: '#141413'\n  body: '#3d3d3a'\n  canvas: '#faf9f5'\n  surface-soft: '#f5f0e8'\n  surface-card: '#efe9de'\n  surface-dark: '#181715'\n  on-dark: '#faf9f5'\n  hairline: '#e6dfd8'\n---\n## Overview\nA warm-canvas editorial interface anchored on a tinted cream canvas with serif display headlines, warm coral CTAs, and dark navy product surfaces used for code editor mockups and model showcase cards.";
  const board = buildBoard("claude-intent", "Claude", "Warm-canvas editorial interface with tinted cream canvas and warm coral CTAs.", claudeContent);
  const dark = deriveDarkThemeTokens(board);
  assert(board.sourceIntent.darkModeIntent === "lightFirstDerived", "Claude warm editorial intent is light-first derived");
  assert(luma(dark.canvas) > luma("#141413"), `Claude derived dark canvas must be softer than raw ink (got ${dark.canvas})`);
  assert(luma(dark.canvas) > 0.02, `Claude derived dark canvas must not be overly black (got ${dark.canvas})`);
  assert(luma(dark.border) < 0.18, "Claude warm/editorial dark border stays subtle");
}

// Test: Cursor-like semantics classify sparse primary, state variant, and timeline-only colors
{
  const cursorContent = "---\ncolors:\n  canvas: '#f7f7f4'\n  primary: '#f54e00'\n  primary-active: '#d04200'\n  ink: '#26251e'\n  timeline-blue: '#4f8cff'\n  timeline-green: '#2fa866'\ncomponents:\n  button-primary:\n    backgroundColor: '#f54e00'\n    textColor: '#ffffff'\n    rounded: '8px'\n    padding: '10px 18px'\n  button-primary-active:\n    backgroundColor: '#d04200'\n    textColor: '#ffffff'\n    rounded: '8px'\n    padding: '10px 18px'\n---\n## Overview\nCursor Orange is reserved for primary CTAs and wordmark. Use it scarcely. The page canvas is warm cream and ink is warm near-black. Timeline colors are only inside in-product timeline visualizations.";
  const board = buildBoard("cursor-semantics", "Cursor", "AI code editor", cursorContent);
  const tokens = allColorTokens(board);
  const canvas = tokens.find((token) => token.key === "canvas");
  const primary = tokens.find((token) => token.key === "primary");
  const active = tokens.find((token) => token.key === "primary-active");
  const timeline = tokens.find((token) => token.key === "timeline-blue");
  assert(canvas?.usageScope === "globalCanvas" && canvas?.usageIntensity === "dominant", "Cursor canvas must be global dominant canvas");
  assert(primary?.semanticRole === "primaryAction" && primary?.usageIntensity === "sparse", "Cursor primary must be sparse primary action");
  assert(active?.semanticRole === "state" && active?.usageScope === "stateOnly", "Cursor primary-active must be stateOnly");
  assert(timeline?.semanticRole === "timeline" && timeline?.usageScope === "timelineOnly", "Cursor timeline color must be timelineOnly");
  const colors = deriveLightThemeTokens(board);
  assert(colors.canvas === "#f7f7f4", "Cursor semantic light canvas must stay cream");
  assert(colors.surface !== "#f54e00" && colors.surface !== "#d04200", "Cursor semantic light surface must not be orange");
  const dark = deriveDarkThemeTokens(board);
  assert(dark.canvas !== "#f54e00" && dark.canvas !== "#d04200", "Cursor semantic dark canvas must not use primary/state orange");
  assert(dark.surface !== "#f54e00" && dark.surface !== "#d04200", "Cursor semantic dark surface must not use primary/state orange");
  const html = generateBoardHtml(board, { variant: "light" });
  assert(html.includes("button-primary"), "Cursor base primary button may render");
  const heroButtons = html.match(/<button class="hero-btn[^>]*>[\s\S]*?<\/button>/g) ?? [];
  assert(!heroButtons.some((button) => button.includes("button-primary-active")), "Cursor primary-active must not render as standalone hero button");
}

// Test: state variants do not render as standalone hero buttons
{
  const content = "---\ncolors:\n  canvas: '#ffffff'\n  text: '#111111'\n  primary: '#2563eb'\n  primary-hover: '#1d4ed8'\ncomponents:\n  button-primary-hover:\n    backgroundColor: '#1d4ed8'\n    textColor: '#ffffff'\n    rounded: '8px'\n    padding: '10px 18px'\n  button-disabled:\n    backgroundColor: '#94a3b8'\n    textColor: '#ffffff'\n    rounded: '8px'\n    padding: '10px 18px'\n---\n## Overview\nHover and disabled colors are state variants only.";
  const board = buildBoard("state-buttons", "State Buttons", "State variants", content);
  const html = generateBoardHtml(board, { variant: "light" });
  assert(!html.includes('<button class="hero-btn"'), "state variant components must not render hero buttons");
}

// Test: sparse/restricted accent stays sparse and state CTA variants are omitted
{
  const content = "---\ncolors:\n  canvas: '#fbfaf4'\n  ink: '#171511'\n  primary: '#ff5a00'\n  surface: '#ffffff'\ncomponents:\n  button-primary-active:\n    backgroundColor: '#cc4400'\n    textColor: '#ffffff'\n---\n## Overview\nPrimary is reserved for wordmark and only for rare CTA use. Use it scarcely.";
  const board = buildBoard("sparse-accent", "Sparse Accent", "Sparse accent", content);
  const html = generateBoardHtml(board, { variant: "light" });
  const heroButtons = html.match(/<button class="hero-btn[^>]*>[\s\S]*?<\/button>/g) ?? [];
  assert(heroButtons.length === 0, "state-only sparse accent button variants must not render as hero buttons");
  assert(board.qualityWarnings.stateColorOveruseRisk, "state color risk must be exposed in quality warnings");
}

// Test: semantic and timeline tokens do not become theme canvas/surface/dark fallback
{
  const content = "---\ncolors:\n  success: '#008a45'\n  error: '#d93025'\n  timeline-red: '#b91c1c'\n  text: '#111111'\n---\n## Overview\nSuccess and error are semantic validation colors. Timeline red is only for timeline visualizations.";
  const board = buildBoard("semantic-exclusion", "Semantic Exclusion", "Scoped colors", content);
  const dark = deriveDarkThemeTokens(board);
  assert(dark.canvas !== "#008a45" && dark.canvas !== "#d93025" && dark.canvas !== "#b91c1c", "dark canvas must exclude semantic/timeline colors");
  assert(dark.surface !== "#008a45" && dark.surface !== "#d93025" && dark.surface !== "#b91c1c", "dark surface must exclude semantic/timeline colors");
}

// Test: explicit brand canvas is allowed when source names it as canvas/background
{
  const content = "---\ncolors:\n  brand-background: '#ffcc00'\n  text: '#111111'\n---\n## Overview\nBrand background is the global page background.";
  const board = buildBoard("brand-canvas", "Brand Canvas", "Brand canvas", content);
  const light = deriveLightThemeTokens(board);
  assert(light.canvas === "#ffcc00", "explicit brand-background may be used as canvas");
}

// Test: Cursor-like — light canvas resolves to warm cream
{
  const cursorContent = "---\ncolors:\n  canvas: '#f7f7f4'\n  primary: '#f54e00'\n  primary-active: '#d44400'\n  ink: '#26251e'\n  surface-card: '#ffffff'\n  hairline: '#e5e5e0'\n  surface: '#fafaf8'\n---\n## Overview\nCursor design system";
  const board = buildBoard("cursor-light", "Cursor Light", "AI code editor", cursorContent);
  const colors = deriveLightThemeTokens(board);
  assert(colors.canvas === "#f7f7f4", `Cursor light canvas must be warm cream #f7f7f4 (got ${colors.canvas})`);
  assert(colors.text === "#26251e", `Cursor light text must be ink near-black #26251e (got ${colors.text})`);
}

// Test: primary does not appear as canvas when only primary tokens exist in source
{
  const content = "---\ncolors:\n  primary: '#ff6b00'\n  secondary: '#334455'\n---\n## Overview\nNo canvas defined — only primary and secondary";
  const board = buildBoard("no-canvas-primary", "No Canvas", "Only primary", content);
  const colors = deriveDarkThemeTokens(board);
  // Dark canvas must NOT be primary #ff6b00 (brand/accent is forbidden for canvas)
  assert(colors.canvas !== "#ff6b00", "dark canvas must NOT be primary when no canvas token exists");
  // Secondary/muted is neutral enough to be acceptable as derived dark canvas
  // — it is NOT in brand/accent or semantic/status groups.
}

// Test: dark fallback excludes semantic/timeline colors
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  success: '#22c55e'\n  error: '#ef4444'\n  warning: '#f59e0b'\n  canvas: '#ffffff'\n  text: '#111111'\n---\n## Overview\nSemantic colors must not become canvas";
  const board = buildBoard("no-canvas-semantic", "Semantic Test", "Semantic colors", content);
  const colors = deriveDarkThemeTokens(board);
  // Dark canvas must NOT be any semantic color
  assert(colors.canvas !== "#22c55e", "dark canvas must NOT be semantic success green");
  assert(colors.canvas !== "#ef4444", "dark canvas must NOT be semantic error red");
  assert(colors.canvas !== "#f59e0b", "dark canvas must NOT be semantic warning yellow");
}

// Test: dark surface derivation excludes brand/accent tokens
{
  const content = "---\ncolors:\n  primary: '#ff6600'\n  canvas: '#ffffff'\n  text: '#111111'\n  canvas-dark: '#18181b'\n  on-dark: '#f4f4f5'\n---\n## Overview\nTest surface derivation filtering";
  const board = buildBoard("surface-filter", "Surface Filter", "Surface filtering", content);
  const colors = deriveDarkThemeTokens(board);
  // surface should be derived from canvas-dark, not primary
  assert(colors.surface !== "#ff6600", "dark surface must NOT be primary orange");
  const surfaceLuma = relativeLuminance(colors.surface);
  const canvasLuma = relativeLuminance(colors.canvas);
  assert(surfaceLuma !== null && canvasLuma !== null,
    "surface and canvas must have valid luma values");
  // Surface should be slightly lighter than canvas (not wildly different)
  assert(Math.abs(surfaceLuma! - canvasLuma!) < 0.3,
    `dark surface (${colors.surface}) luma should be close to canvas (${colors.canvas}) luma`);
}

// Test: dark canvas uses neutral ink before primary as fallback
{
  const content = "---\ncolors:\n  ink: '#1a1a1a'\n  primary: '#ff4500'\n---\n## Overview\nInk should beat primary as dark canvas base";
  const board = buildBoard("ink-vs-primary", "Ink vs Primary", "Ink beats primary", content);
  const colors = deriveDarkThemeTokens(board);
  // ink #1a1a1a is a neutral dark, primary #ff4500 is forbidden for canvas
  assert(colors.canvas !== "#ff4500", "dark canvas must NOT be primary when ink exists");
  // The canvas should be derived from the darkest neutral safe token
  const canvasLuma = relativeLuminance(colors.canvas);
  assert(canvasLuma !== null && canvasLuma < 0.3, "dark canvas must be dark");
}

// Test: dark border fallback is not pure white
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  canvas-dark: '#0d1117'\n  on-dark: '#f0f2f5'\n---\n## Overview\nNo border tokens — derived border should not be white";
  const board = buildBoard("border-not-white", "Border Not White", "Derived border is subtle", content);
  const colors = deriveDarkThemeTokens(board);
  const borderLuma = relativeLuminance(colors.border);
  assert(borderLuma !== null && borderLuma < 0.5,
    `derived dark border must not be white/light (got ${colors.border}, luma ${borderLuma?.toFixed(3)})`);
}

// Test: explicit canvas-dark wins over black token
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  black: '#000000'\n  canvas-dark: '#111827'\n  on-dark: '#f3f4f6'\n---\n## Overview\nCanvas-dark should beat black";
  const board = buildBoard("canvas-vs-black", "Canvas vs Black", "Source priority", content);
  const colors = deriveDarkThemeTokens(board);
  assert(colors.canvas === "#111827", `canvas-dark must win over black token (got ${colors.canvas})`);
}

// Test: dark canvas must NOT use plain black when canvas-dark exists
{
  const content = "---\ncolors:\n  primary: '#2563eb'\n  background: '#ffffff'\n  text: '#111111'\n  black: '#000000'\n  canvas-dark: '#111827'\n  on-dark: '#f3f4f6'\n---\n## Overview\nBlack should lose to canvas-dark";
  const board = buildBoard("test-black-vs-canvas-2", "Black vs Canvas 2", "Source priority test", content);
  const colors = deriveDarkThemeTokens(board);
  assert(colors.canvas !== "#000000", "dark canvas must NOT be plain black when canvas-dark token exists");
  assert(colors.canvas === "#111827", "dark canvas must use explicit canvas-dark over black token");
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
