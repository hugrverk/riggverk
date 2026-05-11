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
import {
  determineDarkPreviewMode,
  type DarkPreviewMode,
} from "./designMdDarkPreviewPolicy";

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
  darkPreviewMode?: DarkPreviewMode;
  darkPreviewNote?: string;
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

function isSoftWarmIntent(board: DesignMdBoard): boolean {
  return board.sourceIntent.mood.includes("warm")
    || board.sourceIntent.mood.includes("soft")
    || board.sourceIntent.mood.includes("editorial")
    || board.sourceIntent.contrastIntent === "soft";
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
  darkPreviewMode: DarkPreviewMode;
  darkPreviewNote: string;
}

function selectDarkTheme(board: DesignMdBoard): DarkThemeSelection & { darkPreviewMode: DarkPreviewMode; darkPreviewNote: string } {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  const softWarm = isSoftWarmIntent(board);

  // ── Consult the dark preview policy ──
  const darkPolicy = determineDarkPreviewMode(board);

  const explicitCanvasKeys = [
    "body-dark", "canvas-dark", "background-dark", "page-dark", "app-dark",
    "canvas-night", "background-night",
    "dark-body", "dark-canvas", "dark-background",
    // inverse-canvas explicitly excluded — it is an inversion hint, not a dark-theme token.
  ];

  // ── Derive a conservative dark canvas fallback (never from scoped or section-only tokens) ──
  const deriveConservativeDarkCanvas = (): string => {
    // Only use neutral (text/canvas/border) dark tokens; never component-surface
    const neutralDarkTokens = allColors.filter((t) =>
      !isForbiddenThemeCandidate(t)
      && !isComponentSurfaceRole(t, "medium")
      && isSafeColorValue(t.resolvedValue)
      && isDarkColor(t.resolvedValue)
    );
    // Canvas derivation: require canvas role (globalCanvas/pageBackground/bodyBackground).
    // SectionSurface and component-surface tokens are deliberately excluded:
    // surface-dark/card-dark/panel-dark are ELEVATED surfaces, not page canvas.
    const canvasGroupTokens = board.colorGroups
      .filter((g) => g.prefix === "canvas/surface")
      .flatMap((g) => g.tokens)
      .filter((t) => !isForbiddenThemeCandidate(t) && isCanvasRole(t, "low"));
    const textGroupTokens = board.colorGroups
      .filter((g) => g.prefix === "text/ink")
      .flatMap((g) => g.tokens)
      .filter((t) => !isContextualTextToken(t.key) && !isForbiddenThemeCandidate(t) && isSolidHexColor(t.resolvedValue) && isDarkColor(t.resolvedValue));

    const darkCanvas = darkestPaletteColor(canvasGroupTokens, "");
    if (darkCanvas && isDarkColor(darkCanvas) && !isForbiddenThemeCandidate(allColors.find((t) => isSafeColorValue(t.resolvedValue) && t.resolvedValue.trim() === darkCanvas.trim()) ?? { key: "" } as ThemeColorCandidate)) {
      return darkCanvas;
    }
    const darkInk = darkestPaletteColor(textGroupTokens, "");
    if (darkInk && isDarkColor(darkInk)) {
      const warmLight = lightestPaletteColor(
        board.colorGroups
          .filter((g) => g.prefix === "canvas/surface")
          .flatMap((g) => g.tokens)
          .filter((t) => isSolidHexColor(t.resolvedValue) && isNearLightColor(t.resolvedValue) && !isForbiddenThemeCandidate(t)),
        "#f5f0e8",
      );
      const mixRatio = softWarm ? 0.18 : 0.10;
      const mixed = mixHexColor(darkInk, warmLight, mixRatio);
      if (mixed && isSafeColorValue(mixed)) {
        const mixedLuma = relativeLuminance(mixed);
        if (softWarm && mixedLuma !== null && mixedLuma < 0.04) {
          const reMixed = mixHexColor(darkInk, warmLight, 0.22);
          if (reMixed && isSafeColorValue(reMixed)) return reMixed;
        }
        return mixed;
      }
      return darkInk;
    }
    const darkestNeutral = darkestPaletteColor(neutralDarkTokens, "");
    if (darkestNeutral && isDarkColor(darkestNeutral)) return darkestNeutral;
    return softWarm ? "#3b3830" : "#2a2d34";
  };

  // ── darkTokenBoard: stable neutral dark wrapper, NOT a derived dark theme ──
  // Uses fixed colors that are identical for every board to visually communicate
  // "no explicit dark theme detected". Does NOT derive from board palette to avoid
  // giving the impression of a real dark mode.
  //
  // The wrapper is dark-safe for readability but visually distinct from fullSourceDark.
  if (darkPolicy.mode === "darkTokenBoard") {
    return {
      canvas: { value: "#1a1c1e", source: "fallback", note: "stable neutral wrapper (dark token board)" },
      surface: { value: "#242628", source: "fallback", note: "stable neutral wrapper (dark token board)" },
      text: { value: "#e0e2e5", source: "fallback", note: "stable neutral text (dark token board)" },
      border: { value: "#333538", source: "fallback", note: "stable neutral border (dark token board)" },
      muted: { value: "#8b909a", source: "fallback", note: "stable neutral muted (dark token board)" },
      darkPreviewMode: darkPolicy.mode,
      darkPreviewNote: darkPolicy.reason,
    };
  }

  // ── sectionalSourceDark ──
  // No global dark canvas, but explicit dark sections/tiles/surfaces with on-dark text.
  // Canvas is derived from palette neutrals (not dark section surfaces).
  // Surface uses source-backed dark section surfaces when available.
  // Text uses on-dark/body-on-dark/primary-on-dark tokens.
  if (darkPolicy.mode === "sectionalSourceDark") {
    // Canvas: conservative derivation from palette neutrals — NOT from section surfaces
    const canvasResolve = resolveDarkToken(
      allColors,
      [],
      () => deriveConservativeDarkCanvas(),
      softWarm ? "#3b3830" : "#1a1c1e",
      true, // filter forbidden canvas candidates
    );
    const darkCanvas = canvasResolve.value;

    // Surface: prefer source-backed dark section surfaces (surface-tile-*, surface-black)
    const sectionDarkKeys = [
      "surface-tile-1", "surface-tile-2", "surface-tile-3",
      "surface-black", "surface-dark",
      "product-tile-dark", "product-tile-dark-2", "product-tile-dark-3",
      "dark-surface", "dark-tile", "card-dark", "panel-dark",
    ];
    const surfaceResolve = resolveDarkToken(
      allColors,
      sectionDarkKeys,
      () => {
        const lighten = softWarm ? 0.11 : 0.08;
        const mixed = mixHexColor(darkCanvas, "#ffffff", lighten);
        if (mixed && isSafeColorValue(mixed)) return mixed;
        return softWarm ? "#4a4740" : "#242628";
      },
      softWarm ? "#4a4740" : "#242628",
      false, // don't filter non-canvas — we want surface tokens
    );
    const darkSurface = surfaceResolve.value;

    // Text: use on-dark body text tokens explicitly.
    // primary-on-dark is excluded — it is an accent/link color, not body text.
    const textExplicit = [
      "on-dark", "body-on-dark", "text-on-dark",
      "foreground-dark", "on-canvas-dark", "ink-on-dark",
    ];
    const textResolve = resolveDarkToken(
      allColors,
      textExplicit,
      () => {
        const textGroupTokens = board.colorGroups
          .filter((g) => g.prefix === "text/ink")
          .flatMap((g) => g.tokens)
          .filter((t) => !isContextualTextToken(t.key) && isTextRole(t, "low"));
        const lightestText = lightestPaletteColor(textGroupTokens, "");
        if (lightestText && !isDarkColor(lightestText)) {
          if (ensureReadable(lightestText, darkCanvas, "") === lightestText) return lightestText;
        }
        return softWarm ? "#f6f1e8" : "#f0f2f5";
      },
      softWarm ? "#f6f1e8" : "#f0f2f5",
    );
    const darkText = ensureReadable(textResolve.value, darkCanvas, softWarm ? "#f6f1e8" : "#f0f2f5");

    const mutedResolve = resolveDarkToken(
      allColors,
      ["muted-on-dark", "on-dark-muted", "text-muted-dark", "muted-dark"],
      () => {
        const mixed = mixHexColor(darkText, darkCanvas, softWarm ? 0.60 : 0.55);
        if (mixed && isSafeColorValue(mixed)) return mixed;
        return softWarm ? "#aaa59c" : "#8b909a";
      },
      softWarm ? "#aaa59c" : "#8b909a",
    );
    const darkMuted = ensureReadable(mutedResolve.value, darkCanvas, softWarm ? "#aaa59c" : "#8b909a");

    const borderResolve = resolveDarkToken(
      allColors,
      ["border-dark", "hairline-dark", "divider-dark", "stroke-dark"],
      () => {
        const mixed = mixHexColor(darkSurface, darkText, softWarm ? 0.06 : 0.10);
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
      darkPreviewMode: darkPolicy.mode,
      darkPreviewNote: darkPolicy.reason,
    };
  }

  // ── fullSourceDark / conservativeDerivedDark ──

  const isFullSource = darkPolicy.mode === "fullSourceDark";

  const canvasResolve = resolveDarkToken(
    allColors,
    explicitCanvasKeys,
    () => deriveConservativeDarkCanvas(),
    softWarm ? "#3b3830" : "#14181e",
    !isFullSource, // for conservativeDerivedDark, filter non-dark/body/component-surface candidates
  );
  const darkCanvas = canvasResolve.value;

  const surfaceExplicit = [
    "surface-dark", "surface-card-dark", "elevated-dark", "card-dark", "panel-dark",
    "surface-night", "card-night", "inverse-surface", "inverse-surface-1", "inverse-surface-2",
    "dark-surface", "dark-card", "dark-panel",
  ];
  const surfaceResolve = resolveDarkToken(
    allColors,
    isFullSource ? surfaceExplicit : [], // conservativeDerivedDark: don't look for explicit dark surface
    () => {
      const lighten = softWarm ? 0.11 : 0.08;
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
      const mixed = mixHexColor(darkText, darkCanvas, softWarm ? 0.60 : 0.55);
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
      const mixed = mixHexColor(darkSurface, darkText, softWarm ? 0.06 : 0.10);
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
    darkPreviewMode: darkPolicy.mode,
    darkPreviewNote: darkPolicy.reason,
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

  const isTokenBoard = darkTheme.darkPreviewMode === "darkTokenBoard";
  const darkThemeSource: DarkThemeSource = {
    canvas: { source: isTokenBoard ? "policy" : darkTheme.canvas.source, matchedKey: darkTheme.canvas.matchedKey, note: darkTheme.canvas.note },
    surface: { source: isTokenBoard ? "policy" : darkTheme.surface.source, matchedKey: darkTheme.surface.matchedKey, note: darkTheme.surface.note },
    text: { source: isTokenBoard ? "policy" : darkTheme.text.source, matchedKey: darkTheme.text.matchedKey, note: darkTheme.text.note },
    border: { source: isTokenBoard ? "policy" : darkTheme.border.source, matchedKey: darkTheme.border.matchedKey, note: darkTheme.border.note },
    muted: { source: isTokenBoard ? "policy" : darkTheme.muted.source, matchedKey: darkTheme.muted.matchedKey, note: darkTheme.muted.note },
    warnings: ([] as string[]).concat(
      isTokenBoard ? ["dark token board — no full dark theme derived"] : [],
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
    darkPreviewMode: darkTheme.darkPreviewMode,
    darkPreviewNote: darkTheme.darkPreviewNote,
  };
}
