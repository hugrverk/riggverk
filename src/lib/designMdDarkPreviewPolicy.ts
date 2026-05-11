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
  if (darkNative) evidence.push("source intent is dark-native");

  // ── Rule 1: fullSourceDark ──
  // Requires ALL of:
  //   - explicit dark canvas key with medium+ canvas role confidence
  //   - explicit on-dark text token (body-on-dark, text-on-dark, on-dark, etc.)
  //   - source intent not strongly light-first
  //
  // inverse-canvas is explicitly excluded from dark canvas key detection
  // because it is an inverse-palette hint, not a dark-theme declaration.
  //
  // If explicit dark canvas exists but lacks on-dark text evidence,
  // fall through to conservativeDerivedDark or darkTokenBoard.
  if (hasExplicitDarkCanvas) {
    // Light-first designs with cream/off-white/warm canvas should NOT get fullSourceDark
    // even if they have dark-named canvas tokens.
    if (isStronglyLightOnly(board)) {
      evidence.push("explicit dark canvas token exists but source is light-first");
      warnings.push("dark canvas token exists but source is light-first; rendering conservative");
      // Fall through — will not qualify for fullSourceDark due to light-only source
    } else if (hasExplicitOnDark && (hasExplicitDarkSurface || darkNative)) {
      return {
        mode: "fullSourceDark",
        reason: "explicit dark canvas with on-dark text supported by explicit surface or dark-native intent",
        evidence,
        warnings,
      };
    } else if (hasExplicitOnDark) {
      // Has explicit dark canvas key with canvas role AND explicit on-dark text,
      // but no surface-dark token and no dark-native intent.
      // Still qualifies because canvas+text together are sufficient dark-theme evidence.
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

  // ── Rule 2: conservativeDerivedDark ──
  // No explicit dark canvas, but enough neutral dark-valued tokens to derive safely.
  // Source must not be strongly light-only.
  // Requires AT LEAST:
  //   - one dark-valued text/ink candidate
  //   - one dark-valued surface/canvas candidate
  //   - three total neutral candidates with dark values

  if (isStronglyLightOnly(board)) {
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
