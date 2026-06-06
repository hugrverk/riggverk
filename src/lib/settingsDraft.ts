import type { AppSettings } from "../types";

/** AppSettings persistence state for autosave UI. */
export type SettingsSaveStatus = "saved" | "pending" | "saving" | "error";

export const SETTINGS_AUTOSAVE_DEBOUNCE_MS = 600;

export const DEFAULT_TARGET_IDS = ["codex_rules", "opencode_rules", "opencode_config"];
export const APP_FONT_SIZE_VALUES = ["small", "medium", "large"] as const;

/** Canonical installed workspace path (display form; backend owns resolution). */
export const DEFAULT_WORKSPACE_PATH = "~/.config/agent-workspace";

export function defaultSettings(): AppSettings {
  return {
    appearance: "dark",
    app_font_size: "medium",
    workspace_path: null,
    enabled_target_ids: DEFAULT_TARGET_IDS,
    accent_color: null,
    background_color: null,
    foreground_color: null,
    repo_dashboard_entries: [],
    active_repo_dashboard_id: null,
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
      return { background: "#f5f5f5", foreground: "#1a1a1a" };
    case "dark":
      return { background: "#212121", foreground: "#e0e0e0" };
    case "system":
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? { background: "#212121", foreground: "#e0e0e0" }
        : { background: "#f5f5f5", foreground: "#1a1a1a" };
  }
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
  root.style.setProperty(
    "--app-font-size",
    appFontSize === "small" ? "13px" : appFontSize === "large" ? "17px" : "15px",
  );
  root.style.setProperty("--app-font-scale", "1");

  if (settings.accent_color && THEME_HEX_RE.test(settings.accent_color)) {
    root.style.setProperty("--accent", settings.accent_color);
    root.style.setProperty("--accent-rgb", hexToRgb(settings.accent_color));
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-rgb");
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
