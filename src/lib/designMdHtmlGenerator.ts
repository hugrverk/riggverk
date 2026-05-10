import type { DesignMdSpecimen, DesignMdBoard, DesignMdBoardComponentGroup } from "./designMdSpecimenBuilder";
import { isSafeColorValue, isSafeFontFamilyValue, isSafeSizeValue, isSafeSpacingValue, isUnsafeDesignMdStyleValue } from "./designMdPreviewParser";

const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:;">';

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cssText(value: string | undefined, fallback: string): string {
  if (!value || isUnsafeDesignMdStyleValue(value)) return fallback;
  return value.trim();
}

function cssColor(value: string | undefined, fallback: string): string {
  return isSafeColorValue(value) ? value.trim() : fallback;
}

function cssSize(value: string | undefined, fallback: string): string {
  return isSafeSizeValue(value) ? value.trim() : fallback;
}

function cssSpacing(value: string | undefined, fallback: string): string {
  return isSafeSpacingValue(value) ? value.trim() : fallback;
}

function cssFont(value: string | undefined, fallback: string): string {
  return isSafeFontFamilyValue(value) ? value.trim() : fallback;
}

function tokenKeyMatches(key: string, match: string): boolean {
  const normalized = key.toLowerCase();
  if (normalized === match) return true;
  return normalized.split(/[^a-z0-9]+/).includes(match);
}

function tokenValue(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
  for (const match of matches) {
    const found = tokens.find((token) => tokenKeyMatches(token.key, match));
    if (found && !isUnsafeDesignMdStyleValue(found.resolvedValue)) return found.resolvedValue.trim();
  }
  return fallback;
}

function tokenColor(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
  for (const match of matches) {
    const found = tokens.find((token) => tokenKeyMatches(token.key, match));
    if (isSafeColorValue(found?.resolvedValue)) return found.resolvedValue.trim();
  }
  return fallback;
}

function component(board: DesignMdBoard, matches: string[]): DesignMdBoardComponentGroup | undefined {
  for (const match of matches) {
    const exact = board.componentGroups.find((group) => group.name.toLowerCase() === match);
    if (exact) return exact;
    const prefixed = board.componentGroups.find((group) => group.name.toLowerCase().startsWith(match));
    if (prefixed) return prefixed;
    const partial = board.componentGroups.find((group) => group.name.toLowerCase().includes(match));
    if (partial) return partial;
  }
  return undefined;
}

function prioritizedComponentGroups(board: DesignMdBoard): DesignMdBoardComponentGroup[] {
  const priorities: Record<DesignMdBoard["archetype"], string[]> = {
    marketplace: ["search", "property", "experience", "listing", "guest", "rating", "badge", "tab", "card", "button"],
    product_gallery: ["global-nav", "sub-nav", "product-tile", "store", "button", "link", "chip", "quote", "footer"],
    finance_dashboard: ["top-nav", "markets", "asset-row", "price", "balance", "stat", "trust", "button", "input", "badge", "card"],
    luxury_automotive: ["hero", "model", "photo", "inventory", "spec", "configurator", "filter", "m-stripe", "button", "nav"],
    data_product: ["stat", "code", "chart", "table", "query", "badge", "feature", "pricing", "input", "button", "nav"],
    developer_docs: ["top-nav", "docs", "code", "command", "terminal", "link", "button", "input", "card"],
    collaboration_saas: ["hero", "mesh", "pill", "button", "input", "pricing", "feature", "card", "nav", "link"],
    editorial: ["hero", "article", "story", "quote", "card", "link", "button", "nav"],
    generic_system: ["nav", "button", "card", "tile", "input", "chip", "link"],
  };
  const rank = (group: DesignMdBoardComponentGroup) => {
    const name = group.name.toLowerCase();
    const index = priorities[board.archetype].findIndex((needle) => name.includes(needle));
    return index === -1 ? 100 : index;
  };
  return [...board.componentGroups].sort((a, b) => rank(a) - rank(b));
}

function componentColors(group: DesignMdBoardComponentGroup | undefined, bg: string, fg: string) {
  return {
    bg: cssColor(group?.backgroundColor, bg),
    fg: cssColor(group?.textColor, fg),
    border: cssColor(group?.borderColor, "currentColor"),
    radius: cssSize(group?.rounded, "10px"),
    padding: cssSpacing(group?.padding, "12px 18px"),
  };
}

/** Legacy generic page — delegates to board for backward compat. */
export function generateSpecimenHtml(spec: DesignMdSpecimen): string {
  return generateBoardHtml({
    slug: spec.slug,
    title: spec.title,
    description: spec.description,
    colorGroups: [{ prefix: "palette", tokens: [
      { key: "primary", rawValue: spec.primaryColor, resolvedValue: spec.primaryColor },
      { key: "surface", rawValue: spec.surfaceColor, resolvedValue: spec.surfaceColor },
      { key: "canvas", rawValue: spec.canvasColor, resolvedValue: spec.canvasColor },
      { key: "text", rawValue: spec.textColor, resolvedValue: spec.textColor },
      { key: "muted", rawValue: spec.mutedColor, resolvedValue: spec.mutedColor },
      { key: "border", rawValue: spec.borderColor, resolvedValue: spec.borderColor },
    ]}],
    palette: [],
    typographyTokens: [],
    radiusTokens: [
      { key: "sm", rawValue: spec.radiusSm, resolvedValue: spec.radiusSm },
      { key: "md", rawValue: spec.radiusMd, resolvedValue: spec.radiusMd },
      { key: "lg", rawValue: spec.radiusLg, resolvedValue: spec.radiusLg },
      { key: "pill", rawValue: spec.radiusPill, resolvedValue: spec.radiusPill },
    ],
    spacingTokens: [
      { key: "sm", rawValue: spec.spaceSm, resolvedValue: spec.spaceSm },
      { key: "md", rawValue: spec.spaceMd, resolvedValue: spec.spaceMd },
      { key: "lg", rawValue: spec.spaceLg, resolvedValue: spec.spaceLg },
    ],
    componentGroups: [],
    visualLanguage: { phrases: spec.overview ? [spec.overview] : [], keywords: [] },
    archetype: "generic_system",
    overview: spec.overview,
    layout: null,
  });
}

function typographyCss(board: DesignMdBoard, matches: string[], fallbackSize: string) {
  const token = board.typographyTokens.find((t) => matches.some((match) => t.key.toLowerCase().includes(match))) ?? board.typographyTokens[0];
  return {
    family: cssFont(token?.fontFamily, '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'),
    size: cssSize(token?.fontSize, fallbackSize),
    weight: cssText(token?.fontWeight, "600"),
    lineHeight: cssText(token?.lineHeight, "1.15"),
    letterSpacing: cssText(token?.letterSpacing, "0"),
  };
}

function heroPattern(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  switch (board.archetype) {
    case "marketplace":
      return marketplaceHero(board, colors);
    case "product_gallery":
      return productGalleryHero(board, colors);
    case "finance_dashboard":
      return financeHero(board, colors);
    case "developer_docs":
      return docsHero(board, colors);
    case "collaboration_saas":
      return collaborationHero(board, colors);
    case "luxury_automotive":
      return automotiveHero(board, colors);
    case "data_product":
      return dataHero(board, colors);
    default:
      return genericHero(board, colors);
  }
}

function marketplaceHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const searchGroup = component(board, ["search-bar", "search"]);
  const cardGroups = ["property-card", "experience-card", "rating-display-card"].map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const search = componentColors(searchGroup, colors.canvas, colors.text);
  const card = componentColors(cardGroups[0] ?? component(board, ["card"]), colors.surface, colors.text);
  return '<section class="hero hero-market">' +
    '<div class="market-nav"><strong>' + esc(board.title) + '</strong><span>Homes</span><span>Experiences</span><span>Services</span><span class="badge">NEW</span></div>' +
    '<div class="market-search" style="background:' + search.bg + ';color:' + search.fg + ';border-radius:' + search.radius + '">' +
    '<span><b>Where</b><small>' + esc(searchGroup?.name ?? "search") + '</small></span><span><b>When</b><small>Add dates</small></span><span><b>Who</b><small>Add guests</small></span><i style="background:' + colors.primary + ';color:' + colors.onPrimary + '">⌕</i></div>' +
    '<div class="listing-grid">' + [0, 1, 2].map((i) =>
      '<article class="listing-card" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + card.radius + '">' +
      '<div class="photo-block p' + i + '"><span class="badge">Guest favorite</span></div>' +
      '<b>' + esc(cardGroups[i]?.name ?? ["property card", "experience card", "rating card"][i]) + '</b><span class="muted">4.9 · 2 nights · actual card tokens</span></article>'
    ).join("") + '</div></section>';
}

function productGalleryHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const lightGroup = component(board, ["product-tile-light", "product-tile-parchment", "product-tile"]);
  const darkGroup = component(board, ["product-tile-dark", "product-tile-dark-2", "product-tile-dark-3"]);
  const buttonGroup = component(board, ["button-store-hero", "button-primary", "button-secondary-pill"]);
  const light = componentColors(lightGroup, colors.canvas, colors.text);
  const dark = componentColors(darkGroup, colors.darkSurface, colors.onDark);
  const button = componentColors(buttonGroup, colors.primary, colors.onPrimary);
  return '<section class="hero hero-gallery">' +
    '<div class="gallery-nav" style="background:' + colors.darkSurface + ';color:' + colors.onDark + '"><span>' + esc(board.title) + '</span><span>Store</span><span>Mac</span><span>iPhone</span><button style="background:' + button.bg + ';color:' + button.fg + '">' + esc(buttonGroup?.name ?? "Buy") + '</button></div>' +
    '<div class="product-tiles">' +
    '<article class="product-tile product-tile-light" style="background:' + light.bg + ';color:' + light.fg + ';border-radius:' + light.radius + '"><h2>' + esc(lightGroup?.name ?? "product tile") + '</h2><p>Photography-first sparse surface</p><div class="device-shape"></div><span class="pill" style="background:' + button.bg + ';color:' + button.fg + '">' + esc(buttonGroup?.name ?? "CTA") + '</span></article>' +
    '<article class="product-tile product-tile-dark" style="background:' + dark.bg + ';color:' + dark.fg + ';border-radius:' + dark.radius + '"><h2>' + esc(darkGroup?.name ?? "dark product tile") + '</h2><p>Alternating dark gallery block</p><div class="device-shape dark"></div><span class="pill outline">' + esc(component(board, ["text-link-on-dark", "text-link"])?.name ?? "text link") + '</span></article>' +
    '</div></section>';
}

function financeHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const nav = componentColors(component(board, ["top-nav-dark", "top-nav"]), colors.darkCanvas, colors.onDark);
  const tableGroup = component(board, ["markets-table-card", "asset-row", "product-ui-card"]);
  const card = componentColors(tableGroup ?? component(board, ["card", "panel"]), colors.darkSurface, colors.onDark);
  const actionGroup = component(board, ["button-primary", "button-primary-pill"]);
  const action = componentColors(actionGroup, colors.primary, colors.onPrimary);
  return '<section class="hero hero-finance" style="background:' + colors.darkCanvas + ';color:' + colors.onDark + '">' +
    '<div class="finance-nav" style="background:' + nav.bg + ';color:' + nav.fg + '"><strong>' + esc(board.title) + '</strong><span>Buy Crypto</span><span>Markets</span><button style="background:' + action.bg + ';color:' + action.fg + ';border-radius:' + action.radius + '">' + esc(actionGroup?.name ?? "Sign Up") + '</button></div>' +
    '<div class="finance-grid"><article class="balance-card" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + card.radius + '"><small>Total Balance</small><h2>$42,918.80</h2><button style="background:' + action.bg + ';color:' + action.fg + ';border-radius:' + action.radius + '">Deposit</button></article>' +
    '<article class="market-table" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + card.radius + '"><b>' + esc(tableGroup?.name ?? "market table") + '</b>' +
    [["BTC", "+2.4%", colors.up], ["ETH", "-0.8%", colors.down], ["BNB", "+1.7%", colors.up]].map((row) => '<div><span>' + row[0] + '</span><strong style="color:' + row[2] + '">' + row[1] + '</strong></div>').join("") +
    '</article><article class="action-stack"><button style="background:' + action.bg + ';color:' + action.fg + ';border-radius:' + action.radius + '">Buy</button><button>Sell</button><button>Convert</button></article></div></section>';
}

function docsHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const code = component(board, ["code-block", "code-window", "terminal", "command"]);
  const feature = component(board, ["card-feature", "docs-card", "pricing", "panel"]);
  const cta = component(board, ["button-primary", "button-primary-green", "button-on-dark", "button"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary);
  return '<section class="hero hero-docs"><aside><b>' + esc(board.title) + '</b><span>Overview</span><span>API</span><span>Components</span><span>Changelog</span></aside><main><div class="docs-copy"><h2>' + esc(board.title) + ' system</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Read docs") + '</button></div><div class="docs-panels"><pre>' + esc(code?.name ?? "terminal") + '\n$ npm install design-system\n✓ local preview ready</pre><article><b>' + esc(feature?.name ?? "feature panel") + '</b><span>API surface</span><span>Status: stable</span></article></div></main></section>';
}

function collaborationHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const primary = component(board, ["button-primary-pill", "button-primary", "pill"]);
  const input = component(board, ["text-input", "search-input", "input"]);
  const cards = ["card-pricing-featured", "card-feature-cream", "card-stat", "card-pricing"].map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const button = componentColors(primary, colors.primary, colors.onPrimary);
  const inputStyle = componentColors(input, colors.canvas, colors.text);
  const card = componentColors(cards[0] ?? component(board, ["card"]), colors.surface, colors.text);
  return '<section class="hero hero-collab"><div class="collab-copy"><span class="collab-kicker">Team workspace</span><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><div class="collab-actions"><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(primary?.name ?? "button-primary-pill") + '</button><span style="border-color:' + button.bg + ';color:' + button.bg + '">' + esc(component(board, ["button-secondary", "button-outline"])?.name ?? "outline button") + '</span></div></div><div class="collab-mesh"><div class="collab-input" style="background:' + inputStyle.bg + ';color:' + inputStyle.fg + ';border-radius:' + inputStyle.radius + '"><span>' + esc(input?.name ?? "text-input") + '</span><i></i></div><div class="collab-cards">' +
    [0, 1, 2].map((i) => '<article style="background:' + (i === 0 ? button.bg : card.bg) + ';color:' + (i === 0 ? button.fg : card.fg) + ';border-radius:' + card.radius + '"><b>' + esc(cards[i]?.name ?? ["card-pricing-featured", "card-feature", "card-stat"][i]) + '</b><span>' + ["Channels", "Automations", "Messages"][i] + '</span></article>').join("") +
    '</div></div></section>';
}

function automotiveHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const hero = componentColors(component(board, ["hero-band", "photo-band"]), colors.darkSurface, colors.onDark);
  const cardGroups = ["model-card", "feature-photo-card", "inventory-card"].map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const card = componentColors(cardGroups[0] ?? component(board, ["card"]), colors.surface, colors.text);
  return '<section class="hero hero-auto"><div class="auto-band" style="background:' + hero.bg + ';color:' + hero.fg + '"><div><small>Corporate automotive</small><h2>' + esc(board.title) + '</h2><button style="background:' + colors.primary + ';color:' + colors.onPrimary + ';border-radius:' + hero.radius + '">Explore models</button></div><div class="vehicle-silhouette"></div></div><div class="auto-grid">' +
    [0, 1, 2].map((i) => '<article style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + card.radius + '"><div class="vehicle-mini"></div><b>' + esc(cardGroups[i]?.name ?? ["model card", "feature photo card", "inventory card"][i]) + '</b><span>Learn more</span></article>').join("") +
    '</div></section>';
}

function dataHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const groups = prioritizedComponentGroups(board);
  const chart = groups.find((group) => /chart|stat|code|mockup|card/i.test(group.name));
  const table = groups.find((group) => /table|row|query|pricing/i.test(group.name));
  return '<section class="hero hero-data"><div class="data-sidebar"><b>' + esc(board.title) + '</b><span>Queries</span><span>Metrics</span><span>Events</span></div><div class="data-main"><div class="chart-card"><h2>' + esc(chart?.name ?? "data panel") + '</h2><div class="bars"><i></i><i></i><i></i><i></i><i></i></div></div><div class="data-table"><b>' + esc(table?.name ?? "metric table") + '</b>' +
    ["Latency", "Queries", "Errors"].map((label, i) => '<div><span>' + label + '</span><strong style="color:' + (i === 2 ? colors.down : colors.primary) + '">' + ["18ms", "1.2M", "0.01%"][i] + '</strong></div>').join("") +
    '</div></div></section>';
}

function genericHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  return '<section class="hero hero-generic"><div><small>' + esc(board.archetype) + '</small><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p></div><div class="generic-board">' +
    board.componentGroups.slice(0, 4).map((group) => componentSampleHtml(group, colors)).join("") +
    '</div></section>';
}

function deriveTokens(board: DesignMdBoard) {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  const canvas = tokenColor(allColors, ["canvas-light", "canvas", "background", "white"], "#ffffff");
  const darkCanvas = tokenColor(allColors, ["canvas-dark", "surface-black", "surface-dark", "black"], "#0b0e11");
  const surface = tokenColor(allColors, ["surface-card", "surface-soft", "surface", "card"], "#f5f5f5");
  const darkSurface = tokenColor(allColors, ["surface-card-dark", "surface-tile", "surface-dark", "elevated-dark"], "#1f2329");
  const text = tokenColor(allColors, ["ink", "body-on-light", "text", "body"], "#181818");
  const muted = tokenColor(allColors, ["muted", "secondary", "soft"], "#6f7480");
  const border = tokenColor(allColors, ["hairline", "border", "divider"], "#e5e5e5");
  const primary = tokenColor(allColors, ["primary", "brand", "accent", "blue", "yellow"], "#0066cc");
  const onPrimary = tokenColor(allColors, ["on-primary"], "#ffffff");
  const onDark = tokenColor(allColors, ["on-dark", "body-on-dark"], "#ffffff");
  const up = tokenColor(allColors, ["trading-up", "success"], "#0ecb81");
  const down = tokenColor(allColors, ["trading-down", "error"], "#f6465d");
  const radius = cssSize(tokenValue(board.radiusTokens, ["md", "lg", "sm"], "10px"), "10px");
  const pill = cssSize(tokenValue(board.radiusTokens, ["pill", "full"], "9999px"), "9999px");
  const spacing = cssSpacing(tokenValue(board.spacingTokens, ["lg", "md", "base"], "24px"), "24px");
  return { canvas, darkCanvas, surface, darkSurface, text, muted, border, primary, onPrimary, onDark, up, down, radius, pill, spacing };
}

function componentSampleHtml(group: DesignMdBoardComponentGroup, colors: ReturnType<typeof deriveTokens>): string {
  const style = componentColors(group, colors.surface, colors.text);
  const name = esc(group.name);
  switch (group.kind) {
    case "button":
      return '<button class="sample sample-button" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + ';padding:' + style.padding + '">' + name + '</button>';
    case "search":
    case "input":
      return '<div class="sample sample-input" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><span>' + name + '</span><i></i></div>';
    case "chip":
    case "badge":
      return '<span class="sample sample-chip" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + colors.pill + '">' + name + '</span>';
    case "nav":
    case "subnav":
      return '<div class="sample sample-nav" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><b>' + name + '</b><span>One</span><span>Two</span></div>';
    case "product-tile":
    case "tile":
      return '<div class="sample sample-tile" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><div></div><b>' + name + '</b></div>';
    case "hero":
    case "gradient":
      return '<div class="sample sample-gradient" style="background:linear-gradient(135deg,' + style.bg + ',' + colors.primary + ');color:' + style.fg + ';border-radius:' + style.radius + '"><b>' + name + '</b><span>hero surface</span></div>';
    case "mockup":
      return '<div class="sample sample-mockup" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><b>' + name + '</b><code>const preview = local;</code><span></span><span></span></div>';
    case "stat":
      return '<div class="sample sample-stat" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><small>' + name + '</small><b>98.7%</b><span style="color:' + colors.primary + '">+12.4%</span></div>';
    case "table":
      return '<div class="sample sample-table" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><span><i>Alpha</i><strong>Active</strong></span><span><i>Beta</i><strong>Queued</strong></span></div>';
    case "link":
      return '<a class="sample sample-link" style="color:' + style.fg + '">' + name + '</a>';
    case "quote":
      return '<blockquote class="sample sample-card" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '">“' + name + '”</blockquote>';
    case "footer":
      return '<div class="sample sample-footer" style="background:' + style.bg + ';color:' + style.fg + '">' + name + '</div>';
    case "card":
      if (/table|row|price|market|asset/i.test(group.name)) {
        return '<div class="sample sample-table" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><span><i>BTC</i><strong>+2.4%</strong></span><span><i>ETH</i><strong>-0.8%</strong></span></div>';
      }
      return '<div class="sample sample-card" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><small>' + esc(Object.keys(group.raw).slice(0, 3).join(" · ")) + '</small></div>';
    case "utility":
    case "generic":
    default:
      return '<div class="sample sample-card" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><small>' + esc(Object.keys(group.raw).slice(0, 3).join(" · ")) + '</small></div>';
  }
}

function generatePalette(board: DesignMdBoard): string {
  const tokens = board.colorGroups.flatMap((group) => group.tokens.map((token) => ({ ...token, group: group.prefix })));
  const visible = tokens.slice(0, 16);
  const more = Math.max(0, tokens.length - visible.length);
  return '<section class="strip palette-strip"><header><b>Palette</b><span>' + tokens.length + ' colors</span></header><div class="palette-grid">' +
    visible.map((token) => '<div class="swatch"><i style="background:' + cssColor(token.resolvedValue, "#d8d8d8") + '"></i><b>' + esc(token.key) + '</b><small>' + esc(token.group) + '</small></div>').join("") +
    (more ? '<div class="swatch more"><b>+' + more + ' more</b></div>' : "") +
    '</div></section>';
}

function generateTypography(board: DesignMdBoard): string {
  const tokens = board.typographyTokens.slice(0, 8);
  if (tokens.length === 0) return "";
  return '<section class="strip type-strip"><header><b>Typography</b><span>token samples</span></header><div class="type-grid">' +
    tokens.map((token) => {
      const style = [
        "font-family:" + cssFont(token.fontFamily, "inherit"),
        "font-size:" + cssSize(token.fontSize, "18px"),
        "font-weight:" + cssText(token.fontWeight, "500"),
        "line-height:" + cssText(token.lineHeight, "1.25"),
        "letter-spacing:" + cssText(token.letterSpacing, "0"),
      ].join(";");
      return '<div class="type-row"><small>' + esc(token.key) + '</small><span style="' + style + '">' + esc(token.key) + ' speaks in this system</span></div>';
    }).join("") + '</div></section>';
}

function generateRhythm(board: DesignMdBoard): string {
  const radius = board.radiusTokens.slice(0, 8).map((token) => '<div class="radius-cell" style="border-radius:' + cssSize(token.resolvedValue, "0px") + '">' + esc(token.key) + '</div>').join("");
  const spacing = board.spacingTokens.slice(0, 8).map((token) => '<div class="space-row"><span>' + esc(token.key) + '</span><i style="width:' + cssSize(token.resolvedValue, "8px") + '"></i><small>' + esc(token.resolvedValue) + '</small></div>').join("");
  if (!radius && !spacing) return "";
  return '<section class="strip rhythm-strip"><header><b>Radius & spacing</b><span>shape rhythm</span></header><div class="rhythm-grid"><div class="radius-grid">' + radius + '</div><div>' + spacing + '</div></div></section>';
}

function generateComponents(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  if (board.componentGroups.length === 0) return "";
  return '<section class="strip component-strip"><header><b>Components</b><span>actual DESIGN.md groups</span></header><div class="component-grid">' +
    prioritizedComponentGroups(board).slice(0, 18).map((group) => '<article><label>' + esc(group.name) + '</label>' + componentSampleHtml(group, colors) + '</article>').join("") +
    '</div></section>';
}

function generateOverviewDeck(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const components = prioritizedComponentGroups(board).slice(0, 6);
  const colorTokens = board.colorGroups.flatMap((group) => group.tokens.map((token) => ({ ...token, group: group.prefix }))).slice(0, 8);
  const typeTokens = board.typographyTokens.slice(0, 3);

  const componentHtml = components.length > 0
    ? '<section class="overview-card overview-components"><header><b>Components</b><span>' + board.componentGroups.length + ' groups</span></header><div class="overview-component-grid">' +
      components.map((group) => '<article><label>' + esc(group.name) + '</label>' + componentSampleHtml(group, colors) + '</article>').join("") +
      '</div></section>'
    : "";

  const paletteHtml = colorTokens.length > 0
    ? '<section class="overview-card overview-palette"><header><b>Palette</b><span>' + colorTokens.length + ' shown</span></header><div class="overview-swatch-grid">' +
      colorTokens.map((token) => '<div><i style="background:' + cssColor(token.resolvedValue, "#d8d8d8") + '"></i><span>' + esc(token.key) + '</span></div>').join("") +
      '</div></section>'
    : "";

  const typeHtml = typeTokens.length > 0
    ? '<section class="overview-card overview-type"><header><b>Type</b><span>' + board.typographyTokens.length + ' tokens</span></header>' +
      typeTokens.map((token) => {
        const style = [
          "font-family:" + cssFont(token.fontFamily, "inherit"),
          "font-size:" + cssSize(token.fontSize, "16px"),
          "font-weight:" + cssText(token.fontWeight, "500"),
          "line-height:" + cssText(token.lineHeight, "1.2"),
        ].join(";");
        return '<div><small>' + esc(token.key) + '</small><span style="' + style + '">' + esc(token.key) + '</span></div>';
      }).join("") + '</section>'
    : "";

  if (!componentHtml && !paletteHtml && !typeHtml) return "";
  return '<section class="overview-deck">' + componentHtml + '<div class="overview-side">' + paletteHtml + typeHtml + '</div></section>';
}

function generateNotes(board: DesignMdBoard): string {
  const notes = board.visualLanguage.phrases.slice(0, 4);
  if (notes.length === 0) return "";
  return '<section class="strip notes-strip"><header><b>Design notes</b><span>' + esc(board.archetype) + '</span></header><ul>' +
    notes.map((note) => '<li>' + esc(note.length > 180 ? note.slice(0, 177) + "..." : note) + '</li>').join("") +
    '</ul></section>';
}

export function generateBoardHtml(board: DesignMdBoard): string {
  const colors = deriveTokens(board);
  const display = typographyCss(board, ["hero", "display-xl", "display-lg", "display"], "40px");
  const body = typographyCss(board, ["body", "text"], "15px");
  const caption = typographyCss(board, ["caption", "label", "small"], "12px");

  const css = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    "html,body{width:100%;height:100%;min-height:100%;overflow:auto}",
    "body{font-family:" + body.family + ";font-size:" + body.size + ";font-weight:" + body.weight + ";line-height:1.45;letter-spacing:" + body.letterSpacing + ";background:" + colors.canvas + ";color:" + colors.text + ";-webkit-font-smoothing:antialiased}",
    ".board{min-height:100%;background:" + colors.canvas + ";color:" + colors.text + "}",
    ".board-meta{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;border-bottom:1px solid " + colors.border + ";background:" + colors.canvas + ";position:sticky;top:0;z-index:2}",
    ".board-meta strong{font-size:13px}.board-meta span{font-size:" + caption.size + ";color:" + colors.muted + "}.keywords{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.keywords i{font-style:normal;border:1px solid " + colors.border + ";border-radius:" + colors.pill + ";padding:3px 8px;color:" + colors.muted + "}",
    ".hero{min-height:300px;padding:22px;display:flex;flex-direction:column;gap:18px}",
    ".hero h2{font-family:" + display.family + ";font-size:clamp(30px," + display.size + ",64px);font-weight:" + display.weight + ";line-height:" + display.lineHeight + ";letter-spacing:" + display.letterSpacing + "}",
    "button{font:inherit;border:0;cursor:default}.pill{display:inline-flex;align-items:center;justify-content:center;border-radius:" + colors.pill + ";padding:9px 18px;font-weight:500}.outline{border:1px solid currentColor}",
    ".muted{color:" + colors.muted + "}.badge{display:inline-flex;align-items:center;border-radius:" + colors.pill + ";background:" + colors.canvas + ";color:" + colors.text + ";box-shadow:0 0 0 1px " + colors.border + ";padding:4px 9px;font-size:" + caption.size + ";font-weight:600}",
    ".hero-market{background:" + colors.canvas + "}.market-nav{display:flex;align-items:center;gap:22px;min-height:48px}.market-nav strong{color:" + colors.primary + ";margin-right:auto}.market-search{display:grid;grid-template-columns:1fr 1fr 1fr 48px;align-items:center;max-width:900px;width:100%;margin:0 auto;padding:8px 8px 8px 26px;box-shadow:0 8px 24px rgba(0,0,0,.09);border:1px solid " + colors.border + "}.market-search span{display:flex;flex-direction:column;border-right:1px solid " + colors.border + ";padding-right:18px}.market-search small{color:" + colors.muted + "}.market-search i{display:grid;place-items:center;width:48px;height:48px;border-radius:999px;font-style:normal;font-size:22px}.listing-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.listing-card{padding:10px;display:flex;flex-direction:column;gap:8px}.photo-block{height:160px;border-radius:inherit;background:linear-gradient(135deg," + colors.surface + "," + colors.border + ");padding:10px}.p1{background:linear-gradient(135deg,#f4d9d3,#f9f6f0)}.p2{background:linear-gradient(135deg,#dfe7df,#f6eee4)}",
    ".gallery-nav{display:flex;align-items:center;gap:22px;height:44px;padding:0 18px}.gallery-nav span:first-child{margin-right:auto}.gallery-nav button{border-radius:" + colors.pill + ";padding:5px 12px}.product-tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;flex:1}.product-tile{min-height:300px;display:flex;flex-direction:column;align-items:center;text-align:center;justify-content:flex-start;gap:12px;padding:34px 22px}.device-shape{width:min(260px,70%);height:112px;margin-top:auto;border-radius:28px;background:linear-gradient(145deg,#d8d8dc,#ffffff);box-shadow:3px 5px 30px rgba(0,0,0,.18)}.device-shape.dark{background:linear-gradient(145deg,#111,#555)}",
    ".hero-finance{padding:0}.finance-nav{height:62px;display:flex;align-items:center;gap:22px;padding:0 22px}.finance-nav strong{color:" + colors.primary + ";margin-right:auto}.finance-nav button{padding:10px 18px}.finance-grid{display:grid;grid-template-columns:1.2fr 1.6fr .7fr;gap:16px;padding:24px}.balance-card,.market-table{padding:24px}.balance-card h2{color:" + colors.primary + ";font-size:42px;margin:10px 0 24px}.balance-card button{padding:12px 20px}.market-table{display:flex;flex-direction:column;gap:14px}.market-table div{display:flex;justify-content:space-between;border-top:1px solid " + colors.border + ";padding-top:12px}.action-stack{display:flex;flex-direction:column;gap:10px}.action-stack button{padding:14px 18px;border-radius:" + colors.radius + ";background:" + colors.darkSurface + ";color:" + colors.onDark + "}",
    ".hero-docs{display:grid;grid-template-columns:220px 1fr;background:" + colors.surface + "}.hero-docs aside{display:flex;flex-direction:column;gap:12px;border-right:1px solid " + colors.border + ";padding:22px}.hero-docs main{display:grid;grid-template-columns:.9fr 1.1fr;gap:20px;padding:34px}.docs-copy{max-width:560px}.docs-copy p{color:" + colors.muted + ";margin:12px 0 18px}.hero-docs pre{padding:18px;border-radius:" + colors.radius + ";background:" + colors.darkCanvas + ";color:" + colors.onDark + ";white-space:pre-wrap}.hero-docs button{padding:11px 18px}.docs-panels{display:grid;gap:12px}.docs-panels article{display:grid;gap:8px;padding:18px;border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";background:" + colors.canvas + "}",
    ".hero-collab{display:grid;grid-template-columns:.9fr 1.1fr;gap:22px;align-items:center;background:radial-gradient(circle at 75% 20%," + colors.surface + ",transparent 32%),linear-gradient(135deg," + colors.canvas + "," + colors.surface + ")}.collab-kicker{display:inline-flex;color:" + colors.primary + ";font-size:" + caption.size + ";font-weight:700;text-transform:uppercase;letter-spacing:.08em}.collab-copy p{color:" + colors.muted + ";margin:14px 0 20px;max-width:620px}.collab-actions{display:flex;gap:10px;flex-wrap:wrap}.collab-actions button,.collab-actions span{display:inline-flex;align-items:center;padding:12px 18px;border:1px solid currentColor}.collab-mesh{padding:22px;border-radius:" + colors.radius + ";background:linear-gradient(135deg,rgba(255,255,255,.65),rgba(255,255,255,.2));box-shadow:0 18px 50px rgba(0,0,0,.12)}.collab-input{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;margin-bottom:14px;border:1px solid " + colors.border + "}.collab-input i{width:12px;height:12px;border-radius:50%;background:" + colors.primary + "}.collab-cards{display:grid;grid-template-columns:1fr 1fr;gap:12px}.collab-cards article:first-child{grid-column:span 2}.collab-cards article{padding:18px;min-height:96px;display:flex;flex-direction:column;justify-content:space-between}.collab-cards span{opacity:.72}",
    ".hero-auto{padding:0}.auto-band{min-height:300px;display:grid;grid-template-columns:1fr 1.1fr;align-items:center;padding:42px}.auto-band small{letter-spacing:.12em;text-transform:uppercase}.auto-band button{margin-top:20px;padding:14px 28px}.vehicle-silhouette{height:150px;border-radius:4px;background:linear-gradient(180deg,transparent 35%,rgba(255,255,255,.18) 36% 62%,transparent 63%),linear-gradient(90deg,transparent 5%,rgba(255,255,255,.9) 18% 82%,transparent 95%)}.auto-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:" + colors.border + "}.auto-grid article{padding:24px;min-height:150px;display:flex;flex-direction:column;gap:8px}.auto-grid span{font-size:" + caption.size + ";letter-spacing:.08em;text-transform:uppercase;color:" + colors.muted + "}.vehicle-mini{height:64px;background:" + colors.surface + ";margin-bottom:10px}",
    ".hero-data{display:grid;grid-template-columns:220px 1fr;background:" + colors.darkCanvas + ";color:" + colors.onDark + "}.data-sidebar{display:flex;flex-direction:column;gap:14px;border-right:1px solid " + colors.darkSurface + ";padding:22px}.data-main{display:grid;grid-template-columns:1.3fr .8fr;gap:16px;padding:24px}.chart-card,.data-table{background:" + colors.darkSurface + ";border-radius:" + colors.radius + ";padding:22px}.bars{display:flex;align-items:end;gap:10px;height:160px;margin-top:28px}.bars i{flex:1;background:" + colors.primary + ";border-radius:4px 4px 0 0}.bars i:nth-child(1){height:32%}.bars i:nth-child(2){height:68%}.bars i:nth-child(3){height:48%}.bars i:nth-child(4){height:86%}.bars i:nth-child(5){height:58%}.data-table div{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid " + colors.border + "}",
    ".hero-generic{display:grid;grid-template-columns:.9fr 1.1fr;align-items:center;background:" + colors.surface + "}.hero-generic p{color:" + colors.muted + ";max-width:560px;margin-top:12px}.generic-board{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
    ".overview-deck{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);gap:14px;padding:16px 20px 20px;border-top:1px solid " + colors.border + ";background:" + colors.canvas + "}.overview-card{border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";background:" + colors.canvas + ";padding:12px;overflow:hidden}.overview-card header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.overview-card header span{font-size:" + caption.size + ";color:" + colors.muted + "}.overview-side{display:grid;gap:14px}.overview-component-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.overview-component-grid article{min-height:94px}.overview-component-grid label{display:block;color:" + colors.muted + ";font-size:10px;margin-bottom:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.overview-swatch-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.overview-swatch-grid i{display:block;height:28px;border-radius:7px;border:1px solid rgba(0,0,0,.08)}.overview-swatch-grid span{display:block;margin-top:5px;color:" + colors.muted + ";font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.overview-type{display:grid;gap:8px}.overview-type small{display:block;color:" + colors.muted + ";font-size:10px}.overview-type span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".strip{padding:20px;border-top:1px solid " + colors.border + "}.strip header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}.strip header span{font-size:" + caption.size + ";color:" + colors.muted + "}.palette-grid{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px}.swatch{min-height:84px;border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:8px;background:" + colors.canvas + ";overflow:hidden}.swatch i{display:block;height:32px;border-radius:6px;margin-bottom:8px;border:1px solid rgba(0,0,0,.08)}.swatch b,.swatch small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.swatch small{color:" + colors.muted + ";font-size:10px}.more{display:grid;place-items:center}",
    ".type-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.type-row{border-bottom:1px solid " + colors.border + ";padding:8px 0}.type-row small{display:block;color:" + colors.muted + ";margin-bottom:4px}.component-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.component-grid article{border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:10px;min-height:112px;overflow:hidden}.component-grid label{display:block;color:" + colors.muted + ";font-size:11px;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sample{max-width:100%}.sample-button{border:1px solid transparent}.sample-input{display:flex;justify-content:space-between;align-items:center;border:1px solid " + colors.border + ";padding:12px}.sample-input i{width:14px;height:14px;border-radius:50%;background:" + colors.primary + "}.sample-chip{display:inline-flex;padding:7px 12px}.sample-nav{display:flex;gap:12px;padding:11px}.sample-card{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid " + colors.border + "}.sample-stat{display:grid;gap:5px;padding:14px;border:1px solid " + colors.border + "}.sample-stat b{font-size:28px}.sample-gradient{min-height:92px;padding:16px;display:flex;flex-direction:column;justify-content:space-between}.sample-mockup{display:grid;gap:7px;padding:13px}.sample-mockup code{display:block;padding:7px;border-radius:6px;background:rgba(0,0,0,.22);color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sample-mockup span{height:8px;border-radius:99px;background:rgba(127,127,127,.28)}.sample-table{display:flex;flex-direction:column;gap:7px;padding:12px;border:1px solid " + colors.border + "}.sample-table span{display:flex;justify-content:space-between;gap:12px;border-top:1px solid rgba(127,127,127,.25);padding-top:6px}.sample-table i{font-style:normal}.sample-tile{padding:14px}.sample-tile div{height:56px;background:rgba(127,127,127,.18);margin-bottom:10px}.sample-link{text-decoration:underline}.sample-footer{padding:14px}.rhythm-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.radius-grid{display:flex;flex-wrap:wrap;gap:8px}.radius-cell{width:58px;height:58px;display:grid;place-items:center;background:" + colors.surface + ";border:1px solid " + colors.border + ";font-size:10px;color:" + colors.muted + "}.space-row{display:flex;align-items:center;gap:10px;margin:7px 0}.space-row span{width:70px}.space-row i{display:block;height:10px;background:" + colors.primary + ";border-radius:999px}.notes-strip ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px;padding-left:18px;color:" + colors.muted + "}",
    "@media(max-width:760px){.board-meta{position:static;align-items:flex-start;flex-direction:column}.overview-deck,.listing-grid,.product-tiles,.finance-grid,.auto-grid,.component-grid,.type-grid,.rhythm-grid,.hero-docs,.hero-docs main,.hero-data,.data-main,.hero-generic,.hero-collab{grid-template-columns:1fr}.overview-component-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-swatch-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.market-search{grid-template-columns:1fr;gap:8px;border-radius:" + colors.radius + "}.market-search span{border-right:0;border-bottom:1px solid " + colors.border + ";padding-bottom:8px}.palette-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.notes-strip ul{grid-template-columns:1fr}.hero{min-height:auto}.auto-band{grid-template-columns:1fr}.product-tile{min-height:260px}}",
  ].join("\n");

  const keywords = board.visualLanguage.keywords.slice(0, 5).map((keyword) => '<i>' + esc(keyword) + '</i>').join("");
  const html = [
    '<div class="board">',
    '<div class="board-meta"><div><strong>' + esc(board.title) + '</strong><span> · ' + esc(board.slug) + ' · ' + esc(board.archetype) + '</span></div><div class="keywords">' + keywords + '</div></div>',
    heroPattern(board, colors),
    generateOverviewDeck(board, colors),
    generateComponents(board, colors),
    generatePalette(board),
    generateTypography(board),
    generateRhythm(board),
    generateNotes(board),
    '</div>',
  ].join("\n");

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    CSP + '\n<style>' + css + '</style>\n</head>\n<body>\n' + html + '\n</body>\n</html>';
}
