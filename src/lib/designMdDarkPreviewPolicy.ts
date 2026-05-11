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
 * 2. conservativeDerivedDark: no explicit dark canvas, but enough neutral
 *    text/surface/canvas tokens exist to derive safely. Source intent is not
 *    strongly light-only (cream, offWhite, warmLight + lightFirstDerived).
 * 3. darkTokenBoard: everything else — light-first/warm/cream/soft/editorial
 *    without explicit dark evidence, ambiguous tokens, or insufficient
 *    neutral tokens for safe derivation.
 */

import type { DesignMdBoard } from "./designMdSpecimenBuilder";
import type { DesignMdTokenRoleConfidence } from "./designMdTokenRoleResolver";

export type DarkPreviewMode =
  | "fullSourceDark"
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
    "canvas-night", "background-night", "inverse-canvas",
    "dark-body", "dark-canvas", "dark-background",
    "dark-page", "dark-app",
  ];
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

function hasAnyDarkEvidenceInProse(board: DesignMdBoard): boolean {
  const text = [
    board.overview,
    board.description,
    board.visualLanguage.phrases.join(" "),
    board.visualLanguage.keywords.join(" "),
    board.fontSubstitutes,
  ].join(" ").toLowerCase();
  return /\bdark\b|\bnight\b|\bblack canvas\b|\binverse\b|\bon-dark\b|\bterminal\b|\bconsole\b|\bhigh contrast\b/.test(text);
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
  if (darkNative) evidence.push("source intent is dark-native");

  // ── Rule 1: fullSourceDark ──
  // Requires explicit dark canvas with medium+ confidence AND
  // either dark-native intent or explicit on-dark tokens or explicit dark surface tokens.
  // BUT: if source intent is strongly light-first, explicit dark tokens are overridden.
  if (hasExplicitDarkCanvas) {
    // Light-first designs with cream/off-white/warm canvas should NOT get fullSourceDark
    // even if they have dark-named canvas tokens (e.g., "inverse-canvas" in a light-first design).
    if (isStronglyLightOnly(board)) {
      evidence.push("explicit dark canvas token exists but source intent is light-first");
      warnings.push("dark canvas token exists but source is light-first; rendering conservative");
      // Fall through to conservativeDerivedDark
    } else if (darkNative || hasExplicitOnDark || hasExplicitDarkSurface) {
      return {
        mode: "fullSourceDark",
        reason: "explicit dark canvas token with supporting dark evidence",
        evidence,
        warnings,
      };
    } else if (hasAnyDarkEvidenceInProse(board)) {
      evidence.push("dark prose evidence supports dark canvas");
      return {
        mode: "fullSourceDark",
        reason: "explicit dark canvas token with prose evidence",
        evidence,
        warnings,
      };
    } else {
      // Explicit dark canvas token but no supporting evidence — weak fullSourceDark
      evidence.push("explicit dark canvas token but limited supporting evidence");
      warnings.push("dark canvas exists but lacks on-dark/surface-dark; preview may be incomplete");
      return {
        mode: "fullSourceDark",
        reason: "explicit dark canvas token (limited support)",
        evidence,
        warnings,
      };
    }
  }

  // ── Rule 2: conservativeDerivedDark ──
  // No explicit dark canvas, but enough neutral tokens to derive safely.
  // Source must not be strongly light-only.

  if (isStronglyLightOnly(board)) {
    evidence.push("source is strongly light-only (cream/offWhite/warmLight canvas with light-first intent)");
  } else {
    // Check if enough neutral tokens exist for derivation
    const neutralDarkTokens = allColors.filter((t) =>
      !isScopedToken(t)
      && !isComponentSurfaceRole(t)
      && t.resolvedRole !== "unknown"
      && (hasCanvasRole(t, "low") || hasTextRole(t, "low") || hasSurfaceRole(t, "low") || t.resolvedRole === "border" || t.resolvedRole === "hairline")
    );

    if (neutralDarkTokens.length >= 2) {
      // Additional checks for darkNative intent without explicit canvas
      if (darkNative) {
        evidence.push("dark-native intent without explicit dark canvas — conservative derivation");
      }
      if (hasAnyDarkCanvasKey && !hasExplicitDarkCanvas) {
        warnings.push("dark canvas key exists but role confidence is low/fallback");
      }
      return {
        mode: "conservativeDerivedDark",
        reason: `neutral tokens available for safe dark derivation (${neutralDarkTokens.length} neutral tokens)`,
        evidence,
        warnings,
      };
    } else {
      evidence.push("insufficient neutral tokens for safe dark derivation");
    }
  }

  // ── Rule 3: darkTokenBoard ──
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
