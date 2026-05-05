import type { AppSettings } from "../types";

export const DEFAULT_TARGET_IDS = ["codex_rules", "opencode_rules", "auggie_rules", "opencode_config"];

export function defaultSettings(): AppSettings {
  return {
    appearance: "dark",
    workspace_path: null,
    enabled_target_ids: DEFAULT_TARGET_IDS,
    accent_color: null,
  };
}

export function serializeSettingsForCompare(settings: AppSettings): string {
  return JSON.stringify(settings);
}

const ACCENT_HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

export function isValidAccentHex(v: string | null | undefined): boolean {
  return !!v && ACCENT_HEX_RE.test(v);
}

export function applyThemeSettings(settings: AppSettings): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", settings.appearance);

  if (settings.accent_color && ACCENT_HEX_RE.test(settings.accent_color)) {
    root.style.setProperty("--accent", settings.accent_color);
    root.style.setProperty("--accent-rgb", hexToRgb(settings.accent_color));
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-rgb");
  }
}
