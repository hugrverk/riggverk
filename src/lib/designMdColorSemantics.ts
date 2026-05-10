import type { DesignMdPaletteGroupName, DesignMdSourceEvidence } from "./designMdPreviewParser";

export type ColorSemanticRole =
  | "canvas"
  | "surface"
  | "text"
  | "border"
  | "primaryAction"
  | "brandAccent"
  | "semantic"
  | "status"
  | "timeline"
  | "state"
  | "decorative"
  | "unknown";

export type ColorUsageScope =
  | "globalCanvas"
  | "sectionSurface"
  | "cardSurface"
  | "text"
  | "border"
  | "primaryButton"
  | "secondaryButton"
  | "wordmark"
  | "stateOnly"
  | "timelineOnly"
  | "semanticOnly"
  | "decorativeOnly"
  | "unknown";

export type ColorUsageIntensity = "dominant" | "supporting" | "sparse" | "scopedOnly" | "unknown";

export interface DesignMdColorSemantics {
  semanticRole: ColorSemanticRole;
  usageScope: ColorUsageScope;
  usageIntensity: ColorUsageIntensity;
  evidence: string[];
  warnings: string[];
}

export interface DesignMdSemanticColorInput {
  key: string;
  value: string;
  group: DesignMdPaletteGroupName;
  prose?: string;
  sourceEvidence?: DesignMdSourceEvidence;
}

function parts(key: string): string[] {
  return key.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean);
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function inferColorSemantics(input: DesignMdSemanticColorInput): DesignMdColorSemantics {
  const key = input.key.toLowerCase();
  const keyParts = parts(input.key);
  const prose = (input.prose ?? "").toLowerCase();
  const localEvidence = (input.sourceEvidence?.text ?? "").toLowerCase();
  const tokenContext = `${key} ${input.group} ${localEvidence}`;
  const context = `${tokenContext} ${prose}`;
  const evidence: string[] = [];
  const warnings: string[] = [];

  const hasState = keyParts.some((p) => /^(active|hover|pressed|focus|focused|disabled|selected|loading|visited|checked)$/.test(p));
  const hasTimeline = keyParts.some((p) => /^(timeline|stage|phase|milestone)$/.test(p)) || /\btimeline\b/.test(tokenContext);
  const hasStatus = keyParts.some((p) => /^(status|success|error|danger|warning|info|trading|up|down)$/.test(p));
  const hasSemantic = keyParts.some((p) => /^(semantic|validation|valid|invalid|success|error|danger|warning|info)$/.test(p))
    || hasAny(tokenContext, [/\bsemantic\b/, /\bvalidation\b/]);
  const restricted = hasAny(context, [
    /\breserved for\b/,
    /\bused scarcely\b/,
    /\buse scarcely\b/,
    /\bscarcely\b/,
    /\bonly inside\b/,
    /\bonly for\b/,
    /\bnever\b/,
  ]);

  let semanticRole: ColorSemanticRole = "unknown";
  let usageScope: ColorUsageScope = "unknown";
  let usageIntensity: ColorUsageIntensity = "unknown";

  if (hasState) {
    semanticRole = "state";
    usageScope = "stateOnly";
    usageIntensity = "scopedOnly";
    evidence.push("state variant key");
  } else if (hasTimeline) {
    semanticRole = "timeline";
    usageScope = "timelineOnly";
    usageIntensity = "scopedOnly";
    evidence.push("timeline key/prose");
  } else if (hasSemantic) {
    semanticRole = hasStatus ? "status" : "semantic";
    usageScope = "semanticOnly";
    usageIntensity = "scopedOnly";
    evidence.push("semantic/status key/prose");
  } else if (keyParts.some((p) => /^(canvas|background|page|body|app|floor|root)$/.test(p))) {
    semanticRole = "canvas";
    usageScope = "globalCanvas";
    usageIntensity = "dominant";
    evidence.push("canvas/background key");
  } else if (keyParts.some((p) => /^(surface|card|panel|elevated|sheet|tile)$/.test(p))) {
    semanticRole = "surface";
    usageScope = keyParts.some((p) => /^(card|tile)$/.test(p)) ? "cardSurface" : "sectionSurface";
    usageIntensity = "supporting";
    evidence.push("surface/card key");
  } else if (keyParts.some((p) => /^(ink|text|foreground)$/.test(p)) || key === "body" || keyParts.includes("body")) {
    semanticRole = "text";
    usageScope = "text";
    usageIntensity = "dominant";
    evidence.push("text/ink key");
  } else if (keyParts.some((p) => /^(border|hairline|divider|stroke|line)$/.test(p))) {
    semanticRole = "border";
    usageScope = "border";
    usageIntensity = "supporting";
    evidence.push("border/hairline key");
  } else if (keyParts.some((p) => /^(primary|cta)$/.test(p)) || /\bprimary cta\b/.test(tokenContext)) {
    semanticRole = "primaryAction";
    usageScope = "primaryButton";
    usageIntensity = restricted ? "sparse" : "supporting";
    evidence.push("primary/CTA key or prose");
  } else if (keyParts.some((p) => /^(brand|accent|wordmark|logo)$/.test(p))) {
    semanticRole = "brandAccent";
    usageScope = keyParts.some((p) => /^(wordmark|logo)$/.test(p)) || /\bwordmark\b/.test(context) ? "wordmark" : "primaryButton";
    usageIntensity = restricted ? "sparse" : "supporting";
    evidence.push("brand/accent key or prose");
  } else if (input.group === "canvas/surface") {
    semanticRole = "surface";
    usageScope = "sectionSurface";
    usageIntensity = "supporting";
    evidence.push("canvas/surface group");
  } else if (input.group === "text/ink") {
    semanticRole = "text";
    usageScope = "text";
    usageIntensity = "dominant";
    evidence.push("text/ink group");
  } else if (input.group === "borders/hairlines") {
    semanticRole = "border";
    usageScope = "border";
    usageIntensity = "supporting";
    evidence.push("border group");
  } else if (input.group === "semantic/status") {
    semanticRole = "semantic";
    usageScope = "semanticOnly";
    usageIntensity = "scopedOnly";
    evidence.push("semantic/status group");
  } else if (input.group === "brand/accent") {
    semanticRole = "brandAccent";
    usageScope = "primaryButton";
    usageIntensity = restricted ? "sparse" : "supporting";
    evidence.push("brand/accent group");
  }

  if (restricted && (semanticRole === "primaryAction" || semanticRole === "brandAccent")) {
    if (usageIntensity !== "scopedOnly") usageIntensity = "sparse";
    warnings.push("source prose restricts broad use");
  }
  if (hasAny(tokenContext, [/\bonly inside\b/, /\bonly for\b/]) && semanticRole !== "primaryAction") {
    usageIntensity = "scopedOnly";
  }
  if (semanticRole === "primaryAction" && /\bwordmark\b/.test(context)) {
    evidence.push("wordmark prose");
  }

  return { semanticRole, usageScope, usageIntensity, evidence, warnings };
}

export function canUseAsCanvas(color: DesignMdColorSemantics | undefined): boolean {
  return color?.usageScope === "globalCanvas" && color.semanticRole === "canvas";
}

export function canUseAsSurface(color: DesignMdColorSemantics | undefined): boolean {
  return color?.semanticRole === "surface" && (color.usageScope === "sectionSurface" || color.usageScope === "cardSurface");
}

export function canUseAsHeroAccent(color: DesignMdColorSemantics | undefined): boolean {
  if (!color) return false;
  if (isScopedOnlyColor(color) || color.semanticRole === "state") return false;
  return color.semanticRole === "primaryAction" || color.semanticRole === "brandAccent";
}

export function canUseAsButtonFill(color: DesignMdColorSemantics | undefined): boolean {
  if (!color) return false;
  if (isScopedOnlyColor(color) || color.semanticRole === "state") return false;
  return color.semanticRole === "primaryAction" || color.semanticRole === "brandAccent";
}

export function canUseAsPaletteSwatch(_color: DesignMdColorSemantics | undefined): boolean {
  return true;
}

export function canUseAsDarkCanvasCandidate(color: DesignMdColorSemantics | undefined): boolean {
  if (!color) return true;
  return color.semanticRole === "canvas" || color.semanticRole === "surface" || color.semanticRole === "text" || color.semanticRole === "border" || color.semanticRole === "unknown";
}

export function isStateVariantColor(color: DesignMdColorSemantics | undefined): boolean {
  return color?.semanticRole === "state" || color?.usageScope === "stateOnly";
}

export function isScopedOnlyColor(color: DesignMdColorSemantics | undefined): boolean {
  return color?.usageIntensity === "scopedOnly"
    || color?.usageScope === "timelineOnly"
    || color?.usageScope === "semanticOnly"
    || color?.usageScope === "stateOnly"
    || color?.usageScope === "decorativeOnly";
}

export function isAccentSparse(color: DesignMdColorSemantics | undefined): boolean {
  return color?.usageIntensity === "sparse";
}
