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
  graphicalComponents,
  compactComponents,
  type ComponentRenderEligibility,
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

function componentColors(group: DesignMdBoardComponentGroup | undefined, colors: ReturnType<typeof deriveTokens>) {
  let bg = cssColor(group?.backgroundColor, colors.surface);
  let fg = cssColor(group?.textColor, colors.text);
  if (colors.variant === "dark" && (!group?.backgroundColor || isLightColor(bg))) bg = colors.surface;
  if (colors.variant === "dark" && (!group?.textColor || (isDarkColor(fg) && isDarkColor(bg)))) fg = colors.text;
  fg = ensureReadable(fg, bg, readableTextColor(bg));
  return {
    bg,
    fg,
    border: cssColor(group?.borderColor, colors.border),
    radius: cssSize(group?.rounded, colors.radius),
    padding: cssSpacing(group?.padding, "12px 16px"),
  };
}

function prioritizedComponentGroups(board: DesignMdBoard): DesignMdBoardComponentGroup[] {
  const meaningful = board.componentGroups.filter((group) => group.sourceEvidence && group.sourceEvidence.confidence !== "fallback");
  return [...meaningful].sort((a, b) => a.name.localeCompare(b.name));
}

function neutralKind(kind: string): string {
  return kind.replace(/-/g, " ");
}

/**
 * Render a compact source-derived token row for a component that does not qualify for graphical rendering.
 */
function componentCompactRowHtml(group: DesignMdBoardComponentGroup, eligibility: ComponentRenderEligibility): string {
  const name = esc(group.name);
  const kind = esc(neutralKind(group.kind));
  const evidence = esc(evidenceLabel(group.sourceEvidence));
  const styleCount = eligibility.safeStyleCount;
  const props: string[] = [];
  if (group.backgroundColor) props.push("bg:" + esc(group.backgroundColor.slice(0, 7)));
  if (group.textColor) props.push("fg:" + esc(group.textColor.slice(0, 7)));
  if (group.rounded) props.push("r:" + esc(group.rounded));
  if (group.padding) props.push("p:" + esc(group.padding));
  const propsStr = props.length > 0 ? props.join(" ") : "no source styles";
  return '<div class="compact-row"><b>' + name + '</b><span>' + kind + '</span><code>' + propsStr + '</code><small>' + evidence + ' · ' + styleCount + ' styles · ' + esc(eligibility.reason) + '</small></div>';
}

/**
 * Render a graphical sample for a component. Only call after checking render eligibility.
 */
function componentSampleHtml(group: DesignMdBoardComponentGroup, colors: ReturnType<typeof deriveTokens>): string {
  const eligibility = checkRenderEligibility(group);
  if (!eligibility.canRenderGraphic) {
    return componentCompactRowHtml(group, eligibility);
  }
  const style = componentColors(group, colors);
  const name = esc(group.name);
  const meta = esc(neutralKind(group.kind));
  if (group.kind === "button") {
    return '<button class="sample sample-button" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + ';padding:' + style.padding + '">' + name + '</button>';
  }
  if (group.kind === "search" || group.kind === "input" || group.kind === "prompt-input") {
    return '<div class="sample sample-input" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><span>' + name + '</span><i></i></div>';
  }
  if (group.kind === "chip" || group.kind === "badge") {
    return '<span class="sample sample-chip" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + colors.pill + '">' + name + '</span>';
  }
  if (group.kind === "terminal-panel" || group.kind === "code-panel") {
    return '<div class="sample sample-code" style="background:' + (group.kind === "terminal-panel" ? colors.darkCanvas : style.bg) + ';color:' + (group.kind === "terminal-panel" ? colors.onDark : style.fg) + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><code>' + esc(Object.keys(group.raw).slice(0, 2).join(" · ") || meta) + '</code></div>';
  }
  if (group.kind === "workflow-step") {
    return '<div class="sample sample-workflow" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><span>' + meta + '</span></div>';
  }
  if (group.kind === "market-table" || group.kind === "table") {
    return '<div class="sample sample-table" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><span><i>' + meta + '</i><strong>' + esc(evidenceLabel(group.sourceEvidence)) + '</strong></span></div>';
  }
  if (group.kind === "chart") {
    return '<div class="sample sample-chart" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><div><i></i><i></i><i></i><i></i></div></div>';
  }
  if (group.kind === "nav" || group.kind === "subnav") {
    return '<div class="sample sample-nav" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><span>' + meta + '</span></div>';
  }
  return '<div class="sample sample-card" style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><b>' + name + '</b><small>' + meta + '</small></div>';
}

function renderSourceHeader(board: DesignMdBoard): string {
  const keywords = board.visualLanguage.keywords.slice(0, 5).map((keyword) => '<i>' + esc(keyword) + '</i>').join("");
  const state = board.confidence.lightPreview === "low" || board.coverage.componentCount === 0 ? "source-limited" : "source-backed";
  return '<div class="board-meta"><div><strong>' + esc(board.title) + '</strong><span> · ' + esc(board.slug) + ' · ' + esc(board.archetype) + ' · ' + state + '</span></div><div class="keywords">' + keywords + '</div></div>';
}

function renderSourcePatternBoard(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const allGroups = prioritizedComponentGroups(board).slice(0, 16);
  const eligible = graphicalComponents(allGroups);
  const note = board.overview ?? board.layout ?? board.visualLanguage.phrases[0] ?? board.description;
  const evidence = [
    `${board.coverage.colorsCount} colors`,
    `${board.coverage.typographyCount} type`,
    `${board.coverage.componentCount} components`,
    evidenceLabel(board.archetypeEvidence),
  ].map((item) => '<span>' + esc(item) + '</span>').join("");

  // No graphical components eligible - render a clean source-derived board
  if (eligible.length === 0) {
    const paletteStrip = board.colorGroups.flatMap(g => g.tokens).slice(0, 8)
      .map(t => '<i class="hero-swatch" style="background:' + cssColor(t.resolvedValue, "#d8d8d8") + '"></i>').join("");
    const typeSample = board.typographyTokens.slice(0, 2)
      .map(t => '<span class="hero-type" style="font-family:' + cssPreviewFont(t.fontFamily, board, t.raw) + ';font-size:' + cssFontSize(t.fontSize, "22px", 32) + '">' + esc(t.key) + '</span>').join("");
    const compactAll = compactComponents(allGroups);
    const compactRows = compactAll.length > 0
      ? '<div class="compact-inventory">' + compactAll.map(({ component, eligibility }) => componentCompactRowHtml(component, eligibility)).join("") + '</div>'
      : '';
    return '<section class="hero hero-board"><div class="source-copy"><span class="source-kicker">' + esc(board.archetype.replace(/_/g, " ")) + '</span><h2>' + esc(board.title) + '</h2>' + (note ? '<p>' + esc(note.length > 240 ? note.slice(0, 237) + "..." : note) + '</p>' : '') + '<div class="source-evidence">' + evidence + '</div></div>' +
      '<div class="board-strips">' +
      (paletteStrip ? '<div class="board-strip"><b>Palette</b><div class="hero-palette">' + paletteStrip + '</div></div>' : '') +
      (typeSample ? '<div class="board-strip"><b>Typography</b><div class="hero-type-row">' + typeSample + '</div></div>' : '') +
      (compactRows ? '<div class="board-strip"><b>Component inventory</b>' + compactRows + '</div>' : '') +
      '</div></section>';
  }

  // At least one graphical component - use the existing hero layout
  const lead = eligible[0].component;
  const leadStyle = componentColors(lead, colors);
  const leadHtml = '<article class="source-lead" style="background:' + leadStyle.bg + ';color:' + leadStyle.fg + ';border-color:' + leadStyle.border + ';border-radius:' + leadStyle.radius + '"><small>' + esc(neutralKind(lead.kind)) + '</small><b>' + esc(lead.name) + '</b>' + componentSampleHtml(lead, colors) + '</article>';

  const restEligible = eligible.slice(1, 5);
  let restHtml = restEligible.map(({ component }) => {
    const style = componentColors(component, colors);
    return '<article style="background:' + style.bg + ';color:' + style.fg + ';border-color:' + style.border + ';border-radius:' + style.radius + '"><small>' + esc(neutralKind(component.kind)) + '</small><b>' + esc(component.name) + '</b></article>';
  }).join("");

  return '<section class="hero hero-source hero-source-' + esc(board.archetype) + '"><div class="source-copy"><span class="source-kicker">' + esc(board.archetype.replace(/_/g, " ")) + '</span><h2>' + esc(board.title) + '</h2>' + (note ? '<p>' + esc(note.length > 240 ? note.slice(0, 237) + "..." : note) + '</p>' : '') + '<div class="source-evidence">' + evidence + '</div></div><div class="source-components">' + leadHtml + restHtml + '</div></section>';
}

function renderSourcePalette(board: DesignMdBoard): string {
  const tokens = board.colorGroups.flatMap((group) => group.tokens.map((token) => ({ ...token, group: group.prefix })));
  if (tokens.length === 0) return "";
  const visible = tokens.slice(0, 20);
  return '<section class="strip"><header><b>Palette</b><span>' + tokens.length + ' colors</span></header><div class="palette-grid">' + visible.map((token) => '<div class="swatch"><i style="background:' + cssColor(token.resolvedValue, "#d8d8d8") + '"></i><b>' + esc(token.key) + '</b><small>' + esc(token.group) + '</small></div>').join("") + '</div></section>';
}

function renderSourceTypography(board: DesignMdBoard): string {
  const tokens = board.typographyTokens.slice(0, 10);
  if (tokens.length === 0) return "";
  return '<section class="strip"><header><b>Typography</b><span>source tokens</span></header><div class="type-grid">' + tokens.map((token) => {
    const style = [
      "font-family:" + cssPreviewFont(token.fontFamily, board, token.raw),
      "font-size:" + cssFontSize(token.fontSize, "18px", 32),
      "font-weight:" + cssText(token.fontWeight, "500"),
      "line-height:" + cssText(token.lineHeight, "1.25"),
      "letter-spacing:0",
    ].join(";");
    return '<div class="type-row"><small>' + esc(token.key) + '</small><span style="' + style + '">' + esc(token.key) + '</span><em>' + esc(evidenceLabel(token.sourceEvidence)) + '</em></div>';
  }).join("") + '</div></section>';
}

function renderSourceRadiusSpacing(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const radius = board.radiusTokens.slice(0, 8).map((token) => '<div class="radius-cell" style="border-radius:' + cssSize(token.resolvedValue, "0px") + '">' + esc(token.key) + '</div>').join("");
  const spacing = board.spacingTokens.slice(0, 8).map((token) => '<div class="space-row"><span>' + esc(token.key) + '</span><i style="width:' + cssSize(token.resolvedValue, "8px") + '"></i><small>' + esc(token.resolvedValue) + '</small></div>').join("");
  if (!radius && !spacing) return "";
  return '<section class="strip"><header><b>Radius & spacing</b><span>source tokens</span></header><div class="rhythm-grid"><div class="radius-grid">' + radius + '</div><div style="color:' + colors.text + '">' + spacing + '</div></div></section>';
}

function renderSourceComponentGallery(board: DesignMdBoard, colors: ReturnType<typeof deriveTokens>): string {
  const allGroups = prioritizedComponentGroups(board).slice(0, 18);
  if (allGroups.length === 0) return "";

  const gfx = graphicalComponents(allGroups.map(g => g));
  const compact = compactComponents(allGroups.map(g => g));

  let html = '<section class="strip"><header><b>Components</b><span>' + allGroups.length + ' source-backed groups</span></header>';

  // Graphical component samples
  if (gfx.length > 0) {
    html += '<div class="component-grid">' + gfx.map(({ component }) => {
      return '<article><label>' + esc(component.name) + '</label>' + componentSampleHtml(component, colors) + '</article>';
    }).join("") + '</div>';
  }

  // Compact rows for non-graphical components
  if (compact.length > 0) {
    html += '<div class="compact-inventory" style="margin-top:' + (gfx.length > 0 ? '14px' : '0') + '"><div class="compact-section-label" style="color:' + colors.muted + ';font-size:10px;text-transform:uppercase;margin-bottom:6px">compact source rows</div>' + compact.map(({ component, eligibility }) => componentCompactRowHtml(component, eligibility)).join("") + '</div>';
  }

  // If no eligible graphical components but we have compact ones, note why
  if (gfx.length === 0 && compact.length > 0) {
    // compact inventory is already shown above
  }

  html += '</section>';
  return html;
}

function renderSourceLayoutNotes(board: DesignMdBoard): string {
  const notes = [board.layout, board.overview, ...board.visualLanguage.phrases].filter((note): note is string => !!note).slice(0, 5);
  if (notes.length === 0) return "";
  return '<section class="strip notes-strip"><header><b>Layout</b><span>source notes</span></header><ul>' + notes.map((note) => '<li>' + esc(note.length > 220 ? note.slice(0, 217) + "..." : note) + '</li>').join("") + '</ul></section>';
}

function renderSourceDoDont(board: DesignMdBoard): string {
  const dos = board.guardrailDos.slice(0, 5);
  const donts = board.guardrailDonts.slice(0, 5);
  if (dos.length === 0 && donts.length === 0) return "";
  return '<section class="strip notes-strip"><header><b>Source notes</b><span>do/don&apos;t</span></header><div class="do-dont">' +
    '<ul>' + dos.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>' +
    '<ul>' + donts.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>' +
    '</div></section>';
}

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
    "body{font-family:" + body.family + ";font-size:" + body.size + ";font-weight:" + body.weight + ";line-height:1.45;letter-spacing:0;background:" + colors.canvas + ";color:" + colors.text + ";-webkit-font-smoothing:antialiased}",
    ".board{min-height:100%;background:" + colors.canvas + ";color:" + colors.text + "}",
    ".board-meta{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;border-bottom:1px solid " + colors.border + ";background:" + colors.canvas + ";position:sticky;top:0;z-index:2}",
    ".board-meta strong{font-size:13px}.board-meta span{font-size:" + caption.size + ";color:" + colors.muted + "}.keywords{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.keywords i{font-style:normal;border:1px solid " + colors.border + ";border-radius:" + colors.pill + ";padding:3px 8px;color:" + colors.muted + "}",
    ".hero-source{min-height:300px;display:grid;grid-template-columns:minmax(0,.86fr) minmax(320px,1.14fr);gap:18px;align-items:stretch;padding:" + colors.spacing + ";background:" + colors.canvas + "}.source-copy{display:flex;flex-direction:column;justify-content:center;gap:12px;min-width:0}.source-kicker{color:" + colors.primary + ";font-size:" + caption.size + ";font-weight:700;text-transform:uppercase}.source-copy h2{font-family:" + display.family + ";font-size:clamp(28px," + display.size + ",56px);font-weight:" + display.weight + ";line-height:" + display.lineHeight + ";letter-spacing:0}.source-copy p{color:" + colors.muted + ";max-width:660px}.source-evidence{display:flex;flex-wrap:wrap;gap:7px;margin-top:4px}.source-evidence span{border:1px solid " + colors.border + ";border-radius:" + colors.pill + ";padding:4px 8px;color:" + colors.muted + ";font-size:" + caption.size + "}",
    ".source-components{display:grid;grid-template-columns:1.15fr .85fr;grid-auto-rows:minmax(92px,auto);gap:10px}.source-components article{border:1px solid " + colors.border + ";padding:13px;min-width:0;overflow:hidden;display:flex;flex-direction:column;gap:7px}.source-components article small{color:" + colors.muted + ";font-size:10px;text-transform:uppercase}.source-components article b,.source-components article span{overflow-wrap:anywhere}.source-lead{grid-row:span 3}.source-limited-card span{color:" + colors.muted + "}",
    ".strip{padding:20px;border-top:1px solid " + colors.border + "}.strip header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}.strip header span{font-size:" + caption.size + ";color:" + colors.muted + "}",
    ".palette-grid{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px}.swatch{min-height:84px;border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:8px;background:" + colors.surface + ";overflow:hidden}.swatch i{display:block;height:32px;border-radius:6px;margin-bottom:8px;border:1px solid rgba(127,127,127,.25)}.swatch b,.swatch small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.swatch small{color:" + colors.muted + ";font-size:10px}",
    ".type-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.type-row{border-bottom:1px solid " + colors.border + ";padding:8px 0}.type-row small,.type-row em{display:block;color:" + colors.muted + ";margin-bottom:4px;font-size:10px;font-style:normal}.type-row span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".component-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.component-grid article{border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:10px;min-height:112px;overflow:hidden}.component-grid label{display:block;color:" + colors.muted + ";font-size:11px;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".sample{max-width:100%}.sample-button{border:1px solid transparent}.sample-input{display:flex;justify-content:space-between;align-items:center;border:1px solid;padding:12px}.sample-input i{width:14px;height:14px;border-radius:50%;background:" + colors.primary + "}.sample-chip{display:inline-flex;padding:7px 12px;border:1px solid}.sample-nav{display:flex;gap:12px;padding:11px;border:1px solid}.sample-card{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid}.sample-code{display:grid;gap:8px;padding:14px;border:1px solid;overflow:hidden}.sample-code code{display:block;padding:8px;border-radius:5px;background:rgba(0,0,0,.15);font-family:monospace;font-size:" + caption.size + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sample-workflow{display:flex;justify-content:space-between;align-items:center;padding:14px;border:1px solid}.sample-workflow span{color:" + colors.muted + "}.sample-table{display:flex;flex-direction:column;gap:7px;padding:12px;border:1px solid}.sample-table span{display:flex;justify-content:space-between;gap:12px;border-top:1px solid rgba(127,127,127,.25);padding-top:6px}.sample-table i{font-style:normal}.sample-table strong{font-weight:400;color:" + colors.muted + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sample-chart{display:grid;gap:12px;padding:14px;border:1px solid}.sample-chart div{height:58px;display:flex;align-items:end;gap:8px}.sample-chart i{flex:1;background:" + colors.primary + ";border-radius:4px 4px 0 0}.sample-chart i:nth-child(1){height:35%}.sample-chart i:nth-child(2){height:70%}.sample-chart i:nth-child(3){height:48%}.sample-chart i:nth-child(4){height:88%}",
    ".rhythm-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.radius-grid{display:flex;flex-wrap:wrap;gap:8px}.radius-cell{width:58px;height:58px;display:grid;place-items:center;background:" + colors.surface + ";border:1px solid " + colors.border + ";font-size:10px;color:" + colors.muted + "}.space-row{display:flex;align-items:center;gap:10px;margin:7px 0}.space-row span{width:70px}.space-row i{display:block;height:10px;background:" + colors.primary + ";border-radius:999px}.notes-strip ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px;padding-left:18px;color:" + colors.muted + "}.do-dont{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
    ".compact-inventory{border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";overflow:hidden;margin-bottom:0}.compact-row{display:grid;grid-template-columns:140px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid " + colors.border + ";font-size:12px}.compact-row:last-child{border-bottom:none}.compact-row b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}.compact-row span{color:" + colors.muted + "}.compact-row code{font-family:monospace;color:" + colors.muted + ";font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.compact-row small{color:" + colors.muted + ";font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;grid-column:1/-1}.compact-section-label{padding:6px 12px 4px;border-bottom:1px solid " + colors.border + ";font-size:10px;text-transform:uppercase}",
    ".hero-board{padding:" + colors.spacing + ";background:" + colors.canvas + "}.hero-board .source-copy{margin-bottom:18px}.board-strips{display:flex;flex-direction:column;gap:14px}.board-strip b{display:block;font-size:10px;text-transform:uppercase;color:" + colors.muted + ";margin-bottom:8px;letter-spacing:.05em}.hero-palette{display:flex;flex-wrap:wrap;gap:6px}.hero-swatch{display:block;width:36px;height:36px;border-radius:6px;border:1px solid rgba(127,127,127,.25);flex-shrink:0}.hero-type-row{display:flex;flex-wrap:wrap;gap:16px}.hero-type{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}",
    "@media(max-width:760px){.board-meta{position:static;align-items:flex-start;flex-direction:column}.hero-source,.source-components,.palette-grid,.type-grid,.component-grid,.rhythm-grid,.notes-strip ul,.do-dont{grid-template-columns:1fr}.source-lead{grid-row:auto}.palette-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.compact-row{grid-template-columns:1fr 1fr;gap:4px}}",
  ].join("\n");
  const html = [
    '<div class="board">',
    renderSourceHeader(board),
    renderSourcePatternBoard(board, colors),
    renderSourceComponentGallery(board, colors),
    renderSourcePalette(board),
    renderSourceTypography(board),
    renderSourceRadiusSpacing(board, colors),
    renderSourceLayoutNotes(board),
    renderSourceDoDont(board),
    '</div>',
  ].join("\n");
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' + CSP + '\n<style>' + css + '</style>\n</head>\n<body>\n' + html + '\n</body>\n</html>';
}
