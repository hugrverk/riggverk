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

function confidenceWeight(confidence: string): number {
  if (confidence === "high") return 30;
  if (confidence === "medium") return 18;
  if (confidence === "low") return 8;
  return 0;
}

function luminanceWeight(value: string): number {
  const lum = relativeLuminance(value);
  if (lum === null) return 0;
  return Math.max(0, Math.round((1 - lum) * 20));
}

type SurfaceSelectionContext = "canvas" | "section" | "black" | "nav";

interface RankedSurfaceToken extends DarkSurfaceToken {
  score: number;
  order: number;
}

function scoreSurfaceToken(
  token: DarkSurfaceToken,
  context: SurfaceSelectionContext,
  options: {
    sectionalEvidenceKeys: Set<string>;
    proseEvidenceCount: number;
    darkComponentCount: number;
    allowBlackAsSection?: boolean;
  },
): number {
  const key = token.key.toLowerCase();
  const parts = keyParts(token.key);
  const sourceKindScore: Record<DarkSurfaceSourceKind, number> = {
    globalCanvas: context === "canvas" ? 1000 : 0,
    tileSurface: context === "section" ? 520 : 0,
    sectionSurface: context === "section" ? 420 : 0,
    componentSurface: context === "section" ? 360 : 0,
    cardSurface: context === "section" ? 320 : 0,
    panelSurface: context === "section" ? 300 : 0,
    blackVoid: context === "black" ? 520 : (context === "section" ? -180 : 0),
    navSurface: context === "nav" ? 520 : (context === "section" ? -160 : 0),
  };

  let score = sourceKindScore[token.sourceKind];

  if (context === "canvas") {
    if (key.includes("body-dark") || key.includes("canvas-dark") || key.includes("background-dark") || key.includes("page-dark") || key.includes("app-dark")) {
      score += 220;
    }
    if (token.resolvedRole === "globalCanvas") score += 40;
    if (token.resolvedRole === "pageBackground") score += 30;
    if (token.resolvedRole === "bodyBackground") score += 25;
  }

  if (context === "section") {
    if (key.includes("surface-tile-1")) score += 160;
    else if (key.includes("surface-tile-2")) score += 150;
    else if (key.includes("surface-tile-3")) score += 140;
    else if (key.includes("product-tile-dark-3")) score += 150;
    else if (key.includes("product-tile-dark-2")) score += 155;
    else if (key.includes("product-tile-dark")) score += 165;
    else if (key.includes("section-dark")) score += 130;
    else if (key.includes("dark-tile")) score += 125;
    else if (key.includes("surface-dark")) score += 100;
    else if (key.includes("dark-surface")) score += 100;

    if (parts.includes("tile")) score += 80;
    if (parts.includes("surface")) score += 28;
    if (parts.includes("section")) score += 24;
    if (parts.includes("product")) score += 18;
    if (parts.includes("card")) score += 10;
    if (parts.includes("panel")) score += 8;
    if (parts.includes("black")) score -= 120;
    if (parts.some((p) => /^(nav|navigation|global-nav)$/.test(p))) score -= 160;
    if (parts.some((p) => /^(1|2|3)$/.test(p))) score += 12;
    if (parts.some((p) => /^(hero|feature|editorial|environment|utility|band|strip|block)$/.test(p))) score += 10;
    if (token.sourceKind === "tileSurface") score += 24;
    if (token.sourceKind === "sectionSurface") score += 16;
    if (token.sourceKind === "cardSurface" || token.sourceKind === "panelSurface" || token.sourceKind === "componentSurface") score += 8;
    if (options.sectionalEvidenceKeys.has(token.key)) score += 22;
    score += Math.min(18, options.proseEvidenceCount * 3);
    score += Math.min(12, options.darkComponentCount * 4);
  }

  if (context === "black") {
    if (token.sourceKind === "blackVoid") score += 180;
    if (key === "surface-black") score += 160;
    if (parts.includes("black")) score += 90;
    if (parts.some((p) => /^(nav|video|void)$/.test(p))) score += 30;
    if (options.sectionalEvidenceKeys.has(token.key)) score += 18;
    score += Math.min(10, options.proseEvidenceCount * 2);
    score += Math.min(8, options.darkComponentCount * 2);
  }

  if (context === "nav") {
    if (token.sourceKind === "navSurface") score += 180;
    if (parts.some((p) => /^(nav|navigation|global-nav)$/.test(p))) score += 120;
    if (parts.includes("dark")) score += 35;
    if (options.sectionalEvidenceKeys.has(token.key)) score += 10;
  }

  score += confidenceWeight(token.roleConfidence);
  score += luminanceWeight(token.value);

  if (context === "section" && token.sourceKind === "blackVoid" && !options.allowBlackAsSection) {
    score -= 220;
  }

  return score;
}

function pickBestSurfaceToken(
  tokens: DarkSurfaceToken[],
  context: SurfaceSelectionContext,
  options: {
    sectionalEvidenceKeys: Set<string>;
    proseEvidenceCount: number;
    darkComponentCount: number;
    allowBlackAsSection?: boolean;
  },
): RankedSurfaceToken | undefined {
  const ranked = tokens
    .map((token, order) => ({
      ...token,
      score: scoreSurfaceToken(token, context, options),
      order,
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked[0];
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
  const linkOnDarkTokens: DarkSurfaceToken[] = [];

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
      surfaceToken.usableAs.push("paletteSwatch", "sourceNoteOnly");
    }

    if (kind === "blackVoid") {
      surfaceToken.usableAs.push("paletteSwatch", "sourceNoteOnly");
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

  // Dark link/accent tokens are tracked separately from text tokens.
  for (const token of allColors) {
    if (!isSafeColorValue(token.resolvedValue)) continue;
    const keyLc = token.key.toLowerCase();
    if (!/^(primary-on-dark|link-on-dark|accent-on-dark|on-primary-dark)$/.test(keyLc)) continue;
    const accentToken: DarkSurfaceToken = {
      key: token.key,
      value: token.resolvedValue.trim(),
      resolvedRole: token.resolvedRole ?? "unknown",
      roleConfidence: token.roleConfidence ?? "fallback",
      sourceKind: "sectionSurface",
      evidence: ["link/accent on dark token"],
      usableAs: ["paletteSwatch", "sourceNoteOnly"],
    };
    linkOnDarkTokens.push(accentToken);
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

    onDarkTextTokens.push(t);
  }

  const sectionSurfaceTokens = [
    ...sectionTiles,
    ...cardPanelTokens,
    ...componentTokens,
    ...genericSectionTokens,
  ];
  const sectionEvidenceKeys = new Set(sectionalEvidence.map((item) => item.tokenKey));
  const sectionCandidates = sectionSurfaceTokens;
  const blackCandidates = blackTokens;
  const navCandidates = navTokens;
  const canUseBlackAsSection = sectionCandidates.length === 0
    && (sectionalEvidence.length > 0 || proseEvidence.length > 0 || componentEvidence.length > 0 || navTokens.length === 0);

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
  const hasSectionalSurfaces = sectionCandidates.length > 0 || blackCandidates.length > 0 || navCandidates.length > 0;
  const hasTextTokens = onDarkTextTokens.length > 0;

  if (hasGlobalCanvas) {
    surfaceSet.mode = "full";
    surfaceSet.pageCanvas = pickBestSurfaceToken(globalCanvasTokens, "canvas", {
      sectionalEvidenceKeys: sectionEvidenceKeys,
      proseEvidenceCount: proseEvidence.length,
      darkComponentCount: componentEvidence.length,
    }) ?? globalCanvasTokens[0];
  } else if (
    hasTextTokens
    && (
      sectionCandidates.length >= 3
      || (sectionCandidates.length >= 2 && (sectionalEvidence.length > 0 || componentEvidence.length > 0 || proseEvidence.length > 0))
    )
  ) {
    surfaceSet.mode = "sectional";
  } else if (hasSectionalSurfaces || hasTextTokens) {
    surfaceSet.mode = "derived";
  } else {
    surfaceSet.mode = "tokenBoard";
  }

  // Assign surfaces by rank
  if (globalCanvasTokens.length > 0) {
    surfaceSet.pageCanvas = surfaceSet.pageCanvas ?? pickBestSurfaceToken(globalCanvasTokens, "canvas", {
      sectionalEvidenceKeys: sectionEvidenceKeys,
      proseEvidenceCount: proseEvidence.length,
      darkComponentCount: componentEvidence.length,
    }) ?? globalCanvasTokens[0];
    evidence.push(`global dark canvas: ${surfaceSet.pageCanvas.key}`);
  }

  const rankedSectionCandidate = (token: DarkSurfaceToken) => ({
    ...token,
    score: scoreSurfaceToken(token, "section", {
      sectionalEvidenceKeys: sectionEvidenceKeys,
      proseEvidenceCount: proseEvidence.length,
      darkComponentCount: componentEvidence.length,
      allowBlackAsSection: canUseBlackAsSection,
    }),
    order: sectionCandidates.indexOf(token),
  });

  const rankedSections = sectionCandidates
    .map(rankedSectionCandidate)
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const rankedBlack = blackCandidates
    .map((token, order) => ({
      ...token,
      score: scoreSurfaceToken(token, "black", {
        sectionalEvidenceKeys: sectionEvidenceKeys,
        proseEvidenceCount: proseEvidence.length,
        darkComponentCount: componentEvidence.length,
      }),
      order,
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const rankedNav = navCandidates
    .map((token, order) => ({
      ...token,
      score: scoreSurfaceToken(token, "nav", {
        sectionalEvidenceKeys: sectionEvidenceKeys,
        proseEvidenceCount: proseEvidence.length,
        darkComponentCount: componentEvidence.length,
      }),
      order,
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const primary = rankedSections[0] ?? (canUseBlackAsSection ? rankedBlack[0] : undefined);
  const secondary = rankedSections[1];
  const tertiary = rankedSections[2];

  if (primary) {
    surfaceSet.primarySectionSurface = primary;
    evidence.push(`primary dark section surface: ${primary.key} (${primary.value})`);
    if (primary.sourceKind === "blackVoid") {
      primary.usableAs.push("sectionSurface");
    }
  }
  if (secondary) {
    surfaceSet.secondarySectionSurface = secondary;
    evidence.push(`secondary dark section surface: ${secondary.key} (${secondary.value})`);
  }
  if (tertiary) {
    surfaceSet.tertiarySectionSurface = tertiary;
    evidence.push(`tertiary dark section surface: ${tertiary.key} (${tertiary.value})`);
  }

  const blackVoid = rankedBlack[0];
  if (blackVoid) {
    surfaceSet.blackSurface = blackVoid;
    evidence.push(`black void surface: ${blackVoid.key}`);
  }

  const navSurface = rankedNav[0];
  if (navSurface) {
    surfaceSet.navSurface = navSurface;
    evidence.push(`nav dark surface: ${navSurface.key}`);
  }

  // Text tokens
  const bodyOnDark = onDarkTextTokens.find((t) =>
    /body-on-dark/.test(t.key) || /^on-dark$/.test(t.key) || /text-on-dark/.test(t.key) || /ink-on-dark/.test(t.key)
  );
  const primaryOnDark = linkOnDarkTokens.find((t) => /link-on-dark/.test(t.key))
    ?? linkOnDarkTokens.find((t) => /primary-on-dark/.test(t.key))
    ?? linkOnDarkTokens[0]
    ?? onDarkTextTokens.find((t) => /primary-on-dark/.test(t.key) || /link-on-dark/.test(t.key));
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
  if (onDarkTextTokens.length > 0 && sectionCandidates.length === 0 && !hasGlobalCanvas) {
    warnings.push("on-dark text detected but no dark surfaces");
  }
  if (componentEvidence.length > 0 && sectionCandidates.length === 0) {
    warnings.push("dark component names exist but no dark surface tokens");
  }
  if (proseEvidence.length > 0 && sectionCandidates.length === 0 && !hasGlobalCanvas) {
    warnings.push("dark prose evidence exists but no dark surface tokens");
  }
  if (sectionCandidates.length > 0 && surfaceSet.primarySectionSurface?.sourceKind === "blackVoid") {
    warnings.push("black surface selected as primary while tile surfaces exist");
  }
  if (sectionCandidates.length > 0 && surfaceSet.primarySectionSurface?.sourceKind === "navSurface") {
    warnings.push("nav surface selected as primary section");
  }
  if (sectionCandidates.length > 0 && (surfaceSet.primarySectionSurface?.sourceKind === "cardSurface" || surfaceSet.primarySectionSurface?.sourceKind === "panelSurface" || surfaceSet.primarySectionSurface?.sourceKind === "componentSurface") && sectionTiles.length > 0) {
    warnings.push("component-local surface promoted too broadly");
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

  // Include named slots + remaining section surfaces + separate black/nav surfaces.
  const remainingSections = rankedSections
    .slice(3)
    .map(({ score: _score, order: _order, ...token }) => token)
    .filter((t) => !namedKeys.has(t.key));
  const remainingBlack = rankedBlack
    .slice(1)
    .map(({ score: _score, order: _order, ...token }) => token)
    .filter((t) => !namedKeys.has(t.key));
  const remainingNav = rankedNav
    .slice(1)
    .map(({ score: _score, order: _order, ...token }) => token)
    .filter((t) => !namedKeys.has(t.key));

  surfaceSet.allSurfaces = [
    ...(surfaceSet.pageCanvas ? [surfaceSet.pageCanvas] : []),
    ...(surfaceSet.primarySectionSurface ? [surfaceSet.primarySectionSurface] : []),
    ...(surfaceSet.secondarySectionSurface ? [surfaceSet.secondarySectionSurface] : []),
    ...(surfaceSet.tertiarySectionSurface ? [surfaceSet.tertiarySectionSurface] : []),
    ...remainingSections,
    ...(surfaceSet.blackSurface ? [surfaceSet.blackSurface] : []),
    ...(surfaceSet.navSurface ? [surfaceSet.navSurface] : []),
    ...remainingBlack,
    ...remainingNav,
  ];

  surfaceSet.evidence = evidence;
  surfaceSet.warnings = warnings;

  return surfaceSet;
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
