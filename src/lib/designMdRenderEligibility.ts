import type { DesignMdBoardComponentGroup } from "./designMdSpecimenBuilder";
import type {
  DesignMdComponentKind,
  DesignMdSourceConfidence,
} from "./designMdPreviewParser";
import {
  isSafeColorValue,
  isSafeSizeValue,
  isSafeSpacingValue,
} from "./designMdPreviewParser";
import { isContrastFailure } from "./designMdContrast";

export type RenderConfidence = "high" | "medium" | "low" | "fallback";

export interface ComponentRenderEligibility {
  component: DesignMdBoardComponentGroup;
  canRenderGraphic: boolean;
  canRenderCompact: boolean;
  reason: string;
  confidence: RenderConfidence;
  missing: {
    background: boolean;
    textColor: boolean;
    borderColor: boolean;
    radius: boolean;
    padding: boolean;
    content: boolean;
    kind: boolean;
    sourceEvidence: boolean;
  };
  safeStyleCount: number;
  sourceBackedPropertyCount: number;
}

/**
 * Minimum requirements for graphical rendering by component kind.
 * A component needs at minimum a background or border + readable text.
 */
const GRAPHIC_REQUIREMENTS: Partial<Record<DesignMdComponentKind, {
  minStyles: number;
  requireBgOrBorder: boolean;
  requireContent: boolean;
  requireKind: boolean;
}>> = {
  button: { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: true },
  card: { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  "pricing-card": { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  "stat-card": { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  tile: { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  "product-tile": { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  "editorial-card": { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  "article-card": { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  "media-card": { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  "payment-card": { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  input: { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: true },
  search: { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: true },
  "prompt-input": { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: true },
  chip: { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  badge: { minStyles: 1, requireBgOrBorder: true, requireContent: true, requireKind: false },
  nav: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  subnav: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  "terminal-panel": { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  "code-panel": { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  "workflow-step": { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  "market-table": { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  table: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  chart: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  hero: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  gradient: { minStyles: 0, requireBgOrBorder: false, requireContent: false, requireKind: true },
  mockup: { minStyles: 0, requireBgOrBorder: false, requireContent: false, requireKind: true },
  utility: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: false },
  footer: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  quote: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  link: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  stat: { minStyles: 0, requireBgOrBorder: false, requireContent: true, requireKind: true },
  // generic: should never render as a large graphical component.
  generic: { minStyles: 999, requireBgOrBorder: true, requireContent: true, requireKind: false },
};

/**
 * Components whose kind alone is NOT meaningful enough to show as a visual block,
 * regardless of style count. These are layout/contextual tags, not standalone components.
 */
const ALWAYS_COMPACT_KINDS: Set<DesignMdComponentKind> = new Set([
  "generic",
  "utility",
  "footer",
  "link",
  "quote",
  "stat",
  "mockup",
  "gradient",
]);

/**
 * Count source-backed style properties that are safe CSS values.
 */
function countSafeStyleProps(component: DesignMdBoardComponentGroup): number {
  let count = 0;
  if (component.backgroundColor && isSafeColorValue(component.backgroundColor)) count += 1;
  if (component.textColor && isSafeColorValue(component.textColor)) count += 1;
  if (component.borderColor && isSafeColorValue(component.borderColor)) count += 1;
  if (component.rounded && isSafeSizeValue(component.rounded)) count += 1;
  if (component.padding && isSafeSpacingValue(component.padding)) count += 1;
  return count;
}

/**
 * Count source-backed structured properties from the raw map.
 */
function countSourceRawProps(component: DesignMdBoardComponentGroup): number {
  let count = 0;
  for (const value of Object.values(component.raw)) {
    if (value && value.trim()) count += 1;
  }
  return count;
}

function evidenceConfidence(component: DesignMdBoardComponentGroup): DesignMdSourceConfidence {
  return component.sourceEvidence?.confidence ?? "fallback";
}

function hasSourceBacking(component: DesignMdBoardComponentGroup): boolean {
  const confidence = evidenceConfidence(component);
  if (confidence === "high" || confidence === "medium") return true;
  // low confidence from frontmatter or markdown-list is acceptable
  if (confidence === "low") {
    const sourceType = component.sourceEvidence?.sourceType;
    return sourceType === "frontmatter" || sourceType === "markdown-list" || sourceType === "markdown-heading";
  }
  return false;
}

function validateComponentName(name: string): boolean {
  if (!name || name.trim().length === 0) return false;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  // shorter than 3 chars after cleanup = too generic/empty
  if (normalized.length < 3) return false;
  return true;
}

/**
 * Determine if a component can be rendered as a graphical sample.
 */
export function checkRenderEligibility(
  component: DesignMdBoardComponentGroup,
): ComponentRenderEligibility {
  const requirements = GRAPHIC_REQUIREMENTS[component.kind];
  const safeStyles = countSafeStyleProps(component);
  const sourceProps = countSourceRawProps(component);
  const evidence = evidenceConfidence(component);
  const hasSource = hasSourceBacking(component);
  const validName = validateComponentName(component.name);
  const isAlwaysCompact = ALWAYS_COMPACT_KINDS.has(component.kind);

  const missing = {
    background: !component.backgroundColor || !isSafeColorValue(component.backgroundColor),
    textColor: !component.textColor || !isSafeColorValue(component.textColor),
    borderColor: !component.borderColor || !isSafeColorValue(component.borderColor),
    radius: !component.rounded || !isSafeSizeValue(component.rounded),
    padding: !component.padding || !isSafeSpacingValue(component.padding),
    content: !validName,
    kind: false, // kind is always present (derived)
    sourceEvidence: !hasSource,
  };

  // Generic components can only render compact
  if (component.kind === "generic") {
    return {
      component,
      canRenderGraphic: false,
      canRenderCompact: validName,
      reason: "generic components cannot render as graphical samples",
      confidence: "fallback",
      missing,
      safeStyleCount: safeStyles,
      sourceBackedPropertyCount: sourceProps,
    };
  }

  // Always-compact kinds
  if (isAlwaysCompact) {
    return {
      component,
      canRenderGraphic: false,
      canRenderCompact: validName,
      reason: `${component.kind} components render as compact rows only`,
      confidence: "low",
      missing,
      safeStyleCount: safeStyles,
      sourceBackedPropertyCount: sourceProps,
    };
  }

  // Must have a valid name to render at all
  if (!validName) {
    return {
      component,
      canRenderGraphic: false,
      canRenderCompact: false,
      reason: "missing valid component name",
      confidence: "fallback",
      missing,
      safeStyleCount: safeStyles,
      sourceBackedPropertyCount: sourceProps,
    };
  }

  // Must have source backing
  if (!hasSource) {
    return {
      component,
      canRenderGraphic: false,
      canRenderCompact: true,
      reason: "no source evidence for component",
      confidence: "fallback",
      missing,
      safeStyleCount: safeStyles,
      sourceBackedPropertyCount: sourceProps,
    };
  }

  // Require minimum styles for certain kinds
  if (requirements) {
    if (safeStyles < requirements.minStyles) {
      return {
        component,
        canRenderGraphic: false,
        canRenderCompact: true,
        reason: `insufficient styles (${safeStyles}/${requirements.minStyles}) for ${component.kind}`,
        confidence: evidence as RenderConfidence,
        missing,
        safeStyleCount: safeStyles,
        sourceBackedPropertyCount: sourceProps,
      };
    }
    if (requirements.requireBgOrBorder) {
      const hasBg = component.backgroundColor && isSafeColorValue(component.backgroundColor);
      const hasBorder = component.borderColor && isSafeColorValue(component.borderColor);
      if (!hasBg && !hasBorder) {
        return {
          component,
          canRenderGraphic: false,
          canRenderCompact: true,
          reason: `missing background or border for ${component.kind}`,
          confidence: "low",
          missing,
          safeStyleCount: safeStyles,
          sourceBackedPropertyCount: sourceProps,
        };
      }
    }
    if (requirements.requireContent && !validName) {
      return {
        component,
        canRenderGraphic: false,
        canRenderCompact: false,
        reason: `missing visible label for ${component.kind}`,
        confidence: "fallback",
        missing,
        safeStyleCount: safeStyles,
        sourceBackedPropertyCount: sourceProps,
      };
    }
  }

  // Contrast check: if both bg and text exist but fail contrast, downgrade to compact
  if (isSafeColorValue(component.backgroundColor) && isSafeColorValue(component.textColor)) {
    if (isContrastFailure(component.backgroundColor.trim(), component.textColor.trim())) {
      return {
        component,
        canRenderGraphic: false,
        canRenderCompact: true,
        reason: `poor foreground/background contrast for ${component.kind}`,
        confidence: "low",
        missing: { ...missing, content: false },
        safeStyleCount: safeStyles,
        sourceBackedPropertyCount: sourceProps,
      };
    }
  }

  // Determine confidence
  let confidence: RenderConfidence;
  if (evidence === "high" && safeStyles >= 2 && sourceProps >= 2) {
    confidence = "high";
  } else if (evidence === "high" || (evidence === "medium" && safeStyles >= 1)) {
    confidence = "medium";
  } else if (safeStyles >= 1 || sourceProps >= 1) {
    confidence = "low";
  } else {
    confidence = "fallback";
  }

  return {
    component,
    canRenderGraphic: true,
    canRenderCompact: true,
    reason: `eligible for graphical rendering (${safeStyles} styles, ${sourceProps} props, ${evidence} evidence)`,
    confidence,
    missing,
    safeStyleCount: safeStyles,
    sourceBackedPropertyCount: sourceProps,
  };
}

/**
 * Check all components in a board and return eligibility results.
 */
export function checkAllComponents(
  components: DesignMdBoardComponentGroup[],
): ComponentRenderEligibility[] {
  return components.map(checkRenderEligibility);
}

/**
 * Return only components eligible for graphical rendering.
 */
export function graphicalComponents(
  components: DesignMdBoardComponentGroup[],
): { component: DesignMdBoardComponentGroup; eligibility: ComponentRenderEligibility }[] {
  return components
    .map((c) => ({ component: c, eligibility: checkRenderEligibility(c) }))
    .filter((r) => r.eligibility.canRenderGraphic);
}

/**
 * Return only components eligible for compact rendering (non-graphical).
 */
export function compactComponents(
  components: DesignMdBoardComponentGroup[],
): { component: DesignMdBoardComponentGroup; eligibility: ComponentRenderEligibility }[] {
  return components
    .map((c) => ({ component: c, eligibility: checkRenderEligibility(c) }))
    .filter((r) => !r.eligibility.canRenderGraphic && r.eligibility.canRenderCompact);
}
