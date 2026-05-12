/**
 * designMdDarkPreviewPolicy.ts
 *
 * Central dark preview mode classification.
 * Determines whether a DesignMdBoard qualifies for a full dark theme rendering
 * or must render a conservative dark token board.
 *
 * Policy rules (in priority order):
 * 1. fullSourceDark: explicit dark canvas/background/page/body-background token
 *    with medium+ confidence, AND at least one of: dark-native source intent,
 *    explicit on-dark/text-on-dark token, or surface-dark token.
 * 2. sectionalSourceDark: no global dark canvas, but explicit dark sections/
 *    tiles/nav/cards/surfaces with on-dark text and/or prose evidence of
 *    alternating dark/light canvases, dark product tiles, dark nav bars,
 *    or dark component surfaces.
 * 3. conservativeDerivedDark: no explicit dark canvas, but enough neutral
 *    text/surface/canvas tokens exist to derive safely. Source intent is not
 *    strongly light-only (cream, offWhite, warmLight + lightFirstDerived).
 * 4. darkTokenBoard: everything else — light-first/warm/cream/soft/editorial
 *    without explicit dark evidence, ambiguous tokens, or insufficient
 *    neutral tokens for safe derivation.
 */

import type { DesignMdBoard } from "./designMdSpecimenBuilder";
import type { DesignMdTokenRoleConfidence } from "./designMdTokenRoleResolver";
import { isSafeColorValue } from "./designMdPreviewParser";

export type DarkPreviewMode =
  | "fullSourceDark"
  | "sectionalSourceDark"
  | "conservativeDerivedDark"
  | "darkTokenBoard";

export interface DarkPreviewDecision {
  mode: DarkPreviewMode;
  reason: string;
  evidence: string[];
  warnings: string[];
}

// ─── Token role helpers ────────────────────────────────────────────

type BoardToken = DesignMdBoard["colorGroups"][number]["tokens"][number];

function hasCanvasRole(token: BoardToken, minimum: DesignMdTokenRoleConfidence = "medium"): boolean {
  const order: Record<DesignMdTokenRoleConfidence, number> = { fallback: 0, low: 1, medium: 2, high: 3 };
  const conf = token.roleConfidence ?? "fallback";
  if (order[conf] < order[minimum]) return false;
  return token.resolvedRole === "globalCanvas" || token.resolvedRole === "pageBackground" || token.resolvedRole === "bodyBackground";
}

function hasTextRole(token: BoardToken, minimum: DesignMdTokenRoleConfidence = "low"): boolean {
  const order: Record<DesignMdTokenRoleConfidence, number> = { fallback: 0, low: 1, medium: 2, high: 3 };
  const conf = token.roleConfidence ?? "fallback";
  if (order[conf] < order[minimum]) return false;
  return token.resolvedRole === "bodyText" || token.resolvedRole === "headingText" || token.resolvedRole === "foregroundText" || token.resolvedRole === "mutedText";
}

function hasSurfaceRole(token: BoardToken, minimum: DesignMdTokenRoleConfidence = "medium"): boolean {
  const order: Record<DesignMdTokenRoleConfidence, number> = { fallback: 0, low: 1, medium: 2, high: 3 };
  const conf = token.roleConfidence ?? "fallback";
  if (order[conf] < order[minimum]) return false;
  return token.resolvedRole === "sectionSurface" || token.resolvedRole === "cardSurface" || token.resolvedRole === "panelSurface";
}

function isComponentSurfaceRole(token: BoardToken): boolean {
  return token.resolvedRole === "componentSurface";
}

function isScopedToken(token: BoardToken): boolean {
  return token.resolvedRole === "stateOnly"
    || token.resolvedRole === "timelineOnly"
    || token.resolvedRole === "semanticOnly"
    || token.resolvedRole === "decorativeOnly"
    || token.resolvedRole === "primaryAction"
    || token.resolvedRole === "brandAccent";
}

/**
 * Check whether a token's value is visually dark (low relative luminance).
 * Used to prevent light or mid-tone tokens from qualifying as dark theme
 * candidates when only their key implies darkness.
 */
function tokenIsDarkValue(token: BoardToken): boolean {
  const hex = token.resolvedValue?.trim();
  if (!hex || !/^#[0-9a-fA-F]{3,8}$/.test(hex)) return false;
  const raw = hex.slice(1);
  const full = raw.length === 3 || raw.length === 4
    ? raw.slice(0, 3).split("").map((c) => c + c).join("")
    : raw.slice(0, 6);
  const int = Number.parseInt(full, 16);
  if (Number.isNaN(int)) return false;
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  // Relative luminance < ~0.32 means visually dark
  const luma = 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
  return luma < 0.32;
}

// ─── Key matching helpers ──────────────────────────────────────────

function keyParts(key: string): string[] {
  return key.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean);
}

function isDarkKey(key: string): boolean {
  return keyParts(key).some((p) => /^(dark|black|night|inverse|aubergine)$/.test(p));
}

function isExplicitDarkCanvasKey(key: string): boolean {
  const compact = keyParts(key).join("-");
  const matches = [
    "body-dark", "canvas-dark", "background-dark", "page-dark", "app-dark",
    "canvas-night", "background-night",
    "dark-body", "dark-canvas", "dark-background",
    "dark-page", "dark-app",
  ];
  // NOTE: inverse-canvas deliberately excluded — inverse tokens are inversion hints,
  // not dark-theme declarations. A light-first design may have inverse-canvas but no
  // actual dark mode.
  return matches.includes(compact) || matches.some((m) => key.toLowerCase().includes(m));
}

function isExplicitDarkSurfaceKey(key: string): boolean {
  const compact = keyParts(key).join("-");
  const matches = [
    "surface-dark", "surface-card-dark", "elevated-dark", "card-dark", "panel-dark",
    "surface-night", "card-night",
    "dark-surface", "dark-card", "dark-panel",
  ];
  return matches.includes(compact) || (
    keyParts(key).some((p) => /^(surface|card|panel|elevated)$/.test(p))
    && isDarkKey(key)
  );
}

function isOnDarkKey(key: string): boolean {
  const compact = keyParts(key).join("-");
  const matches = [
    "on-dark", "text-on-dark", "body-on-dark", "foreground-dark",
    "on-canvas-dark", "ink-on-dark", "on-night",
  ];
  return matches.includes(compact) || matches.some((m) => key.toLowerCase().includes(m));
}

/**
 * Check if a token key suggests a dark section/component surface even without
 * a global dark canvas key. Examples:
 *   surface-tile-1, surface-tile-2, surface-black (surface+tile or surface+black)
 *   product-tile-dark, product-tile-dark-2 (product + tile + dark)
 *
 * Also matches keys with both "surface" and "tile" parts even without "dark" keyword,
 * because surface-tile-naming is a clear pattern for section surfaces.
 *
 * The associated value check (tokenIsDarkValue) filters out false positives.
 */
function isSectionalDarkKey(key: string): boolean {
  const kp = keyParts(key);
  // surface + tile together implies a section surface regardless of dark keyword
  if (kp.includes("surface") && kp.includes("tile")) return true;
  // surface + black together implies a black section surface
  if (kp.includes("surface") && kp.includes("black")) return true;
  // Otherwise require a surface/component part AND a dark modifier
  const hasSurfacePart = kp.some((p) =>
    /^(surface|tile|card|panel|nav|product|utility|editorial|environment)$/.test(p)
  );
  if (!hasSurfacePart) return false;
  return kp.some((p) => /^(dark|black|night)$/.test(p));
}

/**
 * Check for key patterns that indicate a tile-like dark surface.
 * surface-tile-1, dark-tile, tile-dark, dark-utility-tile etc.
 */
function isTileDarkKey(key: string): boolean {
  const kp = keyParts(key);
  const hasTile = kp.includes("tile");
  if (!hasTile) return false;
  return isDarkKey(key);
}

/**
 * Check for key patterns that indicate a nav bar with dark background.
 */
function isNavDarkKey(key: string): boolean {
  const kp = keyParts(key);
  const hasNav = kp.some((p) => /^(nav|navigation|global-nav)$/.test(p));
  if (!hasNav) return false;
  return isDarkKey(key);
}

/**
 * Check for key patterns like product-tile-dark, component-dark-name.
 * Component-level dark surfaces that are not global but indicate dark sections.
 */
function isComponentDarkKey(key: string): boolean {
  const kp = keyParts(key);
  // Exclude keys that are already classified as canvas/surface semantic roles
  if (kp.some((p) => /^(canvas|background|page|app|root)$/.test(p))) return false;
  const hasComponentPart = kp.some((p) =>
    /^(product|feature|hero|banner|strip|band|editorial|environment|utility|section|block)$/.test(p)
  );
  return hasComponentPart && isDarkKey(key);
}

/**
 * Check for prose evidence of dark sections, alternating canvases,
 * dark tiles, dark navigation, terminal/dark shell, or dark editorial bands.
 */
function hasSectionalDarkProse(board: DesignMdBoard): boolean {
  const text = [
    board.title,
    board.description,
    board.overview ?? "",
    board.layout ?? "",
    ...board.visualLanguage.phrases,
  ].join(" ").toLowerCase();

  const patterns = [
    /\balternating (light and dark|dark and light) (canvas|section|surface)/,
    /dark (product |utility |editorial |environment )?tile/,
    /dark section/,
    /dark nav/,
    /dark component surface/,
    /\b(light hero|light canvas).*(dark tile|dark section|dark surface)/,
    /dark (editorial|environment|band)/,
    /sectional dark/,
  ];
  return patterns.some((p) => p.test(text));
}

function hasExplicitFullDarkProse(board: DesignMdBoard): boolean {
  const text = [
    board.title,
    board.description,
    board.overview ?? "",
    board.layout ?? "",
    ...board.visualLanguage.phrases,
  ].join(" ").toLowerCase();

  const patterns = [
    /\bdark theme\b/,
    /\bdark-native\b/,
    /\bdark canvas\b/,
    /\bnear[-\s]black canvas\b/,
    /\bblack canvas\b/,
    /\bdark mode\b/,
    /\bfull dark\b/,
    /\bdark interface\b/,
    /\bdark shell\b/,
    /\bimmersive dark\b/,
  ];
  return patterns.some((p) => p.test(text));
}

// ─── Source intent helpers ─────────────────────────────────────────

function isDarkNativeIntent(board: DesignMdBoard): boolean {
  const intent = board.sourceIntent;
  return intent.darkModeIntent === "darkNative"
    || intent.mood.includes("darkNative")
    || intent.canvasIntent === "dark"
    || intent.canvasIntent === "black";
}

function isStronglyLightOnly(board: DesignMdBoard): boolean {
  const intent = board.sourceIntent;
  const lightCanvas = intent.canvasIntent === "cream"
    || intent.canvasIntent === "offWhite"
    || intent.canvasIntent === "warmLight";
  const lightFirst = intent.darkModeIntent === "lightFirstDerived";
  const editorial = intent.mood.includes("editorial");
  const soft = intent.mood.includes("soft") || intent.contrastIntent === "soft";
  const warm = intent.mood.includes("warm");
  // Strongly light-only = light canvas/light-first/warm/soft/editorial, not dark-native
  return (lightCanvas || lightFirst || editorial || soft || warm) && !isDarkNativeIntent(board);
}

// ─── Main policy function ──────────────────────────────────────────

export function determineDarkPreviewMode(board: DesignMdBoard): DarkPreviewDecision {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  const evidence: string[] = [];
  const warnings: string[] = [];

  // ── Find explicit dark tokens ──
  const explicitDarkCanvasTokens = allColors.filter((t) =>
    isExplicitDarkCanvasKey(t.key) && hasCanvasRole(t, "medium"));
  const explicitDarkSurfaceTokens = allColors.filter((t) =>
    isExplicitDarkSurfaceKey(t.key) && (hasSurfaceRole(t, "medium") || hasCanvasRole(t, "low")));
  const explicitOnDarkTokens = allColors.filter((t) =>
    isOnDarkKey(t.key) && hasTextRole(t, "low"));
  const anyDarkCanvasKey = allColors.filter((t) =>
    isExplicitDarkCanvasKey(t.key));

  // ── Check for weak dark evidence ──
  const hasExplicitDarkCanvas = explicitDarkCanvasTokens.length > 0;
  const hasExplicitDarkSurface = explicitDarkSurfaceTokens.length > 0;
  const hasExplicitOnDark = explicitOnDarkTokens.length > 0;
  const hasAnyDarkCanvasKey = anyDarkCanvasKey.length > 0;

  if (hasExplicitDarkCanvas) {
    evidence.push(`explicit dark canvas token: ${explicitDarkCanvasTokens.map((t) => t.key).join(", ")}`);
  }
  if (hasExplicitDarkSurface) {
    evidence.push(`explicit dark surface token: ${explicitDarkSurfaceTokens.map((t) => t.key).join(", ")}`);
  }
  if (hasExplicitOnDark) {
    evidence.push(`explicit on-dark token: ${explicitOnDarkTokens.map((t) => t.key).join(", ")}`);
  }

  const darkNative = isDarkNativeIntent(board);
  const fullDarkProse = hasExplicitFullDarkProse(board);
  if (darkNative) evidence.push("source intent is dark-native");
  if (fullDarkProse) evidence.push("explicit full-dark prose evidence");

  // ── Rule 1: fullSourceDark ──
  // Requires:
  //   - explicit dark canvas key with medium+ canvas role confidence
  //   - explicit on-dark text token
  //   - source intent not strongly light-first unless explicit full-dark prose exists
  //
  // inverse-canvas is explicitly excluded from dark canvas key detection
  // because it is an inverse-palette hint, not a dark-theme declaration.
  //
  if (hasExplicitDarkCanvas) {
    if (isStronglyLightOnly(board) && !fullDarkProse) {
      evidence.push("explicit dark canvas token exists but source is light-first");
      warnings.push("dark canvas token exists but source is light-first; rendering conservative");
      // Fall through — will not qualify for fullSourceDark due to light-only source
    } else if (hasExplicitOnDark) {
      evidence.push("explicit dark canvas and on-dark text token form sufficient dark theme evidence");
      return {
        mode: "fullSourceDark",
        reason: "explicit dark canvas with on-dark text",
        evidence,
        warnings,
      };
    } else {
      evidence.push("explicit dark canvas token exists but no explicit on-dark text token");
      warnings.push("dark canvas exists but lacks on-dark text; rendering conservative");
      // Fall through to conservativeDerivedDark or darkTokenBoard
    }
  }

  // ── Rule 2: sectionalSourceDark ──
  const sectionalDarkSurfaceTokens = allColors.filter((t) =>
    (isSectionalDarkKey(t.key) || isTileDarkKey(t.key) || isNavDarkKey(t.key) || isComponentDarkKey(t.key))
    && isSafeColorValue(t.resolvedValue)
    && tokenIsDarkValue(t)
  );
  const darkComponentNames = board.componentGroups
    .filter((g) => {
      const name = g.name.toLowerCase();
      return name.includes("dark") || name.includes("black");
    })
    .map((g) => g.name);
  const hasDarkComponents = darkComponentNames.length > 0;
  const hasSectionalProse = hasSectionalDarkProse(board);
  const hasSectionalSurfaces = sectionalDarkSurfaceTokens.length > 0;

  if (hasSectionalSurfaces) {
    evidence.push(`sectional dark surface tokens: ${sectionalDarkSurfaceTokens.map((t) => t.key).join(", ")}`);
  }
  if (hasDarkComponents) {
    evidence.push(`dark-named components: ${darkComponentNames.join(", ")}`);
  }
  if (hasSectionalProse) {
    evidence.push("sectional dark prose evidence");
  }

  if (hasExplicitOnDark && sectionalDarkSurfaceTokens.length >= 3) {
    return {
      mode: "sectionalSourceDark",
      reason: `sectional dark surfaces (${sectionalDarkSurfaceTokens.length}) with on-dark text`,
      evidence,
      warnings,
    };
  }

  if (hasExplicitOnDark && sectionalDarkSurfaceTokens.length >= 2 && (hasDarkComponents || hasSectionalProse)) {
    return {
      mode: "sectionalSourceDark",
      reason: `sectional dark surfaces (${sectionalDarkSurfaceTokens.length}) with on-dark text and ${hasDarkComponents ? "dark components" : "prose evidence"}`,
      evidence,
      warnings,
    };
  }

  // ── Rule 3: conservativeDerivedDark ──
  // Only allow derivation when there are no explicit sectional dark surfaces.
  if (sectionalDarkSurfaceTokens.length > 0) {
    evidence.push("explicit sectional dark surfaces exist; conservative derivation skipped");
  } else if (isStronglyLightOnly(board)) {
    evidence.push("source is strongly light-only (cream/offWhite/warmLight canvas with light-first intent)");
  } else {
    // Check if enough neutral dark-valued tokens exist for safe derivation
    const neutralDarkValueTokens = allColors.filter((t) =>
      !isScopedToken(t)
      && !isComponentSurfaceRole(t)
      && t.resolvedRole !== "unknown"
      && (hasCanvasRole(t, "low") || hasTextRole(t, "low") || hasSurfaceRole(t, "low") || t.resolvedRole === "border" || t.resolvedRole === "hairline")
      && tokenIsDarkValue(t)  // value must actually be dark, not just have a dark role
    );

    const darkTextCandidate = neutralDarkValueTokens.some((t) =>
      hasTextRole(t, "low") && tokenIsDarkValue(t));
    const darkSurfaceCandidate = neutralDarkValueTokens.some((t) =>
      hasCanvasRole(t, "low") || hasSurfaceRole(t, "low"));

    if (neutralDarkValueTokens.length >= 3 && darkTextCandidate && darkSurfaceCandidate) {
      if (hasAnyDarkCanvasKey && !hasExplicitDarkCanvas) {
        warnings.push("dark canvas key exists but role confidence is low/fallback");
      }
      return {
        mode: "conservativeDerivedDark",
        reason: `neutral dark-valued tokens for safe derivation (${neutralDarkValueTokens.length} tokens, text: ${darkTextCandidate}, surface: ${darkSurfaceCandidate})`,
        evidence,
        warnings,
      };
    } else {
      evidence.push(`insufficient dark-valued neutral tokens for safe dark derivation (${neutralDarkValueTokens.length} tokens, text: ${darkTextCandidate}, surface: ${darkSurfaceCandidate})`);
    }
  }

  // ── Rule 4: darkTokenBoard ──
  // Everything else: light-first, warm, cream, soft, editorial without
  // explicit dark canvas, ambiguous tokens, or insufficient neutrals.

  warnings.push("no explicit dark canvas token with sufficient confidence");
  warnings.push("dark preview is conservative and token-based");
  return {
    mode: "darkTokenBoard",
    reason: "no explicit dark theme evidence; rendering dark token board",
    evidence,
    warnings,
  };
}

/**
 * Quick check: can this board render a full-source dark theme?
 */
export function canRenderFullDark(board: DesignMdBoard): boolean {
  return determineDarkPreviewMode(board).mode === "fullSourceDark";
}

/**
 * Quick check: is this board limited to dark token board?
 */
export function isDarkTokenBoardOnly(board: DesignMdBoard): boolean {
  return determineDarkPreviewMode(board).mode === "darkTokenBoard";
}

/**
 * Quick check: can this board render a sectional dark theme?
 */
export function canRenderSectionalDark(board: DesignMdBoard): boolean {
  return determineDarkPreviewMode(board).mode === "sectionalSourceDark";
}
