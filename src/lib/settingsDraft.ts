import type { AppSettings } from "../types";

/** AppSettings persistence state for autosave UI. */
export type SettingsSaveStatus = "saved" | "pending" | "saving" | "error";

export const SETTINGS_AUTOSAVE_DEBOUNCE_MS = 600;

export const DEFAULT_TARGET_IDS = ["codex_rules", "opencode_rules", "auggie_rules", "opencode_config"];

/** Canonical installed workspace path (display form; backend owns resolution). */
export const DEFAULT_WORKSPACE_PATH = "~/.config/agent-workspace";

export function defaultSettings(): AppSettings {
  return {
    appearance: "dark",
    workspace_path: null,
    enabled_target_ids: DEFAULT_TARGET_IDS,
    accent_color: null,
    background_color: null,
    foreground_color: null,
  };
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

export function hasPoorContrast(foreground: string | null, background: string | null): boolean {
  if (!foreground || !background) return false;
  if (!isValidThemeHex(foreground) || !isValidThemeHex(background)) return false;
  return contrastRatio(foreground, background) < 4.5;
}

export function applyThemeSettings(settings: AppSettings): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", settings.appearance);

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
