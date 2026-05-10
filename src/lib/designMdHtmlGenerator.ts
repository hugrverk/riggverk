import type { DesignMdSpecimen, DesignMdBoard, DesignMdBoardComponentGroup } from "./designMdSpecimenBuilder";
import {
  isSafeColorValue,
  isSafeFontFamilyValue,
  isSafeSizeValue,
  isSafeSpacingValue,
  isUnsafeDesignMdStyleValue,
  resolveGeneratedFontFamily,
} from "./designMdPreviewParser";
import { evidenceLabel } from "./designMdSourceEvidence";
import {
  checkRenderEligibility,
} from "./designMdRenderEligibility";

const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:;">';

type GeneratedPreviewVariant = "light" | "dark";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

function cssText(value: string | undefined, fallback: string): string {
  if (!value || isUnsafeDesignMdStyleValue(value)) return fallback;
  return value.trim();
}

function cssFontSize(value: string | undefined, fallback: string, maxPx = 40): string {
  const safe = cssSize(value, fallback);
  const match = safe.match(/^(\d+(?:\.\d+)?)(px|rem|em|pt)?$/);
  if (!match) return safe;
  const unit = match[2] ?? "px";
  const numeric = Number.parseFloat(match[1]);
  const px = unit === "rem" || unit === "em" ? numeric * 16 : unit === "pt" ? numeric * 1.333 : numeric;
  return px <= maxPx ? safe : `${maxPx}px`;
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

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("");
}

function mixHexColor(a: string, b: string, amount: number): string | null {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return null;
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex(ca.r + (cb.r - ca.r) * t, ca.g + (cb.g - ca.g) * t, ca.b + (cb.b - ca.b) * t);
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

function colorLuma(value: string): number | null {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

function isLightColor(value: string | undefined): boolean {
  const luma = value ? colorLuma(value) : null;
  return luma !== null && luma > 0.72;
}

function isDarkColor(value: string | undefined): boolean {
  const luma = value ? colorLuma(value) : null;
  return luma !== null && luma < 0.36;
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

function tokenKeyMatches(key: string, match: string): boolean {
  const normalized = key.toLowerCase();
  const target = match.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const compactTarget = target.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const keyParts = compact.split("-").filter(Boolean);
  const targetParts = compactTarget.split("-").filter(Boolean);
  const keyTheme = keyParts.some((part) => /^(dark|black|inverse|night|aubergine)$/.test(part)) ? "dark"
    : keyParts.some((part) => /^(light|white)$/.test(part)) ? "light"
      : null;
  const targetTheme = targetParts.some((part) => /^(dark|black|inverse|night|aubergine)$/.test(part)) ? "dark"
    : targetParts.some((part) => /^(light|white)$/.test(part)) ? "light"
      : null;
  const targetIsBaseSurface = targetParts.some((part) => /^(canvas|surface|background|card|text|ink|body|foreground)$/.test(part));
  if (keyTheme && !targetTheme && targetIsBaseSurface) return false;
  if (keyTheme && targetTheme && keyTheme !== targetTheme) return false;
  if (compact === compactTarget || normalized === target) return true;
  // When the target is a single theme indicator (dark/light/black/white/etc.),
  // only match if the token's first part is that theme — prevents text tokens
  // like "on-dark" or "text-light" from matching as canvas/surface colors.
  const singleThemeTarget = targetParts.length === 1 && targetTheme !== null;
  if (singleThemeTarget) return keyParts[0] === compactTarget;
  return keyParts.includes(compactTarget);
}

function tokenColor(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
  for (const match of matches) {
    const found = tokens.find((token) => tokenKeyMatches(token.key, match));
    if (isSafeColorValue(found?.resolvedValue)) return found.resolvedValue.trim();
  }
  return fallback;
}

function tokenValue(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
  for (const match of matches) {
    const found = tokens.find((token) => tokenKeyMatches(token.key, match));
    if (found && !isUnsafeDesignMdStyleValue(found.resolvedValue)) return found.resolvedValue.trim();
  }
  return fallback;
}

function deriveTokens(board: DesignMdBoard, variant: GeneratedPreviewVariant = "light") {
  const allColors = board.colorGroups.flatMap((group) => group.tokens);
  const paletteDark = darkestPaletteColor(allColors, "#0b0e11");
  const paletteLight = lightestPaletteColor(allColors, "#ffffff");
  const fallbackDarkCanvas = isDarkColor(paletteDark) ? paletteDark : "#0b0e11";
  const fallbackDarkSurface = mixHexColor(fallbackDarkCanvas, "#ffffff", 0.1) ?? "#1f2329";
  const pickedLightCanvas = tokenColor(allColors, ["canvas-light", "background-light", "white", "background", "canvas", "surface-light"], paletteLight);
  const lightCanvas = isDarkColor(pickedLightCanvas) ? paletteLight : pickedLightCanvas;
  const pickedLightSurface = tokenColor(allColors, ["surface-light", "surface-card-light", "white", "surface-card", "surface", "card"], isLightColor(lightCanvas) ? "#f6f7f9" : mixHexColor(lightCanvas, "#ffffff", 0.08) ?? "#f6f7f9");
  const lightSurface = isDarkColor(pickedLightSurface) ? (mixHexColor(lightCanvas, "#000000", 0.04) ?? "#f6f7f9") : pickedLightSurface;
  const darkCanvas = tokenColor(allColors, ["canvas-dark", "background-dark", "surface-black", "black", "dark-surface", "dark"], fallbackDarkCanvas);
  const darkSurface = tokenColor(allColors, ["surface-dark", "surface-card-dark", "elevated-dark", "card-dark", "surface-black", "black"], fallbackDarkSurface);
  const primary = tokenColor(allColors, ["primary", "brand", "accent", "green", "blue", "red", "yellow"], "#2563eb");
  const lightText = ensureReadable(tokenColor(allColors, ["ink", "text-on-light", "body-on-light", "text", "body", "foreground", "black"], "#111111"), lightCanvas, "#111111");
  const onDark = ensureReadable(tokenColor(allColors, ["on-dark", "body-on-dark", "text-on-dark", "on-black", "white"], "#f8fafc"), darkCanvas, "#f8fafc");
  const canvas = variant === "dark" ? darkCanvas : lightCanvas;
  const surface = variant === "dark" ? darkSurface : lightSurface;
  const text = ensureReadable(variant === "dark" ? onDark : lightText, canvas, variant === "dark" ? "#f8fafc" : "#111111");
  const muted = ensureReadable(tokenColor(allColors, variant === "dark" ? ["muted-on-dark", "on-dark-muted", "muted"] : ["muted", "secondary", "soft"], variant === "dark" ? "#a7adb8" : "#667085"), canvas, variant === "dark" ? "#a7adb8" : "#667085");
  const border = tokenColor(allColors, variant === "dark" ? ["hairline-dark", "border-dark", "divider-dark", "hairline", "border"] : ["hairline", "border", "divider"], variant === "dark" ? mixHexColor(surface, "#ffffff", 0.16) ?? "#30363d" : "#d7dce2");
  const onPrimary = ensureReadable(tokenColor(allColors, ["on-primary"], readableTextColor(primary)), primary, readableTextColor(primary));
  const radius = cssSize(tokenValue(board.radiusTokens, ["md", "lg", "sm"], "10px"), "10px");
  const pill = cssSize(tokenValue(board.radiusTokens, ["pill", "full"], "9999px"), "9999px");
  const spacing = cssSpacing(tokenValue(board.spacingTokens, ["lg", "md", "base"], "24px"), "24px");
  return { variant, canvas, surface, text, muted, border, primary, onPrimary, onDark, darkCanvas, darkSurface, radius, pill, spacing };
}

function typographyCss(board: DesignMdBoard, matches: string[], fallbackSize: string) {
  const token = board.typographyTokens.find((t) => matches.some((match) => t.key.toLowerCase().includes(match))) ?? board.typographyTokens[0];
  return {
    family: cssPreviewFont(token?.fontFamily, board, token?.raw),
    size: cssFontSize(token?.fontSize, fallbackSize, 40),
    weight: cssText(token?.fontWeight, "600"),
    lineHeight: cssText(token?.lineHeight, "1.15"),
  };
}

function componentsOfKind(board: DesignMdBoard, kind: string): DesignMdBoardComponentGroup[] {
  return board.componentGroups.filter((g) =>
    g.kind === kind &&
    g.sourceEvidence &&
    g.sourceEvidence.confidence !== "fallback"
  );
}

function hasButtonTokens(board: DesignMdBoard): boolean {
  const buttons = componentsOfKind(board, "button");
  return buttons.some((g) => {
    const eligibility = checkRenderEligibility(g);
    return eligibility.canRenderGraphic && eligibility.safeStyleCount >= 2;
  });
}

function renderButtonLabel(group: DesignMdBoardComponentGroup): string {
  // Prefer actual component/token name
  const name = group.name;
  if (/button/.test(name.toLowerCase())) return esc(name);
  // Neutral label as token-label chrome only
  return esc(name || "Button");
}

/**
 * Render a single button sample for the hero. Only used for button-kinded components
 * that pass render eligibility and have actual source-backed style tokens.
 */
function renderHeroButton(group: DesignMdBoardComponentGroup, colors: ReturnType<typeof deriveTokens>): string {
  const eligibility = checkRenderEligibility(group);
  if (!eligibility.canRenderGraphic) return "";
  const bg = cssColor(group.backgroundColor, colors.primary);
  const fg = ensureReadable(
    cssColor(group.textColor, colors.onPrimary),
    bg,
    colors.onPrimary
  );
  const radius = cssSize(group.rounded, colors.radius);
  const padding = cssSpacing(group.padding, "10px 20px");
  const label = renderButtonLabel(group);
  return '<button class="hero-btn" style="background:' + bg + ';color:' + fg + ';border-radius:' + radius + ';padding:' + padding + '">' + label + '</button>';
}

function neutralKind(kind: string): string {
  return kind.replace(/-/g, " ");
}

// ── Section renderers ──

function renderHero(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>, display: ReturnType<typeof typographyCss>): string {
  const title = esc(board.title);
  const slug = esc(board.slug);
  const archetype = esc(board.archetype.replace(/_/g, " "));
  const state = board.confidence.lightPreview === "low" || board.coverage.colorsCount < 3 ? "source-limited" : "source-backed";
  const note = board.overview ?? board.visualLanguage.phrases[0] ?? board.description;
  const description = note ? '<p class="hero-desc">' + esc(note.length > 280 ? note.slice(0, 277) + "..." : note) + '</p>' : '';

  const evidence = [
    board.coverage.colorsCount + ' colors',
    board.coverage.typographyCount + ' type',
    board.coverage.componentCount + ' components',
    evidenceLabel(board.archetypeEvidence),
  ].map((item) => '<span>' + esc(item) + '</span>').join("");

  // Button rendering: only when DESIGN.md contains actual button tokens
  let buttonHtml = '';
  if (hasButtonTokens(board)) {
    const buttons = componentsOfKind(board, "button");
    const eligible = buttons
      .map((g) => ({ group: g, eligibility: checkRenderEligibility(g) }))
      .filter((r) => r.eligibility.canRenderGraphic && r.eligibility.safeStyleCount >= 2)
      .slice(0, 2);
    if (eligible.length > 0) {
      buttonHtml = '<div class="hero-buttons">' + eligible.map(({ group }) => renderHeroButton(group, colors)).join("") + '</div>';
    }
  }

  // Small palette preview strip
  const paletteSwatches = board.colorGroups.flatMap(g => g.tokens).slice(0, 6)
    .map(t => '<i class="hero-swatch" style="background:' + cssColor(t.resolvedValue, "#d8d8d8") + '"></i>').join("");
  const paletteStrip = paletteSwatches ? '<div class="hero-palette-strip">' + paletteSwatches + '</div>' : '';

  return '<section class="hero">' +
    '<div class="hero-inner">' +
    '<div class="hero-text">' +
    '<span class="hero-kicker">' + archetype + ' · ' + state + '</span>' +
    '<h1 class="hero-title" style="font-family:' + display.family + ';font-size:clamp(28px,' + display.size + ',52px);font-weight:' + display.weight + ';line-height:' + display.lineHeight + ';letter-spacing:0">' + title + '</h1>' +
    '<span class="hero-meta">' + slug + '</span>' +
    description +
    '<div class="hero-evidence">' + evidence + '</div>' +
    buttonHtml +
    '</div>' +
    (paletteStrip ? '<div class="hero-visual">' + paletteStrip + '</div>' : '') +
    '</div>' +
    '</section>';
}

function renderPalette(board: DesignMdBoard): string {
  const tokens = board.colorGroups.flatMap((group) => group.tokens.map((token) => ({ ...token, group: group.prefix })));
  if (tokens.length === 0) return "";
  const visible = tokens.slice(0, 24);
  return '<section class="strip" id="palette">' +
    '<header><h3>Palette</h3><span>' + tokens.length + ' colors</span></header>' +
    '<div class="palette-grid">' +
    visible.map((token) =>
      '<div class="swatch">' +
      '<i style="background:' + cssColor(token.resolvedValue, "#d8d8d8") + '"></i>' +
      '<b>' + esc(token.key) + '</b>' +
      '<small>' + esc(token.group) + '</small>' +
      '</div>'
    ).join("") +
    '</div></section>';
}

function renderTypography(board: DesignMdBoard): string {
  const tokens = board.typographyTokens.slice(0, 10);
  if (tokens.length === 0) return "";
  return '<section class="strip" id="typography">' +
    '<header><h3>Typography</h3><span>' + tokens.length + ' tokens</span></header>' +
    '<div class="type-grid">' +
    tokens.map((token) => {
      const style = [
        "font-family:" + cssPreviewFont(token.fontFamily, board, token.raw),
        "font-size:" + cssFontSize(token.fontSize, "18px", 32),
        "font-weight:" + cssText(token.fontWeight, "500"),
        "line-height:" + cssText(token.lineHeight, "1.25"),
        "letter-spacing:0",
      ].join(";");
      return '<div class="type-row">' +
        '<small>' + esc(token.key) + '</small>' +
        '<span style="' + style + '">' + esc(token.key) + '</span>' +
        '<em>' + esc(evidenceLabel(token.sourceEvidence)) + '</em>' +
        '</div>';
    }).join("") +
    '</div>' +
    (board.fontSubstitutes ? '<div class="strip-note">Font substitutes: ' + esc(board.fontSubstitutes.slice(0, 200)) + '</div>' : '') +
    '</section>';
}

function renderRadiusSpacing(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const radius = board.radiusTokens.slice(0, 8).map((token) =>
    '<div class="radius-cell" style="border-radius:' + cssSize(token.resolvedValue, "0px") + '">' + esc(token.key) + '</div>'
  ).join("");
  const spacing = board.spacingTokens.slice(0, 8).map((token) =>
    '<div class="space-row">' +
    '<span>' + esc(token.key) + '</span>' +
    '<i style="width:' + cssSize(token.resolvedValue, "8px") + '"></i>' +
    '<small>' + esc(token.resolvedValue) + '</small>' +
    '</div>'
  ).join("");
  if (!radius && !spacing) return "";
  return '<section class="strip" id="radius-spacing">' +
    '<header><h3>Radius &amp; Spacing</h3><span>source tokens</span></header>' +
    '<div class="rhythm-grid">' +
    '<div class="radius-grid">' + radius + '</div>' +
    '<div style="color:' + colors.text + '">' + spacing + '</div>' +
    '</div></section>';
}

function renderLayout(board: DesignMdBoard): string {
  const notes = [
    board.layout,
    board.overview,
    ...board.visualLanguage.phrases,
  ].filter((note): note is string => !!note && note.length > 20).slice(0, 5);
  if (notes.length === 0) return "";
  return '<section class="strip notes-strip" id="layout">' +
    '<header><h3>Layout</h3><span>source-derived</span></header>' +
    '<ul>' + notes.map((note) =>
      '<li>' + esc(note.length > 240 ? note.slice(0, 237) + "..." : note) + '</li>'
    ).join("") + '</ul>' +
    '</section>';
}

function renderSourceNotes(board: DesignMdBoard): string {
  const sections: string[] = [];

  // Visual language notes
  const phrases = board.visualLanguage.phrases.slice(0, 4);
  const keywords = board.visualLanguage.keywords.slice(0, 8);
  if (phrases.length > 0 || keywords.length > 0) {
    let langHtml = '<div class="src-section"><h4>Visual language</h4>';
    if (keywords.length > 0) {
      langHtml += '<div class="src-keywords">' + keywords.map((k) => '<span>' + esc(k) + '</span>').join("") + '</div>';
    }
    if (phrases.length > 0) {
      langHtml += '<ul class="src-phrases">' + phrases.map((p) => '<li>' + esc(p.length > 180 ? p.slice(0, 177) + "..." : p) + '</li>').join("") + '</ul>';
    }
    langHtml += '</div>';
    sections.push(langHtml);
  }

  // Do / Don't
  const dos = board.guardrailDos.slice(0, 5);
  const donts = board.guardrailDonts.slice(0, 5);
  if (dos.length > 0 || donts.length > 0) {
    let ddHtml = '<div class="src-section"><h4>Do / Don&apos;t</h4><div class="do-dont">';
    if (dos.length > 0) {
      ddHtml += '<ul class="do-list">' + dos.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>';
    }
    if (donts.length > 0) {
      ddHtml += '<ul class="dont-list">' + donts.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>';
    }
    ddHtml += '</div></div>';
    sections.push(ddHtml);
  }

  // Component inventory (names only, not rendered library)
  const meaningful = board.componentGroups.filter((g) => g.sourceEvidence && g.sourceEvidence.confidence !== "fallback");
  if (meaningful.length > 0) {
    const sorted = [...meaningful].sort((a, b) => a.name.localeCompare(b.name));
    let invHtml = '<div class="src-section"><h4>Component inventory</h4>' +
      '<div class="src-inventory">' +
      sorted.slice(0, 20).map((g) => {
        const name = esc(g.name);
        const kind = esc(neutralKind(g.kind));
        const evidence = esc(evidenceLabel(g.sourceEvidence));
        return '<div class="inv-item"><b>' + name + '</b><span>' + kind + '</span><em>' + evidence + '</em></div>';
      }).join("") +
      '</div></div>';
    sections.push(invHtml);
  }

  // Source limitations / warnings
  if (board.warnings.length > 0) {
    let warnHtml = '<div class="src-section"><h4>Source limitations</h4>' +
      '<ul class="src-warnings">' +
      board.warnings.map((w) => '<li>' + esc(w) + '</li>').join("") +
      '</ul></div>';
    sections.push(warnHtml);
  }

  if (sections.length === 0) return "";
  return '<section class="strip notes-strip" id="source-notes">' +
    '<header><h3>Source notes</h3><span>' + sections.length + ' sections</span></header>' +
    '<div class="src-body">' + sections.join("") + '</div>' +
    '</section>';
}

// ── Main generator ──

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
    ]}],
    palette: [],
    typographyTokens: [],
    radiusTokens: [],
    spacingTokens: [],
    componentGroups: [],
    visualLanguage: { phrases: spec.overview ? [spec.overview] : [], keywords: [] },
    archetype: "generic_system",
    archetypeEvidence: { sourceType: "derived-fallback", sourcePath: "legacy-specimen", confidence: "fallback", text: "legacy specimen fallback" },
    overview: spec.overview,
    layout: null,
    fontSubstitutes: "",
    guardrailDos: [],
    guardrailDonts: [],
    coverage: {
      colorsCount: 4,
      markdownColorsCount: 0,
      typographyCount: 0,
      radiusCount: 0,
      spacingCount: 0,
      componentCount: 0,
      componentKinds: {},
      fontFamilies: [],
      markdownSections: [],
      darkTokenCount: 0,
      darkComponentCount: 0,
      componentGroupsWithEvidenceCount: 0,
      fontSubstituteHintsCount: 0,
    },
    confidence: { archetype: "low", lightPreview: "low", darkPreview: "low", components: "low" },
    warnings: ["generic archetype fallback", "dark tokens derived"],
  }, { variant: "light" });
}

export function generateBoardHtml(board: DesignMdBoard, options: { variant?: GeneratedPreviewVariant } = {}): string {
  const colors = deriveTokens(board, options.variant ?? "light");
  const display = typographyCss(board, ["hero", "display-xl", "display-lg", "display"], "38px");
  const body = typographyCss(board, ["body", "text"], "15px");
  const caption = typographyCss(board, ["caption", "label", "small"], "12px");

  const css = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    "html,body{width:100%;height:100%;min-height:100%;overflow:auto}",
    "body{font-family:" + body.family + ";font-size:" + body.size + ";font-weight:" + body.weight + ";line-height:1.5;letter-spacing:0;background:" + colors.canvas + ";color:" + colors.text + ";-webkit-font-smoothing:antialiased}",
    ".board{min-height:100%;background:" + colors.canvas + ";color:" + colors.text + "}",

    // ── Hero ──
    ".hero{padding:" + colors.spacing + " " + colors.spacing + ";background:" + colors.surface + "}",
    ".hero-inner{display:flex;gap:24px;align-items:flex-start;max-width:960px;margin:0 auto}",
    ".hero-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}",
    ".hero-kicker{color:" + colors.primary + ";font-size:" + caption.size + ";font-weight:700;text-transform:uppercase;letter-spacing:.04em}",
    ".hero-title{color:" + colors.text + "}",
    ".hero-meta{color:" + colors.muted + ";font-size:" + caption.size + "}",
    ".hero-desc{color:" + colors.muted + ";max-width:560px;line-height:1.55}",
    ".hero-evidence{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}",
    ".hero-evidence span{border:1px solid " + colors.border + ";border-radius:" + colors.pill + ";padding:3px 8px;color:" + colors.muted + ";font-size:" + caption.size + "}",
    ".hero-buttons{display:flex;gap:8px;margin-top:4px;flex-wrap:wrap}",
    ".hero-btn{border:none;cursor:default;font-family:" + body.family + ";font-size:" + body.size + ";font-weight:600;border:1px solid transparent;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".hero-visual{flex-shrink:0;display:flex;align-items:flex-start;gap:6px;padding-top:4px}",
    ".hero-palette-strip{display:flex;flex-wrap:wrap;gap:4px;max-width:180px}",
    ".hero-swatch{display:block;width:28px;height:28px;border-radius:6px;border:1px solid rgba(127,127,127,.25);flex-shrink:0}",

    // ── Section strips ──
    ".strip{padding:" + colors.spacing + ";border-top:1px solid " + colors.border + ";max-width:960px;margin:0 auto}",
    ".strip header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}",
    ".strip h3{font-family:" + display.family + ";font-size:18px;font-weight:" + display.weight + "}",
    ".strip header span{font-size:" + caption.size + ";color:" + colors.muted + "}",
    ".strip-note{font-size:" + caption.size + ";color:" + colors.muted + ";margin-top:10px;padding-top:8px;border-top:1px solid " + colors.border + ";line-height:1.4}",

    // ── Palette ──
    ".palette-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}",
    ".swatch{min-height:84px;border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:8px;background:" + colors.surface + ";overflow:hidden}",
    ".swatch i{display:block;height:32px;border-radius:6px;margin-bottom:8px;border:1px solid rgba(127,127,127,.25)}",
    ".swatch b,.swatch small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".swatch small{color:" + colors.muted + ";font-size:10px}",

    // ── Typography ──
    ".type-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}",
    ".type-row{border-bottom:1px solid " + colors.border + ";padding:10px 0}",
    ".type-row small,.type-row em{display:block;color:" + colors.muted + ";margin-bottom:4px;font-size:10px;font-style:normal}",
    ".type-row span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

    // ── Radius & Spacing ──
    ".rhythm-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}",
    ".radius-grid{display:flex;flex-wrap:wrap;gap:8px}",
    ".radius-cell{width:58px;height:58px;display:grid;place-items:center;background:" + colors.surface + ";border:1px solid " + colors.border + ";font-size:10px;color:" + colors.muted + "}",
    ".space-row{display:flex;align-items:center;gap:10px;margin:7px 0}",
    ".space-row span{width:70px;font-size:" + caption.size + "}",
    ".space-row i{display:block;height:10px;background:" + colors.primary + ";border-radius:999px;min-width:4px}",
    ".space-row small{font-size:10px;color:" + colors.muted + "}",

    // ── Layout notes ──
    ".notes-strip ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 20px;padding-left:18px;color:" + colors.muted + ";font-size:" + body.size + ";line-height:1.45}",

    // ── Source notes ──
    ".src-body{display:flex;flex-direction:column;gap:16px}",
    ".src-section h4{font-size:12px;font-weight:600;color:" + colors.text + ";margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}",
    ".src-keywords{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}",
    ".src-keywords span{border:1px solid " + colors.border + ";border-radius:" + colors.pill + ";padding:2px 8px;color:" + colors.muted + ";font-size:10px}",
    ".src-phrases{color:" + colors.muted + ";font-size:" + caption.size + ";padding-left:16px;line-height:1.45}",
    ".src-phrases li{margin-bottom:4px}",
    ".do-dont{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
    ".do-list{color:" + colors.muted + ";padding-left:16px;font-size:" + caption.size + ";line-height:1.45}",
    ".do-list li{margin-bottom:3px}",
    ".dont-list{color:" + colors.muted + ";padding-left:16px;font-size:" + caption.size + ";line-height:1.45}",
    ".dont-list li{margin-bottom:3px}",
    ".src-inventory{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}",
    ".inv-item{display:flex;align-items:baseline;gap:8px;padding:5px 8px;border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";font-size:" + caption.size + "}",
    ".inv-item b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}",
    ".inv-item span{color:" + colors.muted + ";flex-shrink:0}",
    ".inv-item em{color:" + colors.muted + ";font-size:9px;margin-left:auto;flex-shrink:0}",
    ".src-warnings{color:" + colors.muted + ";font-size:" + caption.size + ";padding-left:16px;line-height:1.4}",
    ".src-warnings li{margin-bottom:3px}",

    // ── Responsive ──
    "@media(max-width:760px){.hero-inner{flex-direction:column}.hero-visual{width:100%}.hero-palette-strip{max-width:100%}.palette-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.type-grid,.rhythm-grid,.notes-strip ul,.do-dont,.src-inventory{grid-template-columns:1fr}}",
    "@media(max-width:960px){.strip{padding-left:16px;padding-right:16px}}",
  ].join("\n");

  const html = [
    '<div class="board">',
    renderHero(board, colors, display),
    renderPalette(board),
    renderTypography(board),
    renderRadiusSpacing(board, colors),
    renderLayout(board),
    renderSourceNotes(board),
    '</div>',
  ].join("\n");

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' + CSP + '\n<style>' + css + '</style>\n</head>\n<body>\n' + html + '\n</body>\n</html>';
}
