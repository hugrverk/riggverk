import { parseFlatFrontmatter, parseDesignMdForPreview } from "./designMdPreviewParser";
// ── sanitization ──

function isSafeColor(val: string): string | null {
  const t = val.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return t;
  if (/^rgba?\s*\([^)]+\)$/.test(t)) return t;
  if (/^hsl/.test(t)) return t;
  return null;
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
  let result = value;
  let prev = "";
  for (let i = 0; i < 3 && prev !== result; i++) {
    prev = result;
    result = result.replace(/\{([^}]+)\}/g, (_, k: string) => {
      const r = map.get(k.trim());
      return r ?? `{${k}}`;
    });
  }
  return result;
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
}

export interface DesignMdBoardComponentGroup {
  name: string;
  kind: "button" | "card" | "tile" | "input" | "chip" | "nav" | "link" | "quote" | "footer" | "surface" | "generic";
  backgroundColor?: string;
  textColor?: string;
  borderColor?: string;
  rounded?: string;
  padding?: string;
  raw: Record<string, string>;
}

export interface DesignMdBoard {
  slug: string;
  title: string;
  description: string;
  colorGroups: DesignMdBoardColorGroup[];
  typographyTokens: DesignMdBoardTypoToken[];
  radiusTokens: DesignMdBoardToken[];
  spacingTokens: DesignMdBoardToken[];
  componentGroups: DesignMdBoardComponentGroup[];
  overview: string | null;
  layout: string | null;
}

function groupTokens(fm: Map<string, string>, prefix: string): DesignMdBoardToken[] {
  const tokens: DesignMdBoardToken[] = [];
  const dot = prefix + ".";
  for (const [key, value] of fm) {
    if (key.startsWith(dot)) {
      const resolved = resolveRef(value, fm);
      tokens.push({ key: key.slice(dot.length), rawValue: value, resolvedValue: resolved });
    }
  }
  return tokens;
}

function getFirstValue(fm: Map<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = fm.get(k);
    if (v && v.trim()) return resolveRef(v.trim(), fm);
  }
  return undefined;
}

function inferComponentKind(name: string): DesignMdBoardComponentGroup["kind"] {
  const n = name.toLowerCase();
  if (n.includes("button") || n.includes("cta")) return "button";
  if (n.includes("card")) return "card";
  if (n.includes("tile")) return "tile";
  if (n.includes("input") || n.includes("field") || n.includes("search")) return "input";
  if (n.includes("chip") || n.includes("badge") || n.includes("tag") || n.includes("pill")) return "chip";
  if (n.includes("nav") || n.includes("header")) return "nav";
  if (n.includes("link")) return "link";
  if (n.includes("quote")) return "quote";
  if (n.includes("footer")) return "footer";
  if (n.includes("surface") || n.includes("sheet")) return "surface";
  return "generic";
}

export function buildBoard(
  slug: string,
  title: string,
  description: string,
  content: string,
): DesignMdBoard {
  const fm = parseFlatFrontmatter(content);
  const model = parseDesignMdForPreview(slug, title, description, content);

  const colorTokens = groupTokens(fm, "colors");
  // Group colors with smart sub-grouping
  const colorGroups: DesignMdBoardColorGroup[] = colorTokens.length > 0
    ? [{ prefix: "all", tokens: colorTokens }]
    : [];

  const typographyTokens: DesignMdBoardTypoToken[] = [];
  const typoRaw = groupTokens(fm, "typography");
  const seenTypo = new Set<string>();
  for (const t of typoRaw) {
    const parts = t.key.split(".");
    const base = parts.slice(0, -1).join(".");
    if (seenTypo.has(base)) continue;
    seenTypo.add(base);
    typographyTokens.push({
      key: base || t.key,
      fontFamily: getFirstValue(fm, [`${"typography"}.${base}.fontFamily`, `${"typography"}.${base}.font-family`]),
      fontSize: getFirstValue(fm, [`${"typography"}.${base}.fontSize`, `${"typography"}.${base}.font-size`]),
      fontWeight: getFirstValue(fm, [`${"typography"}.${base}.fontWeight`, `${"typography"}.${base}.font-weight`]),
      lineHeight: getFirstValue(fm, [`${"typography"}.${base}.lineHeight`, `${"typography"}.${base}.line-height`]),
      letterSpacing: getFirstValue(fm, [`${"typography"}.${base}.letterSpacing`, `${"typography"}.${base}.letter-spacing`]),
      raw: {},
    });
  }

  const radiusTokens = groupTokens(fm, "rounded").length > 0
    ? groupTokens(fm, "rounded")
    : groupTokens(fm, "radius");
  const spacingTokens = groupTokens(fm, "spacing");

  // Component groups
  const compRaw = groupTokens(fm, "components");
  const compGroups = new Map<string, DesignMdBoardComponentGroup>();
  for (const c of compRaw) {
    const name = c.key.split(".")[0];
    if (!compGroups.has(name)) {
      compGroups.set(name, {
        name,
        kind: inferComponentKind(name),
        raw: {},
      });
    }
    const g = compGroups.get(name)!;
    const prop = c.key.slice(name.length + 1);
    g.raw[prop] = c.resolvedValue;
    if (prop.includes("backgroundColor") || prop.includes("background-color") || prop.includes("background")) g.backgroundColor = c.resolvedValue;
    if (prop.includes("textColor") || prop.includes("text-color") || prop.includes("color")) g.textColor = c.resolvedValue;
    if (prop.includes("borderColor") || prop.includes("border-color")) g.borderColor = c.resolvedValue;
    if (prop.includes("rounded") || prop.includes("borderRadius") || prop.includes("border-radius")) g.rounded = c.resolvedValue;
    if (prop.includes("padding")) g.padding = c.resolvedValue;
  }
  const componentGroups = Array.from(compGroups.values());

  return {
    slug,
    title,
    description,
    colorGroups,
    typographyTokens,
    radiusTokens,
    spacingTokens,
    componentGroups,
    overview: model.overviewText,
    layout: model.layoutText,
  };
}
