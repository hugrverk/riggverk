import type { ThemeTokens } from "./designMdThemeResolver";
import type { DarkSurfaceSet } from "./designMdDarkSurfaceSet";
import {
  contrastRatio,
  readableTextColor,
  relativeLuminance,
} from "./designMdContrast";
import { isSafeColorValue } from "./designMdPreviewParser";

export interface ContrastTextChoice {
  value: string;
  source: "preferred" | "fallbackLight" | "fallbackDark";
  ratio: number | null;
  warning?: string;
}

export interface ContrastAuditFinding {
  label: string;
  foreground: string;
  background: string;
  ratio: number | null;
  threshold: number;
  passes: boolean;
  note: string;
}

function safeHex(value: string | undefined): string | null {
  if (!value || !isSafeColorValue(value)) return null;
  return value.trim();
}

function scoreTextChoice(background: string, foreground: string): number {
  const ratio = contrastRatio(background, foreground);
  return ratio ?? 0;
}

export function readableTextOn(
  background: string,
  preferred: string,
  fallbackLight: string,
  fallbackDark: string,
): ContrastTextChoice {
  const bg = safeHex(background);
  if (!bg) {
    return {
      value: preferred,
      source: "preferred",
      ratio: null,
      warning: "invalid background color; using preferred text",
    };
  }

  const candidates: Array<{
    value: string;
    source: ContrastTextChoice["source"];
    ratio: number | null;
  }> = [
    { value: preferred, source: "preferred" as const, ratio: scoreTextChoice(bg, preferred) },
    { value: fallbackLight, source: "fallbackLight" as const, ratio: scoreTextChoice(bg, fallbackLight) },
    { value: fallbackDark, source: "fallbackDark" as const, ratio: scoreTextChoice(bg, fallbackDark) },
    { value: "#ffffff", source: "fallbackLight" as const, ratio: scoreTextChoice(bg, "#ffffff") },
    { value: "#000000", source: "fallbackDark" as const, ratio: scoreTextChoice(bg, "#000000") },
  ].filter((candidate) => !!safeHex(candidate.value));

  const uniqueCandidates = candidates.filter((candidate, index, array) =>
    array.findIndex((other) => other.value.toLowerCase() === candidate.value.toLowerCase()) === index,
  );

  if (uniqueCandidates.length === 0) {
    return {
      value: readableTextColor(bg),
      source: "fallbackDark",
      ratio: scoreTextChoice(bg, readableTextColor(bg)),
      warning: "no safe text candidates; using readable fallback",
    };
  }

  const ranked = [...uniqueCandidates].sort((a, b) => {
    const ratioA = a.ratio ?? 0;
    const ratioB = b.ratio ?? 0;
    if (ratioA !== ratioB) return ratioB - ratioA;

    // Prefer the source-backed token on a tie, then prefer the theme-appropriate fallback.
    if (a.source === b.source) return 0;
    if (a.source === "preferred") return -1;
    if (b.source === "preferred") return 1;

    const bgLuma = relativeLuminance(bg) ?? 0.5;
    if (bgLuma < 0.5) {
      if (a.source === "fallbackLight") return -1;
      if (b.source === "fallbackLight") return 1;
    } else {
      if (a.source === "fallbackDark") return -1;
      if (b.source === "fallbackDark") return 1;
    }
    return 0;
  });

  const chosen = ranked[0] ?? candidates[0];
  const preferredRatio = uniqueCandidates[0]?.ratio ?? null;
  const warning =
    chosen.source !== "preferred"
      ? `preferred text fails contrast on ${bg}; using ${chosen.source}`
      : (chosen.ratio !== null && chosen.ratio < 4.5)
        ? `preferred text is below WCAG AA on ${bg}; using source-backed text`
        : undefined;

  return {
    value: chosen.value,
    source: chosen.source,
    ratio: chosen.ratio,
    warning: warning ?? (preferredRatio !== null && preferredRatio < 4.5 ? `preferred text contrast is ${preferredRatio.toFixed(2)}:1` : undefined),
  };
}

export function auditTextContrast(
  label: string,
  foreground: string,
  background: string,
  threshold = 4.5,
): ContrastAuditFinding {
  const fg = safeHex(foreground) ?? foreground;
  const bg = safeHex(background) ?? background;
  const ratio = contrastRatio(fg, bg);
  const passes = ratio !== null && ratio >= threshold;
  return {
    label,
    foreground: fg,
    background: bg,
    ratio,
    threshold,
    passes,
    note: passes
      ? "passes"
      : ratio === null
        ? "invalid colors"
        : `below ${threshold.toFixed(1)}:1`,
  };
}

export function auditThemeContrast(theme: ThemeTokens): ContrastAuditFinding[] {
  const findings: ContrastAuditFinding[] = [];

  findings.push(auditTextContrast("theme text on canvas", theme.text, theme.canvas, 4.5));
  findings.push(auditTextContrast("theme muted on canvas", theme.muted, theme.canvas, 3.0));
  findings.push(auditTextContrast("theme on-primary on primary", theme.onPrimary, theme.primary, 4.5));

  if (theme.variant === "dark") {
    findings.push(auditTextContrast("dark text on dark canvas", theme.text, theme.darkCanvas, 4.5));
    findings.push(auditTextContrast("dark muted on dark canvas", theme.muted, theme.darkCanvas, 3.0));
    findings.push(auditTextContrast("on-dark on dark canvas", theme.onDark, theme.darkCanvas, 4.5));
    findings.push(auditTextContrast("on-dark on dark surface", theme.onDark, theme.darkSurface, 4.5));
  }

  return findings;
}

export function auditDarkSurfaceSetContrast(surfaceSet: DarkSurfaceSet, theme: ThemeTokens): ContrastAuditFinding[] {
  const findings: ContrastAuditFinding[] = [];
  const surfaces = [
    surfaceSet.pageCanvas,
    surfaceSet.primarySectionSurface,
    surfaceSet.secondarySectionSurface,
    surfaceSet.tertiarySectionSurface,
    surfaceSet.blackSurface,
    surfaceSet.navSurface,
  ].filter((token): token is NonNullable<typeof token> => !!token);

  for (const surface of surfaces) {
    findings.push(auditTextContrast(
      `${surface.key} on-dark text`,
      surfaceSet.onDarkText?.value ?? theme.onDark,
      surface.value,
      4.5,
    ));

    if (surfaceSet.mutedOnDarkText && isSafeColorValue(surfaceSet.mutedOnDarkText.value) && isSafeColorValue(surface.value)) {
      findings.push(auditTextContrast(
        `${surface.key} muted on-dark text`,
        surfaceSet.mutedOnDarkText.value,
        surface.value,
        3.0,
      ));
    }

    if (surfaceSet.linkOnDark && isSafeColorValue(surfaceSet.linkOnDark.value) && isSafeColorValue(surface.value)) {
      findings.push(auditTextContrast(
        `${surface.key} link/accent on-dark`,
        surfaceSet.linkOnDark.value,
        surface.value,
        3.0,
      ));
    }

    if (surfaceSet.borderOnDark && isSafeColorValue(surfaceSet.borderOnDark.value) && isSafeColorValue(surface.value)) {
      const ratio = contrastRatio(surfaceSet.borderOnDark.value, surface.value);
      const bgLuma = relativeLuminance(surface.value);
      const tooHard = ratio !== null && bgLuma !== null && bgLuma < 0.4 && ratio > 4.5;
      findings.push({
        label: `${surface.key} border on dark`,
        foreground: surfaceSet.borderOnDark.value,
        background: surface.value,
        ratio,
        threshold: 1.5,
        passes: !tooHard,
        note: tooHard ? "border may read as a hard outline" : "border acceptable",
      });
    }
  }

  return findings;
}
