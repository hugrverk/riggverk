import type { DesignMdSpecimen, DesignMdBoard, DesignMdBoardComponentGroup } from "./designMdSpecimenBuilder";
import { isSafeColorValue, isSafeFontFamilyValue, isSafeSizeValue, isSafeSpacingValue, isUnsafeDesignMdStyleValue, resolveGeneratedFontFamily } from "./designMdPreviewParser";

const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:;">';
type GeneratedPreviewVariant = "light" | "dark";

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

function cssFontSize(value: string | undefined, fallback: string, maxPx = 44): string {
  const safe = cssSize(value, fallback);
  const match = safe.match(/^(\d+(?:\.\d+)?)(px|rem|em|pt)?$/);
  if (!match) return safe;
  const unit = match[2] ?? "px";
  const numeric = Number.parseFloat(match[1]);
  const px = unit === "rem" || unit === "em" ? numeric * 16 : unit === "pt" ? numeric * 1.333 : numeric;
  if (px <= maxPx) return safe;
  return `${maxPx}px`;
}

function cssSpacing(value: string | undefined, fallback: string): string {
  return isSafeSpacingValue(value) ? value.trim() : fallback;
}

function boardFontContext(board: DesignMdBoard, raw: Record<string, string> = {}): string {
  return [
    board.title,
    board.description,
    board.archetype,
    board.fontSubstitutes,
    ...board.visualLanguage.phrases,
    ...board.visualLanguage.keywords,
    ...Object.values(raw),
  ].join(" ");
}

function cssPreviewFont(value: string | undefined, board: DesignMdBoard, raw: Record<string, string> = {}): string {
  const stack = resolveGeneratedFontFamily(value, boardFontContext(board, raw));
  return isSafeFontFamilyValue(stack) ? stack : '-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
}

function tokenKeyMatches(key: string, match: string): boolean {
  const normalized = key.toLowerCase();
  const normalizedMatch = match.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const compactMatch = normalizedMatch.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const keyParts = compact.split("-").filter(Boolean);
  const matchParts = compactMatch.split("-").filter(Boolean);
  const themeFor = (parts: string[]) => {
    if (parts.some((part) => /^(dark|black|inverse|night|aubergine)$/.test(part))) return "dark";
    if (parts.some((part) => /^(light|white)$/.test(part))) return "light";
    return null;
  };
  const keyedTheme = themeFor(keyParts);
  const matchTheme = themeFor(matchParts);
  const themedBase = matchParts.some((part) => /^(canvas|surface|background|card|body|text|ink|foreground)$/.test(part));
  if (keyedTheme && matchTheme && keyedTheme !== matchTheme) return false;
  if (keyedTheme && !matchTheme && themedBase && compact !== compactMatch) return false;
  if (normalized === normalizedMatch || compact === compactMatch) return true;
  return normalized.split(/[^a-z0-9]+/).includes(normalizedMatch);
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
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const groups = board.componentGroups.map((group) => ({ group, name: normalize(group.name) }));
  for (const match of matches) {
    const needle = normalize(match);
    const exact = groups.find(({ name }) => name === needle)?.group;
    if (exact) return exact;
    const prefixed = groups.find(({ name }) => name.startsWith(needle))?.group;
    if (prefixed) return prefixed;
    const partial = groups.find(({ name }) => name.includes(needle))?.group;
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
    developer_product: ["top-nav", "project", "deployment", "status", "code", "terminal", "docs", "button", "card", "nav"],
    collaboration_saas: ["hero", "mesh", "pill", "button", "input", "pricing", "feature", "card", "nav", "link"],
    editorial: ["hero", "article", "story", "quote", "card", "search", "button", "link", "nav"],
    media_editorial: ["headline", "article-card", "story-card", "media-card", "opinion", "sidebar", "search", "nav", "button", "card"],
    ai_product: ["prompt-input", "model-status", "output-panel", "agent-card", "code-panel", "stat", "button", "input", "nav", "card"],
    ai_agent_product: ["agent-graph", "tool-card", "action-card", "trace-panel", "orchestration", "prompt-input", "button", "card", "nav"],
    creative_tool: ["canvas", "editor", "component-panel", "property-panel", "toolbar", "frame", "button", "input", "card", "nav"],
    payment_finance: ["payment-card", "transaction-row", "spend-summary", "brand-strip", "card", "button", "stat", "badge", "nav"],
    retail_food: ["menu-card", "product-card", "store-card", "campaign", "loyalty-chip", "order-button", "button", "card", "nav"],
    retail_brand: ["hero", "product-card", "campaign", "badge", "store-card", "pricing", "button", "nav", "card"],
    telecom_service: ["plan-card", "coverage-module", "device-tile", "service-card", "brand-cta", "button", "card", "nav"],
    automation_workflow: ["workflow-step", "app-card", "step-badge", "pipeline", "trigger", "action", "button", "card", "nav"],
    music_campaign: ["campaign-tile", "playlist-card", "album-card", "hero", "now-playing", "search", "button", "card", "nav"],
    terminal_tool: ["terminal-panel", "code-panel", "command-palette", "split-pane", "command-chip", "button", "input", "nav"],
    generic_system: ["nav", "button", "card", "tile", "input", "chip", "link"],
  };
  const rank = (group: DesignMdBoardComponentGroup) => {
    const name = group.name.toLowerCase();
    const index = priorities[board.archetype].findIndex((needle) => name.includes(needle));
    return index === -1 ? 100 : index;
  };
  return [...board.componentGroups].sort((a, b) => rank(a) - rank(b));
}

function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  const hex = value.trim();
  if (!/^#[0-9a-fA-F]{3,8}$/.test(hex)) return null;
  const raw = hex.slice(1);
  const full = raw.length === 3 || raw.length === 4
    ? raw.slice(0, 3).split("").map((c) => c + c).join("")
    : raw.slice(0, 6);
  const int = Number.parseInt(full, 16);
  if (Number.isNaN(int)) return null;
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function colorLuma(value: string): number | null {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("");
}

function mixHexColor(a: string, b: string, amount: number): string | null {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return null;
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex(
    ca.r + (cb.r - ca.r) * t,
    ca.g + (cb.g - ca.g) * t,
    ca.b + (cb.b - ca.b) * t,
  );
}

function relativeLuminance(value: string): number | null {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrastRatio(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function readableTextColor(bg: string, light = "#f8fafc", dark = "#111111"): string {
  const lightContrast = contrastRatio(bg, light) ?? 0;
  const darkContrast = contrastRatio(bg, dark) ?? 0;
  return lightContrast >= darkContrast ? light : dark;
}

function ensureReadable(fg: string, bg: string, fallback?: string): string {
  const ratio = contrastRatio(fg, bg);
  if (ratio === null || ratio >= 4.5) return fg;
  return fallback ?? readableTextColor(bg);
}

function darkestPaletteColor(tokens: { resolvedValue: string }[], fallback: string): string {
  const sorted = tokens
    .map((token) => token.resolvedValue)
    .filter(isSafeColorValue)
    .map((value) => ({ value: value.trim(), luma: colorLuma(value.trim()) }))
    .filter((item): item is { value: string; luma: number } => item.luma !== null)
    .sort((a, b) => a.luma - b.luma);
  return sorted[0]?.value ?? fallback;
}

function lightestPaletteColor(tokens: { resolvedValue: string }[], fallback: string): string {
  const sorted = tokens
    .map((token) => token.resolvedValue)
    .filter(isSafeColorValue)
    .map((value) => ({ value: value.trim(), luma: colorLuma(value.trim()) }))
    .filter((item): item is { value: string; luma: number } => item.luma !== null)
    .sort((a, b) => b.luma - a.luma);
  return sorted[0]?.value ?? fallback;
}

function isLightColor(value: string | undefined): boolean {
  const luma = value ? colorLuma(value) : null;
  return luma !== null && luma > 0.72;
}

function isDarkColor(value: string | undefined): boolean {
  const luma = value ? colorLuma(value) : null;
  return luma !== null && luma < 0.36;
}

function componentIsDarkSpecific(group: DesignMdBoardComponentGroup | undefined): boolean {
  return !!group && /dark|black|aubergine|on-dark|on-black|inverse|night/i.test(group.name);
}

function componentColors(
  group: DesignMdBoardComponentGroup | undefined,
  bg: string,
  fg: string,
  colors?: ReturnType<typeof deriveTokens>,
) {
  const variant = colors?.variant ?? "light";
  let resolvedBg = cssColor(group?.backgroundColor, bg);
  let resolvedFg = cssColor(group?.textColor, fg);

  if (variant === "dark") {
    const canUseComponentBg = componentIsDarkSpecific(group) || isDarkColor(resolvedBg);
    if (!canUseComponentBg || isLightColor(resolvedBg)) {
      resolvedBg = bg;
    }
    if (!group?.textColor || (isDarkColor(resolvedFg) && isDarkColor(resolvedBg))) {
      resolvedFg = fg;
    }
  }

  resolvedFg = ensureReadable(resolvedFg, resolvedBg, readableTextColor(resolvedBg));

  return {
    bg: resolvedBg,
    fg: resolvedFg,
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
    fontSubstitutes: "",
    coverage: {
      colorsCount: 6,
      markdownColorsCount: 0,
      typographyCount: 0,
      radiusCount: 4,
      spacingCount: 3,
      componentCount: 0,
      componentKinds: {},
      fontFamilies: [],
      markdownSections: [],
      darkTokenCount: 0,
      darkComponentCount: 0,
    },
    confidence: {
      archetype: "low",
      lightPreview: "medium",
      darkPreview: "low",
      components: "low",
    },
    warnings: ["generic archetype fallback", "dark tokens derived"],
  }, { variant: "light" });
}

function typographyCss(board: DesignMdBoard, matches: string[], fallbackSize: string) {
  const token = board.typographyTokens.find((t) => matches.some((match) => t.key.toLowerCase().includes(match))) ?? board.typographyTokens[0];
  return {
    family: cssPreviewFont(token?.fontFamily, board, token?.raw),
    size: cssFontSize(token?.fontSize, fallbackSize, 44),
    weight: cssText(token?.fontWeight, "600"),
    lineHeight: cssText(token?.lineHeight, "1.15"),
    letterSpacing: "0",
  };
}

function archetypeLabel(board: DesignMdBoard): string {
  const labels: Record<DesignMdBoard["archetype"], string> = {
    marketplace: "Marketplace",
    product_gallery: "Product Gallery",
    finance_dashboard: "Finance Dashboard",
    editorial: "Editorial",
    media_editorial: "Media Editorial",
    collaboration_saas: "Collaboration",
    developer_docs: "Developer Docs",
    developer_product: "Developer Product",
    luxury_automotive: "Automotive",
    data_product: "Data Product",
    ai_product: "AI Product",
    ai_agent_product: "Agent Product",
    creative_tool: "Creative Tool",
    payment_finance: "Payment Finance",
    retail_food: "Retail Food",
    retail_brand: "Retail Brand",
    telecom_service: "Telecom Service",
    automation_workflow: "Automation",
    music_campaign: "Music Campaign",
    terminal_tool: "Terminal Tool",
    generic_system: "Design System",
  };
  return labels[board.archetype];
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
    case "developer_product":
      return developerProductHero(board, colors);
    case "collaboration_saas":
      return collaborationHero(board, colors);
    case "luxury_automotive":
      return automotiveHero(board, colors);
    case "data_product":
      return dataHero(board, colors);
    case "editorial":
      return editorialHero(board, colors);
    case "media_editorial":
      return mediaEditorialHero(board, colors);
    case "ai_product":
      return aiProductHero(board, colors);
    case "ai_agent_product":
      return aiAgentProductHero(board, colors);
    case "creative_tool":
      return creativeToolHero(board, colors);
    case "payment_finance":
      return paymentFinanceHero(board, colors);
    case "retail_food":
      return retailFoodHero(board, colors);
    case "retail_brand":
      return retailBrandHero(board, colors);
    case "telecom_service":
      return telecomServiceHero(board, colors);
    case "automation_workflow":
      return automationWorkflowHero(board, colors);
    case "music_campaign":
      return musicCampaignHero(board, colors);
    case "terminal_tool":
      return terminalToolHero(board, colors);
    default:
      return genericHero(board, colors);
  }
}

function marketplaceHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const searchGroup = component(board, colors.variant === "dark" ? ["search-dark", "search-bar-dark", "search-bar", "search"] : ["search-bar", "search"]);
  const cardGroups = ["property-card-dark", "listing-card-dark", "property-card", "experience-card", "rating-display-card"].map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const search = componentColors(searchGroup, colors.surface, colors.text, colors);
  const card = componentColors(cardGroups[0] ?? component(board, ["card-dark", "card"]), colors.surface, colors.text, colors);
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
  const light = componentColors(lightGroup, colors.variant === "dark" ? colors.surface : colors.canvas, colors.text, colors);
  const dark = componentColors(darkGroup, colors.darkSurface, colors.onDark, colors);
  const button = componentColors(buttonGroup, colors.primary, colors.onPrimary, colors);
  return '<section class="hero hero-gallery">' +
    '<div class="gallery-nav" style="background:' + colors.darkSurface + ';color:' + colors.onDark + '"><span>' + esc(board.title) + '</span><span>Store</span><span>Mac</span><span>iPhone</span><button style="background:' + button.bg + ';color:' + button.fg + '">' + esc(buttonGroup?.name ?? "Buy") + '</button></div>' +
    '<div class="product-tiles">' +
    '<article class="product-tile product-tile-light" style="background:' + light.bg + ';color:' + light.fg + ';border-radius:' + light.radius + '"><h2>' + esc(lightGroup?.name ?? "product tile") + '</h2><p>Photography-first sparse surface</p><div class="device-shape"></div><span class="pill" style="background:' + button.bg + ';color:' + button.fg + '">' + esc(buttonGroup?.name ?? "CTA") + '</span></article>' +
    '<article class="product-tile product-tile-dark" style="background:' + dark.bg + ';color:' + dark.fg + ';border-radius:' + dark.radius + '"><h2>' + esc(darkGroup?.name ?? "dark product tile") + '</h2><p>Alternating dark gallery block</p><div class="device-shape dark"></div><span class="pill outline">' + esc(component(board, ["text-link-on-dark", "text-link"])?.name ?? "text link") + '</span></article>' +
    '</div></section>';
}

function financeHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const financeBg = colors.variant === "dark" ? colors.darkCanvas : colors.canvas;
  const financeFg = colors.variant === "dark" ? colors.onDark : colors.text;
  const financePanel = colors.variant === "dark" ? colors.darkSurface : colors.surface;
  const nav = componentColors(component(board, colors.variant === "dark" ? ["top-nav-dark", "top-nav-on-dark", "top-nav"] : ["top-nav", "top-nav-light", "nav"]), financeBg, financeFg, colors);
  const tableGroup = component(board, ["markets-table-card", "asset-row", "price", "balance", "product-ui-card"]);
  const card = componentColors(tableGroup ?? component(board, colors.variant === "dark" ? ["card-dark", "panel-dark", "card", "panel"] : ["card", "panel", "stat"]), financePanel, financeFg, colors);
  const actionGroup = component(board, ["button-primary", "button-primary-pill"]);
  const action = componentColors(actionGroup, colors.primary, colors.onPrimary, colors);
  return '<section class="hero hero-finance" style="background:' + financeBg + ';color:' + financeFg + '">' +
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
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  return '<section class="hero hero-docs"><aside><b>' + esc(board.title) + '</b><span>Overview</span><span>API</span><span>Components</span><span>Changelog</span></aside><main><div class="docs-copy"><h2>' + esc(board.title) + ' system</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Read docs") + '</button></div><div class="docs-panels"><pre>' + esc(code?.name ?? "terminal") + '\n$ npm install design-system\n✓ local preview ready</pre><article><b>' + esc(feature?.name ?? "feature panel") + '</b><span>API surface</span><span>Status: stable</span></article></div></main></section>';
}

function collaborationHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const primary = component(board, ["button-primary-pill", "button-primary", "pill"]);
  const input = component(board, ["text-input", "search-input", "input"]);
  const cards = (colors.variant === "dark" ? ["card-pricing-dark", "card-dark", "card-pricing-featured", "card-stat"] : ["card-pricing-featured", "card-feature-cream", "card-stat", "card-pricing"]).map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const button = componentColors(primary, colors.primary, colors.onPrimary, colors);
  const inputStyle = componentColors(input, colors.surface, colors.text, colors);
  const card = componentColors(cards[0] ?? component(board, ["card"]), colors.surface, colors.text, colors);
  return '<section class="hero hero-collab" style="background:radial-gradient(circle at 75% 20%,' + colors.surface + ',transparent 34%),linear-gradient(135deg,' + colors.canvas + ',' + colors.surface + ')"><div class="collab-copy"><span class="collab-kicker">Team workspace</span><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><div class="collab-actions"><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(primary?.name ?? "button-primary-pill") + '</button><span style="border-color:' + button.bg + ';color:' + button.bg + '">' + esc(component(board, ["button-secondary", "button-outline"])?.name ?? "outline button") + '</span></div></div><div class="collab-mesh"><div class="collab-input" style="background:' + inputStyle.bg + ';color:' + inputStyle.fg + ';border-radius:' + inputStyle.radius + '"><span>' + esc(input?.name ?? "text-input") + '</span><i></i></div><div class="collab-cards">' +
    [0, 1, 2].map((i) => '<article style="background:' + (i === 0 ? button.bg : card.bg) + ';color:' + (i === 0 ? button.fg : card.fg) + ';border-radius:' + card.radius + '"><b>' + esc(cards[i]?.name ?? ["card-pricing-featured", "card-feature", "card-stat"][i]) + '</b><span>' + ["Channels", "Automations", "Messages"][i] + '</span></article>').join("") +
    '</div></div></section>';
}

function automotiveHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const hero = componentColors(component(board, ["hero-band-dark", "hero-band", "photo-band"]), colors.darkSurface, colors.onDark, colors);
  const cardGroups = ["model-card", "feature-photo-card", "inventory-card"].map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const card = componentColors(cardGroups[0] ?? component(board, ["card"]), colors.surface, colors.text, colors);
  return '<section class="hero hero-auto"><div class="auto-band" style="background:' + hero.bg + ';color:' + hero.fg + '"><div><small>Corporate automotive</small><h2>' + esc(board.title) + '</h2><button style="background:' + colors.primary + ';color:' + colors.onPrimary + ';border-radius:' + hero.radius + '">Explore models</button></div><div class="vehicle-silhouette"></div></div><div class="auto-grid">' +
    [0, 1, 2].map((i) => '<article style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + card.radius + '"><div class="vehicle-mini"></div><b>' + esc(cardGroups[i]?.name ?? ["model card", "feature photo card", "inventory card"][i]) + '</b><span>Learn more</span></article>').join("") +
    '</div></section>';
}

function dataHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const groups = prioritizedComponentGroups(board);
  const chart = groups.find((group) => /chart|stat|code|mockup|card/i.test(group.name));
  const table = groups.find((group) => /table|row|query|pricing/i.test(group.name));
  const dataBg = colors.variant === "dark" ? colors.darkCanvas : colors.canvas;
  const dataPanel = colors.variant === "dark" ? colors.darkSurface : colors.surface;
  const dataFg = colors.variant === "dark" ? colors.onDark : colors.text;
  return '<section class="hero hero-data" style="background:' + dataBg + ';color:' + dataFg + '"><div class="data-sidebar"><b>' + esc(board.title) + '</b><span>Queries</span><span>Metrics</span><span>Events</span></div><div class="data-main"><div class="chart-card" style="background:' + dataPanel + ';color:' + dataFg + '"><h2>' + esc(chart?.name ?? "data panel") + '</h2><div class="bars"><i></i><i></i><i></i><i></i><i></i></div></div><div class="data-table" style="background:' + dataPanel + ';color:' + dataFg + '"><b>' + esc(table?.name ?? "metric table") + '</b>' +
    ["Latency", "Queries", "Errors"].map((label, i) => '<div><span>' + label + '</span><strong style="color:' + (i === 2 ? colors.down : colors.primary) + '">' + ["18ms", "1.2M", "0.01%"][i] + '</strong></div>').join("") +
    '</div></div></section>';
}

function editorialHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const groups = prioritizedComponentGroups(board);
  const campaign = component(board, ["campaign-tile", "hero", "album", "playlist", "product-card", "card"]);
  const cta = component(board, ["button-primary", "pill-button", "button-primary-pill", "button"]);
  const search = component(board, ["search-pill", "search-input", "search"]);
  const card = componentColors(campaign, colors.surface, colors.text, colors);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  const secondary = componentColors(search, colors.surface, colors.text, colors);
  const headline = board.visualLanguage.keywords.includes("music") ? "Featured rotation" : "Campaign system";
  return '<section class="hero hero-editorial"><div class="editorial-copy"><span>' + esc(headline) + '</span><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><div><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "primary button") + '</button><button style="background:' + secondary.bg + ';color:' + secondary.fg + ';border-radius:' + secondary.radius + '">' + esc(search?.name ?? "search") + '</button></div></div><div class="campaign-grid">' +
    [0, 1, 2].map((i) => '<article style="background:' + (i === 0 ? card.bg : colors.surface) + ';color:' + (i === 0 ? card.fg : colors.text) + ';border-radius:' + card.radius + '"><div class="campaign-art c' + i + '"></div><b>' + esc(groups[i]?.name ?? ["campaign tile", "product card", "playlist card"][i]) + '</b><span>' + ["Hero", "Collection", "Signal"][i] + '</span></article>').join("") +
    '</div></section>';
}

function genericHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  return '<section class="hero hero-generic"><div><small>' + esc(board.archetype) + '</small><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p></div><div class="generic-board">' +
    board.componentGroups.slice(0, 4).map((group) => componentSampleHtml(group, colors)).join("") +
    '</div></section>';
}

function aiProductHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const promptGroup = component(board, ["prompt-input", "ai-input", "model-input", "search-input", "input"]);
  const outputGroup = component(board, ["output-panel", "generated-panel", "code-panel", "result-panel", "card"]);
  const modelGroup = component(board, ["model-status-card", "model-card", "agent-card", "stat-card", "card"]);
  const cta = component(board, ["button-primary", "button", "pill"]);
  const promptStyle = componentColors(promptGroup, colors.surface, colors.text, colors);
  const outputStyle = componentColors(outputGroup, colors.variant === "dark" ? colors.darkSurface : colors.canvas, colors.variant === "dark" ? colors.onDark : colors.text, colors);
  const modelStyle = componentColors(modelGroup, colors.surface, colors.text, colors);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  const modelNames = board.componentGroups.filter((g) => /model|agent|status/i.test(g.name)).slice(0, 3);
  return '<section class="hero hero-ai"><div class="ai-header"><div><span class="ai-kicker">AI Product</span><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p></div><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Generate") + '</button></div>' +
    '<div class="ai-interface"><div class="ai-prompt" style="background:' + promptStyle.bg + ';color:' + promptStyle.fg + ';border-radius:' + promptStyle.radius + '"><div class="ai-prompt-label">' + esc(promptGroup?.name ?? "Prompt") + '</div><div class="ai-prompt-bar">Describe what you want to create...</div></div>' +
    '<div class="ai-outputs">' +
    '<div class="ai-output-panel" style="background:' + outputStyle.bg + ';color:' + outputStyle.fg + ';border-radius:' + colors.radius + '"><div class="ai-output-placeholder">' + esc(outputGroup?.name ?? "Output Panel") + '</div><code>const result = await generate(input);</code></div>' +
    '<div class="ai-model-cards">' +
    (modelNames.length > 0
      ? modelNames.map((group) => {
          const ms = componentColors(group, colors.surface, colors.text, colors);
          const active = board.componentGroups.indexOf(group) === 0;
          return '<article class="ai-model-card" style="background:' + (active ? colors.primary : ms.bg) + ';color:' + (active ? colors.onPrimary : ms.fg) + ';border-radius:' + colors.radius + '"><b>' + esc(group.name) + '</b><span>' + (active ? 'Active' : 'Available') + '</span></article>';
        }).join("")
      : '<article class="ai-model-card" style="background:' + modelStyle.bg + ';color:' + modelStyle.fg + ';border-radius:' + colors.radius + '"><b>' + esc(modelGroup?.name ?? "Model Status") + '</b><span>Ready</span></article>') +
    '</div></div></div></section>';
}

function creativeToolHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const canvasGroup = component(board, ["canvas", "editor", "workspace", "design-surface"]);
  const panelGroups = ["component-panel", "property-panel", "toolbar", "inspector-panel"].map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const frameGroup = component(board, ["frame", "artboard", "page"]);
  const cta = component(board, ["button-primary", "button"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  const canvasStyle = componentColors(canvasGroup ?? component(board, ["card"]), colors.canvas, colors.text, colors);
  return '<section class="hero hero-creative"><div class="creative-toolbar" style="background:' + colors.surface + ';color:' + colors.text + '"><b>' + esc(board.title) + '</b><span>' + esc(component(board, ["toolbar", "tools"])?.name ?? "Toolbar") + '</span><button style="background:' + button.bg + ';color:' + button.fg + '">' + esc(cta?.name ?? "Publish") + '</button></div>' +
    '<div class="creative-workspace"><div class="creative-sidebar" style="background:' + colors.surface + ';color:' + colors.muted + '"><b>Layers</b>' +
    panelGroups.map((group) => '<span style="color:' + colors.text + '">' + esc(group.name) + '</span>').join("") +
    '</div><div class="creative-canvas" style="background:' + canvasStyle.bg + ';color:' + canvasStyle.fg + ';border-radius:' + colors.radius + '"><div class="creative-frame" style="border:1px dashed ' + colors.border + '">' + esc(frameGroup?.name ?? "Canvas frame") + '</div></div><div class="creative-inspector" style="background:' + colors.surface + '">' +
    (panelGroups.length > 0
      ? panelGroups.map((group) => '<div><small style="color:' + colors.muted + '">Property</small><span style="color:' + colors.text + '">' + esc(group.name) + '</span></div>').join("")
      : '<div><small style="color:' + colors.muted + '">Inspector</small><span style="color:' + colors.text + '">Select an element</span></div>') +
    '</div></div></section>';
}

function paymentFinanceHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const cardGroup = component(board, ["payment-card", "credit-card", "card", "card-dark"]);
  const rowGroups = ["transaction-row", "spend-row", "statement-row", "balance-row"].map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const cta = component(board, ["button-primary", "button", "pill"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  const cardStyle = componentColors(cardGroup, colors.variant === "dark" ? colors.darkSurface : colors.surface, colors.variant === "dark" ? colors.onDark : colors.text, colors);
  return '<section class="hero hero-payment"><div class="payment-brand" style="background:linear-gradient(135deg,' + colors.primary + ',' + mixHexColor(colors.primary, colors.darkSurface, 0.3) + ');color:' + colors.onPrimary + '"><div><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p></div><button style="background:' + colors.onPrimary + ';color:' + colors.primary + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Get Started") + '</button></div>' +
    '<div class="payment-grid"><article class="payment-card" style="background:linear-gradient(135deg,' + colors.darkSurface + ',' + colors.primary + ');color:' + colors.onDark + ';border-radius:' + colors.radius + '"><small>' + esc(board.title) + '</small><b>•••• •••• •••• 4242</b><div><span>' + esc(cardGroup?.name ?? "Payment Card") + '</span><span>12/28</span></div></article>' +
    '<div class="payment-transactions" style="background:' + cardStyle.bg + ';color:' + cardStyle.fg + ';border-radius:' + colors.radius + '"><b>Recent</b>' +
    (rowGroups.length > 0
      ? rowGroups.map((group, i) => '<div class="payment-row"><span>' + esc(group.name) + '</span><strong>' + ["$42.50", "$128.00", "$9.99"][i] + '</strong></div>').join("")
      : ['<div class="payment-row"><span>Coffee Shop</span><strong>$4.50</strong></div>', '<div class="payment-row"><span>Subscription</span><strong>$12.99</strong></div>', '<div class="payment-row"><span>Transfer</span><strong>$250.00</strong></div>'].join("")) +
    '</div></div></section>';
}

function musicCampaignHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const isDark = colors.variant === "dark";
  const campaignBg = isDark ? colors.darkCanvas : colors.canvas;
  const tileBg = isDark ? colors.darkSurface : colors.surface;
  const tileFg = isDark ? colors.onDark : colors.text;
  const campaignGroups = ["campaign-tile", "hero-band", "playlist-card", "album-card", "card"].map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const card = componentColors(campaignGroups[0] ?? component(board, ["card"]), tileBg, tileFg, colors);
  const cta = component(board, ["button-primary", "pill-button", "button"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  const musicKeywords = board.visualLanguage.keywords.filter((k) => /music|playlist|album|track|audio|sound|player/.test(k)).slice(0, 2);
  return '<section class="hero hero-music" style="background:' + campaignBg + '"><div class="music-copy"><span class="music-kicker">' + esc(musicKeywords[0] ?? archetypeLabel(board)) + '</span><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Listen Now") + '</button></div>' +
    '<div class="music-grid">' +
    [0, 1, 2].map((i) => {
      const tileColors = i === 0 ? { bg: colors.primary, fg: colors.onPrimary } : card;
      return '<article class="music-tile" style="background:' + tileColors.bg + ';color:' + tileColors.fg + ';border-radius:' + colors.radius + '"><div class="music-art m' + i + '"></div><b>' + esc(campaignGroups[i]?.name ?? ["Campaign Tile", "Playlist", "Album"][i]) + '</b><span>' + (i === 0 ? 'Featured' : 'New release') + '</span></article>';
    }).join("") +
    '</div></section>';
}

function terminalToolHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const terminalBg = colors.variant === "dark" ? "#0a0a0a" : colors.darkCanvas;
  const terminalFg = colors.onDark;
  const terminalGroup = component(board, ["terminal-panel", "terminal", "command-palette", "code-panel"]);
  const chipGroup = component(board, ["command-chip", "chip", "badge"]);
  const chipStyle = componentColors(chipGroup, colors.surface, colors.text, colors);
  return '<section class="hero hero-terminal"><div class="terminal-header" style="background:' + colors.surface + ';color:' + colors.text + '"><b>' + esc(board.title) + '</b><span>' + esc(board.visualLanguage.keywords[0] ?? "Terminal") + '</span></div>' +
    '<div class="terminal-body" style="background:' + terminalBg + ';color:' + terminalFg + '"><div class="terminal-prompt"><span class="terminal-prefix">❯</span><span>' + esc(terminalGroup?.name ?? "terminal") + '</span></div>' +
    '<div class="terminal-output"><pre>status:  ready\nversion: 2.4.1\nmode:    ' + esc(board.archetype) + '</pre></div>' +
    '<div class="terminal-chips">' +
    [0, 1, 2].map((i) => '<span style="background:' + chipStyle.bg + ';color:' + chipStyle.fg + ';border-color:' + chipStyle.border + '">' + esc(["⌘K", "⌘P", "⌘⇧P"][i]) + '</span>').join("") +
    '</div></div></section>';
}

function mediaEditorialHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const isDark = colors.variant === "dark";
  const edBg = isDark ? colors.darkCanvas : colors.canvas;
  const edSurface = isDark ? colors.darkSurface : colors.surface;
  const edFg = isDark ? colors.onDark : colors.text;
  const headlineGroup = component(board, ["headline", "hero", "article-card", "card"]);
  const card = componentColors(headlineGroup ?? component(board, ["card"]), edSurface, edFg, colors);
  return '<section class="hero hero-editorial" style="background:' + edBg + '"><div class="editorial-copy"><span class="editorial-kicker">' + esc(archetypeLabel(board)) + '</span><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p></div>' +
    '<div class="campaign-grid">' +
    '<article class="editorial-lead" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + colors.radius + '"><div class="editorial-img e0"></div><b>' + esc(board.componentGroups[0]?.name ?? "Lead Story") + '</b><span class="muted">By Author · 8 min read</span></article>' +
    [1, 2].map((i) => '<article style="background:' + edSurface + ';color:' + edFg + ';border-radius:' + colors.radius + '"><b>' + esc(board.componentGroups[i]?.name ?? ["Opinion", "Latest"][i - 1]) + '</b><span class="muted">By Author · ' + [5, 3][i - 1] + ' min read</span></article>').join("") +
    '</div></section>';
}

function retailFoodHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const isDark = colors.variant === "dark";
  const foodBg = isDark ? colors.darkCanvas : colors.canvas;
  const foodSurface = isDark ? colors.darkSurface : colors.surface;
  const foodFg = isDark ? colors.onDark : colors.text;
  const cardGroups = ["menu-card", "product-card", "store-card", "card"].map((name) => component(board, [name])).filter(Boolean) as DesignMdBoardComponentGroup[];
  const card = componentColors(cardGroups[0] ?? component(board, ["card"]), foodSurface, foodFg, colors);
  const cta = component(board, ["button-primary", "order-button", "button"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  return '<section class="hero hero-music" style="background:' + foodBg + '"><div class="music-copy"><span class="music-kicker">' + esc(archetypeLabel(board)) + '</span><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Order Now") + '</button></div>' +
    '<div class="music-grid">' +
    [0, 1, 2].map((i) => {
      const tileColors = i === 0 ? { bg: colors.primary, fg: colors.onPrimary } : card;
      return '<article class="music-tile" style="background:' + tileColors.bg + ';color:' + tileColors.fg + ';border-radius:' + colors.radius + '"><div class="music-art m' + i + '"></div><b>' + esc(cardGroups[i]?.name ?? ["Menu Item", "Beverage", "Food"][i]) + '</b><span>' + (i === 0 ? 'Featured' : 'Popular') + '</span></article>';
    }).join("") +
    '</div></section>';
}

function telecomServiceHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const isDark = colors.variant === "dark";
  const telBg = isDark ? colors.darkCanvas : colors.canvas;
  const telSurface = isDark ? colors.darkSurface : colors.surface;
  const telFg = isDark ? colors.onDark : colors.text;
  const planGroup = component(board, ["plan-card", "pricing-card", "card"]);
  const card = componentColors(planGroup ?? component(board, ["card"]), telSurface, telFg, colors);
  const cta = component(board, ["button-primary", "brand-cta", "button"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  return '<section class="hero hero-payment" style="background:' + telBg + '"><div class="payment-brand" style="background:linear-gradient(135deg,' + colors.primary + ',' + mixHexColor(colors.primary, colors.darkSurface, 0.3) + ');color:' + colors.onPrimary + '"><div><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p></div><button style="background:' + colors.onPrimary + ';color:' + colors.primary + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "View Plans") + '</button></div>' +
    '<div class="payment-grid"><article class="payment-card" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + colors.radius + '"><small>Unlimited</small><b>$45/mo</b><div><span>Plan Card</span><span>5G · 50GB</span></div></article>' +
    '<div class="payment-transactions" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + colors.radius + '"><b>Popular plans</b>' +
    [0, 1, 2].map((i) => '<div class="payment-row"><span>' + ["Basic Plan", "Plus Plan", "Premium Plan"][i] + '</span><strong>' + ["$25", "$45", "$65"][i] + '</strong></div>').join("") +
    '</div></div></section>';
}

function automationWorkflowHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const isDark = colors.variant === "dark";
  const autoBg = isDark ? colors.darkCanvas : colors.canvas;
  const autoSurface = isDark ? colors.darkSurface : colors.surface;
  const autoFg = isDark ? colors.onDark : colors.text;
  const stepGroup = component(board, ["workflow-step", "pipeline", "app-card", "card"]);
  const card = componentColors(stepGroup ?? component(board, ["card"]), autoSurface, autoFg, colors);
  const cta = component(board, ["button-primary", "button"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  return '<section class="hero hero-collab" style="background:radial-gradient(circle at 25% 30%,' + colors.surface + ',transparent 30%),linear-gradient(135deg,' + autoBg + ',' + autoSurface + ')"><div class="collab-copy"><span class="collab-kicker">' + esc(archetypeLabel(board)) + '</span><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Create Zap") + '</button></div>' +
    '<div class="collab-mesh"><div class="workflow-chain">' +
    [0, 1, 2].map((i) => '<div class="workflow-node" style="background:' + card.bg + ';color:' + card.fg + ';border-color:' + colors.primary + ';border-radius:' + colors.radius + '"><b>' + esc(board.componentGroups[i]?.name ?? ["Trigger", "Action", "Filter"][i]) + '</b><span>' + ["New Email", "Create Task", "Check"][i] + '</span></div>' + (i < 2 ? '<span class="workflow-arrow">→</span>' : '')).join("") +
    '</div></div></section>';
}

function developerProductHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const isDark = colors.variant === "dark";
  const dpBg = isDark ? colors.darkCanvas : colors.canvas;
  const dpSurface = isDark ? colors.darkSurface : colors.surface;
  const code = component(board, ["code-panel", "code-block", "terminal", "command"]);
  const feature = component(board, ["card-feature", "docs-card", "project", "card"]);
  const cta = component(board, ["button-primary", "button"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  return '<section class="hero hero-docs"><aside style="background:' + dpBg + '"><b>' + esc(board.title) + '</b><span>Overview</span><span>Projects</span><span>Deployments</span><span>Docs</span></aside><main style="background:' + dpSurface + '"><div class="docs-copy"><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Deploy") + '</button></div><div class="docs-panels"><pre>' + esc(code?.name ?? "terminal") + '\n$ vercel deploy\n✓ Production ready</pre><article style="background:' + dpBg + '"><b>' + esc(feature?.name ?? "Project Panel") + '</b><span>Status: Ready</span></article></div></main></section>';
}

function aiAgentProductHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const isDark = colors.variant === "dark";
  const agentBg = isDark ? colors.darkCanvas : colors.canvas;
  const agentSurface = isDark ? colors.darkSurface : colors.surface;
  const agentFg = isDark ? colors.onDark : colors.text;
  const promptGroup = component(board, ["prompt-input", "ai-input", "input"]);
  const promptStyle = componentColors(promptGroup, agentSurface, agentFg, colors);
  const cta = component(board, ["button-primary", "button"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  return '<section class="hero hero-ai" style="background:' + agentBg + '"><div class="ai-header"><div><span class="ai-kicker">AI Agent</span><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p></div><button style="background:' + button.bg + ';color:' + button.fg + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Run Agent") + '</button></div>' +
    '<div class="ai-interface"><div class="ai-prompt" style="background:' + promptStyle.bg + ';color:' + promptStyle.fg + ';border-radius:' + promptStyle.radius + '"><div class="ai-prompt-label">' + esc(promptGroup?.name ?? "Agent Prompt") + '</div><div class="ai-prompt-bar">Describe the task...</div></div>' +
    '<div class="ai-outputs">' +
    '<div class="ai-output-panel"><div class="ai-output-placeholder">Agent Trace</div><code>→ tool: read_file("src/app.ts")\n→ tool: write_file("src/app.ts", ...)\n✓ task complete</code></div>' +
    '<div class="ai-model-cards">' +
    [0, 1, 2].map((i) => {
      const ms = componentColors(board.componentGroups[i], agentSurface, agentFg, colors);
      return '<article class="ai-model-card" style="background:' + (i === 0 ? colors.primary : ms.bg) + ';color:' + (i === 0 ? colors.onPrimary : ms.fg) + ';border-radius:' + colors.radius + '"><b>' + esc(board.componentGroups[i]?.name ?? ["Tool Card", "Action Card", "Trace Panel"][i]) + '</b><span>' + (i === 0 ? 'Running' : 'Available') + '</span></article>';
    }).join("") +
    '</div></div></div></section>';
}

function retailBrandHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const isDark = colors.variant === "dark";
  const brandSurface = isDark ? colors.darkSurface : colors.surface;
  const brandFg = isDark ? colors.onDark : colors.text;
  const cardGroup = component(board, ["payment-card", "product-card", "brand-strip", "card"]);
  const card = componentColors(cardGroup ?? component(board, ["card"]), brandSurface, brandFg, colors);
  const cta = component(board, ["button-primary", "button"]);
  const button = componentColors(cta, colors.primary, colors.onPrimary, colors);
  return '<section class="hero hero-payment"><div class="payment-brand" style="background:linear-gradient(135deg,' + colors.primary + ',' + mixHexColor(colors.primary, colors.darkSurface, 0.3) + ');color:' + colors.onPrimary + '"><div><h2>' + esc(board.title) + '</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p></div><button style="background:' + colors.onPrimary + ';color:' + colors.primary + ';border-radius:' + button.radius + '">' + esc(cta?.name ?? "Explore") + '</button></div>' +
    '<div class="payment-grid"><article class="payment-card" style="background:linear-gradient(135deg,' + colors.darkSurface + ',' + colors.primary + ');color:' + colors.onDark + ';border-radius:' + colors.radius + '"><small>' + esc(board.title) + '</small><b>' + esc(cardGroup?.name ?? "Brand Card") + '</b><div><span>Premium</span><span>2026</span></div></article>' +
    '<div class="payment-transactions" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + colors.radius + '"><b>Products</b>' +
    [0, 1, 2].map((i) => '<div class="payment-row"><span>' + ["Product Card", "Campaign", "Badge"][i] + '</span><strong>' + esc(board.componentGroups[i]?.name ?? "...") + '</strong></div>').join("") +
    '</div></div></section>';
}

function deriveTokens(board: DesignMdBoard, variant: GeneratedPreviewVariant = "light") {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  const paletteDark = darkestPaletteColor(allColors, "#0b0e11");
  const paletteLight = lightestPaletteColor(allColors, "#ffffff");
  const fallbackDarkCanvas = isDarkColor(paletteDark) ? paletteDark : "#0b0e11";
  const fallbackDarkSurface = mixHexColor(fallbackDarkCanvas, "#ffffff", 0.1) ?? "#1f2329";
  const lightCanvas = tokenColor(allColors, ["canvas-light", "white", "background-light", "background", "canvas", "surface-light"], paletteLight);
  const darkCanvas = tokenColor(allColors, ["canvas-dark", "background-dark", "surface-black", "black", "darkSurface", "dark-surface"], fallbackDarkCanvas);
  const lightSurface = tokenColor(allColors, ["surface-light", "surface-card-light", "white", "surface-card", "surface-soft", "surface", "card"], "#f5f5f5");

  // Dark surface preferences vary by archetype for intentional dark feels
  const darkSurfaceMatches: Record<DesignMdBoard["archetype"] | "default", string[]> = {
    marketplace: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    product_gallery: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    finance_dashboard: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    developer_docs: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    developer_product: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    data_product: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    generic_system: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark", "surface-aubergine"],
    collaboration_saas: ["surface-aubergine", "aubergine", "surface-dark", "surface-card-dark", "elevated-dark", "surface-black", "black"],
    ai_product: ["surface-dark", "surface-black", "black", "surface-card-dark", "elevated-dark"],
    ai_agent_product: ["surface-dark", "surface-black", "black", "surface-card-dark", "elevated-dark"],
    terminal_tool: ["surface-black", "black", "surface-dark", "surface-card-dark", "elevated-dark"],
    music_campaign: ["surface-dark", "surface-black", "black", "surface-card-dark", "elevated-dark", "surface-aubergine"],
    payment_finance: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    retail_food: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    retail_brand: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    telecom_service: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    automation_workflow: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    luxury_automotive: ["surface-black", "black", "surface-dark", "surface-card-dark", "elevated-dark"],
    editorial: ["surface-dark", "surface-black", "black", "surface-card-dark", "elevated-dark"],
    media_editorial: ["surface-dark", "surface-black", "black", "surface-card-dark", "elevated-dark"],
    creative_tool: ["surface-dark", "surface-card-dark", "surface-black", "black", "elevated-dark"],
    default: ["surface-dark", "surface-card-dark", "surface-black", "black", "surface-aubergine", "darkSurface", "dark-surface", "elevated-dark", "card-dark"],
  };
  const darkSurface = tokenColor(allColors, darkSurfaceMatches[board.archetype] ?? darkSurfaceMatches.default, fallbackDarkSurface);

  const lightText = ensureReadable(tokenColor(allColors, ["ink", "body-on-light", "text-on-light", "text", "body", "black"], "#181818"), lightCanvas, "#181818");
  const muted = ensureReadable(tokenColor(allColors, ["muted", "secondary", "soft"], "#6f7480"), lightCanvas, "#6f7480");

  // Dark muted with better fallback for code/terminal archetypes
  const darkMutedFallback = board.archetype === "terminal_tool" || board.archetype === "ai_product"
    ? "#8b949e"
    : "#a7adb8";
  const darkMuted = ensureReadable(tokenColor(allColors, ["on-dark-muted", "on-aubergine-muted", "on-aubergine-mute", "muted-on-dark", "body-on-dark-muted", "muted"], darkMutedFallback), darkCanvas, darkMutedFallback);

  const lightBorder = tokenColor(allColors, ["hairline", "border", "divider"], "#e5e5e5");
  const darkBorder = tokenColor(allColors, ["hairline-dark", "border-dark", "divider-dark", "surface-border-dark", "hairline", "border"], mixHexColor(darkSurface, "#ffffff", 0.12) ?? "#30363d");
  const primary = tokenColor(allColors, ["primary", "brand", "accent", "green", "blue", "yellow"], "#0066cc");
  const onPrimary = ensureReadable(tokenColor(allColors, ["on-primary"], readableTextColor(primary)), primary, readableTextColor(primary));
  const onDark = ensureReadable(tokenColor(allColors, ["on-dark", "body-on-dark", "on-black", "on-aubergine", "body-on-dark"], "#f8fafc"), darkCanvas, "#f8fafc");
  const canvas = variant === "dark" ? darkCanvas : lightCanvas;
  const surface = variant === "dark" ? darkSurface : lightSurface;
  const text = ensureReadable(variant === "dark" ? onDark : lightText, canvas, variant === "dark" ? "#f8fafc" : "#111111");
  const border = variant === "dark" ? darkBorder : lightBorder;
  const actualMuted = variant === "dark" ? darkMuted : muted;
  const up = tokenColor(allColors, ["trading-up", "success"], "#0ecb81");
  const down = tokenColor(allColors, ["trading-down", "error"], "#f6465d");
  const radius = cssSize(tokenValue(board.radiusTokens, ["md", "lg", "sm"], "10px"), "10px");
  const pill = cssSize(tokenValue(board.radiusTokens, ["pill", "full"], "9999px"), "9999px");
  const spacing = cssSpacing(tokenValue(board.spacingTokens, ["lg", "md", "base"], "24px"), "24px");
  return { variant, canvas, darkCanvas, surface, darkSurface, text, muted: actualMuted, border, primary, onPrimary, onDark, up, down, radius, pill, spacing };
}

function componentSampleHtml(group: DesignMdBoardComponentGroup, colors: ReturnType<typeof deriveTokens>): string {
  const style = componentColors(group, colors.surface, colors.text, colors);
  const name = esc(group.name);
  switch (group.kind) {
    case "button":
      return '<button class="sample sample-button" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + ';padding:' + style.padding + '">' + name + '</button>';
    case "search":
    case "input":
    case "prompt-input":
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
    case "code-panel":
      return '<div class="sample sample-code" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><b>' + name + '</b><code>export function Example() {}</code></div>';
    case "terminal-panel":
      return '<div class="sample sample-terminal" style="background:' + colors.darkCanvas + ';color:' + colors.onDark + ';border-radius:' + style.radius + '"><b>' + name + '</b><code>❯ npm run build</code></div>';
    case "workflow-step":
      return '<div class="sample sample-workflow" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><b>' + name + '</b><span>→</span></div>';
    case "editorial-card":
    case "article-card":
    case "media-card":
      return '<div class="sample sample-editorial" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><div class="sample-editorial-img"></div><b>' + name + '</b><small>By Author · 5 min read</small></div>';
    case "payment-card":
      return '<div class="sample sample-payment" style="background:linear-gradient(135deg,' + colors.darkSurface + ',' + colors.primary + ');color:' + colors.onDark + ';border-radius:' + style.radius + '"><b>' + name + '</b><span>•••• 4242</span></div>';
    case "market-table":
      return '<div class="sample sample-table" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><span><i>BTC</i><strong style="color:' + colors.up + '">+2.4%</strong></span><span><i>ETH</i><strong style="color:' + colors.down + '">-0.8%</strong></span></div>';
    case "stat":
    case "stat-card":
      return '<div class="sample sample-stat" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><small>' + name + '</small><b>98.7%</b><span style="color:' + colors.primary + '">+12.4%</span></div>';
    case "table":
      return '<div class="sample sample-table" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><span><i>Alpha</i><strong>Active</strong></span><span><i>Beta</i><strong>Queued</strong></span></div>';
    case "chart":
      return '<div class="sample sample-chart" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><div><i></i><i></i><i></i><i></i></div></div>';
    case "link":
      return '<a class="sample sample-link" style="color:' + style.fg + '">' + name + '</a>';
    case "quote":
      return '<blockquote class="sample sample-card" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '">"' + name + '"</blockquote>';
    case "footer":
      return '<div class="sample sample-footer" style="background:' + style.bg + ';color:' + style.fg + '">' + name + '</div>';
    case "card":
    case "pricing-card":
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
        "font-family:" + cssPreviewFont(token.fontFamily, board, token.raw),
        "font-size:" + cssFontSize(token.fontSize, "18px", 32),
        "font-weight:" + cssText(token.fontWeight, "500"),
        "line-height:" + cssText(token.lineHeight, "1.25"),
        "letter-spacing:0",
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
          "font-family:" + cssPreviewFont(token.fontFamily, board, token.raw),
          "font-size:" + cssFontSize(token.fontSize, "16px", 28),
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

export function generateBoardHtml(board: DesignMdBoard, options: { variant?: GeneratedPreviewVariant } = {}): string {
  const colors = deriveTokens(board, options.variant ?? "light");
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
    ".hero-collab{display:grid;grid-template-columns:.9fr 1.1fr;gap:22px;align-items:center;background:radial-gradient(circle at 75% 20%," + colors.surface + ",transparent 32%),linear-gradient(135deg," + colors.canvas + "," + colors.surface + ")}.collab-kicker{display:inline-flex;color:" + colors.primary + ";font-size:" + caption.size + ";font-weight:700;text-transform:uppercase;letter-spacing:.08em}.collab-copy p{color:" + colors.muted + ";margin:14px 0 20px;max-width:620px}.collab-actions{display:flex;gap:10px;flex-wrap:wrap}.collab-actions button,.collab-actions span{display:inline-flex;align-items:center;padding:12px 18px;border:1px solid currentColor}.collab-mesh{padding:22px;border-radius:" + colors.radius + ";background:linear-gradient(135deg," + colors.surface + "," + colors.canvas + ");box-shadow:0 18px 50px rgba(0,0,0,.12)}.collab-input{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;margin-bottom:14px;border:1px solid " + colors.border + "}.collab-input i{width:12px;height:12px;border-radius:50%;background:" + colors.primary + "}.collab-cards{display:grid;grid-template-columns:1fr 1fr;gap:12px}.collab-cards article:first-child{grid-column:span 2}.collab-cards article{padding:18px;min-height:96px;display:flex;flex-direction:column;justify-content:space-between}.collab-cards span{opacity:.72}",
    ".hero-auto{padding:0}.auto-band{min-height:300px;display:grid;grid-template-columns:1fr 1.1fr;align-items:center;padding:42px}.auto-band small{letter-spacing:.12em;text-transform:uppercase}.auto-band button{margin-top:20px;padding:14px 28px}.vehicle-silhouette{height:150px;border-radius:4px;background:linear-gradient(180deg,transparent 35%,rgba(255,255,255,.18) 36% 62%,transparent 63%),linear-gradient(90deg,transparent 5%,rgba(255,255,255,.9) 18% 82%,transparent 95%)}.auto-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:" + colors.border + "}.auto-grid article{padding:24px;min-height:150px;display:flex;flex-direction:column;gap:8px}.auto-grid span{font-size:" + caption.size + ";letter-spacing:.08em;text-transform:uppercase;color:" + colors.muted + "}.vehicle-mini{height:64px;background:" + colors.surface + ";margin-bottom:10px}",
    ".hero-data{display:grid;grid-template-columns:220px 1fr;background:" + colors.darkCanvas + ";color:" + colors.onDark + "}.data-sidebar{display:flex;flex-direction:column;gap:14px;border-right:1px solid " + colors.darkSurface + ";padding:22px}.data-main{display:grid;grid-template-columns:1.3fr .8fr;gap:16px;padding:24px}.chart-card,.data-table{background:" + colors.darkSurface + ";border-radius:" + colors.radius + ";padding:22px}.bars{display:flex;align-items:end;gap:10px;height:160px;margin-top:28px}.bars i{flex:1;background:" + colors.primary + ";border-radius:4px 4px 0 0}.bars i:nth-child(1){height:32%}.bars i:nth-child(2){height:68%}.bars i:nth-child(3){height:48%}.bars i:nth-child(4){height:86%}.bars i:nth-child(5){height:58%}.data-table div{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid " + colors.border + "}",
    ".hero-editorial{display:grid;grid-template-columns:.85fr 1.15fr;gap:18px;align-items:stretch;background:" + colors.canvas + "}.editorial-copy{display:flex;flex-direction:column;justify-content:center;gap:14px}.editorial-copy span{font-size:" + caption.size + ";letter-spacing:.12em;text-transform:uppercase;color:" + colors.muted + ";font-weight:700}.editorial-copy p{color:" + colors.muted + ";max-width:620px}.editorial-copy div{display:flex;gap:10px;flex-wrap:wrap}.editorial-copy button{padding:12px 20px}.campaign-grid{display:grid;grid-template-columns:1.2fr .8fr;grid-template-rows:1fr 1fr;gap:12px}.campaign-grid article{padding:14px;display:flex;flex-direction:column;gap:8px;min-height:132px;overflow:hidden}.campaign-grid article:first-child{grid-row:span 2}.campaign-grid span{color:" + colors.muted + ";font-size:" + caption.size + "}.campaign-art{flex:1;min-height:72px;background:linear-gradient(135deg," + colors.primary + "," + colors.surface + ");border-radius:inherit}.campaign-art.c1{background:linear-gradient(135deg," + colors.surface + "," + colors.border + ")}.campaign-art.c2{background:linear-gradient(135deg," + colors.darkSurface + "," + colors.primary + ")}",
    ".hero-generic{display:grid;grid-template-columns:.9fr 1.1fr;align-items:center;background:" + colors.surface + "}.hero-generic p{color:" + colors.muted + ";max-width:560px;margin-top:12px}.generic-board{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
    ".hero-ai{display:flex;flex-direction:column;gap:18px;padding:28px;background:" + colors.canvas + "}.ai-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.ai-header button{padding:12px 24px}.ai-kicker{color:" + colors.primary + ";font-size:" + caption.size + ";text-transform:uppercase;letter-spacing:.08em;font-weight:700}.ai-interface{display:grid;grid-template-columns:1fr;gap:16px}.ai-prompt{border:1px solid " + colors.border + ";padding:16px}.ai-prompt-label{font-size:" + caption.size + ";color:" + colors.muted + ";margin-bottom:8px}.ai-prompt-bar{font-size:" + body.size + ";opacity:.6}.ai-outputs{display:grid;grid-template-columns:1.3fr .8fr;gap:16px}.ai-output-panel{padding:18px;border:1px solid " + colors.border + "}.ai-output-panel code{display:block;margin-top:12px;padding:10px;border-radius:6px;background:" + colors.darkSurface + ";color:" + colors.onDark + ";white-space:pre-wrap}.ai-output-placeholder{color:" + colors.muted + ";margin-bottom:8px}.ai-model-cards{display:grid;gap:10px}.ai-model-card{padding:14px;display:flex;flex-direction:column;gap:4px}.ai-model-card span{font-size:" + caption.size + ";opacity:.7}",
    ".hero-creative{display:flex;flex-direction:column;gap:0}.creative-toolbar{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid " + colors.border + "}.creative-toolbar b{color:" + colors.primary + "}.creative-toolbar button{margin-left:auto;padding:8px 16px}.creative-workspace{display:grid;grid-template-columns:160px 1fr 180px;gap:0;min-height:280px}.creative-sidebar,.creative-inspector{padding:14px;display:flex;flex-direction:column;gap:10px}.creative-sidebar{border-right:1px solid " + colors.border + "}.creative-inspector{border-left:1px solid " + colors.border + "}.creative-inspector small,.creative-inspector span{display:block}.creative-canvas{display:grid;place-items:center;padding:24px}.creative-frame{width:80%;height:70%;display:grid;place-items:center;font-size:" + caption.size + "}",
    ".hero-payment{display:flex;flex-direction:column;gap:0}.payment-brand{display:flex;align-items:center;justify-content:space-between;padding:32px 28px}.payment-brand button{padding:12px 24px}.payment-brand p{max-width:520px;opacity:.85;margin-top:8px}.payment-grid{display:grid;grid-template-columns:1fr 1.2fr;gap:16px;padding:24px}.payment-card{padding:22px;display:flex;flex-direction:column;gap:14px;box-shadow:0 12px 40px rgba(0,0,0,.18)}.payment-card b{font-size:22px;letter-spacing:.06em;margin-top:auto}.payment-card div{display:flex;justify-content:space-between;font-size:" + caption.size + "}.payment-transactions{padding:18px;display:flex;flex-direction:column;gap:10px}.payment-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid " + colors.border + "}.payment-row:last-child{border-bottom:0}",
    ".hero-music{display:grid;grid-template-columns:.8fr 1.2fr;align-items:center;gap:20px;padding:28px;min-height:320px}.music-copy{display:flex;flex-direction:column;gap:12px}.music-kicker{font-size:" + caption.size + ";text-transform:uppercase;letter-spacing:.12em;font-weight:700}.music-copy p{color:" + colors.muted + ";max-width:480px}.music-copy button{padding:12px 20px;align-self:flex-start}.music-grid{display:grid;grid-template-columns:1.3fr .8fr;grid-template-rows:1fr 1fr;gap:12px}.music-tile{padding:14px;display:flex;flex-direction:column;gap:6px;min-height:122px;overflow:hidden}.music-tile:first-child{grid-row:span 2}.music-tile span{font-size:" + caption.size + ";opacity:.65}.music-art{flex:1;min-height:56px;border-radius:8px;background:linear-gradient(135deg," + colors.primary + "," + colors.surface + ")}.music-art.m1{background:linear-gradient(135deg," + colors.surface + "," + colors.border + ")}.music-art.m2{background:linear-gradient(135deg," + colors.darkSurface + "," + colors.primary + ")}",
    ".hero-terminal{display:flex;flex-direction:column;gap:0;min-height:280px}.terminal-header{display:flex;align-items:center;justify-content:space-between;padding:10px 18px;border-bottom:1px solid " + colors.border + "}.terminal-body{padding:20px;flex:1;display:flex;flex-direction:column;gap:14px}.terminal-prompt{display:flex;gap:10px;align-items:center}.terminal-prefix{color:" + colors.primary + ";font-weight:700}.terminal-output pre{margin:0;font-family:monospace;opacity:.8;line-height:1.5}.terminal-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto}.terminal-chips span{display:inline-flex;padding:5px 10px;border:1px solid rgba(255,255,255,.18);font-size:" + caption.size + "}",
    ".editorial-kicker{font-size:" + caption.size + ";text-transform:uppercase;letter-spacing:.12em;font-weight:700;color:" + colors.muted + "}.editorial-lead{padding:14px;display:flex;flex-direction:column;gap:8px;overflow:hidden}.editorial-img{flex:1;min-height:72px;border-radius:8px;background:linear-gradient(135deg," + colors.primary + "," + colors.surface + ")}.editorial-img.e0{background:linear-gradient(135deg," + colors.darkSurface + "," + colors.primary + ")}",
    ".workflow-chain{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 0}.workflow-node{padding:14px 16px;border:2px solid;display:flex;flex-direction:column;gap:4px;min-width:120px}.workflow-node span{font-size:" + caption.size + ";opacity:.65}.workflow-arrow{font-size:24px;color:" + colors.primary + ";opacity:.5}",
    ".sample-code,.sample-terminal,.sample-workflow,.sample-editorial,.sample-payment{padding:14px;border:1px solid " + colors.border + ";overflow:hidden}.sample-code code,.sample-terminal code{display:block;margin-top:8px;padding:8px;border-radius:5px;background:rgba(0,0,0,.15);font-family:monospace;font-size:" + caption.size + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sample-workflow{display:flex;justify-content:space-between;align-items:center}.sample-workflow span{font-size:20px;opacity:.4}.sample-editorial{display:flex;flex-direction:column;gap:8px}.sample-editorial-img{height:64px;border-radius:6px;background:linear-gradient(135deg," + colors.surface + "," + colors.primary + ")}.sample-editorial small{color:" + colors.muted + ";font-size:10px}.sample-payment{display:flex;flex-direction:column;gap:6px}.sample-payment span{font-size:" + caption.size + ";opacity:.7;letter-spacing:.04em}",
    ".overview-deck{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);gap:14px;padding:16px 20px 20px;border-top:1px solid " + colors.border + ";background:" + colors.canvas + "}.overview-card{border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";background:" + colors.canvas + ";padding:12px;overflow:hidden}.overview-card header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.overview-card header span{font-size:" + caption.size + ";color:" + colors.muted + "}.overview-side{display:grid;gap:14px}.overview-component-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.overview-component-grid article{min-height:94px}.overview-component-grid label{display:block;color:" + colors.muted + ";font-size:10px;margin-bottom:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.overview-swatch-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.overview-swatch-grid i{display:block;height:28px;border-radius:7px;border:1px solid rgba(0,0,0,.08)}.overview-swatch-grid span{display:block;margin-top:5px;color:" + colors.muted + ";font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.overview-type{display:grid;gap:8px}.overview-type small{display:block;color:" + colors.muted + ";font-size:10px}.overview-type span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".strip{padding:20px;border-top:1px solid " + colors.border + "}.strip header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}.strip header span{font-size:" + caption.size + ";color:" + colors.muted + "}.palette-grid{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px}.swatch{min-height:84px;border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:8px;background:" + colors.canvas + ";overflow:hidden}.swatch i{display:block;height:32px;border-radius:6px;margin-bottom:8px;border:1px solid rgba(0,0,0,.08)}.swatch b,.swatch small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.swatch small{color:" + colors.muted + ";font-size:10px}.more{display:grid;place-items:center}",
    ".type-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.type-row{border-bottom:1px solid " + colors.border + ";padding:8px 0}.type-row small{display:block;color:" + colors.muted + ";margin-bottom:4px}.component-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.component-grid article{border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:10px;min-height:112px;overflow:hidden}.component-grid label{display:block;color:" + colors.muted + ";font-size:11px;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sample{max-width:100%}.sample-button{border:1px solid transparent}.sample-input{display:flex;justify-content:space-between;align-items:center;border:1px solid " + colors.border + ";padding:12px}.sample-input i{width:14px;height:14px;border-radius:50%;background:" + colors.primary + "}.sample-chip{display:inline-flex;padding:7px 12px}.sample-nav{display:flex;gap:12px;padding:11px}.sample-card{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid " + colors.border + "}.sample-stat{display:grid;gap:5px;padding:14px;border:1px solid " + colors.border + "}.sample-stat b{font-size:28px}.sample-chart{display:grid;gap:12px;padding:14px;border:1px solid " + colors.border + "}.sample-chart div{height:58px;display:flex;align-items:end;gap:8px}.sample-chart i{flex:1;background:" + colors.primary + ";border-radius:4px 4px 0 0}.sample-chart i:nth-child(1){height:35%}.sample-chart i:nth-child(2){height:70%}.sample-chart i:nth-child(3){height:48%}.sample-chart i:nth-child(4){height:88%}.sample-gradient{min-height:92px;padding:16px;display:flex;flex-direction:column;justify-content:space-between}.sample-mockup{display:grid;gap:7px;padding:13px}.sample-mockup code{display:block;padding:7px;border-radius:6px;background:rgba(0,0,0,.22);color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sample-mockup span{height:8px;border-radius:99px;background:rgba(127,127,127,.28)}.sample-table{display:flex;flex-direction:column;gap:7px;padding:12px;border:1px solid " + colors.border + "}.sample-table span{display:flex;justify-content:space-between;gap:12px;border-top:1px solid rgba(127,127,127,.25);padding-top:6px}.sample-table i{font-style:normal}.sample-tile{padding:14px}.sample-tile div{height:56px;background:rgba(127,127,127,.18);margin-bottom:10px}.sample-link{text-decoration:underline}.sample-footer{padding:14px}.rhythm-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.radius-grid{display:flex;flex-wrap:wrap;gap:8px}.radius-cell{width:58px;height:58px;display:grid;place-items:center;background:" + colors.surface + ";border:1px solid " + colors.border + ";font-size:10px;color:" + colors.muted + "}.space-row{display:flex;align-items:center;gap:10px;margin:7px 0}.space-row span{width:70px}.space-row i{display:block;height:10px;background:" + colors.primary + ";border-radius:999px}.notes-strip ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px;padding-left:18px;color:" + colors.muted + "}",
    "@media(max-width:760px){.board-meta{position:static;align-items:flex-start;flex-direction:column}.overview-deck,.listing-grid,.product-tiles,.finance-grid,.auto-grid,.component-grid,.type-grid,.rhythm-grid,.hero-docs,.hero-docs main,.hero-data,.data-main,.hero-generic,.hero-collab,.hero-editorial,.campaign-grid,.hero-ai .ai-outputs,.hero-creative .creative-workspace,.hero-music,.music-grid,.hero-payment .payment-grid{grid-template-columns:1fr}.hero-ai .ai-header{flex-direction:column}.hero-creative .creative-workspace{grid-template-columns:1fr}.hero-creative .creative-sidebar,.hero-creative .creative-inspector{border:0;border-top:1px solid " + colors.border + "}.overview-component-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-swatch-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.market-search{grid-template-columns:1fr;gap:8px;border-radius:" + colors.radius + "}.market-search span{border-right:0;border-bottom:1px solid " + colors.border + ";padding-bottom:8px}.palette-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.notes-strip ul{grid-template-columns:1fr}.hero{min-height:auto}.auto-band{grid-template-columns:1fr}.product-tile{min-height:260px}.campaign-grid article:first-child{grid-row:auto}.music-tile:first-child{grid-row:auto}}",
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
