import type { DesignMdBoard, DesignMdBoardComponentGroup } from "./designMdSpecimenBuilder";
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
import {
  canUseAsButtonFill,
  canUseAsHeroAccent,
  isAccentSparse,
  isScopedOnlyColor,
  isStateVariantColor,
  type DesignMdColorSemantics,
} from "./designMdColorSemantics";
import { sourceIntentSummary } from "./designMdSourceIntent";
import {
  hexToRgb,
  ensureReadable,
} from "./designMdContrast";
import { resolveLightTokens, resolveDarkTokens } from "./designMdThemeResolver";
import type { ThemeTokens } from "./designMdThemeResolver";

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

// ── Source intent helpers (used by render sections) ──

function isSoftWarmIntent(board: DesignMdBoard): boolean {
  return board.sourceIntent.mood.includes("warm")
    || board.sourceIntent.mood.includes("soft")
    || board.sourceIntent.mood.includes("editorial")
    || board.sourceIntent.contrastIntent === "soft";
}

function isSparseAccentIntent(board: DesignMdBoard): boolean {
  return board.sourceIntent.accentIntent.some((intent) =>
    intent === "sparse"
    || intent === "ctaOnly"
    || intent === "wordmarkOnly"
    || intent === "semanticOnly"
    || intent === "timelineOnly"
    || intent === "decorativeOnly"
  );
}

/**
 * Reconstruct a simplified semantic object from a board token.
 * Used by render sections (palette, button fill checks) to gate on token roles.
 */
function tokenSemantics(
  token: { semanticRole?: DesignMdColorSemantics["semanticRole"]; usageScope?: DesignMdColorSemantics["usageScope"]; usageIntensity?: DesignMdColorSemantics["usageIntensity"] } | undefined,
): DesignMdColorSemantics | undefined {
  if (!token?.semanticRole || !token.usageScope || !token.usageIntensity) return undefined;
  return { semanticRole: token.semanticRole, usageScope: token.usageScope, usageIntensity: token.usageIntensity, evidence: [], warnings: [] };
}

// ── Theme resolution (delegates to designMdThemeResolver) ──

/**
 * Thin wrapper that adds radius/spacing resolution on top of theme tokens.
 * The theme resolver handles all color/contrast/source-intent decisions.
 */
function themeTokensForBoard(board: DesignMdBoard, variant: GeneratedPreviewVariant): ThemeTokens {
  const theme = variant === "dark" ? resolveDarkTokens(board) : resolveLightTokens(board);
  return theme;
}

// ── Render helpers ──

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
    if (!eligibility.canRenderGraphic) return false;
    const hasBg = isSafeColorValue(g.backgroundColor);
    const hasFg = isSafeColorValue(g.textColor);
    const hasBorder = isSafeColorValue(g.borderColor);
    return (hasBg && hasFg) || (hasBorder && hasFg);
  });
}

function isStateVariantComponentName(name: string): boolean {
  return /(?:^|[-_\s])(active|hover|pressed|focus|focused|disabled|selected|loading|visited|checked)(?:$|[-_\s])/i.test(name);
}

function isBaseHeroButtonName(name: string): boolean {
  const normalized = name.toLowerCase();
  return /button-(primary|secondary|download|cta|outline)$/.test(normalized)
    || /^(primary|secondary|download|cta|outline)-button$/.test(normalized)
    || /^(button|cta)$/.test(normalized);
}

function colorTokenForValue(board: DesignMdBoard, value: string | undefined) {
  if (!isSafeColorValue(value)) return undefined;
  const normalized = value!.trim().toLowerCase();
  return board.colorGroups.flatMap((group) => group.tokens).find((token) => token.resolvedValue.trim().toLowerCase() === normalized);
}

function buttonFillAllowed(board: DesignMdBoard, group: DesignMdBoardComponentGroup): boolean {
  if (isStateVariantComponentName(group.name)) return false;
  const bgToken = colorTokenForValue(board, group.backgroundColor);
  const borderToken = colorTokenForValue(board, group.borderColor);
  const bgSemantics = tokenSemantics(bgToken);
  const borderSemantics = tokenSemantics(borderToken);
  if (isStateVariantColor(bgSemantics) || isScopedOnlyColor(bgSemantics)) return false;
  if (isStateVariantColor(borderSemantics) || isScopedOnlyColor(borderSemantics)) return false;
  if (isSafeColorValue(group.backgroundColor)) {
    if (!bgToken) return true;
    if (!canUseAsButtonFill(bgSemantics)) return false;
    if (isAccentSparse(bgSemantics) && !/primary|cta/i.test(group.name)) return false;
  }
  if (isSafeColorValue(group.borderColor) && borderToken && !canUseAsHeroAccent(borderSemantics)) return false;
  return true;
}

function renderButtonLabel(group: DesignMdBoardComponentGroup): string {
  const name = group.name;
  if (/button/.test(name.toLowerCase())) return esc(name);
  return esc(name || "Button");
}

function renderHeroButton(board: DesignMdBoard, group: DesignMdBoardComponentGroup): string {
  const eligibility = checkRenderEligibility(group);
  if (!eligibility.canRenderGraphic) return "";
  if (!buttonFillAllowed(board, group)) return "";

  const hasBg = isSafeColorValue(group.backgroundColor);
  const hasFg = isSafeColorValue(group.textColor);
  const hasBorder = isSafeColorValue(group.borderColor);
  const radius = cssSize(group.rounded, "8px");
  const padding = cssSpacing(group.padding, "10px 20px");
  const label = renderButtonLabel(group);

  if (hasBg && hasFg) {
    const bg = group.backgroundColor!.trim();
    const fg = ensureReadable(group.textColor!.trim(), bg);
    return '<button class="hero-btn" style="background:' + bg + ';color:' + fg + ';border-radius:' + radius + ';padding:' + padding + '">' + label + '</button>';
  }

  if (hasBorder && hasFg) {
    const border = group.borderColor!.trim();
    const fg = group.textColor!.trim();
    return '<button class="hero-btn hero-btn-outline" style="background:transparent;color:' + fg + ';border-color:' + border + ';border-style:solid;border-width:1px;border-radius:' + radius + ';padding:' + padding + '">' + label + '</button>';
  }

  return "";
}

function neutralKind(kind: string): string {
  return kind.replace(/-/g, " ");
}

// ── Section renderers ──

function renderHero(board: DesignMdBoard, _colors: ThemeTokens, display: ReturnType<typeof typographyCss>): string {
  const title = esc(board.title);
  const slug = esc(board.slug);
  const archetype = esc(board.archetype.replace(/_/g, " "));
  const conservative = board.qualityWarnings.sourceSparse || board.previewQuality.lightScore < 55;
  const state = conservative ? "source-limited" : "source-backed";
  const note = board.overview ?? board.visualLanguage.phrases[0] ?? board.description;
  const description = note ? '<p class="hero-desc">' + esc(note.length > 280 ? note.slice(0, 277) + "..." : note) + '</p>' : '';

  const evidence = [
    board.coverage.colorsCount + ' colors',
    board.coverage.typographyCount + ' type',
    board.coverage.componentCount + ' components',
    evidenceLabel(board.archetypeEvidence),
  ].map((item) => '<span>' + esc(item) + '</span>').join("");

  let buttonHtml = '';
  if (hasButtonTokens(board)) {
    const buttons = componentsOfKind(board, "button");
    const eligible = buttons
      .map((g) => ({ group: g, eligibility: checkRenderEligibility(g) }))
      .filter((r) => {
        if (!r.eligibility.canRenderGraphic) return false;
        if (!isBaseHeroButtonName(r.group.name)) return false;
        if (!buttonFillAllowed(board, r.group)) return false;
        const hasBg = isSafeColorValue(r.group.backgroundColor);
        const hasFg = isSafeColorValue(r.group.textColor);
        const hasBorder = isSafeColorValue(r.group.borderColor);
        return (hasBg && hasFg) || (hasBorder && hasFg);
      })
      .slice(0, isSparseAccentIntent(board) ? 1 : 2);
    if (eligible.length > 0) {
      buttonHtml = '<div class="hero-buttons">' + eligible.map(({ group }) => renderHeroButton(board, group)).join("") + '</div>';
    }
  }

  const paletteSwatches = board.colorGroups.flatMap(g => g.tokens)
    .filter((token) => {
      const semantics = tokenSemantics(token);
      if (isScopedOnlyColor(semantics) || isStateVariantColor(semantics)) return false;
      if (isSparseAccentIntent(board) && (semantics?.semanticRole === "primaryAction" || semantics?.semanticRole === "brandAccent")) {
        return token.usageScope === "primaryButton" && token.key === "primary";
      }
      return true;
    })
    .sort((a, b) => {
      const order = ["canvas", "surface", "text", "border", "primaryAction", "brandAccent", "unknown"];
      return order.indexOf(a.semanticRole ?? "unknown") - order.indexOf(b.semanticRole ?? "unknown");
    })
    .slice(0, conservative || isSparseAccentIntent(board) ? 4 : 6)
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
  const roleOrder = ["canvas", "surface", "text", "border", "primaryAction", "brandAccent", "semantic", "status", "timeline", "state", "decorative", "unknown"];
  const visible = [...tokens].sort((a, b) => {
    const ai = roleOrder.indexOf(a.semanticRole ?? "unknown");
    const bi = roleOrder.indexOf(b.semanticRole ?? "unknown");
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  }).slice(0, 24);
  const moodRoles = new Set(["canvas", "surface", "text", "border", "primaryAction", "brandAccent"]);
  return '<section class="strip" id="palette">' +
    '<header><h3>Palette</h3><span>' + tokens.length + ' colors</span></header>' +
    '<div class="palette-grid">' +
    visible.map((token) => {
      const semantics = tokenSemantics(token);
      const scoped = isScopedOnlyColor(semantics) || isStateVariantColor(semantics);
      const utility = !moodRoles.has(token.semanticRole ?? "unknown");
      const note = token.semanticWarnings?.[0] ?? token.semanticEvidence?.[0] ?? token.group;
      return '<div class="swatch' + (scoped ? ' swatch-scoped' : '') + (utility ? ' swatch-utility' : '') + '">' +
      '<i style="background:' + cssColor(token.resolvedValue, "#d8d8d8") + '"></i>' +
      '<b>' + esc(token.key) + '</b>' +
      '<small>' + esc((token.semanticRole ?? "unknown") + ' · ' + (token.usageScope ?? token.group)) + '</small>' +
      '<em>' + esc(note) + '</em>' +
      '</div>';
    }).join("") +
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

function renderRadiusSpacing(board: DesignMdBoard, colors: ThemeTokens): string {
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
  ].filter((note): note is string => !!note && note.length > 20).slice(0, board.qualityWarnings.weakLayout ? 3 : 5);
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

  const intent = board.sourceIntent;
  const intentEvidence = intent.sourceEvidence.slice(0, 4);
  sections.push('<div class="src-section"><h4>Source intent</h4>' +
    '<div class="src-intent-summary">' + esc(sourceIntentSummary(intent)) + '</div>' +
    (intentEvidence.length > 0
      ? '<ul class="src-phrases">' + intentEvidence.map((item) => '<li><b>' + esc(item.section) + '</b>: ' + esc(item.excerpt) + '</li>').join("") + '</ul>'
      : '') +
    '</div>');

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

  const qualityWarnings = Object.entries(board.qualityWarnings)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key.replace(/[A-Z]/g, (letter) => " " + letter.toLowerCase()))
    .slice(0, 6);
  if (board.warnings.length > 0 || qualityWarnings.length > 0) {
    let warnHtml = '<div class="src-section"><h4>Source limitations</h4>' +
      '<ul class="src-warnings">' +
      board.warnings.map((w) => '<li>' + esc(w) + '</li>').join("") +
      qualityWarnings.map((w) => '<li>' + esc(w) + '</li>').join("") +
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

export function generateBoardHtml(board: DesignMdBoard, options: { variant?: GeneratedPreviewVariant } = {}): string {
  const variant = options.variant ?? "light";
  const colors = themeTokensForBoard(board, variant);
  const display = typographyCss(board, ["hero", "display-xl", "display-lg", "display"], "38px");
  const body = typographyCss(board, ["body", "text"], "15px");
  const caption = typographyCss(board, ["caption", "label", "small"], "12px");

  // Resolve radius/pill/spacing from board tokens (not theme-derived)
  function tokenValue(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
    for (const match of matches) {
      const found = tokens.find((t) => t.key.toLowerCase() === match.toLowerCase() || t.key.toLowerCase().includes(match));
      if (found && !isUnsafeDesignMdStyleValue(found.resolvedValue)) return found.resolvedValue.trim();
    }
    return fallback;
  }
  const radius = cssSize(tokenValue(board.radiusTokens, ["md", "lg", "sm"], "10px"), "10px");
  const pill = cssSize(tokenValue(board.radiusTokens, ["pill", "full"], "9999px"), "9999px");
  const spacing = cssSpacing(tokenValue(board.spacingTokens, ["lg", "md", "base"], "24px"), "24px");

  const subtleSwatchBorder = mixHexColor(colors.surface, colors.text, 0.15) ?? colors.border;
  const conservative = board.qualityWarnings.sourceSparse || board.previewQuality.lightScore < 55;
  const sparseAccent = isSparseAccentIntent(board);
  const softWarm = isSoftWarmIntent(board);
  const accentBarColor = conservative || sparseAccent || board.qualityWarnings.accentOveruseRisk || board.qualityWarnings.primaryOveruseRisk
    ? colors.border
    : colors.primary;
  const heroBackground = softWarm && variant === "dark"
    ? (mixHexColor(colors.canvas, colors.surface, 0.42) ?? colors.surface)
    : colors.surface;

  const css = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    "html,body{width:100%;height:100%;min-height:100%;overflow:auto}",
    "body{font-family:" + body.family + ";font-size:" + body.size + ";font-weight:" + body.weight + ";line-height:1.5;letter-spacing:0;background:" + colors.canvas + ";color:" + colors.text + ";-webkit-font-smoothing:antialiased}",
    ".board{min-height:100%;background:" + colors.canvas + ";color:" + colors.text + "}",

    // ── Hero ──
    ".hero{padding:clamp(24px,4vw," + spacing + ") clamp(16px,4vw," + spacing + ");background:" + heroBackground + "}",
    ".hero:not(:last-child){border-bottom:1px solid " + colors.border + "}",
    ".hero-inner{display:flex;gap:28px;align-items:flex-start;max-width:960px;margin:0 auto}",
    ".hero-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}",
    ".hero-kicker{color:" + (conservative ? colors.muted : colors.primary) + ";font-size:" + caption.size + ";font-weight:700;text-transform:uppercase;letter-spacing:.04em}",
    ".hero-title{color:" + colors.text + "}",
    ".hero-meta{color:" + colors.muted + ";font-size:" + caption.size + "}",
    ".hero-desc{color:" + colors.muted + ";max-width:540px;line-height:1.5;font-size:" + caption.size + "}",
    ".hero-evidence{display:flex;flex-wrap:wrap;gap:0;margin-top:2px;color:" + colors.muted + ";font-size:" + caption.size + ";line-height:1.6}",
    ".hero-evidence span{display:inline}",
    ".hero-evidence span+span::before{content:' · ';opacity:0.4}",
    ".hero-buttons{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}",
    ".hero-btn{padding:8px 18px;border:none;cursor:default;font-family:" + body.family + ";font-size:" + caption.size + ";font-weight:600;border:1px solid transparent;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}",
    ".hero-btn-outline{background:transparent !important}",
    ".hero-visual{flex-shrink:0;display:flex;align-items:flex-start;gap:4px;padding-top:2px}",
    ".hero-palette-strip{display:flex;flex-wrap:wrap;gap:3px;max-width:112px}",
    ".hero-swatch{display:block;width:18px;height:18px;border-radius:4px;border:1px solid " + subtleSwatchBorder + ";flex-shrink:0}",

    // ── Section strips ──
    ".strip{padding:clamp(18px,3vw," + spacing + ") clamp(16px,4vw," + spacing + ");border-top:1px solid " + colors.border + ";max-width:960px;margin:0 auto}",
    ".strip header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}",
    ".strip h3{font-family:" + display.family + ";font-size:15px;font-weight:" + display.weight + ";color:" + colors.text + "}",
    ".strip header span{font-size:10px;color:" + colors.muted + ";opacity:0.55}",
    ".strip-note{font-size:" + caption.size + ";color:" + colors.muted + ";margin-top:8px;padding-top:6px;border-top:1px solid " + colors.border + ";line-height:1.35}",

    // ── Palette ──
    ".palette-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}",
    ".swatch{min-height:68px;border:1px solid " + colors.border + ";border-radius:" + radius + ";padding:6px 8px;background:" + colors.surface + ";overflow:hidden}",
    ".swatch i{display:block;height:24px;border-radius:5px;margin-bottom:5px;border:1px solid " + subtleSwatchBorder + "}",
    ".swatch b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:" + caption.size + "}",
    ".swatch small{display:block;color:" + colors.muted + ";font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".swatch em{display:block;color:" + colors.muted + ";font-size:9px;font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.62}",
    ".swatch-scoped{opacity:.72}",
    ".swatch-scoped i{height:14px}",
    ".swatch-utility{opacity:.66}",
    ".swatch-utility i{height:12px}",

    // ── Typography ──
    ".type-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px}",
    ".type-row{border-bottom:1px solid " + colors.border + ";padding:6px 0}",
    ".type-row small,.type-row em{display:block;color:" + colors.muted + ";margin-bottom:1px;font-size:9px;font-style:normal;opacity:0.75}",
    ".type-row span{display:block;overflow:hidden;text-overflow:ellipsis;line-height:1.3;overflow-wrap:anywhere}",

    // ── Radius & Spacing ──
    ".rhythm-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}",
    ".radius-grid{display:flex;flex-wrap:wrap;gap:6px}",
    ".radius-cell{width:48px;height:48px;display:grid;place-items:center;background:" + colors.surface + ";border:1px solid " + colors.border + ";font-size:9px;color:" + colors.muted + ";border-radius:var(--cell-radius,0)}",
    ".space-row{display:flex;align-items:center;gap:8px;margin:4px 0}",
    ".space-row span{width:60px;font-size:" + caption.size + ";color:" + colors.muted + "}",
    ".space-row i{display:block;height:6px;background:" + accentBarColor + ";border-radius:999px;min-width:4px}",
    ".space-row small{font-size:9px;color:" + colors.muted + "}",

    // ── Layout notes ──
    ".notes-strip ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px;padding-left:16px;color:" + colors.muted + ";font-size:" + caption.size + ";line-height:1.45;opacity:0.75}",

    // ── Source notes ──
    ".src-body{display:flex;flex-direction:column;gap:12px}",
    ".src-section h4{font-size:10px;font-weight:600;color:" + colors.muted + ";margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em;opacity:0.7}",
    ".src-keywords{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}",
    ".src-keywords span{border:1px solid " + colors.border + ";border-radius:" + pill + ";padding:2px 8px;color:" + colors.muted + ";font-size:10px}",
    ".src-intent-summary{color:" + colors.text + ";font-size:" + caption.size + ";line-height:1.4;margin-bottom:6px}",
    ".src-phrases{color:" + colors.muted + ";font-size:" + caption.size + ";padding-left:16px;line-height:1.4}",
    ".src-phrases li{margin-bottom:3px}",
    ".do-dont{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
    ".do-list{color:" + colors.muted + ";padding-left:16px;font-size:" + caption.size + ";line-height:1.4}",
    ".do-list li{margin-bottom:2px}",
    ".dont-list{color:" + colors.muted + ";padding-left:16px;font-size:" + caption.size + ";line-height:1.4}",
    ".dont-list li{margin-bottom:2px}",
    ".src-inventory{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}",
    ".inv-item{display:flex;align-items:baseline;gap:8px;padding:4px 8px;border:1px solid " + colors.border + ";border-radius:" + radius + ";font-size:" + caption.size + "}",
    ".inv-item b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:" + colors.text + "}",
    ".inv-item span{color:" + colors.muted + ";flex-shrink:0}",
    ".inv-item em{color:" + colors.muted + ";font-size:9px;margin-left:auto;flex-shrink:0}",
    ".src-warnings{color:" + colors.muted + ";font-size:" + caption.size + ";padding-left:16px;line-height:1.35}",
    ".src-warnings li{margin-bottom:2px}",

    // ── Responsive ──
    "@media(max-width:760px){.hero-inner{flex-direction:column}.hero-visual{width:100%}.hero-palette-strip{max-width:100%}.palette-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.type-grid,.rhythm-grid,.notes-strip ul,.do-dont,.src-inventory{grid-template-columns:1fr}}",
    "@media(max-width:960px){.strip{padding-left:16px;padding-right:16px}}",
  ].join("\n");

  let diagnosticsHtml = '';
  if (colors.darkThemeSource) {
    const dt = colors.darkThemeSource;
    const lines = [
      '── Design MD dark theme source ──',
      `canvas: ${dt.canvas.note} (source: ${dt.canvas.source}${dt.canvas.matchedKey ? ', key: ' + dt.canvas.matchedKey : ''})`,
      `surface: ${dt.surface.note} (source: ${dt.surface.source}${dt.surface.matchedKey ? ', key: ' + dt.surface.matchedKey : ''})`,
      `text:    ${dt.text.note} (source: ${dt.text.source}${dt.text.matchedKey ? ', key: ' + dt.text.matchedKey : ''})`,
      `border:  ${dt.border.note} (source: ${dt.border.source}${dt.border.matchedKey ? ', key: ' + dt.border.matchedKey : ''})`,
      `muted:   ${dt.muted.note} (source: ${dt.muted.source}${dt.muted.matchedKey ? ', key: ' + dt.muted.matchedKey : ''})`,
    ];
    if (dt.warnings.length > 0) {
      lines.push(`warnings: ${dt.warnings.join(', ')}`);
    }
    diagnosticsHtml = '\n<!--\n' + lines.join('\n') + '\n-->';
  }

  const html = [
    '<div class="board">',
    renderHero(board, colors, display),
    renderPalette(board),
    renderTypography(board),
    renderRadiusSpacing(board, colors),
    renderLayout(board),
    renderSourceNotes(board),
    '</div>',
    diagnosticsHtml,
  ].join("\n");

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' + CSP + '\n<style>' + css + '</style>\n</head>\n<body>\n' + html + '\n</body>\n</html>';
}

/**
 * Test helper: return the derived dark theme tokens for a board.
 */
export function deriveDarkThemeTokens(board: DesignMdBoard): ThemeTokens {
  return resolveDarkTokens(board);
}

/**
 * Test helper: return the derived light theme tokens for a board.
 */
export function deriveLightThemeTokens(board: DesignMdBoard): ThemeTokens {
  return resolveLightTokens(board);
}
