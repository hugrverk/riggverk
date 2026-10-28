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

export function themeColorDefaults(appearance: AppSettings["appearance"]): {
  background: string;
  foreground: string;
} {
  switch (appearance) {
    case "light":
      return { background: "#f5f5f7", foreground: "#1d1d1f" };
    case "dark":
      return { background: "#1e1e20", foreground: "#e6e6e8" };
    case "system":
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? { background: "#1e1e20", foreground: "#e6e6e8" }
        : { background: "#f5f5f7", foreground: "#1d1d1f" };
  }
}

/**
 * Accent when no override is set. Mirrors `--accent` in _tokens.scss (the dark `:root` block and the paper
 * `[data-theme="light"]` block); settingsDraft.test.ts fails when they drift apart.
 */
const ACCENT_DEFAULTS = { dark: "#7d9cc4", light: "#3f6ea8" } as const;

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

export function hasPoorContrast(foreground: string | null, background: string | null): boolean {
  if (!foreground || !background) return false;
  if (!isValidThemeHex(foreground) || !isValidThemeHex(background)) return false;
  return contrastRatio(foreground, background) < 4.5;
}

export function applyThemeSettings(settings: AppSettings): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", settings.appearance);
  const appFontSize = normalizeAppFontSize(settings.app_font_size);
  root.setAttribute("data-app-font-size", appFontSize);
  root.style.setProperty("--app-font-size", appFontSizePx(appFontSize));
  root.style.setProperty("--app-font-scale", "1");
  applyMotionSetting(settings.motion);

  if (settings.accent_color && THEME_HEX_RE.test(settings.accent_color)) {
    root.style.setProperty("--accent", settings.accent_color);
    root.style.setProperty("--accent-rgb", hexToRgb(settings.accent_color));
    root.style.setProperty("--inv-fg", inverseForeground(settings.accent_color));
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-rgb");
    root.style.removeProperty("--inv-fg");
  }

  if (settings.background_color && THEME_HEX_RE.test(settings.background_color)) {
    root.style.setProperty("--custom-bg", settings.background_color);
    root.style.setProperty("--bg", settings.background_color);
  } else {
    root.style.removeProperty("--custom-bg");
    root.style.removeProperty("--bg");
  }

  if (settings.foreground_color && THEME_HEX_RE.test(settings.foreground_color)) {
    root.style.setProperty("--custom-text", settings.foreground_color);
    root.style.setProperty("--text", settings.foreground_color);
    root.style.setProperty("--text-heading", settings.foreground_color);
  } else {
    root.style.removeProperty("--custom-text");
    root.style.removeProperty("--text");
    root.style.removeProperty("--text-heading");
  }
}
