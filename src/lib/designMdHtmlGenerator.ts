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
  canUseAsCanvas,
  canUseAsDarkCanvasCandidate,
  canUseAsHeroAccent,
  canUseAsSurface,
  isAccentSparse,
  isScopedOnlyColor,
  isStateVariantColor,
  type DesignMdColorSemantics,
} from "./designMdColorSemantics";

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
  const lum = value ? relativeLuminance(value) : null;
  return lum !== null && lum > 0.70;
}

function isDarkColor(value: string | undefined): boolean {
  const lum = value ? relativeLuminance(value) : null;
  return lum !== null && lum < 0.20;
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

// ── Token role classification ──
// These helpers identify the semantic role of a token key so that
// canvas/surface/text/border/primary/semantic/timeline resolution is
// explicit and not accidentally dragged into wrong roles.
//
// Rules:
//  - primary/brand/accent must NOT be selected for canvas/surface
//    unless the key also clearly says canvas/background/body/page/surface.
//  - semantic/timeline/status colors must NOT be selected for canvas/surface.
//  - body is ambiguous: if value is dark and source has canvas, treat body as text.

function keyParts(key: string): string[] {
  return key.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean);
}

function isCanvasToken(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((p) => /^(canvas|body|background|page|app|floor|root)$/.test(p));
}

function isSurfaceToken(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((p) => /^(surface|card|panel|elevated|sheet|tile)$/.test(p));
}

function isTextToken(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((p) => /^(ink|text|body|foreground)$/.test(p));
}

function isPrimaryToken(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((p) => /^(primary|brand|accent|cta)$/.test(p));
}

function isSemanticToken(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((p) => /^(semantic|success|error|warning|danger|info)$/.test(p));
}

function isTimelineToken(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((p) => /^(timeline|stage|status)$/.test(p));
}

function isDarkToken(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((p) => /^(dark|black|inverse|night|aubergine)$/.test(p));
}

function isLightToken(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((p) => /^(light|white)$/.test(p));
}

function tokenSemantics(token: { semanticRole?: DesignMdColorSemantics["semanticRole"]; usageScope?: DesignMdColorSemantics["usageScope"]; usageIntensity?: DesignMdColorSemantics["usageIntensity"] } | undefined): DesignMdColorSemantics | undefined {
  if (!token?.semanticRole || !token.usageScope || !token.usageIntensity) return undefined;
  return {
    semanticRole: token.semanticRole,
    usageScope: token.usageScope,
    usageIntensity: token.usageIntensity,
    evidence: [],
    warnings: [],
  };
}

/**
 * True when the token's semantic role forbids using it as canvas/background.
 * Primary, accent, semantic, and timeline colors must NOT become page canvas
 * unless the key itself explicitly names canvas/background/body/page/surface.
 */
function isForbiddenCanvasCandidate(key: string): boolean {
  if (isCanvasToken(key) || isSurfaceToken(key)) return false;
  return isPrimaryToken(key) || isSemanticToken(key) || isTimelineToken(key);
}

function isForbiddenThemeCandidate(token: { key: string; semanticRole?: DesignMdColorSemantics["semanticRole"]; usageScope?: DesignMdColorSemantics["usageScope"]; usageIntensity?: DesignMdColorSemantics["usageIntensity"] }): boolean {
  const semantics = tokenSemantics(token);
  if (semantics && !canUseAsDarkCanvasCandidate(semantics)) return true;
  if (semantics && (isScopedOnlyColor(semantics) || semantics.semanticRole === "primaryAction" || semantics.semanticRole === "brandAccent")) return true;
  return isForbiddenCanvasCandidate(token.key);
}

function isContextualTextToken(key: string): boolean {
  return /(?:link|badge|selection|preview|console|white-text|focus|hover|active|muted|secondary)/i.test(key);
}

function tokenKeyMatches(key: string, match: string): boolean {
  const normalized = key.toLowerCase();
  const target = match.toLowerCase();
  const compact = keyParts(key).join("-");
  const compactTarget = keyParts(match).join("-");
  const kp = keyParts(key);
  const tp = keyParts(match);
  const keyTheme = isDarkToken(key) ? "dark"
    : isLightToken(key) ? "light"
      : null;
  const targetTheme = isDarkToken(match) ? "dark"
    : isLightToken(match) ? "light"
      : null;
  const targetIsBaseSurface = tp.some((p) => /^(canvas|surface|background|card|text|ink|body|foreground)$/.test(p));
  if (keyTheme && !targetTheme && targetIsBaseSurface) return false;
  if (keyTheme && targetTheme && keyTheme !== targetTheme) return false;
  if (compact === compactTarget || normalized === target) return true;
  // When the target is a single theme indicator (dark/light/black/white/etc.),
  // only match if the token's first part is that theme — prevents text tokens
  // like "on-dark" or "text-light" from matching as canvas/surface colors.
  const singleThemeTarget = tp.length === 1 && targetTheme !== null;
  if (singleThemeTarget) return kp[0] === compactTarget;
  return kp.includes(compactTarget);
}

function tokenColor(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
  for (const match of matches) {
    const found = tokens.find((token) => tokenKeyMatches(token.key, match));
    if (isSafeColorValue(found?.resolvedValue)) return found.resolvedValue.trim();
  }
  return fallback;
}

function tokenColorByPolicy(
  tokens: { key: string; resolvedValue: string; semanticRole?: DesignMdColorSemantics["semanticRole"]; usageScope?: DesignMdColorSemantics["usageScope"]; usageIntensity?: DesignMdColorSemantics["usageIntensity"] }[],
  matches: string[],
  fallback: string,
  allowed: (semantics: DesignMdColorSemantics | undefined, token: { key: string; resolvedValue: string }) => boolean,
): string {
  for (const match of matches) {
    const found = tokens.find((token) => tokenKeyMatches(token.key, match) && allowed(tokenSemantics(token), token));
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

/**
 * Resolve a single dark theme value from source tokens with explicit priority.
 * Returns the resolved value and metadata about the selection source.
 */
interface DarkThemeResolve {
  value: string;
  source: "source" | "derived" | "fallback";
  matchedKey?: string;
  note: string;
}

function resolveDarkToken(
  tokens: { key: string; resolvedValue: string; semanticRole?: DesignMdColorSemantics["semanticRole"]; usageScope?: DesignMdColorSemantics["usageScope"]; usageIntensity?: DesignMdColorSemantics["usageIntensity"] }[],
  explicitMatches: string[],
  fallbackDerive: () => string,
  fallbackHard: string,
  filterForbiddenCanvas = false,
): DarkThemeResolve {
  // Phase 1: try explicit source dark tokens
  const found = tokens.find((t) => {
    if (filterForbiddenCanvas && isForbiddenThemeCandidate(t)) return false;
    for (const match of explicitMatches) {
      if (tokenKeyMatches(t.key, match) && isSafeColorValue(t.resolvedValue)) {
        return true;
      }
    }
    return false;
  });
  if (found) {
    return { value: found.resolvedValue.trim(), source: "source", matchedKey: found.key, note: `explicit ${found.key}` };
  }

  // Phase 2: derived from palette
  const derived = fallbackDerive();
  if (isSafeColorValue(derived)) {
    return { value: derived.trim(), source: "derived", note: "derived from palette" };
  }

  // Phase 3: hard fallback
  return { value: fallbackHard, source: "fallback", note: "system fallback" };
}

interface DarkThemeSelection {
  canvas: DarkThemeResolve;
  surface: DarkThemeResolve;
  text: DarkThemeResolve;
  border: DarkThemeResolve;
  muted: DarkThemeResolve;
}

function selectDarkTheme(board: DesignMdBoard): DarkThemeSelection {
  const allColors = board.colorGroups.flatMap((group) => group.tokens);

  // ── Canvas (body/page background) ──
  // Priority: explicit body/canvas/background-dark tokens.
  // DO NOT match plain "black" or "surface-black" early — those are fallback-only.
  // Only "black" tokens that belong to canvas/surface palette groups are considered
  // via the darkest-palette-color fallback.
  const canvasExplicit = [
    "body-dark",
    "canvas-dark",
    "background-dark",
    "page-dark",
    "app-dark",
    "dark-body",
    "dark-canvas",
    "dark-background",
  ];
  const canvasResolve = resolveDarkToken(
    allColors,
    canvasExplicit,
    () => {
      // Prefer neutral text/ink darks before colored surfaces. Many systems have
      // brand-colored panels but no full dark canvas token.
      const textDarkTokens = board.colorGroups
        .filter((g) => g.prefix === "text/ink")
        .flatMap((g) => g.tokens)
        .filter((t) => !isContextualTextToken(t.key) && !isForbiddenThemeCandidate(t) && isSafeColorValue(t.resolvedValue) && isDarkColor(t.resolvedValue));
      const darkestText = darkestPaletteColor(textDarkTokens, "");
      if (darkestText && isDarkColor(darkestText)) return darkestText;

      // Derived: use darkest color from canvas/surface-only palette group.
      // CRITICAL: do NOT include brand/accent or semantic/status —
      // primary/accent colors must not become full-page canvas background.
      const canvasGroupTokens = board.colorGroups
        .filter((g) => g.prefix === "canvas/surface")
        .flatMap((g) => g.tokens)
        .filter((t) => !isForbiddenThemeCandidate(t));
      const darkestCanvas = darkestPaletteColor(canvasGroupTokens, "");
      if (darkestCanvas && isDarkColor(darkestCanvas)) return darkestCanvas;

      // Broader: darkest neutral token that is not forbidden as canvas.
      // Filter out primary/accent/semantic/timeline tokens explicitly.
      const neutralDarkTokens = allColors.filter((t) =>
        !isForbiddenThemeCandidate(t) && isSafeColorValue(t.resolvedValue) && isDarkColor(t.resolvedValue)
      );
      const darkestNeutral = darkestPaletteColor(neutralDarkTokens, "");
      if (darkestNeutral && isDarkColor(darkestNeutral)) return darkestNeutral;

      // Last resort: darkest in all tokens (still filter forbidden)
      const safeAll = allColors.filter((t) => !isForbiddenThemeCandidate(t));
      const darkestSafe = darkestPaletteColor(safeAll, "");
      if (darkestSafe && isDarkColor(darkestSafe)) return darkestSafe;

      return "#0b0e11";
    },
    "#0b0e11",
    true, // filterForbiddenCanvas: exclude primary/accent/semantic/timeline
  );

  const darkCanvas = canvasResolve.value;

  // ── Surface (card/section background) ──
  const surfaceExplicit = [
    "surface-dark",
    "surface-card-dark",
    "elevated-dark",
    "card-dark",
    "panel-dark",
    "dark-surface",
    "dark-card",
    "dark-panel",
  ];
  const surfaceResolve = resolveDarkToken(
    allColors,
    surfaceExplicit,
    () => {
      // Derived: canvas mixed slightly lighter
      const mixed = mixHexColor(darkCanvas, "#ffffff", 0.06);
      if (mixed && isSafeColorValue(mixed)) return mixed;
      return mixHexColor(darkCanvas, "#ffffff", 0.06) ?? "#1a1e24";
    },
    "#1a1e24",
    true, // filterForbiddenCanvas: exclude primary/accent/semantic/timeline from surface
  );

  const darkSurface = surfaceResolve.value;

  // ── Text (foreground on dark) ──
  const textExplicit = [
    "on-dark",
    "text-on-dark",
    "body-on-dark",
    "foreground-dark",
    "on-canvas-dark",
    "ink-on-dark",
  ];
  // Use a white/off-white as readable fallback
  const textResolve = resolveDarkToken(
    allColors,
    textExplicit,
    () => {
      // Derived: use the lightest text/ink token that's readable on dark canvas
      const textGroupTokens = board.colorGroups
        .filter((g) => g.prefix === "text/ink")
        .flatMap((g) => g.tokens)
        .filter((t) => !isContextualTextToken(t.key) && tokenSemantics(t)?.semanticRole === "text");
      const lightestText = lightestPaletteColor(textGroupTokens, "");
      if (lightestText && !isDarkColor(lightestText)) {
        if (ensureReadable(lightestText, darkCanvas, "") === lightestText) {
          return lightestText;
        }
      }
      return "#f0f2f5";
    },
    "#f0f2f5",
  );

  const darkText = ensureReadable(textResolve.value, darkCanvas, "#f0f2f5");

  // ── Muted text on dark ──
  const mutedExplicit = [
    "muted-on-dark",
    "on-dark-muted",
    "text-muted-dark",
    "muted-dark",
  ];
  const mutedResolve = resolveDarkToken(
    allColors,
    mutedExplicit,
    () => {
      // Derived: mix text toward canvas
      const mixed = mixHexColor(darkText, darkCanvas, 0.55);
      if (mixed && isSafeColorValue(mixed)) return mixed;
      return "#8b909a";
    },
    "#8b909a",
  );
  const darkMuted = ensureReadable(mutedResolve.value, darkCanvas, "#8b909a");

  // ── Border (hairlines, dividers) ──
  // CRITICAL: do NOT mix toward white. Mix toward text at low ratio for subtle separation.
  const borderExplicit = [
    "border-dark",
    "hairline-dark",
    "divider-dark",
    "stroke-dark",
    "dark-border",
    "dark-hairline",
    "dark-divider",
  ];
  const borderResolve = resolveDarkToken(
    allColors,
    borderExplicit,
    () => {
      // Derived: mix surface toward text at 8-12% for a subtle readable border
      // that does NOT look like a white outline.
      const mixed = mixHexColor(darkSurface, darkText, 0.10);
      if (mixed && isSafeColorValue(mixed)) return mixed;
      return "#2a2e35";
    },
    "#2a2e35",
  );

  return {
    canvas: canvasResolve,
    surface: surfaceResolve,
    text: { value: darkText, source: textResolve.source, matchedKey: textResolve.matchedKey, note: textResolve.note },
    border: borderResolve,
    muted: { value: darkMuted, source: mutedResolve.source, matchedKey: mutedResolve.matchedKey, note: mutedResolve.note },
  };
}

function deriveTokens(board: DesignMdBoard, variant: GeneratedPreviewVariant = "light") {
  const allColors = board.colorGroups.flatMap((group) => group.tokens);
  const paletteLight = lightestPaletteColor(allColors, "#ffffff");

  // ── Light theme (source-first, role-aware) ──
  // Canvas candidates: explicit light canvas tokens first, then neutral base
  const lightCanvasCandidates = [
    "canvas-light", "background-light",
    "canvas", "background", "page",
    // body-light only if source uses body as canvas (no separate canvas)
    "body-light",
  ];
  let pickedLightCanvas = tokenColorByPolicy(allColors, lightCanvasCandidates, "", (semantics, token) =>
    canUseAsCanvas(semantics) || (semantics === undefined && !isForbiddenCanvasCandidate(token.key))
  );
  // If picked canvas is a dark color (from a misclassified token), fall back
  if (!pickedLightCanvas || isDarkColor(pickedLightCanvas)) {
    // Try body only if it's light and no canvas/background exists
    const bodyToken = tokenColor(allColors, ["body"], "");
    if (bodyToken && !isDarkColor(bodyToken) && isTextToken("body") && allColors.some((t) => isCanvasToken(t.key))) {
      // body should be text, not canvas — skip
    } else if (bodyToken && !isDarkColor(bodyToken)) {
      pickedLightCanvas = bodyToken;
    }
    if (!pickedLightCanvas || isDarkColor(pickedLightCanvas)) {
      // Lightest neutral fallback (filter out forbidden tokens)
      const safeLightTokens = allColors.filter((t) =>
        !isForbiddenThemeCandidate(t) && isSafeColorValue(t.resolvedValue)
      );
      const lightest = lightestPaletteColor(safeLightTokens, "");
      pickedLightCanvas = (lightest && isLightColor(lightest)) ? lightest : paletteLight;
    }
  }
  const lightCanvas = isDarkColor(pickedLightCanvas) ? "#ffffff" : pickedLightCanvas;

  // Surface: explicit surface-light first, then card, panel, derived
  const lightSurfaceCandidates = [
    "surface-light", "surface-card-light", "card-light", "panel-light",
    "surface-card", "surface", "card", "panel",
  ];
  const pickedLightSurface = tokenColorByPolicy(allColors, lightSurfaceCandidates, "", (semantics, token) =>
    canUseAsSurface(semantics) || (semantics === undefined && !isForbiddenCanvasCandidate(token.key))
  );
  const lightSurface = (pickedLightSurface && !isDarkColor(pickedLightSurface))
    ? pickedLightSurface
    : (isLightColor(lightCanvas) ? "#f6f7f9" : (mixHexColor(lightCanvas, "#ffffff", 0.08) ?? "#f6f7f9"));

  // Text: ink first, then text, body-strong, foreground
  const lightTextCandidates = ["ink", "text", "body-strong", "foreground", "body"];
  const lightText = ensureReadable(tokenColorByPolicy(allColors, lightTextCandidates, "#111111", (semantics, token) =>
    semantics?.semanticRole === "text" && !isContextualTextToken(token.key)
  ), lightCanvas, "#111111");

  // Muted
  const lightMuted = ensureReadable(tokenColor(allColors, ["muted", "secondary", "soft"], "#667085"), lightCanvas, "#667085");

  // Border: hairline first, then border, divider, stroke, derived subtle
  const lightBorderCandidates = ["hairline", "border", "divider", "stroke"];
  const lightBorder = tokenColor(allColors, lightBorderCandidates,
    mixHexColor(lightSurface, lightText, 0.12) ?? "#d7dce2");

  // ── Dark theme (source-first resolver) ──
  const darkTheme = selectDarkTheme(board);
  const darkCanvas = darkTheme.canvas.value;
  const darkSurface = darkTheme.surface.value;
  const darkText = darkTheme.text.value;
  const darkBorder = darkTheme.border.value;
  const darkMuted = darkTheme.muted.value;
  // Also try source on-dark for use as primary-on-dark etc.
  const onDark = ensureReadable(tokenColor(allColors, ["on-dark", "body-on-dark", "text-on-dark", "on-black", "white"], darkText), darkCanvas, darkText);

  // ── Shared tokens ──
  // Primary: strictly from primary/brand/accent role tokens, not green/blue/red/yellow
  const primary = tokenColorByPolicy(allColors, ["primary", "brand", "accent"], "#2563eb", (semantics) =>
    canUseAsHeroAccent(semantics)
  );
  const onPrimary = ensureReadable(tokenColor(allColors, ["on-primary"], readableTextColor(primary)), primary, readableTextColor(primary));

  // ── Per-variant selection ──
  const canvas = variant === "dark" ? darkCanvas : lightCanvas;
  const surface = variant === "dark" ? darkSurface : lightSurface;
  const text = variant === "dark" ? darkText : lightText;
  const muted = variant === "dark" ? darkMuted : lightMuted;
  const border = variant === "dark" ? darkBorder : lightBorder;
  const radius = cssSize(tokenValue(board.radiusTokens, ["md", "lg", "sm"], "10px"), "10px");
  const pill = cssSize(tokenValue(board.radiusTokens, ["pill", "full"], "9999px"), "9999px");
  const spacing = cssSpacing(tokenValue(board.spacingTokens, ["lg", "md", "base"], "24px"), "24px");

  // ── Diagnostics (Pass 2) ──
  const darkThemeSource = variant === "dark" ? {
    canvas: { source: darkTheme.canvas.source, matchedKey: darkTheme.canvas.matchedKey, note: darkTheme.canvas.note },
    surface: { source: darkTheme.surface.source, matchedKey: darkTheme.surface.matchedKey, note: darkTheme.surface.note },
    text: { source: darkTheme.text.source, matchedKey: darkTheme.text.matchedKey, note: darkTheme.text.note },
    border: { source: darkTheme.border.source, matchedKey: darkTheme.border.matchedKey, note: darkTheme.border.note },
    muted: { source: darkTheme.muted.source, matchedKey: darkTheme.muted.matchedKey, note: darkTheme.muted.note },
    warnings: ([] as string[]).concat(
      darkTheme.canvas.source === "derived" ? "no explicit dark canvas" : [],
      darkTheme.surface.source === "derived" ? "no explicit dark surface" : [],
      darkTheme.text.source === "derived" ? "text derived" : [],
      darkTheme.border.source === "derived" ? "border derived" : [],
      darkTheme.muted.source === "derived" ? "muted derived" : [],
    ),
  } : undefined;

  return {
    variant,
    canvas, surface, text, muted, border,
    primary, onPrimary, onDark,
    darkCanvas, darkSurface,
    radius, pill, spacing,
    darkThemeSource,
  };
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

/**
 * Determine if any button-kinded component has source-backed colors sufficient
 * to render a hero button. Only filled (bg + fg) or outline (border + fg) buttons
 * pass. Fallback to global primary/onPrimary is NOT allowed.
 */
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
  // Prefer actual component/token name
  const name = group.name;
  if (/button/.test(name.toLowerCase())) return esc(name);
  // Neutral label as token-label chrome only
  return esc(name || "Button");
}

/**
 * Render a single button sample for the hero. Only renders when source-backed
 * colors are present on the component itself. Does NOT fall back to global
 * primary/onPrimary tokens.
 *
 * Filled button: requires source backgroundColor + textColor.
 * Outline button: requires source borderColor + textColor (no bg fill).
 * Returns empty string if source-backed colors are insufficient.
 */
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

  // Filled button: requires bg + fg, both source-backed
  if (hasBg && hasFg) {
    const bg = group.backgroundColor!.trim();
    const fg = ensureReadable(group.textColor!.trim(), bg);
    return '<button class="hero-btn" style="background:' + bg + ';color:' + fg + ';border-radius:' + radius + ';padding:' + padding + '">' + label + '</button>';
  }

  // Outline button: requires border + fg source-backed, background transparent
  if (hasBorder && hasFg) {
    const border = group.borderColor!.trim();
    const fg = group.textColor!.trim();
    return '<button class="hero-btn hero-btn-outline" style="background:transparent;color:' + fg + ';border-color:' + border + ';border-style:solid;border-width:1px;border-radius:' + radius + ';padding:' + padding + '">' + label + '</button>';
  }

  // Insufficient source-backed colors: no button rendered
  return "";
}

function neutralKind(kind: string): string {
  return kind.replace(/-/g, " ");
}

// ── Section renderers ──

function renderHero(board: DesignMdBoard, _colors: ReturnType<typeof deriveTokens>, display: ReturnType<typeof typographyCss>): string {
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

  // Button rendering: only when DESIGN.md contains actual button tokens
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
      .slice(0, 2);
    if (eligible.length > 0) {
      buttonHtml = '<div class="hero-buttons">' + eligible.map(({ group }) => renderHeroButton(board, group)).join("") + '</div>';
    }
  }

  // Small palette preview strip
  const paletteSwatches = board.colorGroups.flatMap(g => g.tokens)
    .filter((token) => {
      const semantics = tokenSemantics(token);
      return !isScopedOnlyColor(semantics) && !isStateVariantColor(semantics);
    })
    .slice(0, conservative ? 4 : 6)
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
  return '<section class="strip" id="palette">' +
    '<header><h3>Palette</h3><span>' + tokens.length + ' colors</span></header>' +
    '<div class="palette-grid">' +
    visible.map((token) => {
      const semantics = tokenSemantics(token);
      const scoped = isScopedOnlyColor(semantics) || isStateVariantColor(semantics);
      const note = token.semanticWarnings?.[0] ?? token.semanticEvidence?.[0] ?? token.group;
      return '<div class="swatch' + (scoped ? ' swatch-scoped' : '') + '">' +
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
  const colors = deriveTokens(board, options.variant ?? "light");
  const display = typographyCss(board, ["hero", "display-xl", "display-lg", "display"], "38px");
  const body = typographyCss(board, ["body", "text"], "15px");
  const caption = typographyCss(board, ["caption", "label", "small"], "12px");

  // Derived subtle border for swatch wrappers — color-derived, not hardcoded gray
  const subtleSwatchBorder = mixHexColor(colors.surface, colors.text, 0.15) ?? colors.border;
  const conservative = board.qualityWarnings.sourceSparse || board.previewQuality.lightScore < 55;
  const accentBarColor = conservative || board.qualityWarnings.accentOveruseRisk || board.qualityWarnings.primaryOveruseRisk
    ? colors.border
    : colors.primary;

  const css = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    "html,body{width:100%;height:100%;min-height:100%;overflow:auto}",
    "body{font-family:" + body.family + ";font-size:" + body.size + ";font-weight:" + body.weight + ";line-height:1.5;letter-spacing:0;background:" + colors.canvas + ";color:" + colors.text + ";-webkit-font-smoothing:antialiased}",
    ".board{min-height:100%;background:" + colors.canvas + ";color:" + colors.text + "}",

    // ── Hero ──
    ".hero{padding:clamp(24px,4vw," + colors.spacing + ") clamp(16px,4vw," + colors.spacing + ");background:" + colors.surface + "}",
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
    ".strip{padding:clamp(18px,3vw," + colors.spacing + ") clamp(16px,4vw," + colors.spacing + ");border-top:1px solid " + colors.border + ";max-width:960px;margin:0 auto}",
    ".strip header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}",
    ".strip h3{font-family:" + display.family + ";font-size:15px;font-weight:" + display.weight + ";color:" + colors.text + "}",
    ".strip header span{font-size:10px;color:" + colors.muted + ";opacity:0.55}",
    ".strip-note{font-size:" + caption.size + ";color:" + colors.muted + ";margin-top:8px;padding-top:6px;border-top:1px solid " + colors.border + ";line-height:1.35}",

    // ── Palette ──
    ".palette-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}",
    ".swatch{min-height:68px;border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";padding:6px 8px;background:" + colors.surface + ";overflow:hidden}",
    ".swatch i{display:block;height:24px;border-radius:5px;margin-bottom:5px;border:1px solid " + subtleSwatchBorder + "}",
    ".swatch b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:" + caption.size + "}",
    ".swatch small{display:block;color:" + colors.muted + ";font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".swatch em{display:block;color:" + colors.muted + ";font-size:9px;font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.62}",
    ".swatch-scoped{opacity:.72}",
    ".swatch-scoped i{height:14px}",

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
    ".src-keywords span{border:1px solid " + colors.border + ";border-radius:" + colors.pill + ";padding:2px 8px;color:" + colors.muted + ";font-size:10px}",
    ".src-phrases{color:" + colors.muted + ";font-size:" + caption.size + ";padding-left:16px;line-height:1.4}",
    ".src-phrases li{margin-bottom:3px}",
    ".do-dont{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
    ".do-list{color:" + colors.muted + ";padding-left:16px;font-size:" + caption.size + ";line-height:1.4}",
    ".do-list li{margin-bottom:2px}",
    ".dont-list{color:" + colors.muted + ";padding-left:16px;font-size:" + caption.size + ";line-height:1.4}",
    ".dont-list li{margin-bottom:2px}",
    ".src-inventory{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}",
    ".inv-item{display:flex;align-items:baseline;gap:8px;padding:4px 8px;border:1px solid " + colors.border + ";border-radius:" + colors.radius + ";font-size:" + caption.size + "}",
    ".inv-item b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:" + colors.text + "}",
    ".inv-item span{color:" + colors.muted + ";flex-shrink:0}",
    ".inv-item em{color:" + colors.muted + ";font-size:9px;margin-left:auto;flex-shrink:0}",
    ".src-warnings{color:" + colors.muted + ";font-size:" + caption.size + ";padding-left:16px;line-height:1.35}",
    ".src-warnings li{margin-bottom:2px}",

    // ── Responsive ──
    "@media(max-width:760px){.hero-inner{flex-direction:column}.hero-visual{width:100%}.hero-palette-strip{max-width:100%}.palette-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.type-grid,.rhythm-grid,.notes-strip ul,.do-dont,.src-inventory{grid-template-columns:1fr}}",
    "@media(max-width:960px){.strip{padding-left:16px;padding-right:16px}}",
  ].join("\n");

  // Dark theme diagnostics (Pass 2) — shown as HTML comment for dev inspection
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
 * Exported for test verification of dark token selection priority.
 */
export function deriveDarkThemeTokens(board: DesignMdBoard) {
  return deriveTokens(board, "dark");
}

/**
 * Test helper: return the derived light theme tokens for a board.
 * Exported for test verification of light token selection.
 */
export function deriveLightThemeTokens(board: DesignMdBoard) {
  return deriveTokens(board, "light");
}
