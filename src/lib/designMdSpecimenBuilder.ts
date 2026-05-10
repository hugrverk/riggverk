import {
  isSafeColorValue,
  parseFlatFrontmatter,
  parseDesignMdForPreview,
  resolveTokenRef,
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
// ── sanitization ──

function isSafeColor(val: string): string | null {
  return isSafeColorValue(val) ? val.trim() : null;
}

function isUnsafe(val: string): boolean {
  return /url\s*\(|expression\s*\(|var\s*\(|calc\s*\(|[<>;{}]|script|iframe|object|embed/i.test(val);
}

/** Try multiple possible keys and return the first safe match. */
function pick(map: Map<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map.get(k);
    if (v && v.trim() && !isUnsafe(v)) return v.trim();
  }
  return undefined;
}

function pickColor(map: Map<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map.get(k);
    if (v) {
      const resolved = resolveRef(v, map);
      const safe = isSafeColor(resolved);
      if (safe) return safe;
    }
  }
  return undefined;
}

function resolveRef(value: string, map: Map<string, string>): string {
  return resolveTokenRef(value, map);
}

// ── specimen model ──

// ── legacy specimen model (simple fallback) ──

export interface DesignMdSpecimen {
  slug: string;
  title: string;
  description: string;
  // palette
  primaryColor: string;
  surfaceColor: string;
  canvasColor: string;
  textColor: string;
  mutedColor: string;
  borderColor: string;
  // typography
  fontFamily: string;
  headingSize: string;
  headingWeight: string;
  bodySize: string;
  captionSize: string;
  // radius
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  radiusPill: string;
  // spacing
  spaceSm: string;
  spaceMd: string;
  spaceLg: string;
  // button
  btnBg: string;
  btnColor: string;
  btnRadius: string;
  // overview
  overview: string | null;
}

const WHITE = "#ffffff";
const BLACK = "#111111";
const GRAY_MUTED = "#888888";
const GRAY_BORDER = "#e0e0e0";

/**
 * Build a resolved specimen from a DESIGN.md content string.
 * Uses fuzzy token matching across common naming conventions.
 */
export function buildSpecimen(
  slug: string,
  title: string,
  description: string,
  content: string,
): DesignMdSpecimen {
  const fm = parseFlatFrontmatter(content);
  const model = parseDesignMdForPreview(slug, title, description, content);

  // ── Color palette ──
  const primaryColor = pickColor(fm, [
    "colors.primary",
    "colors.primary-color",
    "colors.primaryColor",
    "colors.brand",
    "colors.accent",
    "colors.blue",
    "color.primary",
    "palette.primary",
  ]) || "#0066cc";

  const surfaceColor = pickColor(fm, [
    "colors.surface",
    "colors.surface-color",
    "colors.surfaceColor",
    "colors.card-background",
    "colors.cardBackground",
    "colors.card.background",
    "colors.card.backgroundColor",
    "colors.background-secondary",
    "colors.backgroundSecondary",
    "colors.background-alt",
    "colors.backgroundAlt",
  ]) || WHITE;

  const canvasColor = pickColor(fm, [
    "colors.background",
    "colors.background-color",
    "colors.backgroundColor",
    "colors.canvas",
    "colors.page-background",
    "colors.pageBackground",
    "colors.white",
    "colors.body-background",
    "colors.bodyBackground",
  ]) || WHITE;

  const textColor = pickColor(fm, [
    "colors.text",
    "colors.text-color",
    "colors.textColor",
    "colors.on-background",
    "colors.onBackground",
    "colors.on-surface",
    "colors.onSurface",
    "colors.ink",
    "colors.black",
    "colors.foreground",
  ]) || BLACK;

  const mutedColor = pickColor(fm, [
    "colors.muted",
    "colors.text-muted",
    "colors.textMuted",
    "colors.secondary",
    "colors.secondary-text",
    "colors.secondaryText",
    "colors.gray",
    "colors.grey",
    "colors.text-secondary",
    "colors.textSecondary",
  ]) || GRAY_MUTED;

  const borderColor = pickColor(fm, [
    "colors.border",
    "colors.border-color",
    "colors.borderColor",
    "colors.hairline",
    "colors.divider",
    "colors.line",
    "colors.stroke",
  ]) || GRAY_BORDER;

  // ── Typography ──
  const fontFamily = pick(fm, [
    "typography.font-family",
    "typography.fontFamily",
    "typography.body.font-family",
    "typography.body.fontFamily",
    "typography.body-font",
    "typography.bodyFont",
    "font.family",
    "fonts.body",
  ]) || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  const headingSize = pick(fm, [
    "typography.display-xl.fontSize",
    "typography.display-xl.font-size",
    "typography.displayXl.fontSize",
    "typography.displayXl.font-size",
    "typography.h1.fontSize",
    "typography.h1.font-size",
    "typography.heading.fontSize",
    "typography.heading.font-size",
    "typography.heading-size",
    "typography.headingSize",
    "typography.display.fontSize",
    "typography.display.font-size",
  ]) || "28px";

  const headingWeight = pick(fm, [
    "typography.display-xl.fontWeight",
    "typography.display-xl.font-weight",
    "typography.displayXl.fontWeight",
    "typography.h1.fontWeight",
    "typography.h1.font-weight",
    "typography.heading.fontWeight",
    "typography.heading.font-weight",
    "typography.heading-weight",
    "typography.headingWeight",
  ]) || "700";

  const bodySize = pick(fm, [
    "typography.body.fontSize",
    "typography.body.font-size",
    "typography.body-size",
    "typography.bodySize",
    "typography.font-size-base",
    "typography.fontSizeBase",
    "typography.font-size",
    "typography.fontSize",
    "typography.base.fontSize",
    "typography.base.font-size",
    "typography.text.fontSize",
    "typography.text.font-size",
    "typography.body.copy.fontSize",
  ]) || "16px";

  const captionSize = pick(fm, [
    "typography.caption.fontSize",
    "typography.caption.font-size",
    "typography.caption-size",
    "typography.captionSize",
    "typography.small.fontSize",
    "typography.small.font-size",
    "typography.label.fontSize",
    "typography.label.font-size",
    "typography.caption.font-size",
  ]) || "12px";

  // ── Radius ──
  const radiusSm = pick(fm, [
    "rounded.sm",
    "rounded.small",
    "radius.sm",
    "radius.small",
    "borderRadius.sm",
    "borderRadius.small",
    "border-radius-sm",
    "borderRadiusSm",
  ]) || "4px";

  const radiusMd = pick(fm, [
    "rounded.md",
    "rounded.medium",
    "rounded.default",
    "radius.md",
    "radius.medium",
    "radius.default",
    "borderRadius.md",
    "borderRadius.medium",
    "borderRadius.default",
    "border-radius-md",
    "borderRadiusMd",
    "border-radius",
    "borderRadius",
    "rounded",
  ]) || "8px";

  const radiusLg = pick(fm, [
    "rounded.lg",
    "rounded.large",
    "radius.lg",
    "radius.large",
    "borderRadius.lg",
    "borderRadius.large",
    "border-radius-lg",
    "borderRadiusLg",
  ]) || "12px";

  const radiusPill = pick(fm, [
    "rounded.pill",
    "rounded.full",
    "radius.pill",
    "radius.full",
    "borderRadius.pill",
    "borderRadius.full",
    "border-radius-pill",
    "border-radius-full",
    "borderRadiusPill",
  ]) || "9999px";

  // ── Spacing ──
  const spaceSm = pick(fm, [
    "spacing.sm",
    "spacing.small",
    "spacing.xs",
    "space.sm",
    "space.small",
    "space-xs",
    "spacing-sm",
  ]) || "8px";

  const spaceMd = pick(fm, [
    "spacing.md",
    "spacing.medium",
    "spacing.default",
    "space.md",
    "space.medium",
    "space.default",
    "spacing-md",
  ]) || "16px";

  const spaceLg = pick(fm, [
    "spacing.lg",
    "spacing.large",
    "spacing.xl",
    "space.lg",
    "space.large",
    "space-xl",
    "spacing-lg",
  ]) || "32px";

  // ── Button ──
  const btnBg = pickColor(fm, [
    "components.button-primary.backgroundColor",
    "components.button-primary.background",
    "components.buttonPrimary.backgroundColor",
    "components.buttonPrimary.background",
    "components.button.primary.backgroundColor",
    "components.button.primary.background",
    "components.button-primary.background-color",
    "components.primaryButton.backgroundColor",
    "button.primary.background",
    "button.primary.backgroundColor",
    "button.primary.background-color",
    "components.btnPrimary.backgroundColor",
  ]) || primaryColor;

  const btnColor = pickColor(fm, [
    "components.button-primary.textColor",
    "components.button-primary.color",
    "components.button-primary.text-color",
    "components.buttonPrimary.textColor",
    "components.buttonPrimary.color",
    "components.button.primary.textColor",
    "components.button.primary.color",
    "components.primaryButton.textColor",
    "colors.on-primary",
    "colors.onPrimary",
    "colors.primary-text",
    "colors.primaryText",
  ]) || WHITE;

  const btnRadius = pick(fm, [
    "components.button-primary.rounded",
    "components.button-primary.borderRadius",
    "components.buttonPrimary.rounded",
    "components.buttonPrimary.borderRadius",
    "components.button.primary.rounded",
    "components.button.primary.borderRadius",
    "components.primaryButton.borderRadius",
    "components.primaryButton.rounded",
    "button.primary.borderRadius",
    "button.primary.rounded",
  ]) || radiusMd;

  // overview
  const overview = model.overviewText;

  return {
    slug,
    title,
    description,
    primaryColor,
    surfaceColor,
    canvasColor,
    textColor,
    mutedColor,
    borderColor,
    fontFamily,
    headingSize,
    headingWeight,
    bodySize,
    captionSize,
    radiusSm,
    radiusMd,
    radiusLg,
    radiusPill,
    spaceSm,
    spaceMd,
    spaceLg,
    btnBg,
    btnColor,
    btnRadius,
    overview,
  };
}

// ═══════════════════════════════════════════════
// Design-system board model (rich, token-grouped)
// ═══════════════════════════════════════════════

export interface DesignMdBoardToken {
  key: string;
  rawValue: string;
  resolvedValue: string;
  source?: "structured" | "markdown" | "derived";
  sourceEvidence?: DesignMdSourceEvidence;
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
  overview: string | null;
  layout: string | null;
  fontSubstitutes: string;
  coverage: DesignMdPreviewCoverage;
  confidence: DesignMdPreviewConfidence;
  warnings: DesignMdPreviewWarning[];
}

export function buildBoard(
  slug: string,
  title: string,
  description: string,
  content: string,
): DesignMdBoard {
  const model = parseDesignMdForPreview(slug, title, description, content);

  return {
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
    overview: model.overviewText,
    layout: model.layoutText,
    fontSubstitutes: model.fontSubstitutes,
    coverage: model.coverage,
    confidence: model.confidence,
    warnings: model.warnings,
  };
}
