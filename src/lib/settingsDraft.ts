import type { AppSettings } from "../types";
import { DEFAULT_ENABLED_HARNESS_IDS, DEFAULT_ENABLED_TARGET_IDS } from "./harnessInstallation";
import { applyMotionSetting } from "./motion";

/** AppSettings persistence state for autosave UI. */
export type SettingsSaveStatus = "saved" | "pending" | "saving" | "error";

export const SETTINGS_AUTOSAVE_DEBOUNCE_MS = 600;

/** Mirrors agent_targets::default_enabled_ids (registry order; codex_config stays opt-in). */
export const DEFAULT_TARGET_IDS: string[] = [...DEFAULT_ENABLED_TARGET_IDS];
export const DEFAULT_HARNESS_IDS = [...DEFAULT_ENABLED_HARNESS_IDS];
export const APP_FONT_SIZE_VALUES = ["small", "medium", "large", "extra-large"] as const;

export const APP_FONT_SIZE_LABELS: Record<AppSettings["app_font_size"], string> = {
  small: "small",
  medium: "medium",
  large: "large",
  "extra-large": "extra large",
};

export function appFontSizePx(size: AppSettings["app_font_size"]): string {
  switch (size) {
    case "small":
      return "12px";
    case "large":
      return "15px";
    case "extra-large":
      return "17px";
    default:
      return "13px";
  }
}

/** Canonical installed workspace path (display form; backend owns resolution). */
export const DEFAULT_WORKSPACE_PATH = "~/.config/riggverk";

export function defaultSettings(): AppSettings {
  return {
    appearance: "dark",
    app_font_size: "medium",
    workspace_path: null,
    enabled_target_ids: DEFAULT_TARGET_IDS,
    enabled_harness_ids: DEFAULT_HARNESS_IDS,
    accent_color: null,
    background_color: null,
    foreground_color: null,
    motion: "full",
    landing_view: "start",
  };
}

export function normalizeAppFontSize(value: unknown): AppSettings["app_font_size"] {
  return APP_FONT_SIZE_VALUES.includes(value as AppSettings["app_font_size"])
    ? value as AppSettings["app_font_size"]
    : "medium";
}

export function serializeSettingsForCompare(settings: AppSettings): string {
  return JSON.stringify(settings);
}

const THEME_HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

export function isValidThemeHex(v: string | null | undefined): boolean {
  return !!v && THEME_HEX_RE.test(v);
}

function relativeLuminance(hex: string): number {
  const channel = (slice: string) => {
    const c = parseInt(slice, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = channel(hex.slice(1, 3));
  const g = channel(hex.slice(3, 5));
  const b = channel(hex.slice(5, 7));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Mirrors `--bg` and `--text` in _tokens.scss; settingsDraft.test.ts fails when they drift apart. */
const THEME_COLOR_DEFAULTS = {
  dark: { background: "#1e1e20", foreground: "#e6e6e8" },
  light: { background: "#f5f5f7", foreground: "#1d1d1f" },
} as const;

export function themeColorDefaults(appearance: AppSettings["appearance"]): {
  background: string;
  foreground: string;
} {
  return { ...THEME_COLOR_DEFAULTS[resolvedThemeClass(appearance)] };
}

/**
 * Accent when no override is set. Mirrors `--accent` in _tokens.scss (the dark `:root` block and the paper
 * `[data-theme="light"]` block); settingsDraft.test.ts fails when they drift apart.
 */
const ACCENT_DEFAULTS = { dark: "#b8bcc4", light: "#50555e" } as const;

export function themeAccentDefault(appearance: AppSettings["appearance"]): string {
  if (appearance === "light") return ACCENT_DEFAULTS.light;
  if (appearance === "dark") return ACCENT_DEFAULTS.dark;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? ACCENT_DEFAULTS.light : ACCENT_DEFAULTS.dark;
}

/** Text colour for surfaces filled with the accent (active tab, mode badge, primary button). */
export function inverseForeground(accentHex: string): string {
  return contrastRatio(accentHex, "#ffffff") >= contrastRatio(accentHex, "#111111")
    ? "#ffffff"
    : "#111111";
}

/**
 * Theme inks that custom colours do not override: muted text and the state inks. Mirrors `--text-muted`, `--ok`,
 * `--fail`, `--yours` and `--off` in _tokens.scss (dark `:root` block and the paper `[data-theme="light"]` block).
 */
const FIXED_INKS = {
  dark: ["#9b9ba0", "#86b48f", "#cf8e85", "#b0a4d6"],
  light: ["#68686d", "#2f7a47", "#b0493e", "#6a5a9e"],
} as const;

/** Luminance where black and white text have equal contrast; above it a background reads as light. */
const LIGHT_BACKGROUND_LUMINANCE = 0.179;

const LIGHT_SCHEME_QUERY = "(prefers-color-scheme: light)";

function resolvedThemeClass(appearance: AppSettings["appearance"]): "dark" | "light" {
  if (appearance === "light") return "light";
  if (appearance === "dark") return "dark";
  return window.matchMedia?.(LIGHT_SCHEME_QUERY).matches ? "light" : "dark";
}

/**
 * Warnings for a custom colour set. Only colours that are set (or typed as a valid hex) are judged; an unset colour
 * keeps the theme default, which the palette test already covers. A colour that does not fit the theme in force is
 * named as unused (see `themeColorsInForce`); the contrast checks judge what is actually shown.
 */
export function themeColorWarnings(input: {
  appearance: AppSettings["appearance"];
  foreground: string | null;
  background: string | null;
  accent: string | null;
}): string[] {
  const foreground = isValidThemeHex(input.foreground) ? input.foreground : null;
  const background = isValidThemeHex(input.background) ? input.background : null;
  const accent = isValidThemeHex(input.accent) ? input.accent : null;
  const theme = resolvedThemeClass(input.appearance);
  const inForce = themeColorsInForce({
    appearance: input.appearance,
    accent_color: accent,
    background_color: background,
    foreground_color: foreground,
  });
  const shownBackground = inForce.background ?? THEME_COLOR_DEFAULTS[theme].background;
  const shownForeground = inForce.foreground ?? THEME_COLOR_DEFAULTS[theme].foreground;
  const lightness = (hex: string) => (relativeLuminance(hex) > LIGHT_BACKGROUND_LUMINANCE ? "light" : "dark");
  const warnings: string[] = [];

  if (foreground && !inForce.foreground) {
    warnings.push(
      `Foreground contrast ${contrastRatio(foreground, shownBackground).toFixed(1)}:1 against the background is below 4.5:1, so the theme text colour is used.`,
    );
  } else if (inForce.background && contrastRatio(shownForeground, shownBackground) < 4.5) {
    warnings.push(`Contrast ratio ${contrastRatio(shownForeground, shownBackground).toFixed(1)}:1 is below 4.5:1.`);
  }
  if (background && !inForce.background) {
    warnings.push(`This background is ${lightness(background)} on the ${theme} theme, so it is not used. Pick a ${theme} one or switch the appearance.`);
  }
  if (accent && !inForce.accent) {
    warnings.push(
      `Accent contrast ${contrastRatio(accent, shownBackground).toFixed(1)}:1 against the background is below 3:1, so the theme accent is used.`,
    );
  }
  if (inForce.background && FIXED_INKS[theme].some(ink => contrastRatio(ink, shownBackground) < 4.5)) {
    warnings.push("Muted and status text may be hard to read on this background.");
  }
  return warnings;
}

/**
 * The custom colours that suit the theme in force. The theme's other inks (muted text, state colours, panel mixes)
 * stay fixed, so a colour from the opposite theme would leave them unreadable: a background must be dark on the dark
 * theme and light on the light one, a foreground must keep 4.5:1 and an accent 3:1 against the background shown.
 * This matters most for the system theme, where one saved colour set meets both appearances; a colour that does not
 * fit is left out and the theme default shows instead.
 */
export function themeColorsInForce(
  settings: Pick<AppSettings, "appearance" | "accent_color" | "background_color" | "foreground_color">,
): { accent: string | null; background: string | null; foreground: string | null } {
  const theme = resolvedThemeClass(settings.appearance);
  const isLight = (hex: string) => relativeLuminance(hex) > LIGHT_BACKGROUND_LUMINANCE;
  const background = isValidThemeHex(settings.background_color) && isLight(settings.background_color!) === (theme === "light")
    ? settings.background_color!
    : null;
  const effectiveBackground = background ?? THEME_COLOR_DEFAULTS[theme].background;
  const foreground = isValidThemeHex(settings.foreground_color) && contrastRatio(settings.foreground_color!, effectiveBackground) >= 4.5
    ? settings.foreground_color!
    : null;
  const accent = isValidThemeHex(settings.accent_color) && contrastRatio(settings.accent_color!, effectiveBackground) >= 3
    ? settings.accent_color!
    : null;
  return { accent, background, foreground };
}

let stopWatchingColorScheme: (() => void) | null = null;

export function applyThemeSettings(settings: AppSettings): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", settings.appearance);
  const appFontSize = normalizeAppFontSize(settings.app_font_size);
  root.setAttribute("data-app-font-size", appFontSize);
  root.style.setProperty("--app-font-size", appFontSizePx(appFontSize));
  root.style.setProperty("--app-font-scale", "1");
  applyMotionSetting(settings.motion);

  // Which custom colours fit depends on the resolved theme: the system theme re-applies them when macOS switches.
  stopWatchingColorScheme?.();
  stopWatchingColorScheme = null;
  applyThemeColors(settings);
  if (settings.appearance === "system") {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (query?.addEventListener) {
      const reapply = () => applyThemeColors(settings);
      query.addEventListener("change", reapply);
      stopWatchingColorScheme = () => query.removeEventListener("change", reapply);
    }
  }
}

function applyThemeColors(settings: AppSettings): void {
  const root = document.documentElement;
  const { accent, background, foreground } = themeColorsInForce(settings);

  if (accent) {
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-rgb", hexToRgb(accent));
    root.style.setProperty("--inv-fg", inverseForeground(accent));
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-rgb");
    root.style.removeProperty("--inv-fg");
  }

  if (background) {
    root.style.setProperty("--custom-bg", background);
    root.style.setProperty("--bg", background);
  } else {
    root.style.removeProperty("--custom-bg");
    root.style.removeProperty("--bg");
  }

  if (foreground) {
    root.style.setProperty("--custom-text", foreground);
    root.style.setProperty("--text", foreground);
    root.style.setProperty("--text-heading", foreground);
  } else {
    root.style.removeProperty("--custom-text");
    root.style.removeProperty("--text");
    root.style.removeProperty("--text-heading");
  }
}
