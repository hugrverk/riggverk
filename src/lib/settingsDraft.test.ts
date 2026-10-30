import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_FONT_SIZE_VALUES,
  appFontSizePx,
  applyThemeSettings,
  DEFAULT_TARGET_IDS,
  defaultSettings,
  inverseForeground,
  normalizeAppFontSize,
  themeAccentDefault,
  themeColorDefaults,
  themeColorWarnings,
} from "./settingsDraft";

describe("defaultSettings", () => {
  it("enables every harness by default", () => {
    expect(defaultSettings().enabled_harness_ids).toEqual([
      "codex",
      "opencode",
      "claude",
      "cursor",
    ]);
  });

  it("enables every rules, agents, config and MCP target except codex_config, kilo_mcp and antigravity_mcp", () => {
    expect(defaultSettings().enabled_target_ids).toBe(DEFAULT_TARGET_IDS);
    expect([...DEFAULT_TARGET_IDS].sort()).toEqual([
      "antigravity_rules",
      "claude_agents",
      "claude_rules",
      "codex_agents",
      "codex_rules",
      "copilot_mcp",
      "copilot_rules",
      "cursor_setup",
      "kilo_rules",
      "opencode_agents",
      "opencode_config",
      "opencode_rules",
      "pi_mcp",
      "pi_rules",
    ]);
    expect(DEFAULT_TARGET_IDS).not.toContain("codex_config");
    expect(DEFAULT_TARGET_IDS).not.toContain("kilo_mcp");
    expect(DEFAULT_TARGET_IDS).not.toContain("antigravity_mcp");
  });
});

describe("normalizeAppFontSize", () => {
  it("accepts all four persisted values", () => {
    for (const size of APP_FONT_SIZE_VALUES) {
      expect(normalizeAppFontSize(size)).toBe(size);
    }
  });

  it("normalizes invalid values to medium", () => {
    expect(normalizeAppFontSize("huge")).toBe("medium");
    expect(normalizeAppFontSize(undefined)).toBe("medium");
  });
});

describe("appFontSizePx", () => {
  it("maps all four settings to the 12/13/15/17 scale", () => {
    expect(appFontSizePx("small")).toBe("12px");
    expect(appFontSizePx("medium")).toBe("13px");
    expect(appFontSizePx("large")).toBe("15px");
    expect(appFontSizePx("extra-large")).toBe("17px");
  });
});

describe("applyThemeSettings", () => {
  it("sets root data attribute and font variable for extra-large", () => {
    applyThemeSettings({ ...defaultSettings(), app_font_size: "extra-large" });
    expect(document.documentElement.getAttribute("data-app-font-size")).toBe("extra-large");
    expect(document.documentElement.style.getPropertyValue("--app-font-size")).toBe("17px");
    expect(document.documentElement.style.getPropertyValue("--app-font-scale")).toBe("1");
  });

  it("does not apply root zoom", () => {
    applyThemeSettings(defaultSettings());
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
    expect(document.documentElement.style.getPropertyValue("transform")).toBe("");
  });

  it("sets a readable inverse foreground for a custom accent and clears it otherwise", () => {
    applyThemeSettings({ ...defaultSettings(), accent_color: "#ffe066" });
    expect(document.documentElement.style.getPropertyValue("--inv-fg")).toBe("#111111");
    applyThemeSettings({ ...defaultSettings(), accent_color: "#0b5fa5" });
    expect(document.documentElement.style.getPropertyValue("--inv-fg")).toBe("#ffffff");
    applyThemeSettings({ ...defaultSettings(), accent_color: null });
    expect(document.documentElement.style.getPropertyValue("--inv-fg")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });
});

describe("inverseForeground", () => {
  it("picks the foreground with the higher contrast against the accent", () => {
    expect(inverseForeground("#7fb7ff")).toBe("#111111");
    expect(inverseForeground("#1b6f33")).toBe("#ffffff");
  });
});

describe("themeColorDefaults", () => {
  const tokens = readFileSync(resolve(import.meta.dirname, "../styles/_tokens.scss"), "utf8");
  const token = (block: RegExp, name: string) => tokens.match(block)![0].match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))![1]!;
  const dark = /:root\s*\{[^}]*\}/;
  const light = /\[data-theme="light"\]\s*\{[^}]*\}/;

  it("matches --bg and --text in the token sheet for both themes", () => {
    expect(themeColorDefaults("dark")).toEqual({ background: token(dark, "--bg"), foreground: token(dark, "--text") });
    expect(themeColorDefaults("light")).toEqual({ background: token(light, "--bg"), foreground: token(light, "--text") });
  });
});

describe("themeAccentDefault", () => {
  const tokens = readFileSync(resolve(import.meta.dirname, "../styles/_tokens.scss"), "utf8");
  const dark = tokens.match(/:root\s*\{[^}]*?--accent:\s*(#[0-9a-f]{6})/i)![1]!;
  const light = tokens.match(/\[data-theme="light"\]\s*\{[^}]*?--accent:\s*(#[0-9a-f]{6})/i)![1]!;

  it("matches the accent in the token sheet for both themes", () => {
    expect(dark).not.toBe(light);
    expect(themeAccentDefault("dark")).toBe(dark);
    expect(themeAccentDefault("light")).toBe(light);
  });

  it("follows the system colour scheme for the system theme", () => {
    const original = window.matchMedia;
    const prefersLight = (matches: boolean) =>
      ((query: string) => ({ matches: query.includes("light") && matches, media: query })) as unknown as typeof window.matchMedia;
    try {
      window.matchMedia = prefersLight(true);
      expect(themeAccentDefault("system")).toBe(light);
      window.matchMedia = prefersLight(false);
      expect(themeAccentDefault("system")).toBe(dark);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("typography inheritance", () => {
  it("maps all four settings to distinct root font sizes", () => {
    for (const [size, px] of [
      ["small", "12px"],
      ["medium", "13px"],
      ["large", "15px"],
      ["extra-large", "17px"],
    ] as const) {
      applyThemeSettings({ ...defaultSettings(), app_font_size: size });
      expect(document.documentElement.style.getPropertyValue("--app-font-size")).toBe(px);
    }
  });
});

describe("themeColorWarnings", () => {
  const none = { foreground: null, background: null, accent: null };

  it("is silent for the theme defaults and a readable same-class pair", () => {
    expect(themeColorWarnings({ appearance: "dark", ...none })).toEqual([]);
    expect(themeColorWarnings({ appearance: "dark", foreground: "#ffffff", background: "#000000", accent: null })).toEqual([]);
    expect(themeColorWarnings({ appearance: "light", foreground: "#111111", background: "#ffffff", accent: null })).toEqual([]);
  });

  it("warns when foreground and background are below 4.5:1", () => {
    const [warning] = themeColorWarnings({ appearance: "dark", foreground: "#777777", background: "#808080", accent: null });
    expect(warning).toContain("below 4.5:1");
  });

  it("warns when the accent is below 3:1 against the background", () => {
    const warnings = themeColorWarnings({ appearance: "dark", foreground: null, background: null, accent: "#222224" });
    expect(warnings.join(" ")).toContain("below 3:1");
    expect(themeColorWarnings({ appearance: "dark", foreground: null, background: null, accent: "#7d9cc4" })).toEqual([]);
  });

  it("warns when a custom background is the opposite luminance class of the theme", () => {
    const warnings = themeColorWarnings({ appearance: "dark", foreground: "#111111", background: "#ffffff", accent: null });
    expect(warnings.join(" ")).toContain("light on the dark theme");
  });

  it("warns when the fixed muted and status inks do not read on a same-class background", () => {
    const warnings = themeColorWarnings({ appearance: "dark", foreground: "#ffffff", background: "#5a5a60", accent: null });
    expect(warnings.join(" ")).toContain("Muted and status text");
  });
});
