import { describe, expect, it } from "vitest";
import {
  APP_FONT_SIZE_VALUES,
  appFontSizePx,
  applyThemeSettings,
  defaultSettings,
  normalizeAppFontSize,
} from "./settingsDraft";

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
  it("maps all four settings to pixel sizes", () => {
    expect(appFontSizePx("small")).toBe("13px");
    expect(appFontSizePx("medium")).toBe("15px");
    expect(appFontSizePx("large")).toBe("17px");
    expect(appFontSizePx("extra-large")).toBe("19px");
  });
});

describe("applyThemeSettings", () => {
  it("sets root data attribute and font variable for extra-large", () => {
    applyThemeSettings({ ...defaultSettings(), app_font_size: "extra-large" });
    expect(document.documentElement.getAttribute("data-app-font-size")).toBe("extra-large");
    expect(document.documentElement.style.getPropertyValue("--app-font-size")).toBe("19px");
    expect(document.documentElement.style.getPropertyValue("--app-font-scale")).toBe("1");
  });
});
