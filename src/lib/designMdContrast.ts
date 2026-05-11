import { isSafeColorValue } from "./designMdPreviewParser";

/**
 * Convert a hex color string to RGB components.
 */
export function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  const hex = value.trim();
  if (!/^#[0-9a-fA-F]{3,8}$/.test(hex)) return null;
  const raw = hex.slice(1);
  const full = raw.length === 3 || raw.length === 4
    ? raw.slice(0, 3).split("").map((c) => c + c).join("")
    : raw.slice(0, 6);
  const int = Number.parseInt(full, 16);
  if (Number.isNaN(int)) return null;
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/**
 * Calculate relative luminance per WCAG 2.1.
 */
export function relativeLuminance(value: string): number | null {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * Calculate WCAG contrast ratio between two colors.
 * Returns null if either color is invalid.
 */
export function contrastRatio(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  if (!isSafeColorValue(a) || !isSafeColorValue(b)) return null;
  const la = relativeLuminance(a.trim());
  const lb = relativeLuminance(b.trim());
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Return the more readable text color (light or dark) for a given background.
 */
export function readableTextColor(bg: string, light = "#f8fafc", dark = "#111111"): string {
  const lightContrast = contrastRatio(bg, light) ?? 0;
  const darkContrast = contrastRatio(bg, dark) ?? 0;
  return lightContrast >= darkContrast ? light : dark;
}

/**
 * Ensure a foreground color has at least WCAG AA contrast (4.5:1) against a background.
 * If contrast is insufficient, return the fallback or auto-calculated readable color.
 */
export function ensureReadable(fg: string, bg: string, fallback?: string): string {
  if (!isSafeColorValue(fg) || !isSafeColorValue(bg)) return fallback ?? fg;
  const ratio = contrastRatio(fg.trim(), bg.trim());
  if (ratio === null || ratio >= 4.5) return fg.trim();
  return fallback ?? readableTextColor(bg.trim());
}

export interface ContrastCheck {
  fg: string;
  bg: string;
  ratio: number | null;
  passes: boolean;
  /** WCAG AA (4.5:1 for normal text, 3:1 for large text) */
  level: "AAA" | "AA" | "AA-large" | "fail";
}

/**
 * Check contrast between foreground and background.
 */
export function checkContrast(fg: string, bg: string): ContrastCheck {
  const ratio = contrastRatio(fg, bg);
  const passes = ratio !== null && ratio >= 4.5;
  let level: ContrastCheck["level"];
  if (ratio === null) {
    level = "fail";
  } else if (ratio >= 7) {
    level = "AAA";
  } else if (ratio >= 4.5) {
    level = "AA";
  } else if (ratio >= 3) {
    level = "AA-large";
  } else {
    level = "fail";
  }
  return { fg, bg, ratio, passes, level };
}

/**
 * Detect problematic contrast patterns:
 * - white-on-white or near-white (luma both > 0.9)
 * - black-on-dark or near-black (luma both < 0.15)
 * - muted text on similar background (ratio < 3)
 */
export function isContrastFailure(fg: string, bg: string): boolean {
  const check = checkContrast(fg, bg);
  if (check.ratio === null) return true;

  // Barely distinguishable
  if (check.ratio < 2) return true;

  // White-on-white detection
  const fgLuma = relativeLuminance(fg);
  const bgLuma = relativeLuminance(bg);
  if (fgLuma !== null && bgLuma !== null) {
    if (fgLuma > 0.88 && bgLuma > 0.88) return true;
    if (fgLuma < 0.12 && bgLuma < 0.12) return true;
  }

  return false;
}
