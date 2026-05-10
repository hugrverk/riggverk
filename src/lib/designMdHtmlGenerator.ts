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

function tokenValue(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
  for (const match of matches) {
    const found = tokens.find((token) => token.key.toLowerCase().includes(match));
    if (found && !isUnsafeDesignMdStyleValue(found.resolvedValue)) return found.resolvedValue.trim();
  }
  return fallback;
}

function tokenColor(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
  for (const match of matches) {
    const found = tokens.find((token) => token.key.toLowerCase().includes(match));
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

function componentColors(group: DesignMdBoardComponentGroup | undefined, bg: string, fg: string) {
  return {
    bg: cssColor(group?.backgroundColor, bg),
    fg: cssColor(group?.textColor, fg),
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
    case "luxury_automotive":
      return automotiveHero(board, colors);
    case "data_product":
      return dataHero(board);
    default:
      return genericHero(board, colors);
  }
}

function marketplaceHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const search = componentColors(component(board, ["search-bar", "search"]), colors.canvas, colors.text);
  const card = componentColors(component(board, ["property-card", "experience-card", "card"]), colors.surface, colors.text);
  return '<section class="hero hero-market">' +
    '<div class="market-nav"><strong>' + esc(board.title) + '</strong><span>Homes</span><span>Experiences</span><span>Services</span><span class="badge">NEW</span></div>' +
    '<div class="market-search" style="background:' + search.bg + ';color:' + search.fg + ';border-radius:' + search.radius + '">' +
    '<span><b>Where</b><small>Search destinations</small></span><span><b>When</b><small>Add dates</small></span><span><b>Who</b><small>Add guests</small></span><i style="background:' + colors.primary + ';color:' + colors.onPrimary + '">⌕</i></div>' +
    '<div class="listing-grid">' + [0, 1, 2].map((i) =>
      '<article class="listing-card" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + card.radius + '">' +
      '<div class="photo-block p' + i + '"><span class="badge">Guest favorite</span></div>' +
      '<b>' + esc(["Coastal home", "City studio", "Design retreat"][i]) + '</b><span class="muted">4.9 · 2 nights · actual card tokens</span></article>'
    ).join("") + '</div></section>';
}

function productGalleryHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const light = componentColors(component(board, ["product-tile-light", "product-tile-parchment"]), colors.canvas, colors.text);
  const dark = componentColors(component(board, ["product-tile-dark"]), colors.darkSurface, colors.onDark);
  return '<section class="hero hero-gallery">' +
    '<div class="gallery-nav" style="background:' + colors.darkSurface + ';color:' + colors.onDark + '"><span>' + esc(board.title) + '</span><span>Store</span><span>Mac</span><span>iPhone</span><button style="background:' + colors.primary + ';color:' + colors.onPrimary + '">Buy</button></div>' +
    '<div class="product-tiles">' +
    '<article class="product-tile product-tile-light" style="background:' + light.bg + ';color:' + light.fg + ';border-radius:' + light.radius + '"><h2>Product tile light</h2><p>Photography-first sparse surface</p><div class="device-shape"></div><span class="pill" style="background:' + colors.primary + ';color:' + colors.onPrimary + '">Learn more</span></article>' +
    '<article class="product-tile product-tile-dark" style="background:' + dark.bg + ';color:' + dark.fg + ';border-radius:' + dark.radius + '"><h2>Product tile dark</h2><p>Alternating dark gallery block</p><div class="device-shape dark"></div><span class="pill outline">Buy</span></article>' +
    '</div></section>';
}

function financeHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const nav = componentColors(component(board, ["top-nav-dark", "top-nav"]), colors.darkCanvas, colors.onDark);
  const card = componentColors(component(board, ["markets-table-card", "card", "panel"]), colors.darkSurface, colors.onDark);
  const action = componentColors(component(board, ["button-primary", "button-primary-pill"]), colors.primary, colors.onPrimary);
  return '<section class="hero hero-finance" style="background:' + colors.darkCanvas + ';color:' + colors.onDark + '">' +
    '<div class="finance-nav" style="background:' + nav.bg + ';color:' + nav.fg + '"><strong>' + esc(board.title) + '</strong><span>Buy Crypto</span><span>Markets</span><button style="background:' + action.bg + ';color:' + action.fg + ';border-radius:' + action.radius + '">Sign Up</button></div>' +
    '<div class="finance-grid"><article class="balance-card" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + card.radius + '"><small>Total Balance</small><h2>$42,918.80</h2><button style="background:' + action.bg + ';color:' + action.fg + ';border-radius:' + action.radius + '">Deposit</button></article>' +
    '<article class="market-table" style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + card.radius + '"><b>Markets table card</b>' +
    [["BTC", "+2.4%", colors.up], ["ETH", "-0.8%", colors.down], ["BNB", "+1.7%", colors.up]].map((row) => '<div><span>' + row[0] + '</span><strong style="color:' + row[2] + '">' + row[1] + '</strong></div>').join("") +
    '</article><article class="action-stack"><button style="background:' + action.bg + ';color:' + action.fg + ';border-radius:' + action.radius + '">Buy</button><button>Sell</button><button>Convert</button></article></div></section>';
}

function docsHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  return '<section class="hero hero-docs"><aside><b>' + esc(board.title) + '</b><span>Overview</span><span>API</span><span>Components</span></aside><main><h2>Developer system</h2><p>' + esc(board.visualLanguage.phrases[0] ?? board.description) + '</p><pre>npm install design-system</pre><button style="background:' + colors.primary + ';color:' + colors.onPrimary + '">Read docs</button></main></section>';
}

function automotiveHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const hero = componentColors(component(board, ["hero-band", "photo-band"]), colors.darkSurface, colors.onDark);
  const card = componentColors(component(board, ["model-card", "inventory-card"]), colors.surface, colors.text);
  return '<section class="hero hero-auto"><div class="auto-band" style="background:' + hero.bg + ';color:' + hero.fg + '"><div><small>Corporate automotive</small><h2>' + esc(board.title) + '</h2><button style="background:' + colors.primary + ';color:' + colors.onPrimary + ';border-radius:' + hero.radius + '">Explore models</button></div><div class="vehicle-silhouette"></div></div><div class="auto-grid">' +
    ["Model card", "Feature photo card", "Inventory card"].map((label) => '<article style="background:' + card.bg + ';color:' + card.fg + ';border-radius:' + card.radius + '"><div class="vehicle-mini"></div><b>' + label + '</b><span>LEARN MORE</span></article>').join("") +
    '</div></section>';
}

function dataHero(board: DesignMdBoard): string {
  return '<section class="hero hero-data"><div class="data-sidebar"><b>' + esc(board.title) + '</b><span>Queries</span><span>Metrics</span><span>Events</span></div><div class="data-main"><div class="chart-card"><h2>Data product board</h2><div class="bars"><i></i><i></i><i></i><i></i><i></i></div></div><div class="data-table">' +
    ["Latency", "Queries", "Errors"].map((label, i) => '<div><span>' + label + '</span><strong>' + ["18ms", "1.2M", "0.01%"][i] + '</strong></div>').join("") +
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
      return '<button class="sample sample-button" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + ';padding:' + style.padding + '">' + name + '</button>';
    case "search":
    case "input":
      return '<div class="sample sample-input" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><span>' + name + '</span><i></i></div>';
    case "chip":
      return '<span class="sample sample-chip" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + colors.pill + '">' + name + '</span>';
    case "nav":
    case "subnav":
      return '<div class="sample sample-nav" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><b>' + name + '</b><span>One</span><span>Two</span></div>';
    case "product-tile":
    case "tile":
      return '<div class="sample sample-tile" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><div></div><b>' + name + '</b></div>';
    case "link":
      return '<a class="sample sample-link" style="color:' + style.fg + '">' + name + '</a>';
    case "quote":
      return '<blockquote class="sample sample-card" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '">“' + name + '”</blockquote>';
    case "footer":
      return '<div class="sample sample-footer" style="background:' + style.bg + ';color:' + style.fg + '">' + name + '</div>';
    case "card":
    case "utility":
    case "generic":
    default:
      return '<div class="sample sample-card" style="background:' + style.bg + ';color:' + style.fg + ';border-radius:' + style.radius + '"><b>' + name + '</b><small>' + esc(Object.keys(group.raw).slice(0, 3).join(" · ")) + '</small></div>';
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
    board.componentGroups.slice(0, 18).map((group) => '<article><label>' + esc(group.name) + '</label>' + componentSampleHtml(group, colors) + '</article>').join("") +
    '</div></section>';
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
    "html,body{min-height:100%;overflow:auto}",
    "body{font-family:" + body.family + ";font-size:" + body.size + ";font-weight:" + body.weight + ";line-height:1.45;letter-spacing:" + body.letterSpacing + ";background:" + colors.canvas + ";color:" + colors.text + ";-webkit-font-smoothing:antialiased}",
    ".board{min-height:100vh;background:" + colors.canvas + ";color:" + colors.text + "}",
    ".board-meta{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;border-bottom:1px solid " + colors.border + ";background:" + colors.canvas + ";position:sticky;top:0;z-index:2}",
    ".board-meta strong{font-size:13px}.board-meta span{font-size:" + caption.size + ";color:" + colors.muted + "}.keywords{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.keywords i{font-style:normal;border:1px solid " + colors.border + ";border-radius:" + colors.pill + ";padding:3px 8px;color:" + colors.muted + "}",
    ".hero{min-height:430px;padding:22px;display:flex;flex-direction:column;gap:18px}",
    ".hero h2{font-family:" + display.family + ";font-size:clamp(30px," + display.size + ",64px);font-weight:" + display.weight + ";line-height:" + display.lineHeight + ";letter-spacing:" + display.letterSpacing + "}",
    "button{font:inherit;border:0;cursor:default}.pill{display:inline-flex;align-items:center;justify-content:center;border-radius:" + colors.pill + ";padding:9px 18px;font-weight:500}.outline{border:1px solid currentColor}",
    ".muted{color:" + colors.muted + "}.badge{display:inline-flex;align-items:center;border-radius:" + colors.pill + ";background:" + colors.canvas + ";color:" + colors.text + ";box-shadow:0 0 0 1px " + colors.border + ";padding:4px 9px;font-size:" + caption.size + ";font-weight:600}",
    ".hero-market{background:" + colors.canvas + "}.market-nav{display:flex;align-items:center;gap:22px;min-height:48px}.market-nav strong{color:" + colors.primary + ";margin-right:auto}.market-search{display:grid;grid-template-columns:1fr 1fr 1fr 48px;align-items:center;max-width:900px;width:100%;margin:0 auto;padding:8px 8px 8px 26px;box-shadow:0 8px 24px rgba(0,0,0,.09);border:1px solid " + colors.border + "}.market-search span{display:flex;flex-direction:column;border-right:1px solid " + colors.border + ";padding-right:18px}.market-search small{color:" + colors.muted + "}.market-search i{display:grid;place-items:center;width:48px;height:48px;border-radius:999px;font-style:normal;font-size:22px}.listing-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.listing-card{padding:10px;display:flex;flex-direction:column;gap:8px}.photo-block{height:160px;border-radius:inherit;background:linear-gradient(135deg," + colors.surface + "," + colors.border + ");padding:10px}.p1{background:linear-gradient(135deg,#f4d9d3,#f9f6f0)}.p2{background:linear-gradient(135deg,#dfe7df,#f6eee4)}",
    ".gallery-nav{display:flex;align-items:center;gap:22px;height:44px;padding:0 18px}.gallery-nav span:first-child{margin-right:auto}.gallery-nav button{border-radius:" + colors.pill + ";padding:5px 12px}.product-tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;flex:1}.product-tile{min-height:360px;display:flex;flex-direction:column;align-items:center;text-align:center;justify-content:flex-start;gap:12px;padding:42px 22px}.device-shape{width:min(260px,70%);height:130px;margin-top:auto;border-radius:28px;background:linear-gradient(145deg,#d8d8dc,#ffffff);box-shadow:3px 5px 30px rgba(0,0,0,.18)}.device-shape.dark{background:linear-gradient(145deg,#111,#555)}",
    ".hero-finance{padding:0}.finance-nav{height:62px;display:flex;align-items:center;gap:22px;padding:0 22px}.finance-nav strong{color:" + colors.primary + ";margin-right:auto}.finance-nav button{padding:10px 18px}.finance-grid{display:grid;grid-template-columns:1.2fr 1.6fr .7fr;gap:16px;padding:24px}.balance-card,.market-table{padding:24px}.balance-card h2{color:" + colors.primary + ";font-size:42px;margin:10px 0 24px}.balance-card button{padding:12px 20px}.market-table{display:flex;flex-direction:column;gap:14px}.market-table div{display:flex;justify-content:space-between;border-top:1px solid " + colors.border + ";padding-top:12px}.action-stack{display:flex;flex-direction:column;gap:10px}.action-stack button{padding:14px 18px;border-radius:" + colors.radius + ";background:" + colors.darkSurface + ";color:" + colors.onDark + "}",
    ".hero-docs{display:grid;grid-template-columns:220px 1fr;background:" + colors.surface + "}.hero-docs aside{display:flex;flex-direction:column;gap:12px;border-right:1px solid " + colors.border + ";padding:22px}.hero-docs main{padding:34px;max-width:760px}.hero-docs pre{margin:20px 0;padding:18px;border-radius:" + colors.radius + ";background:" + colors.darkCanvas + ";color:" + colors.onDark + "}.hero-docs button{padding:11px 18px;border-radius:" + colors.radius + "}",
    ".hero-auto{padding:0}.auto-band{min-height:300px;display:grid;grid-template-columns:1fr 1.1fr;align-items:center;padding:42px}.auto-band small{letter-spacing:.12em;text-transform:uppercase}.auto-band button{margin-top:20px;padding:14px 28px}.vehicle-silhouette{height:150px;border-radius:4px;background:linear-gradient(180deg,transparent 35%,rgba(255,255,255,.18) 36% 62%,transparent 63%),linear-gradient(90deg,transparent 5%,rgba(255,255,255,.9) 18% 82%,transparent 95%)}.auto-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:" + colors.border + "}.auto-grid article{padding:24px;min-height:150px}.vehicle-mini{height:64px;background:" + colors.surface + ";margin-bottom:18px}",
    ".hero-data{display:grid;grid-template-columns:220px 1fr;background:" + colors.darkCanvas + ";color:" + colors.onDark + "}.data-sidebar{display:flex;flex-direction:column;gap:14px;border-right:1px solid " + colors.darkSurface + ";padding:22px}.data-main{display:grid;grid-template-columns:1.3fr .8fr;gap:16px;padding:24px}.chart-card,.data-table{background:" + colors.darkSurface + ";border-radius:" + colors.radius + ";padding:22px}.bars{display:flex;align-items:end;gap:10px;height:160px;margin-top:28px}.bars i{flex:1;background:" + colors.primary + ";border-radius:4px 4px 0 0}.bars i:nth-child(1){height:32%}.bars i:nth-child(2){height:68%}.bars i:nth-child(3){height:48%}.bars i:nth-child(4){height:86%}.bars i:nth-child(5){height:58%}.data-table div{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid " + colors.border + "}",
    ".hero-generic{display:grid;grid-template-columns:.9fr 1.1fr;align-items:center;background:" + colors.surface + "}.hero-generic p{color:" + colors.muted + ";max-width:560px;margin-top:12px}.generic-board{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
    ".strip{padding:20px;border-top:1px solid " + colors.border + "}.strip header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}.strip header span{font-size:" + caption.size + ";color:" + colors.muted + "}.palette-grid{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px}.swatch{min-height:84px;border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:8px;background:" + colors.canvas + ";overflow:hidden}.swatch i{display:block;height:32px;border-radius:6px;margin-bottom:8px;border:1px solid rgba(0,0,0,.08)}.swatch b,.swatch small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.swatch small{color:" + colors.muted + ";font-size:10px}.more{display:grid;place-items:center}",
    ".type-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.type-row{border-bottom:1px solid " + colors.border + ";padding:8px 0}.type-row small{display:block;color:" + colors.muted + ";margin-bottom:4px}.component-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.component-grid article{border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:10px;min-height:112px}.component-grid label{display:block;color:" + colors.muted + ";font-size:11px;margin-bottom:8px}.sample{max-width:100%}.sample-button{border:0}.sample-input{display:flex;justify-content:space-between;align-items:center;border:1px solid " + colors.border + ";padding:12px}.sample-input i{width:14px;height:14px;border-radius:50%;background:" + colors.primary + "}.sample-chip{display:inline-flex;padding:7px 12px}.sample-nav{display:flex;gap:12px;padding:11px}.sample-card{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid " + colors.border + "}.sample-tile{padding:14px}.sample-tile div{height:56px;background:rgba(127,127,127,.18);margin-bottom:10px}.sample-link{text-decoration:underline}.sample-footer{padding:14px}.rhythm-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.radius-grid{display:flex;flex-wrap:wrap;gap:8px}.radius-cell{width:58px;height:58px;display:grid;place-items:center;background:" + colors.surface + ";border:1px solid " + colors.border + ";font-size:10px;color:" + colors.muted + "}.space-row{display:flex;align-items:center;gap:10px;margin:7px 0}.space-row span{width:70px}.space-row i{display:block;height:10px;background:" + colors.primary + ";border-radius:999px}.notes-strip ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px;padding-left:18px;color:" + colors.muted + "}",
    "@media(max-width:760px){.board-meta{position:static;align-items:flex-start;flex-direction:column}.listing-grid,.product-tiles,.finance-grid,.auto-grid,.component-grid,.type-grid,.rhythm-grid,.hero-docs,.hero-data,.data-main,.hero-generic{grid-template-columns:1fr}.market-search{grid-template-columns:1fr;gap:8px;border-radius:" + colors.radius + "}.market-search span{border-right:0;border-bottom:1px solid " + colors.border + ";padding-bottom:8px}.palette-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.notes-strip ul{grid-template-columns:1fr}.hero{min-height:auto}.auto-band{grid-template-columns:1fr}.product-tile{min-height:260px}}",
  ].join("\n");

  const keywords = board.visualLanguage.keywords.slice(0, 5).map((keyword) => '<i>' + esc(keyword) + '</i>').join("");
  const html = [
    '<div class="board">',
    '<div class="board-meta"><div><strong>' + esc(board.title) + '</strong><span> · ' + esc(board.slug) + ' · ' + esc(board.archetype) + '</span></div><div class="keywords">' + keywords + '</div></div>',
    heroPattern(board, colors),
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
