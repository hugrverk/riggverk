import type { DesignMdBoard, DesignMdBoardToken } from "./designMdSpecimenBuilder";
import { contrastRatio } from "./designMdContrast";

export interface DesignMdPreviewQualityScores {
  lightScore: number;
  darkScore: number;
  colorScore: number;
  typographyScore: number;
  layoutScore: number;
  sourceScore: number;
}

export interface DesignMdPreviewQualityWarnings {
  primaryOveruseRisk: boolean;
  accentOveruseRisk: boolean;
  stateColorOveruseRisk: boolean;
  semanticOveruseRisk: boolean;
  timelineOveruseRisk: boolean;
  darkDerived: boolean;
  darkFallback: boolean;
  weakTypography: boolean;
  weakLayout: boolean;
  sourceSparse: boolean;
  contrastRisk: boolean;
  overflowRisk: boolean;
}

export interface DesignMdPreviewQuality {
  scores: DesignMdPreviewQualityScores;
  warnings: DesignMdPreviewQualityWarnings;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function allColors(board: DesignMdBoard): DesignMdBoardToken[] {
  return board.colorGroups.flatMap((group) => group.tokens);
}

function hasRole(board: DesignMdBoard, role: string): boolean {
  return allColors(board).some((token) => token.semanticRole === role);
}

function countRole(board: DesignMdBoard, roles: string[]): number {
  return allColors(board).filter((token) => token.semanticRole && roles.includes(token.semanticRole)).length;
}

function hasUsablePaletteRoles(board: DesignMdBoard): boolean {
  const roles = new Set(allColors(board).map((token) => token.semanticRole));
  return roles.has("canvas") && roles.has("text") && (roles.has("surface") || roles.has("border"));
}

function sourceDensity(board: DesignMdBoard): number {
  let score = 0;
  if (board.coverage.colorsCount >= 4) score += 25;
  else if (board.coverage.colorsCount >= 2) score += 14;
  if (board.coverage.typographyCount >= 2) score += 18;
  else if (board.coverage.typographyCount >= 1) score += 10;
  if (board.coverage.radiusCount > 0) score += 8;
  if (board.coverage.spacingCount > 0) score += 8;
  if (board.coverage.componentCount >= 3) score += 16;
  else if (board.coverage.componentCount >= 1) score += 8;
  if (board.overview || board.layout) score += 12;
  if (board.guardrailDos.length > 0 || board.guardrailDonts.length > 0 || board.visualLanguage.phrases.length > 0) score += 13;
  return clampScore(score);
}

function estimateContrastRisk(board: DesignMdBoard): boolean {
  const colors = allColors(board);
  const canvas = colors.find((token) => token.semanticRole === "canvas")?.resolvedValue;
  const text = colors.find((token) => token.semanticRole === "text")?.resolvedValue;
  const ratio = contrastRatio(text, canvas);
  return ratio !== null && ratio < 3;
}

export function analyzeDesignMdPreviewQuality(board: DesignMdBoard): DesignMdPreviewQuality {
  const sparse = board.coverage.colorsCount < 3
    || (board.coverage.typographyCount === 0 && board.coverage.componentCount < 3)
    || board.confidence.lightPreview === "low";
  const primaryCount = countRole(board, ["primaryAction"]);
  const accentCount = countRole(board, ["brandAccent"]);
  const stateCount = countRole(board, ["state"]);
  const stateComponentCount = board.componentGroups.filter((component) => /(?:^|[-_\s])(active|hover|pressed|focus|focused|disabled|selected|loading|visited|checked)(?:$|[-_\s])/i.test(component.name)).length;
  const semanticCount = countRole(board, ["semantic", "status"]);
  const timelineCount = countRole(board, ["timeline"]);
  const scopedColors = stateCount + semanticCount + timelineCount;
  const colorCount = Math.max(1, board.coverage.colorsCount);
  const weakTypography = board.coverage.typographyCount === 0;
  const weakLayout = !board.layout && board.visualLanguage.phrases.length < 2;
  const darkDerived = board.coverage.darkTokenCount === 0 || board.warnings.includes("dark tokens derived");
  const darkFallback = darkDerived && board.coverage.colorsCount < 2;
  const overflowRisk = weakTypography
    || board.typographyTokens.some((token) => {
      const size = token.fontSize?.match(/^(\d+(?:\.\d+)?)px$/i);
      return size ? Number.parseFloat(size[1]) > 72 : false;
    });

  const colorScore = clampScore(
    (hasUsablePaletteRoles(board) ? 55 : 25)
    + Math.min(board.coverage.colorsCount, 12) * 3
    - (scopedColors / colorCount > 0.45 ? 15 : 0),
  );
  const typographyScore = clampScore(
    weakTypography ? 28 : 54 + Math.min(board.coverage.typographyCount, 8) * 5,
  );
  const layoutScore = clampScore(
    (board.layout ? 42 : 0)
    + (board.overview ? 18 : 0)
    + Math.min(board.visualLanguage.phrases.length, 5) * 8
    + (board.guardrailDos.length > 0 || board.guardrailDonts.length > 0 ? 8 : 0),
  );
  const sourceScore = sourceDensity(board);
  const lightScore = clampScore(
    colorScore * 0.35
    + typographyScore * 0.2
    + layoutScore * 0.2
    + sourceScore * 0.25
    - (sparse ? 10 : 0)
    - (estimateContrastRisk(board) ? 10 : 0),
  );
  const darkScore = clampScore(
    lightScore
    - (darkDerived ? 14 : -6)
    - (darkFallback ? 12 : 0)
    - (scopedColors / colorCount > 0.45 ? 8 : 0),
  );

  return {
    scores: {
      lightScore,
      darkScore,
      colorScore,
      typographyScore,
      layoutScore,
      sourceScore,
    },
    warnings: {
      primaryOveruseRisk: primaryCount > 0 && !hasRole(board, "canvas") && !hasRole(board, "surface"),
      accentOveruseRisk: accentCount > 0 && allColors(board).some((token) => token.semanticRole === "brandAccent" && token.usageIntensity !== "sparse") && !hasUsablePaletteRoles(board),
      stateColorOveruseRisk: stateCount > 0 || stateComponentCount > 0,
      semanticOveruseRisk: semanticCount / colorCount > 0.25,
      timelineOveruseRisk: timelineCount > 0,
      darkDerived,
      darkFallback,
      weakTypography,
      weakLayout,
      sourceSparse: sparse,
      contrastRisk: estimateContrastRisk(board),
      overflowRisk,
    },
  };
}
