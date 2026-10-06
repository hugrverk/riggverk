import { describe, expect, it } from "vitest";
import {
  APP_FONT_SIZE_VALUES,
  appFontSizePx,
  applyThemeSettings,
  DEFAULT_TARGET_IDS,
  defaultSettings,
  inverseForeground,
  normalizeAppFontSize,
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

  it("enables every rules, agents and config target except codex_config", () => {
    expect(defaultSettings().enabled_target_ids).toBe(DEFAULT_TARGET_IDS);
    expect([...DEFAULT_TARGET_IDS].sort()).toEqual([
      "claude_agents",
      "claude_rules",
      "codex_agents",
      "codex_rules",
      "cursor_setup",
      "opencode_agents",
      "opencode_config",
      "opencode_rules",
    ]);
    expect(DEFAULT_TARGET_IDS).not.toContain("codex_config");
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
