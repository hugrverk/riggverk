import type { DesignMdBoard } from "./designMdSpecimenBuilder";
import type { DesignMdColorSemantics } from "./designMdColorSemantics";
import type { DesignMdTokenRole, DesignMdTokenRoleConfidence } from "./designMdTokenRoleResolver";
import { isSafeColorValue } from "./designMdPreviewParser";
import {
  canUseAsCanvas,
  canUseAsDarkCanvasCandidate,
  canUseAsHeroAccent,
  canUseAsSurface,
  isScopedOnlyColor,
} from "./designMdColorSemantics";
import {
  hexToRgb,
  relativeLuminance,
  readableTextColor,
  ensureReadable,
} from "./designMdContrast";

type ThemeColorCandidate = {
  key: string;
  resolvedValue: string;
  resolvedRole?: DesignMdTokenRole;
  roleConfidence?: DesignMdTokenRoleConfidence;
  semanticRole?: DesignMdColorSemantics["semanticRole"];
  usageScope?: DesignMdColorSemantics["usageScope"];
  usageIntensity?: DesignMdColorSemantics["usageIntensity"];
};

// ─── Public types ────────────────────────────────────────────────

export interface ThemeTokenResolve {
  value: string;
  source: "source" | "derived" | "fallback";
  matchedKey?: string;
  note: string;
}

export interface DarkThemeSource {
  canvas: { source: string; matchedKey?: string; note: string };
  surface: { source: string; matchedKey?: string; note: string };
  text: { source: string; matchedKey?: string; note: string };
  border: { source: string; matchedKey?: string; note: string };
  muted: { source: string; matchedKey?: string; note: string };
  warnings: string[];
}

export interface ThemeTokens {
  variant: "light" | "dark";
  canvas: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  onDark: string;
  darkCanvas: string;
  darkSurface: string;
  darkThemeSource?: DarkThemeSource;
}

// ─── Private color/metric helpers ────────────────────────────────

function colorLuma(value: string): number | null {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

function isLightColor(value: string | undefined): boolean {
  const lum = value ? relativeLuminance(value) : null;
  return lum !== null && lum > 0.70;
}

function isNearLightColor(value: string | undefined): boolean {
  const lum = value ? relativeLuminance(value) : null;
  return lum !== null && lum > 0.55;
}

function isDarkColor(value: string | undefined): boolean {
  const lum = value ? relativeLuminance(value) : null;
  return lum !== null && lum < 0.20;
}

function mixHexColor(a: string, b: string, amount: number): string | null {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return null;
  const t = Math.max(0, Math.min(1, amount));
  const rgbToHex = (r: number, g: number, b: number): string =>
    "#" + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");
  return rgbToHex(ca.r + (cb.r - ca.r) * t, ca.g + (cb.g - ca.g) * t, ca.b + (cb.b - ca.b) * t);
}

function isSolidHexColor(value: string | undefined): boolean {
  return !!value && /^#[0-9a-fA-F]{3,8}$/.test(value.trim());
}

// ─── Palette sort helpers ────────────────────────────────────────

function darkestPaletteColor(tokens: { resolvedValue: string }[], fallback: string): string {
  const sorted = tokens
    .map((t) => t.resolvedValue)
    .filter(isSafeColorValue)
    .map((v) => ({ value: v.trim(), luma: colorLuma(v.trim()) }))
    .filter((item): item is { value: string; luma: number } => item.luma !== null)
    .sort((a, b) => a.luma - b.luma);
  return sorted[0]?.value ?? fallback;
}

function lightestPaletteColor(tokens: { resolvedValue: string }[], fallback: string): string {
  const sorted = tokens
    .map((t) => t.resolvedValue)
    .filter(isSafeColorValue)
    .map((v) => ({ value: v.trim(), luma: colorLuma(v.trim()) }))
    .filter((item): item is { value: string; luma: number } => item.luma !== null)
    .sort((a, b) => b.luma - a.luma);
  return sorted[0]?.value ?? fallback;
}

// ─── Source intent helpers ───────────────────────────────────────

function isLightFirstIntent(board: DesignMdBoard): boolean {
  const intent = board.sourceIntent;
  return intent.darkModeIntent === "lightFirstDerived"
    || intent.mood.includes("lightFirst")
    || intent.canvasIntent === "cream"
    || intent.canvasIntent === "offWhite"
    || intent.canvasIntent === "warmLight";
}

function isSoftWarmIntent(board: DesignMdBoard): boolean {
  return board.sourceIntent.mood.includes("warm")
    || board.sourceIntent.mood.includes("soft")
    || board.sourceIntent.mood.includes("editorial")
    || board.sourceIntent.contrastIntent === "soft";
}

function isDarkNativeIntent(board: DesignMdBoard): boolean {
  return board.sourceIntent.darkModeIntent === "darkNative"
    || board.sourceIntent.mood.includes("darkNative")
    || board.sourceIntent.canvasIntent === "dark"
    || board.sourceIntent.canvasIntent === "black"
    || board.sourceIntent.mood.includes("highContrast");
}

// ─── Token key classification ────────────────────────────────────

function keyParts(key: string): string[] {
  return key.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean);
}

function isCanvasToken(key: string): boolean {
  return keyParts(key).some((p) => /^(canvas|background|page|app|floor|root)$/.test(p))
    || /^(body-bg|body-background|body-canvas)$/.test(keyParts(key).join("-"));
}

function isSurfaceToken(key: string): boolean {
  return keyParts(key).some((p) => /^(surface|card|panel|elevated|sheet|tile)$/.test(p));
}

function isPrimaryToken(key: string): boolean {
  return keyParts(key).some((p) => /^(primary|brand|accent|cta)$/.test(p));
}

function isSemanticToken(key: string): boolean {
  return keyParts(key).some((p) => /^(semantic|success|error|warning|danger|info)$/.test(p));
}

function isTimelineToken(key: string): boolean {
  return keyParts(key).some((p) => /^(timeline|stage|status)$/.test(p));
}

function isDarkToken(key: string): boolean {
  return keyParts(key).some((p) => /^(dark|black|inverse|night|aubergine)$/.test(p));
}

function isLightToken(key: string): boolean {
  return keyParts(key).some((p) => /^(light|white)$/.test(p));
}

function isContextualTextToken(key: string): boolean {
  return /(?:link|badge|selection|preview|console|white-text|focus|hover|active|muted|secondary)/i.test(key);
}

function isForbiddenCanvasCandidate(key: string): boolean {
  if (isCanvasToken(key) || isSurfaceToken(key)) return false;
  return isPrimaryToken(key) || isSemanticToken(key) || isTimelineToken(key);
}

function tokenSemantics(
  token: {
    resolvedRole?: DesignMdTokenRole;
    roleConfidence?: DesignMdTokenRoleConfidence;
    roleEvidence?: string[];
    roleWarnings?: string[];
    semanticRole?: DesignMdColorSemantics["semanticRole"];
    usageScope?: DesignMdColorSemantics["usageScope"];
    usageIntensity?: DesignMdColorSemantics["usageIntensity"];
  } | undefined,
): DesignMdColorSemantics | undefined {
  if (!token?.semanticRole || !token.usageScope || !token.usageIntensity) return undefined;
  return {
    resolvedRole: token.resolvedRole ?? "unknown",
    roleConfidence: token.roleConfidence ?? "fallback",
    roleEvidence: token.roleEvidence ?? [],
    roleWarnings: token.roleWarnings ?? [],
    semanticRole: token.semanticRole,
    usageScope: token.usageScope,
    usageIntensity: token.usageIntensity,
    evidence: [],
    warnings: [],
  };
}

function isForbiddenThemeCandidate(
  token: { key: string; resolvedRole?: DesignMdTokenRole; roleConfidence?: DesignMdTokenRoleConfidence; semanticRole?: DesignMdColorSemantics["semanticRole"]; usageScope?: DesignMdColorSemantics["usageScope"]; usageIntensity?: DesignMdColorSemantics["usageIntensity"] },
): boolean {
  const sem = tokenSemantics(token);
  if (sem && !canUseAsDarkCanvasCandidate(sem)) return true;
  if (sem && (isScopedOnlyColor(sem) || sem.semanticRole === "primaryAction" || sem.semanticRole === "brandAccent")) return true;
  return isForbiddenCanvasCandidate(token.key);
}

function roleConfidenceAtLeast(token: { roleConfidence?: DesignMdTokenRoleConfidence }, minimum: "medium" | "low" = "medium"): boolean {
  const order: Record<DesignMdTokenRoleConfidence, number> = { fallback: 0, low: 1, medium: 2, high: 3 };
  return order[token.roleConfidence ?? "fallback"] >= order[minimum];
}

function isCanvasRole(token: { resolvedRole?: DesignMdTokenRole; roleConfidence?: DesignMdTokenRoleConfidence }, minimum: "medium" | "low" = "medium"): boolean {
  return roleConfidenceAtLeast(token, minimum)
    && (token.resolvedRole === "globalCanvas" || token.resolvedRole === "pageBackground" || token.resolvedRole === "bodyBackground");
}

function isSectionSurfaceRole(token: { resolvedRole?: DesignMdTokenRole; roleConfidence?: DesignMdTokenRoleConfidence }, minimum: "medium" | "low" = "medium"): boolean {
  return roleConfidenceAtLeast(token, minimum) && token.resolvedRole === "sectionSurface";
}

function isComponentSurfaceRole(token: { resolvedRole?: DesignMdTokenRole; roleConfidence?: DesignMdTokenRoleConfidence }, minimum: "medium" | "low" = "medium"): boolean {
  return roleConfidenceAtLeast(token, minimum)
    && (token.resolvedRole === "cardSurface" || token.resolvedRole === "panelSurface" || token.resolvedRole === "componentSurface");
}

function isTextRole(token: { resolvedRole?: DesignMdTokenRole; roleConfidence?: DesignMdTokenRoleConfidence }, minimum: "medium" | "low" = "low"): boolean {
  return roleConfidenceAtLeast(token, minimum)
    && (token.resolvedRole === "bodyText" || token.resolvedRole === "headingText" || token.resolvedRole === "foregroundText" || token.resolvedRole === "mutedText");
}

// ─── Token matching ──────────────────────────────────────────────

function tokenKeyMatches(key: string, match: string): boolean {
  const normalized = key.toLowerCase();
  const target = match.toLowerCase();
  const compact = keyParts(key).join("-");
  const compactTarget = keyParts(match).join("-");
  const kp = keyParts(key);
  const tp = keyParts(match);
  const keyTheme = isDarkToken(key) ? "dark" : isLightToken(key) ? "light" : null;
  const targetTheme = isDarkToken(match) ? "dark" : isLightToken(match) ? "light" : null;
  const targetIsBaseSurface = tp.some((p) => /^(canvas|surface|background|card|text|ink|body|foreground)$/.test(p));
  if (keyTheme && !targetTheme && targetIsBaseSurface) return false;
  if (keyTheme && targetTheme && keyTheme !== targetTheme) return false;
  if (compact === compactTarget || normalized === target) return true;
  const singleThemeTarget = tp.length === 1 && targetTheme !== null;
  if (singleThemeTarget) return kp[0] === compactTarget;
  return kp.includes(compactTarget);
}

function tokenColor(
  tokens: { key: string; resolvedValue: string }[],
  matches: string[],
  fallback: string,
): string {
  for (const match of matches) {
    const found = tokens.find((t) => tokenKeyMatches(t.key, match));
    if (isSafeColorValue(found?.resolvedValue)) return found.resolvedValue.trim();
  }
  return fallback;
}

function tokenColorByPolicy(
  tokens: ThemeColorCandidate[],
  matches: string[],
  fallback: string,
  allowed: (semantics: DesignMdColorSemantics | undefined, token: ThemeColorCandidate) => boolean,
): string {
  for (const match of matches) {
    const found = tokens.find((t) => tokenKeyMatches(t.key, match) && allowed(tokenSemantics(t), t));
    if (isSafeColorValue(found?.resolvedValue)) return found.resolvedValue.trim();
  }
  return fallback;
}

// ─── Dark theme resolution ───────────────────────────────────────

function resolveDarkToken(
  tokens: ThemeColorCandidate[],
  explicitMatches: string[],
  fallbackDerive: () => string,
  fallbackHard: string,
  filterForbiddenCanvas = false,
): ThemeTokenResolve {
  const found = tokens.find((t) => {
    if (filterForbiddenCanvas && isForbiddenThemeCandidate(t)) return false;
    for (const match of explicitMatches) {
      if (tokenKeyMatches(t.key, match) && isSafeColorValue(t.resolvedValue)) {
        if (filterForbiddenCanvas && !isDarkColor(t.resolvedValue)) return false;
        if (filterForbiddenCanvas && keyParts(t.key).includes("body") && !isCanvasRole(t, "medium")) return false;
        if (filterForbiddenCanvas && isComponentSurfaceRole(t, "medium")) return false;
        return true;
      }
    }
    return false;
  });
  if (found) {
    return { value: found.resolvedValue.trim(), source: "source", matchedKey: found.key, note: `explicit ${found.key}` };
  }
  const derived = fallbackDerive();
  if (isSafeColorValue(derived)) {
    return { value: derived.trim(), source: "derived", note: "derived from palette" };
  }
  return { value: fallbackHard, source: "fallback", note: "system fallback" };
}

interface DarkThemeSelection {
  canvas: ThemeTokenResolve;
  surface: ThemeTokenResolve;
  text: ThemeTokenResolve;
  border: ThemeTokenResolve;
  muted: ThemeTokenResolve;
}

function selectDarkTheme(board: DesignMdBoard): DarkThemeSelection {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  const lightFirst = isLightFirstIntent(board) && !isDarkNativeIntent(board);
  const softWarm = isSoftWarmIntent(board);
  const explicitCanvasKeys = [
    "body-dark", "canvas-dark", "background-dark", "page-dark", "app-dark",
    "canvas-night", "background-night", "inverse-canvas",
    "dark-body", "dark-canvas", "dark-background",
  ];

  const deriveSoftDarkFromInk = () => {
    const textDarkTokens = board.colorGroups
      .filter((g) => g.prefix === "text/ink")
      .flatMap((g) => g.tokens)
      .filter((t) => !isContextualTextToken(t.key) && !isForbiddenThemeCandidate(t) && isSolidHexColor(t.resolvedValue) && isDarkColor(t.resolvedValue));
    const ink = darkestPaletteColor(textDarkTokens, "");
    const warmLight = lightestPaletteColor(
      board.colorGroups
        .filter((g) => g.prefix === "canvas/surface")
        .flatMap((g) => g.tokens)
        .filter((t) => isSolidHexColor(t.resolvedValue) && isNearLightColor(t.resolvedValue) && !isForbiddenThemeCandidate(t)),
      "#f5f0e8",
    );
    if (ink && isDarkColor(ink)) {
      // Mix ink toward warm light. Soft/warm/editorial designs get a higher
      // warm-light ratio to avoid harsh near-black dark canvases.
      const mixRatio = softWarm ? 0.18 : 0.10;
      const mixed = mixHexColor(ink, warmLight, mixRatio);
      if (mixed && isSafeColorValue(mixed)) {
        // For soft/warm designs, enforce a minimum luma threshold so the
        // dark canvas stays visibly softer than raw ink.
        const mixedLuma = relativeLuminance(mixed);
        if (softWarm && mixedLuma !== null && mixedLuma < 0.04) {
          const reMixed = mixHexColor(ink, warmLight, 0.22);
          if (reMixed && isSafeColorValue(reMixed)) return reMixed;
        }
        return mixed;
      }
      return ink;
    }
    return softWarm ? "#3b3830" : "#2a2d34";
  };

  const canvasResolve = resolveDarkToken(
    allColors,
    explicitCanvasKeys,
    () => {
      if (lightFirst) return deriveSoftDarkFromInk();
      const textDarkTokens = board.colorGroups
        .filter((g) => g.prefix === "text/ink")
        .flatMap((g) => g.tokens)
        .filter((t) => !isContextualTextToken(t.key) && !isForbiddenThemeCandidate(t) && isSafeColorValue(t.resolvedValue) && isDarkColor(t.resolvedValue));
      const darkestText = darkestPaletteColor(textDarkTokens, "");
      if (darkestText && isDarkColor(darkestText)) {
        // Reject pure black (#000000) or near-black (luma < 0.005) unless dark-native.
        // Many designs have a plain "black" token that should not become full canvas.
        if (!isDarkNativeIntent(board)) {
          const lum = relativeLuminance(darkestText);
          if (lum !== null && lum < 0.005) {
            return "#14181e";
          }
        }
        return darkestText;
      }
      const canvasGroupTokens = board.colorGroups
        .filter((g) => g.prefix === "canvas/surface")
        .flatMap((g) => g.tokens)
        .filter((t) => !isForbiddenThemeCandidate(t) && (isCanvasRole(t, "low") || isSectionSurfaceRole(t, "medium")));
      const darkestCanvas = darkestPaletteColor(canvasGroupTokens, "");
      if (darkestCanvas && isDarkColor(darkestCanvas)) {
        if (!isDarkNativeIntent(board)) {
          const lum = relativeLuminance(darkestCanvas);
          if (lum !== null && lum < 0.005) return "#14181e";
        }
        return darkestCanvas;
      }
      const neutralDarkTokens = allColors.filter((t) =>
        !isForbiddenThemeCandidate(t) && !isComponentSurfaceRole(t, "medium") && isSafeColorValue(t.resolvedValue) && isDarkColor(t.resolvedValue));
      const darkestNeutral = darkestPaletteColor(neutralDarkTokens, "");
      if (darkestNeutral && isDarkColor(darkestNeutral)) {
        if (!isDarkNativeIntent(board)) {
          const lum = relativeLuminance(darkestNeutral);
          if (lum !== null && lum < 0.005) return "#14181e";
        }
        return darkestNeutral;
      }
      const safeAll = allColors.filter((t) => !isForbiddenThemeCandidate(t) && !isComponentSurfaceRole(t, "medium") && isSolidHexColor(t.resolvedValue));
      const darkestSafe = darkestPaletteColor(safeAll, "");
      if (darkestSafe && isDarkColor(darkestSafe)) {
        if (!isDarkNativeIntent(board)) {
          const lum = relativeLuminance(darkestSafe);
          if (lum !== null && lum < 0.005) return "#14181e";
        }
        return darkestSafe;
      }
      return softWarm ? "#3b3830" : "#14181e";
    },
    softWarm ? "#3b3830" : "#14181e",
    true,
  );
  const darkCanvas = canvasResolve.value;

  const surfaceExplicit = [
    "surface-dark", "surface-card-dark", "elevated-dark", "card-dark", "panel-dark",
    "surface-night", "card-night", "inverse-surface", "inverse-surface-1", "inverse-surface-2",
    "dark-surface", "dark-card", "dark-panel",
  ];
  const surfaceResolve = resolveDarkToken(
    allColors,
    lightFirst && canvasResolve.source !== "source" ? [] : surfaceExplicit,
    () => {
      const lighten = lightFirst ? (softWarm ? 0.11 : 0.08) : 0.06;
      const mixed = mixHexColor(darkCanvas, "#ffffff", lighten);
      if (mixed && isSafeColorValue(mixed)) return mixed;
      return mixHexColor(darkCanvas, "#ffffff", lighten) ?? (softWarm ? "#4a4740" : "#1f232b");
    },
    softWarm ? "#4a4740" : "#1f232b",
    true,
  );
  const darkSurface = surfaceResolve.value;

  const textExplicit = [
    "on-dark", "text-on-dark", "body-on-dark", "foreground-dark",
    "on-canvas-dark", "ink-on-dark", "inverse-ink", "on-night",
  ];
  const textResolve = resolveDarkToken(
    allColors,
    textExplicit,
    () => {
      const textGroupTokens = board.colorGroups
        .filter((g) => g.prefix === "text/ink")
        .flatMap((g) => g.tokens)
        .filter((t) => !isContextualTextToken(t.key) && isTextRole(t, "low") && tokenSemantics(t)?.semanticRole === "text");
      const lightestText = lightestPaletteColor(textGroupTokens, "");
      if (lightestText && !isDarkColor(lightestText)) {
        if (ensureReadable(lightestText, darkCanvas, "") === lightestText) return lightestText;
      }
      return softWarm ? "#f6f1e8" : "#f0f2f5";
    },
    softWarm ? "#f6f1e8" : "#f0f2f5",
  );
  const darkText = ensureReadable(textResolve.value, darkCanvas, softWarm ? "#f6f1e8" : "#f0f2f5");

  const mutedExplicit = ["muted-on-dark", "on-dark-muted", "text-muted-dark", "muted-dark"];
  const mutedResolve = resolveDarkToken(
    allColors,
    mutedExplicit,
    () => {
      const mixed = mixHexColor(darkText, darkCanvas, lightFirst ? 0.60 : 0.55);
      if (mixed && isSafeColorValue(mixed)) return mixed;
      return softWarm ? "#aaa59c" : "#8b909a";
    },
    softWarm ? "#aaa59c" : "#8b909a",
  );
  const darkMuted = ensureReadable(mutedResolve.value, darkCanvas, softWarm ? "#aaa59c" : "#8b909a");

  const borderExplicit = [
    "border-dark", "hairline-dark", "divider-dark", "stroke-dark",
    "dark-border", "dark-hairline", "dark-divider",
  ];
  const borderResolve = resolveDarkToken(
    allColors,
    borderExplicit,
    () => {
      const mixed = mixHexColor(darkSurface, darkText, softWarm ? 0.06 : lightFirst ? 0.07 : 0.10);
      if (mixed && isSafeColorValue(mixed)) return mixed;
      return softWarm ? "#4f4c46" : "#2a2e35";
    },
    softWarm ? "#46433d" : "#2a2e35",
  );

  return {
    canvas: canvasResolve,
    surface: surfaceResolve,
    text: { value: darkText, source: textResolve.source, matchedKey: textResolve.matchedKey, note: textResolve.note },
    border: borderResolve,
    muted: { value: darkMuted, source: mutedResolve.source, matchedKey: mutedResolve.matchedKey, note: mutedResolve.note },
  };
}

// ─── Light theme resolution ──────────────────────────────────────

function resolveLightTokensRaw(board: DesignMdBoard): {
  canvas: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
} {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  const lightCanvasCandidates = [
    ...(board.sourceIntent.canvasIntent === "cream" || board.sourceIntent.canvasIntent === "warmLight" || board.sourceIntent.canvasIntent === "offWhite"
      ? ["canvas-cream", "cream", "parchment", "off-white", "offwhite", "canvas-parchment", "canvas-soft"]
      : []),
    "canvas-light", "background-light",
    "canvas", "background", "page",
    "body-light",
  ];
  let pickedLightCanvas = tokenColorByPolicy(allColors, lightCanvasCandidates, "", (sem, t) =>
    isSolidHexColor(t.resolvedValue) && !isComponentSurfaceRole(t, "medium") && (isCanvasRole(t, "medium") || canUseAsCanvas(sem) || (sem === undefined && !isForbiddenCanvasCandidate(t.key))));
  if (!pickedLightCanvas || isDarkColor(pickedLightCanvas)) {
    const bodyToken = allColors.find((t) => tokenKeyMatches(t.key, "body") && isCanvasRole(t, "low") && isSolidHexColor(t.resolvedValue));
    if (bodyToken && !isDarkColor(bodyToken.resolvedValue) && !allColors.some((t) => t.key !== bodyToken.key && isCanvasToken(t.key))) {
      pickedLightCanvas = bodyToken.resolvedValue;
    }
    if (!pickedLightCanvas || isDarkColor(pickedLightCanvas)) {
      const safeLightTokens = allColors.filter((t) =>
        !isForbiddenThemeCandidate(t) && !isComponentSurfaceRole(t, "medium") && isSolidHexColor(t.resolvedValue));
      const lightest = lightestPaletteColor(safeLightTokens, "");
      pickedLightCanvas = (lightest && isLightColor(lightest)) ? lightest : "#ffffff";
    }
  }
  const lightCanvas = isDarkColor(pickedLightCanvas) ? "#ffffff" : pickedLightCanvas;

  const lightSurfaceCandidates = [
    "surface-light", "surface-card-light", "card-light", "panel-light",
    "surface-card", "surface", "card", "panel",
  ];
  const pickedLightSurface = tokenColorByPolicy(allColors, lightSurfaceCandidates, "", (sem, t) =>
    isSolidHexColor(t.resolvedValue) && (isSectionSurfaceRole(t, "medium") || isComponentSurfaceRole(t, "medium") || canUseAsSurface(sem) || (sem === undefined && !isForbiddenCanvasCandidate(t.key))));
  const lightSurface = (pickedLightSurface && !isDarkColor(pickedLightSurface))
    ? pickedLightSurface
    : (isLightColor(lightCanvas) ? "#f6f7f9" : (mixHexColor(lightCanvas, "#ffffff", 0.08) ?? "#f6f7f9"));

  const lightTextCandidates = ["ink", "text", "body-strong", "foreground", "body"];
  const lightText = ensureReadable(tokenColorByPolicy(allColors, lightTextCandidates, "#111111", (sem, _t) =>
    isTextRole(_t, "low") && sem?.semanticRole === "text" && !isContextualTextToken(_t.key)), lightCanvas, "#111111");

  const lightMuted = ensureReadable(tokenColor(allColors, ["muted", "secondary", "soft"], "#667085"), lightCanvas, "#667085");

  const lightBorderCandidates = ["hairline", "border", "divider", "stroke"];
  const lightBorder = tokenColor(allColors, lightBorderCandidates,
    mixHexColor(lightSurface, lightText, 0.12) ?? "#d7dce2");

  return { canvas: lightCanvas, surface: lightSurface, text: lightText, muted: lightMuted, border: lightBorder };
}

// ─── Public resolvers ────────────────────────────────────────────

export function resolveLightTokens(board: DesignMdBoard): ThemeTokens {
  const light = resolveLightTokensRaw(board);
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  const primary = tokenColorByPolicy(allColors, ["primary", "brand", "accent"], "#2563eb", (sem) =>
    canUseAsHeroAccent(sem));
  const onPrimary = ensureReadable(tokenColor(allColors, ["on-primary"], readableTextColor(primary)), primary, readableTextColor(primary));

  return {
    variant: "light",
    canvas: light.canvas,
    surface: light.surface,
    text: light.text,
    muted: light.muted,
    border: light.border,
    primary,
    onPrimary,
    onDark: light.text,
    darkCanvas: light.canvas,
    darkSurface: light.surface,
  };
}

export function resolveDarkTokens(board: DesignMdBoard): ThemeTokens {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  const darkTheme = selectDarkTheme(board);
  const darkCanvas = darkTheme.canvas.value;
  const darkSurface = darkTheme.surface.value;
  const darkText = darkTheme.text.value;
  const darkBorder = darkTheme.border.value;
  const darkMuted = darkTheme.muted.value;
  const onDark = ensureReadable(tokenColor(allColors, ["on-dark", "body-on-dark", "text-on-dark", "on-black", "white"], darkText), darkCanvas, darkText);

  const primary = tokenColorByPolicy(allColors, ["primary", "brand", "accent"], "#2563eb", (sem) =>
    canUseAsHeroAccent(sem));
  const onPrimary = ensureReadable(tokenColor(allColors, ["on-primary"], readableTextColor(primary)), primary, readableTextColor(primary));

  const darkThemeSource: DarkThemeSource = {
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
  };

  return {
    variant: "dark",
    canvas: darkCanvas,
    surface: darkSurface,
    text: darkText,
    muted: darkMuted,
    border: darkBorder,
    primary,
    onPrimary,
    onDark,
    darkCanvas,
    darkSurface,
    darkThemeSource,
  };
}
