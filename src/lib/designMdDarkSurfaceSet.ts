/**
 * designMdDarkSurfaceSet.ts
 *
 * Source-backed model for dark surfaces extracted from a DesignMdBoard.
 * Organizes dark tokens by source kind so that sectional dark previews
 * can render multiple source-backed dark surfaces instead of one
 * flattened surface.
 *
 * This is the data model used by:
 * - designMdDarkPreviewPolicy.ts (evidence gathering)
 * - designMdThemeResolver.ts (dark surface set attachment)
 * - designMdHtmlGenerator.ts (sectional dark rendering)
 * - scripts/audit-design-md-theme-confidence.mjs (audit/report)
 */

import type { DesignMdBoard, DesignMdBoardToken } from "./designMdSpecimenBuilder";
import { isSafeColorValue } from "./designMdPreviewParser";
import { relativeLuminance } from "./designMdContrast";
import {
  getExplicitGlobalDarkCanvasEvidence,
  getSectionalDarkSurfaceEvidence,
  getExplicitDarkTextEvidence,
  getDarkComponentEvidence,
  getDarkProseEvidence,
} from "./designMdDarkSurfaceEvidence";


// ─── Source kind taxonomy ────────────────────────────────────────

export type DarkSurfaceSourceKind =
  | "globalCanvas"
  | "sectionSurface"
  | "tileSurface"
  | "navSurface"
  | "cardSurface"
  | "panelSurface"
  | "componentSurface"
  | "blackVoid";

// ─── How a dark token may be used in generated preview ───────────

export type DarkSurfaceUsableAs =
  | "pageCanvas"
  | "heroSurface"
  | "sectionSurface"
  | "paletteSwatch"
  | "sourceNoteOnly";

// ─── Individual token classification ─────────────────────────────

export interface DarkSurfaceToken {
  key: string;
  value: string;
  resolvedRole: string;
  roleConfidence: string;
  sourceKind: DarkSurfaceSourceKind;
  evidence: string[];
  usableAs: DarkSurfaceUsableAs[];
}

// ─── Complete dark surface set for a design board ────────────────

export interface DarkSurfaceSet {
  mode: "full" | "sectional" | "derived" | "tokenBoard";
  /** Page canvas token (global body/canvas/background dark) — MAY be undefined for sectional */
  pageCanvas?: DarkSurfaceToken;
  /** Primary section surface (tile-1, surface-dark, first dark tile) */
  primarySectionSurface?: DarkSurfaceToken;
  /** Secondary section surface (tile-2, card-dark, second dark tile) */
  secondarySectionSurface?: DarkSurfaceToken;
  /** Tertiary section surface (tile-3, third dark tile) */
  tertiarySectionSurface?: DarkSurfaceToken;
  /** Black/void surface (surface-black, pure black nav, video background) */
  blackSurface?: DarkSurfaceToken;
  /** Nav dark surface (global-nav, nav-dark background) */
  navSurface?: DarkSurfaceToken;
  /** On-dark body text token */
  onDarkText?: DarkSurfaceToken;
  /** Muted text on dark */
  mutedOnDarkText?: DarkSurfaceToken;
  /** Link/accent on dark (primary-on-dark, link-on-dark) */
  linkOnDark?: DarkSurfaceToken;
  /** Border on dark */
  borderOnDark?: DarkSurfaceToken;
  /** All extracted dark surfaces sorted by role priority */
  allSurfaces: DarkSurfaceToken[];
  /** All extracted dark text tokens */
  allTextTokens: DarkSurfaceToken[];
  /** Evidence strings for diagnostics */
  evidence: string[];
  /** Warning strings for diagnostics */
  warnings: string[];
}

// ─── Token value helpers ─────────────────────────────────────────

function tokenIsDarkValue(token: DesignMdBoardToken): boolean {
  const hex = token.resolvedValue?.trim();
  if (!hex || !/^#[0-9a-fA-F]{3,8}$/.test(hex)) return false;
  const lum = relativeLuminance(hex);
  return lum !== null && lum < 0.32;
}

function isSolidHex(value: string | undefined): value is string {
  return !!value && /^#[0-9a-fA-F]{3,8}$/.test(value.trim());
}

// ─── Key classification ──────────────────────────────────────────

function keyParts(key: string): string[] {
  return key.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean);
}

/** Classify a dark token's source kind based on key, role, and value. */
function classifySourceKind(
  token: DesignMdBoardToken,
  isGlobalCanvas: boolean,
): DarkSurfaceSourceKind {
  const kp = keyParts(token.key);
  const role = token.resolvedRole ?? "";

  // Text-role tokens (ink, foreground, body-as-text) are NOT surfaces
  if (role === "bodyText" || role === "foregroundText" || role === "headingText" || role === "mutedText") {
    return "sectionSurface"; // classified as sectionSurface but won't be in allSectionSurfaces
  }

  // Black/void surfaces
  if (kp.includes("black") && kp.some((p) => /^(surface|nav|void|bg)$/.test(p))) {
    return "blackVoid";
  }
  if (token.key.toLowerCase() === "surface-black") return "blackVoid";

  // Global canvas
  if (isGlobalCanvas) return "globalCanvas";

  // Nav surfaces
  if (kp.some((p) => /^(nav|navigation|global-nav)$/.test(p))) return "navSurface";

  // Tile surfaces
  if (kp.includes("tile") && kp.some((p) => /^(surface|product|utility)$/.test(p) || /^(1|2|3)$/.test(p))) {
    return "tileSurface";
  }
  if (kp.includes("tile")) return "tileSurface";

  // Card surfaces
  if (kp.includes("card")) return "cardSurface";

  // Panel surfaces
  if (kp.some((p) => /^(panel|sheet|elevated)$/.test(p))) return "panelSurface";

  // Generic section surfaces
  if (kp.some((p) => /^(surface|section)$/.test(p))) return "sectionSurface";

  // Component surfaces
  if (kp.some((p) => /^(product|feature|hero|banner|strip|band|utility|environment)$/.test(p))) {
    return "componentSurface";
  }

  return "sectionSurface";
}

// ─── Main extraction function ────────────────────────────────────

export function extractDarkSurfaceSet(board: DesignMdBoard): DarkSurfaceSet {
  const allColors = board.colorGroups.flatMap((g) => g.tokens);
  const evidence: string[] = [];
  const warnings: string[] = [];

  // Use the evidence helpers to get structured data
  const globalCanvasEvidence = getExplicitGlobalDarkCanvasEvidence(board);
  const sectionalEvidence = getSectionalDarkSurfaceEvidence(board);
  const textEvidence = getExplicitDarkTextEvidence(board);
  const componentEvidence = getDarkComponentEvidence(board);
  const proseEvidence = getDarkProseEvidence(board);

  // ── Categorize dark tokens ──
  const globalCanvasSet = new Set(globalCanvasEvidence.map((e) => e.tokenKey));

  const darkTokens = allColors.filter((t) =>
    isSafeColorValue(t.resolvedValue)
    && tokenIsDarkValue(t)
  );

  const globalCanvasTokens: DarkSurfaceToken[] = [];
  const sectionTiles: DarkSurfaceToken[] = [];
  const navTokens: DarkSurfaceToken[] = [];
  const blackTokens: DarkSurfaceToken[] = [];
  const cardPanelTokens: DarkSurfaceToken[] = [];
  const componentTokens: DarkSurfaceToken[] = [];
  const genericSectionTokens: DarkSurfaceToken[] = [];
  const onDarkTextTokens: DarkSurfaceToken[] = [];

  for (const token of darkTokens) {
    const isGlobal = globalCanvasSet.has(token.key);
    const isTextToken = textEvidence.some((e) => e.tokenKey === token.key);
    // Skip text-role tokens that are not on-dark text (ink, foreground, body text in light mode)
    const role = token.resolvedRole ?? "";
    const isSurfaceIrrelevantText = !isTextToken && (
      role === "bodyText" || role === "foregroundText" || role === "headingText" || role === "mutedText"
    );
    if (isSurfaceIrrelevantText) continue;

    const kind = classifySourceKind(token, isGlobal);

    const surfaceToken: DarkSurfaceToken = {
      key: token.key,
      value: token.resolvedValue.trim(),
      resolvedRole: token.resolvedRole ?? "unknown",
      roleConfidence: token.roleConfidence ?? "fallback",
      sourceKind: kind,
      evidence: [],
      usableAs: [],
    };

    // Determine usableAs
    if (isGlobal && (token.resolvedRole === "globalCanvas" || token.resolvedRole === "pageBackground" || token.resolvedRole === "bodyBackground")) {
      surfaceToken.usableAs.push("pageCanvas", "paletteSwatch");
    }

    if (kind === "tileSurface" || kind === "sectionSurface") {
      surfaceToken.usableAs.push("sectionSurface", "paletteSwatch");
      if (token.key.toLowerCase().includes("tile-1") || token.key.toLowerCase().includes("-1")) {
        surfaceToken.usableAs.push("heroSurface");
      }
    }

    if (kind === "navSurface") {
      surfaceToken.usableAs.push("sectionSurface", "paletteSwatch");
    }

    if (kind === "blackVoid") {
      surfaceToken.usableAs.push("sectionSurface", "paletteSwatch");
      if (token.key.toLowerCase().includes("nav") || token.key.toLowerCase().includes("video")) {
        surfaceToken.usableAs.push("sourceNoteOnly");
      }
    }

    if (kind === "cardSurface" || kind === "panelSurface" || kind === "componentSurface") {
      surfaceToken.usableAs.push("sectionSurface", "paletteSwatch");
      // Component-local dark surfaces should NOT be page canvas
    }

    if (!isTextToken && surfaceToken.usableAs.length === 0) {
      surfaceToken.usableAs.push("paletteSwatch");
    }

    // Route by kind
    if (kind === "globalCanvas") {
      globalCanvasTokens.push(surfaceToken);
    } else if (kind === "tileSurface") {
      sectionTiles.push(surfaceToken);
    } else if (kind === "navSurface") {
      navTokens.push(surfaceToken);
    } else if (kind === "blackVoid") {
      blackTokens.push(surfaceToken);
    } else if (kind === "cardSurface" || kind === "panelSurface") {
      cardPanelTokens.push(surfaceToken);
    } else if (kind === "componentSurface") {
      componentTokens.push(surfaceToken);
    } else {
      genericSectionTokens.push(surfaceToken);
    }
  }

  // ── Extract text tokens separately ──
  for (const textToken of textEvidence) {
    const token = allColors.find((t) => t.key === textToken.tokenKey);
    if (!token) continue;
    const t: DarkSurfaceToken = {
      key: textToken.tokenKey,
      value: textToken.tokenValue,
      resolvedRole: textToken.resolvedRole,
      roleConfidence: textToken.roleConfidence,
      sourceKind: "sectionSurface",
      evidence: [textToken.reason],
      usableAs: ["sourceNoteOnly"],
    };

    // Determine if this is body text vs link/accent vs muted
    const keyLc = textToken.tokenKey.toLowerCase();
    if (/primary-on-dark|link-on-dark|accent-on-dark/.test(keyLc)) {
      // This is a link/accent token, not body text
      // But we keep it as a text token reference
    }
    if (/muted-on-dark|on-dark-muted|text-muted-dark/.test(keyLc)) {
      // Muted text
    }

    onDarkTextTokens.push(t);
  }

  // ── Rank section surfaces by darkness for role assignment ──
  const allSectionSurfaces = [
    ...sectionTiles,
    ...navTokens,
    ...blackTokens,
    ...cardPanelTokens,
    ...genericSectionTokens,
  ].sort((a, b) => (tokenLumaFromValue(a.value) ?? 1) - (tokenLumaFromValue(b.value) ?? 1));

  // ── Build the dark surface set ──
  const surfaceSet: DarkSurfaceSet = {
    mode: "sectional", // will be adjusted later if global canvas exists
    allSurfaces: [],
    allTextTokens: onDarkTextTokens,
    evidence: [],
    warnings: [],
  };

  // Determine overall mode
  const hasGlobalCanvas = globalCanvasTokens.length > 0;
  const hasSectionalSurfaces = allSectionSurfaces.length > 0;
  const hasTextTokens = onDarkTextTokens.length > 0;

  if (hasGlobalCanvas) {
    surfaceSet.mode = "full";
    surfaceSet.pageCanvas = globalCanvasTokens[0];
  } else if (hasSectionalSurfaces && hasTextTokens) {
    surfaceSet.mode = "sectional";
  } else if (hasSectionalSurfaces || hasTextTokens) {
    surfaceSet.mode = "derived";
  } else {
    surfaceSet.mode = "tokenBoard";
  }

  // Assign surfaces by rank
  if (globalCanvasTokens.length > 0) {
    surfaceSet.pageCanvas = globalCanvasTokens[0];
    evidence.push(`global dark canvas: ${globalCanvasTokens[0].key}`);
  }

  if (allSectionSurfaces.length >= 1) {
    surfaceSet.primarySectionSurface = allSectionSurfaces[0];
    evidence.push(`primary dark section surface: ${allSectionSurfaces[0].key} (${allSectionSurfaces[0].value})`);
  }
  if (allSectionSurfaces.length >= 2) {
    surfaceSet.secondarySectionSurface = allSectionSurfaces[1];
    evidence.push(`secondary dark section surface: ${allSectionSurfaces[1].key} (${allSectionSurfaces[1].value})`);
  }
  if (allSectionSurfaces.length >= 3) {
    surfaceSet.tertiarySectionSurface = allSectionSurfaces[2];
    evidence.push(`tertiary dark section surface: ${allSectionSurfaces[2].key} (${allSectionSurfaces[2].value})`);
  }

  // Black void surface
  const blackVoid = blackTokens[0] ?? allSectionSurfaces.find((s) => s.sourceKind === "blackVoid");
  if (blackVoid) {
    surfaceSet.blackSurface = blackVoid;
    evidence.push(`black void surface: ${blackVoid.key}`);
  }

  // Nav surface
  if (navTokens.length > 0) {
    surfaceSet.navSurface = navTokens[0];
    evidence.push(`nav dark surface: ${navTokens[0].key}`);
  }

  // Text tokens
  const bodyOnDark = onDarkTextTokens.find((t) =>
    /body-on-dark/.test(t.key) || /^on-dark$/.test(t.key) || /text-on-dark/.test(t.key) || /ink-on-dark/.test(t.key)
  );
  const primaryOnDark = onDarkTextTokens.find((t) => /primary-on-dark/.test(t.key) || /link-on-dark/.test(t.key));
  const mutedOnDark = onDarkTextTokens.find((t) => /muted-on-dark/.test(t.key) || /on-dark-muted/.test(t.key));

  if (bodyOnDark) {
    surfaceSet.onDarkText = bodyOnDark;
    evidence.push(`on-dark text: ${bodyOnDark.key} (${bodyOnDark.value})`);
  } else if (onDarkTextTokens.length > 0) {
    surfaceSet.onDarkText = onDarkTextTokens[0];
    evidence.push(`on-dark text: ${onDarkTextTokens[0].key} (${onDarkTextTokens[0].value})`);
  }

  if (primaryOnDark) {
    surfaceSet.linkOnDark = primaryOnDark;
    evidence.push(`link on dark: ${primaryOnDark.key} (${primaryOnDark.value})`);
  }

  if (mutedOnDark) {
    surfaceSet.mutedOnDarkText = mutedOnDark;
    evidence.push(`muted on dark: ${mutedOnDark.key} (${mutedOnDark.value})`);
  }

  // Border on dark
  const borderDark = allColors.find((t) => {
    const k = t.key.toLowerCase();
    return /border-dark/.test(k) || /hairline-dark/.test(k) || /divider-dark/.test(k);
  });
  if (borderDark && isSolidHex(borderDark.resolvedValue)) {
    surfaceSet.borderOnDark = {
      key: borderDark.key,
      value: borderDark.resolvedValue.trim(),
      resolvedRole: borderDark.resolvedRole ?? "unknown",
      roleConfidence: borderDark.roleConfidence ?? "fallback",
      sourceKind: "sectionSurface",
      evidence: [],
      usableAs: ["sourceNoteOnly"],
    };
  }

  // Collect warnings
  if (sectionalEvidence.length > 0 && onDarkTextTokens.length === 0) {
    warnings.push("sectional dark surfaces detected but no on-dark text tokens");
  }
  if (onDarkTextTokens.length > 0 && allSectionSurfaces.length === 0 && !hasGlobalCanvas) {
    warnings.push("on-dark text detected but no dark surfaces");
  }
  if (componentEvidence.length > 0 && allSectionSurfaces.length === 0) {
    warnings.push("dark component names exist but no dark surface tokens");
  }
  if (proseEvidence.length > 0 && allSectionSurfaces.length === 0 && !hasGlobalCanvas) {
    warnings.push("dark prose evidence exists but no dark surface tokens");
  }

  // Collect all surfaces: named slots first, then remaining section tiles,
  // nav/black/component surfaces that aren't already captured.
  const namedKeys = new Set([
    surfaceSet.pageCanvas?.key,
    surfaceSet.primarySectionSurface?.key,
    surfaceSet.secondarySectionSurface?.key,
    surfaceSet.tertiarySectionSurface?.key,
    surfaceSet.blackSurface?.key,
    surfaceSet.navSurface?.key,
  ].filter((k): k is string => !!k));

  // Include named slots + remaining section tiles + other surfaces not already captured
  const remainingTiles = sectionTiles.filter((t) => !namedKeys.has(t.key));
  const remainingBlack = blackTokens.filter((t) => !namedKeys.has(t.key));
  const remainingNav = navTokens.filter((t) => !namedKeys.has(t.key));
  const remainingCardPanel = cardPanelTokens.filter((t) => !namedKeys.has(t.key));
  const remainingComponents = componentTokens.filter((t) => !namedKeys.has(t.key));
  const remainingGeneric = genericSectionTokens.filter((t) => !namedKeys.has(t.key));

  surfaceSet.allSurfaces = [
    ...(surfaceSet.pageCanvas ? [surfaceSet.pageCanvas] : []),
    ...(surfaceSet.primarySectionSurface ? [surfaceSet.primarySectionSurface] : []),
    ...(surfaceSet.secondarySectionSurface ? [surfaceSet.secondarySectionSurface] : []),
    ...(surfaceSet.tertiarySectionSurface ? [surfaceSet.tertiarySectionSurface] : []),
    ...(surfaceSet.blackSurface ? [surfaceSet.blackSurface] : []),
    ...(surfaceSet.navSurface ? [surfaceSet.navSurface] : []),
    ...remainingTiles,
    ...remainingBlack,
    ...remainingNav,
    ...remainingCardPanel,
    ...remainingComponents,
    ...remainingGeneric,
  ];

  surfaceSet.evidence = evidence;
  surfaceSet.warnings = warnings;

  return surfaceSet;
}

function tokenLumaFromValue(value: string): number | null {
  if (!isSolidHex(value)) return null;
  return relativeLuminance(value);
}

export function darkSurfaceSetSummary(set: DarkSurfaceSet): string {
  const parts: string[] = [`mode: ${set.mode}`];
  if (set.pageCanvas) parts.push(`canvas: ${set.pageCanvas.key}`);
  if (set.primarySectionSurface) parts.push(`primary: ${set.primarySectionSurface.key}`);
  if (set.secondarySectionSurface) parts.push(`secondary: ${set.secondarySectionSurface.key}`);
  if (set.tertiarySectionSurface) parts.push(`tertiary: ${set.tertiarySectionSurface.key}`);
  if (set.onDarkText) parts.push(`on-dark: ${set.onDarkText.key}`);
  if (set.linkOnDark) parts.push(`link: ${set.linkOnDark.key}`);
  const n = set.allSurfaces.length;
  if (n > 0) parts.push(`${n} surface(s) total`);
  if (set.warnings.length > 0) parts.push(`warnings: ${set.warnings.join("; ")}`);
  return parts.join(" · ");
}
