/**
 * designMdDarkSurfaceEvidence.ts
 *
 * Fine-grained evidence helpers for dark preview mode classification.
 * Each function returns structured evidence about what kind of dark-surface
 * information exists in a DesignMdBoard.
 *
 * These are used by:
 * - designMdDarkPreviewPolicy.ts (policy decision)
 * - designMdThemeResolver.ts (theme selection)
 * - scripts/audit-design-md-theme-confidence.mjs (audit/report)
 */

import type { DesignMdBoard, DesignMdBoardToken } from "./designMdSpecimenBuilder";
import { isSafeColorValue } from "./designMdPreviewParser";
import type { DesignMdTokenRoleConfidence } from "./designMdTokenRoleResolver";
import { relativeLuminance } from "./designMdContrast";

// ─── Evidence types ────────────────────────────────────────────────

export interface DarkSurfaceEvidence {
  tokenKey: string;
  tokenValue: string;
  resolvedRole: string;
  roleConfidence: DesignMdTokenRoleConfidence;
  reason: string;
}

export interface DarkTextEvidence {
  tokenKey: string;
  tokenValue: string;
  resolvedRole: string;
  roleConfidence: DesignMdTokenRoleConfidence;
  reason: string;
}

export interface DarkComponentEvidence {
  name: string;
  kind: string;
  reason: string;
}

export interface DarkProseEvidence {
  excerpt: string;
  source: string;
  pattern: string;
}

// ─── Helpers ──────────────────────────────────────────────────────

function tokenLuma(token: DesignMdBoardToken): number | null {
  const hex = token.resolvedValue?.trim();
  if (!hex || !/^#[0-9a-fA-F]{3,8}$/.test(hex)) return null;
  return relativeLuminance(hex);
}

function isTokenDarkValue(token: DesignMdBoardToken): boolean {
  const lum = tokenLuma(token);
  return lum !== null && lum < 0.32;
}

function keyParts(key: string): string[] {
  return key.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean);
}

// ─── Global dark canvas evidence ──────────────────────────────────

const CANVAS_DARK_PATTERNS = [
  "body-dark", "canvas-dark", "background-dark", "page-dark", "app-dark",
  "canvas-night", "background-night",
  "dark-body", "dark-canvas", "dark-background",
  "dark-page", "dark-app",
];

function isCanvasDarkKey(key: string): boolean {
  const compact = keyParts(key).join("-");
  return CANVAS_DARK_PATTERNS.includes(compact)
    || CANVAS_DARK_PATTERNS.some((m) => key.toLowerCase().includes(m));
}

function hasCanvasRole(token: DesignMdBoardToken): boolean {
  return token.resolvedRole === "globalCanvas"
    || token.resolvedRole === "pageBackground"
    || token.resolvedRole === "bodyBackground";
}

export function getExplicitGlobalDarkCanvasEvidence(board: DesignMdBoard): DarkSurfaceEvidence[] {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  return allColors
    .filter((t) => isCanvasDarkKey(t.key) && hasCanvasRole(t) && isSafeColorValue(t.resolvedValue))
    .map((t) => ({
      tokenKey: t.key,
      tokenValue: t.resolvedValue.trim(),
      resolvedRole: t.resolvedRole ?? "unknown",
      roleConfidence: t.roleConfidence ?? "fallback",
      reason: "explicit dark canvas key with canvas role",
    }));
}

// ─── Dark surface evidence ────────────────────────────────────────

const SURFACE_DARK_PATTERNS = [
  "surface-dark", "surface-card-dark", "elevated-dark", "card-dark", "panel-dark",
  "surface-night", "card-night",
  "dark-surface", "dark-card", "dark-panel",
];

function isSurfaceDarkKey(key: string): boolean {
  const compact = keyParts(key).join("-");
  return SURFACE_DARK_PATTERNS.includes(compact) || (
    keyParts(key).some((p) => /^(surface|card|panel|elevated)$/.test(p))
    && keyParts(key).some((p) => /^(dark|black|night|inverse|aubergine)$/.test(p))
  );
}

function isTileDarkKey(key: string): boolean {
  const kp = keyParts(key);
  return kp.includes("tile") && kp.some((p) => /^(dark|black)$/.test(p));
}

export function getExplicitDarkSurfaceEvidence(board: DesignMdBoard): DarkSurfaceEvidence[] {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  return allColors
    .filter((t) => (isSurfaceDarkKey(t.key) || isTileDarkKey(t.key))
      && isSafeColorValue(t.resolvedValue)
      && isTokenDarkValue(t))
    .map((t) => ({
      tokenKey: t.key,
      tokenValue: t.resolvedValue.trim(),
      resolvedRole: t.resolvedRole ?? "unknown",
      roleConfidence: t.roleConfidence ?? "fallback",
      reason: isTileDarkKey(t.key) ? "tile dark surface key" : "explicit dark surface key",
    }));
}

// ─── Sectional dark surface evidence ──────────────────────────────

export function getSectionalDarkSurfaceEvidence(board: DesignMdBoard): DarkSurfaceEvidence[] {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  return allColors
    .filter((t) => {
      if (!isSafeColorValue(t.resolvedValue)) return false;
      if (!isTokenDarkValue(t)) return false;
      // Match any key that has a surface-like part AND a dark/black modifier
      // OR any key with "dark" in a component-context part
      const kp = keyParts(t.key);
      const isDarkSurface = kp.some((p) => /^(surface|tile|card|panel|nav)$/.test(p))
        && kp.some((p) => /^(dark|black)$/.test(p));
      const isDarkComponent = kp.some((p) =>
        /^(product|feature|hero|banner|strip|band|editorial|environment|utility)$/.test(p))
        && kp.some((p) => /^(dark|black)$/.test(p));
      const isSurfaceBlack = /^surface-black/.test(t.key);
      return isDarkSurface || isDarkComponent || isSurfaceBlack;
    })
    .map((t) => ({
      tokenKey: t.key,
      tokenValue: t.resolvedValue.trim(),
      resolvedRole: t.resolvedRole ?? "unknown",
      roleConfidence: t.roleConfidence ?? "fallback",
      reason: "sectional dark surface/component token",
    }));
}

// ─── Dark text evidence ───────────────────────────────────────────

const ON_DARK_PATTERNS = [
  "on-dark", "text-on-dark", "body-on-dark", "foreground-dark",
  "on-canvas-dark", "ink-on-dark", "primary-on-dark",
  "on-night", "on-black",
];

function isOnDarkKey(key: string): boolean {
  const compact = keyParts(key).join("-");
  return ON_DARK_PATTERNS.includes(compact)
    || ON_DARK_PATTERNS.some((m) => key.toLowerCase().includes(m));
}

function hasTextRole(token: DesignMdBoardToken): boolean {
  return token.resolvedRole === "bodyText"
    || token.resolvedRole === "headingText"
    || token.resolvedRole === "foregroundText"
    || token.resolvedRole === "mutedText";
}

export function getExplicitDarkTextEvidence(board: DesignMdBoard): DarkTextEvidence[] {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  return allColors
    .filter((t) => isOnDarkKey(t.key) && hasTextRole(t) && isSafeColorValue(t.resolvedValue))
    .map((t) => ({
      tokenKey: t.key,
      tokenValue: t.resolvedValue.trim(),
      resolvedRole: t.resolvedRole ?? "unknown",
      roleConfidence: t.roleConfidence ?? "fallback",
      reason: "on-dark text token",
    }));
}

// ─── Dark component evidence ──────────────────────────────────────

export function getDarkComponentEvidence(board: DesignMdBoard): DarkComponentEvidence[] {
  return board.componentGroups
    .filter((g) => {
      const name = g.name.toLowerCase();
      return name.includes("dark") || name.includes("black");
    })
    .map((g) => ({
      name: g.name,
      kind: g.kind,
      reason: "component name contains 'dark' or 'black'",
    }));
}

// ─── Dark prose evidence ──────────────────────────────────────────

const DARK_PROSE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\balternating (light and dark|dark and light) (canvas|section|surface)\b/i, label: "alternating canvases" },
  { pattern: /\bdark (product |utility |editorial |environment )?tile\b/i, label: "dark tile" },
  { pattern: /\bdark section\b/i, label: "dark section" },
  { pattern: /\bdark nav\b/i, label: "dark navigation" },
  { pattern: /\bdark component surface\b/i, label: "dark component surface" },
  { pattern: /\b(light hero|light canvas).*(dark tile|dark section|dark surface)\b/i, label: "light-to-dark transition" },
  { pattern: /\bdark (editorial|environment|band)\b/i, label: "dark editorial band" },
  { pattern: /\bsectional dark\b/i, label: "sectional dark" },
  { pattern: /\bdark theme\b/i, label: "dark theme" },
  { pattern: /\bdark surface\b/i, label: "dark surface" },
];

export function getDarkProseEvidence(board: DesignMdBoard): DarkProseEvidence[] {
  const sources: { text: string; sourceName: string }[] = [
    { text: board.title, sourceName: "title" },
    { text: board.description, sourceName: "description" },
    { text: board.overview ?? "", sourceName: "overview" },
    { text: board.layout ?? "", sourceName: "layout" },
    ...board.visualLanguage.phrases.map((p) => ({ text: p, sourceName: "phrase" })),
  ];

  const result: DarkProseEvidence[] = [];
  for (const source of sources) {
    if (!source.text) continue;
    for (const { pattern, label } of DARK_PROSE_PATTERNS) {
      const match = source.text.match(pattern);
      if (match) {
        const excerpt = match[0].length > 80 ? match[0].slice(0, 77) + "..." : match[0];
        result.push({
          excerpt,
          source: source.sourceName,
          pattern: label,
        });
      }
    }
  }
  return result;
}

// ─── Composite sectional check ────────────────────────────────────

export interface SectionalDarkSummary {
  hasGlobalCanvasDark: boolean;
  globalCanvasEvidence: DarkSurfaceEvidence[];
  darkSurfaceEvidence: DarkSurfaceEvidence[];
  sectionalSurfaceEvidence: DarkSurfaceEvidence[];
  darkTextEvidence: DarkTextEvidence[];
  darkComponentEvidence: DarkComponentEvidence[];
  darkProseEvidence: DarkProseEvidence[];
  qualifiesSectional: boolean;
  reason: string;
}

export function getSectionalDarkEvidence(board: DesignMdBoard): SectionalDarkSummary {
  const globalCanvasEvidence = getExplicitGlobalDarkCanvasEvidence(board);
  const darkSurfaceEvidence = getExplicitDarkSurfaceEvidence(board);
  const sectionalSurfaceEvidence = getSectionalDarkSurfaceEvidence(board);
  const darkTextEvidence = getExplicitDarkTextEvidence(board);
  const darkComponentEvidence = getDarkComponentEvidence(board);
  const darkProseEvidence = getDarkProseEvidence(board);

  const hasGlobalCanvasDark = globalCanvasEvidence.length > 0;
  const hasOnDarkText = darkTextEvidence.length > 0;
  const hasDarkComponents = darkComponentEvidence.length > 0;
  const hasProseEvidence = darkProseEvidence.length > 0;

  // Criteria for sectional qualification
  const strongCriteria = hasOnDarkText && sectionalSurfaceEvidence.length >= 3;
  const mediumCriteria = hasOnDarkText && sectionalSurfaceEvidence.length >= 2
    && (hasDarkComponents || hasProseEvidence);
  const weakCriteria = hasOnDarkText && sectionalSurfaceEvidence.length >= 1
    && hasDarkComponents && hasProseEvidence;

  let qualifiesSectional = false;
  let reason = "";

  if (strongCriteria) {
    qualifiesSectional = true;
    reason = `strong: ${sectionalSurfaceEvidence.length} sectional surfaces with on-dark text`;
  } else if (mediumCriteria) {
    qualifiesSectional = true;
    reason = `medium: ${sectionalSurfaceEvidence.length} sectional surfaces with on-dark text${hasDarkComponents ? " and components" : ""}${hasProseEvidence ? " and prose" : ""}`;
  } else if (weakCriteria) {
    qualifiesSectional = true;
    reason = "weak: sectional surfaces with on-dark text, components, and prose";
  } else {
    reason = "insufficient sectional dark evidence";
  }

  return {
    hasGlobalCanvasDark,
    globalCanvasEvidence,
    darkSurfaceEvidence,
    sectionalSurfaceEvidence,
    darkTextEvidence,
    darkComponentEvidence,
    darkProseEvidence,
    qualifiesSectional,
    reason,
  };
}
