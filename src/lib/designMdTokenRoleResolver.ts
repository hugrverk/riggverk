import type { DesignMdPaletteGroupName, DesignMdSourceEvidence } from "./designMdPreviewParser";
import { relativeLuminance } from "./designMdContrast";

export type DesignMdTokenRole =
  | "globalCanvas"
  | "pageBackground"
  | "bodyBackground"
  | "sectionSurface"
  | "cardSurface"
  | "panelSurface"
  | "componentSurface"
  | "bodyText"
  | "headingText"
  | "mutedText"
  | "foregroundText"
  | "border"
  | "hairline"
  | "primaryAction"
  | "brandAccent"
  | "semanticOnly"
  | "timelineOnly"
  | "stateOnly"
  | "decorativeOnly"
  | "unknown";

export type DesignMdTokenRoleConfidence = "high" | "medium" | "low" | "fallback";

export interface DesignMdResolvedTokenRole {
  resolvedRole: DesignMdTokenRole;
  roleConfidence: DesignMdTokenRoleConfidence;
  roleEvidence: string[];
  roleWarnings: string[];
}

export interface DesignMdTokenRoleInput {
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

function isDark(value: string): boolean {
  const lum = relativeLuminance(value);
  return lum !== null && lum < 0.32;
}

function isLight(value: string): boolean {
  const lum = relativeLuminance(value);
  return lum !== null && lum > 0.62;
}

function confidence(value: number): DesignMdTokenRoleConfidence {
  if (value >= 4) return "high";
  if (value >= 2) return "medium";
  if (value >= 1) return "low";
  return "fallback";
}

export function resolveDesignMdTokenRole(input: DesignMdTokenRoleInput): DesignMdResolvedTokenRole {
  const key = input.key.toLowerCase();
  const keyParts = parts(input.key);
  const compact = keyParts.join("-");
  const prose = (input.prose ?? "").toLowerCase();
  const localEvidence = (input.sourceEvidence?.text ?? "").toLowerCase();
  // context includes group name for key/group classification
  const context = `${key} ${input.group} ${localEvidence} ${prose}`;
  const tokenContext = `${key} ${input.group} ${localEvidence}`;
  // proseContext excludes group name to avoid false matches against classifier text (e.g. "text/ink")
  const proseContext = `${prose}`;
  const evidence: string[] = [];
  const warnings: string[] = [];
  const score = new Map<DesignMdTokenRole, number>();

  const add = (role: DesignMdTokenRole, amount: number, reason: string) => {
    score.set(role, (score.get(role) ?? 0) + amount);
    evidence.push(reason);
  };

  const part = (re: RegExp) => keyParts.some((p) => re.test(p));
  const exact = (...values: string[]) => values.includes(compact) || values.includes(key);

  if (part(/^(active|hover|pressed|focus|focused|disabled|selected|loading|visited|checked)$/)) add("stateOnly", 5, "state variant key");
  if (part(/^(timeline|stage|phase|milestone)$/) || /\btimeline\b/.test(tokenContext)) add("timelineOnly", 5, "timeline key/prose");
  if (part(/^(semantic|validation|valid|invalid|success|error|danger|warning|info|status)$/)) add("semanticOnly", 5, "semantic/status key");
  if (part(/^(decorative|decoration|ornament)$/) || /\bdecorative only\b/.test(context)) add("decorativeOnly", 5, "decorative key/prose");

  if (part(/^(border|divider|stroke|line)$/)) add("border", 4, "border/divider key");
  if (part(/^(hairline)$/)) add("hairline", 5, "hairline key");
  if (part(/^(primary|cta)$/) || /\bprimary ctas?\b/.test(tokenContext)) add("primaryAction", 4, "primary/CTA key or prose");
  if (part(/^(brand|accent|wordmark|logo)$/)) add("brandAccent", 3, "brand/accent key");

  if (exact("body-bg", "body-background", "body-canvas", "body-surface")) add("bodyBackground", 6, "explicit body background key");
  if (exact("body-text", "body-copy", "text-body", "copy-body", "body-on-dark")) add("bodyText", 6, "explicit body text key");
  if (part(/^(canvas|root|app|floor)$/)) add("globalCanvas", 5, "canvas/root/app key");
  if (part(/^(page|background)$/)) add("pageBackground", 4, "page/background key");
  if (part(/^(ink|foreground)$/)) add("foregroundText", 5, "ink/foreground key");
  if (part(/^(text)$/)) add("foregroundText", 4, "text key");
  if (part(/^(heading|headline|title)$/)) add("headingText", 4, "heading/title key");
  if (part(/^(muted|secondary|subtle)$/)) add("mutedText", 3, "muted/secondary key");

  if (exact("surface", "surface-light", "surface-dark")) add("sectionSurface", 3, "plain surface key");
  if (compact.includes("surface-card") || part(/^(card)$/)) add("cardSurface", 5, "card surface key");
  if (part(/^(panel|sheet|elevated)$/)) add("panelSurface", 5, "panel/elevated key");
  if (part(/^(tile)$/)) add("componentSurface", 5, "tile/component surface key");

  if (input.group === "text/ink") add("foregroundText", 2, "text/ink group");
  if (input.group === "canvas/surface") add("sectionSurface", 2, "canvas/surface group");
  if (input.group === "borders/hairlines") add("border", 3, "border group");
  if (input.group === "semantic/status") add("semanticOnly", 3, "semantic/status group");
  if (input.group === "brand/accent") add("brandAccent", 2, "brand/accent group");

  // Prose-based role inference (uses proseContext to avoid matching classifier group names)
  const textAligned = input.group === "text/ink" || keyParts.some((p) => /^(body|text|ink|foreground|heading|headline|title|muted|secondary)$/.test(p));
  const canvasAligned = input.group === "canvas/surface" || keyParts.some((p) => /^(body|canvas|background|page|app|root|surface)$/.test(p));
  const surfaceAligned = input.group === "canvas/surface" || keyParts.some((p) => /^(surface|card|panel|tile|sheet|elevated)$/.test(p));
  if (textAligned && hasAny(proseContext, [/\bbody text\b/, /\bbody copy\b/, /\bparagraph\b/, /\bcopy\b/, /\bforeground\b/, /\bink\b/, /\btext\b/])) add("bodyText", keyParts.includes("body") ? 4 : 1, "source prose indicates body text");
  if (keyParts.includes("body") && hasAny(proseContext, [/\bbody background\b/, /\bpage body\b/, /\bapp body background\b/, /\bbody canvas\b/])) add("bodyBackground", 5, "source prose indicates body background");
  if (canvasAligned && hasAny(proseContext, [/\bpage background\b/, /\bglobal background\b/, /\bapp background\b/, /\bpage canvas\b/, /\bglobal canvas\b/])) add("pageBackground", 3, "source prose indicates page background");
  if (surfaceAligned && hasAny(proseContext, [/\bpage surface\b/, /\bglobal surface\b/, /\bsection surface\b/])) add("sectionSurface", 3, "source prose indicates section/global surface");
  if (surfaceAligned && hasAny(proseContext, [/\bcard\b/, /\bpanel\b/, /\btile\b/, /\bsheet\b/]) && hasAny(proseContext, [/\bsurface\b/, /\bbackground\b/])) add("componentSurface", 2, "component surface prose");

  if (keyParts.includes("body")) {
    warnings.push("body token is ambiguous");
    if (!exact("body-bg", "body-background", "body-canvas", "body-text", "body-copy", "text-body", "body-on-dark")) {
      if (input.group === "text/ink") add("bodyText", 2, "plain body in text/ink group");
      if (isDark(input.value) && hasAny(proseContext, [/\bcanvas\b/, /\bbackground\b/, /\bpage\b/, /\bsurface\b/])) add("bodyText", 1, "dark body with separate background evidence");
      if (isLight(input.value) && input.group === "canvas/surface") add("bodyBackground", 1, "light body in canvas/surface group");
    }
  }

  if (keyParts.includes("surface") && compact === "surface") warnings.push("surface token is ambiguous");
  if ((part(/^(card|panel|tile)$/) || compact.includes("surface-card")) && score.has("globalCanvas")) warnings.push("component surface must not become global canvas");

  const ranked = Array.from(score.entries()).sort((a, b) => b[1] - a[1]);
  const [role, rawRoleScore] = ranked[0] ?? ["unknown", 0];
  const roleScore = key === "body" ? Math.min(rawRoleScore, 3) : rawRoleScore;
  const resolvedRole = roleScore > 0 ? role : "unknown";

  if (key === "body" && roleScore < 4) warnings.push("plain body resolved with weak evidence");
  if (key === "surface" && roleScore < 4) warnings.push("plain surface resolved with weak evidence");
  if (resolvedRole === "bodyBackground" && !isLight(input.value) && !hasAny(context, [/\bdark\b/, /\bnight\b/, /\binverse\b/])) warnings.push("body background value is not light; verify source intent");
  if ((resolvedRole === "bodyText" || resolvedRole === "foregroundText") && isLight(input.value) && !hasAny(context, [/\bon-dark\b/, /\binverse\b/])) warnings.push("text value is light without on-dark evidence");

  return {
    resolvedRole,
    roleConfidence: confidence(roleScore),
    roleEvidence: Array.from(new Set(evidence)),
    roleWarnings: Array.from(new Set(warnings)),
  };
}

export function tokenRoleIsCanvas(role: DesignMdTokenRole | undefined): boolean {
  return role === "globalCanvas" || role === "pageBackground" || role === "bodyBackground";
}

export function tokenRoleIsSurface(role: DesignMdTokenRole | undefined): boolean {
  return role === "sectionSurface" || role === "cardSurface" || role === "panelSurface" || role === "componentSurface";
}

export function tokenRoleIsText(role: DesignMdTokenRole | undefined): boolean {
  return role === "bodyText" || role === "headingText" || role === "mutedText" || role === "foregroundText";
}
