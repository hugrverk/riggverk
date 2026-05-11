import {
  parseDesignMdForPreview,
  type DesignMdArchetype,
  type DesignMdComponentKind,
  type DesignMdPreviewConfidence,
  type DesignMdPreviewCoverage,
  type DesignMdPreviewWarning,
  type DesignMdPaletteGroup,
  type DesignMdSourceEvidence,
  type DesignMdToken,
  type DesignMdTypographyToken,
  type DesignMdVisualLanguage,
} from "./designMdPreviewParser";
import type { ColorSemanticRole, ColorUsageIntensity, ColorUsageScope } from "./designMdColorSemantics";
import type { DesignMdTokenRole, DesignMdTokenRoleConfidence } from "./designMdTokenRoleResolver";
import { analyzeDesignMdPreviewQuality, type DesignMdPreviewQualityScores, type DesignMdPreviewQualityWarnings } from "./designMdPreviewQuality";
import { analyzeDesignMdSourceIntent, type DesignMdSourceIntent } from "./designMdSourceIntent";

// ═══════════════════════════════════════════════
// Design-system board model (rich, token-grouped)
// ═══════════════════════════════════════════════

export interface DesignMdBoardToken {
  key: string;
  rawValue: string;
  resolvedValue: string;
  source?: "structured" | "markdown" | "derived";
  sourceEvidence?: DesignMdSourceEvidence;
  resolvedRole?: DesignMdTokenRole;
  roleConfidence?: DesignMdTokenRoleConfidence;
  roleEvidence?: string[];
  roleWarnings?: string[];
  semanticRole?: ColorSemanticRole;
  usageScope?: ColorUsageScope;
  usageIntensity?: ColorUsageIntensity;
  semanticEvidence?: string[];
  semanticWarnings?: string[];
}

export interface DesignMdBoardColorGroup {
  prefix: string;
  tokens: DesignMdBoardToken[];
}

export interface DesignMdBoardTypoToken {
  key: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  raw: Record<string, string>;
  source?: "structured" | "markdown" | "derived";
  sourceEvidence?: DesignMdSourceEvidence;
}

export interface DesignMdBoardComponentGroup {
  name: string;
  kind: DesignMdComponentKind;
  backgroundColor?: string;
  textColor?: string;
  borderColor?: string;
  rounded?: string;
  padding?: string;
  styles: Record<string, string>;
  raw: Record<string, string>;
  source?: "structured" | "markdown" | "derived";
  sourceEvidence?: DesignMdSourceEvidence;
}

export interface DesignMdBoard {
  slug: string;
  title: string;
  description: string;
  colorGroups: DesignMdBoardColorGroup[];
  palette: DesignMdPaletteGroup[];
  typographyTokens: DesignMdBoardTypoToken[];
  radiusTokens: DesignMdBoardToken[];
  spacingTokens: DesignMdBoardToken[];
  componentGroups: DesignMdBoardComponentGroup[];
  visualLanguage: DesignMdVisualLanguage;
  archetype: DesignMdArchetype;
  archetypeEvidence: DesignMdSourceEvidence;
  overview: string | null;
  layout: string | null;
  fontSubstitutes: string;
  guardrailDos: string[];
  guardrailDonts: string[];
  coverage: DesignMdPreviewCoverage;
  confidence: DesignMdPreviewConfidence;
  warnings: DesignMdPreviewWarning[];
  sourceIntent: DesignMdSourceIntent;
  previewQuality: DesignMdPreviewQualityScores;
  qualityWarnings: DesignMdPreviewQualityWarnings;
}

export function buildBoard(
  slug: string,
  title: string,
  description: string,
  content: string,
): DesignMdBoard {
  const model = parseDesignMdForPreview(slug, title, description, content);
  const board: DesignMdBoard = {
    slug: model.meta.slug,
    title: model.meta.title,
    description: model.meta.description,
    colorGroups: model.palette.map((group) => ({ prefix: group.name, tokens: group.tokens })),
    palette: model.palette,
    typographyTokens: model.typography as DesignMdTypographyToken[],
    radiusTokens: model.radius as DesignMdToken[],
    spacingTokens: model.spacing as DesignMdToken[],
    componentGroups: model.components.map((component) => ({
      name: component.name,
      kind: component.kind,
      backgroundColor: component.styles.backgroundColor ?? component.styles.background ?? component.styles["background-color"],
      textColor: component.styles.textColor ?? component.styles.color ?? component.styles["text-color"],
      borderColor: component.styles.borderColor ?? component.styles["border-color"],
      rounded: component.styles.rounded ?? component.styles.borderRadius ?? component.styles["border-radius"],
      padding: component.styles.padding,
      styles: component.styles,
      raw: component.raw,
      source: component.source,
      sourceEvidence: component.sourceEvidence,
    })),
    visualLanguage: model.visualLanguage,
    archetype: model.archetype,
    archetypeEvidence: model.archetypeEvidence,
    overview: model.overviewText,
    layout: model.layoutText,
    fontSubstitutes: model.fontSubstitutes,
    guardrailDos: model.guardrailDos,
    guardrailDonts: model.guardrailDonts,
    coverage: model.coverage,
    confidence: model.confidence,
    warnings: model.warnings,
    sourceIntent: analyzeDesignMdSourceIntent(content, model.meta.title, model.meta.description),
    previewQuality: {
      lightScore: 0,
      darkScore: 0,
      colorScore: 0,
      typographyScore: 0,
      layoutScore: 0,
      sourceScore: 0,
    },
    qualityWarnings: {
      primaryOveruseRisk: false,
      accentOveruseRisk: false,
      stateColorOveruseRisk: false,
      semanticOveruseRisk: false,
      timelineOveruseRisk: false,
      darkDerived: false,
      darkFallback: false,
      weakTypography: false,
      weakLayout: false,
      sourceSparse: false,
      contrastRisk: false,
      overflowRisk: false,
    },
  };
  const quality = analyzeDesignMdPreviewQuality(board);
  board.previewQuality = quality.scores;
  board.qualityWarnings = quality.warnings;
  return board;
}
