import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyThemeSettings, defaultSettings } from "./lib/settingsDraft";

const stylePartials = [
  "_tokens.scss",
  "_shell.scss",
  "_content.scss",
  "_settings.scss",
  "_targets.scss",
  "_workspace.scss",
  "_library.scss",
  "_tools-prompt.scss",
  "_repo-dashboard.scss",
  "_dialogs.scss",
  "_terminal.scss",
];
const styles = stylePartials
  .map(file => readFileSync(resolve(import.meta.dirname, "styles", file), "utf8"))
  .join("\n");

function rootBlockDeclarations(): Map<string, string> {
  const match = styles.match(/:root\s*\{([^}]+)\}/);
  expect(match).not.toBeNull();
  const declarations = new Map<string, string>();
  for (const line of match![1].split("\n")) {
    const decl = line.match(/^\s*(--[\w-]+):\s*(.+?);\s*$/);
    if (decl) declarations.set(decl[1], decl[2].trim());
  }
  return declarations;
}

function themeHeadingColor(blockSelector: string): string | null {
  const escaped = blockSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{[^}]*--text-heading:\\s*([^;\\s]+)`, "s");
  const match = styles.match(re);
  return match?.[1] ?? null;
}

function systemLightHeadingColor(): string | null {
  const match = styles.match(
    /@media \(prefers-color-scheme: light\)\s*\{\s*\[data-theme="system"\][^}]*--text-heading:\s*([^;\s]+)/s,
  );
  return match?.[1] ?? null;
}

describe("heading typography tokens", () => {
  it("keeps --text-heading as a color token in :root", () => {
    const value = rootBlockDeclarations().get("--text-heading");
    expect(value).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("defines --font-size-heading as a length token in :root", () => {
    const value = rootBlockDeclarations().get("--font-size-heading");
    expect(value).toMatch(/^\d+(\.\d+)?rem$/);
  });

  it("does not assign font-size values to --text-heading", () => {
    const re = /--text-heading:\s*([^;]+);/g;
    for (const match of styles.matchAll(re)) {
      expect(match[1].trim()).not.toMatch(/rem|px|em|%$/);
    }
  });

  it("does not assign color values to --font-size-heading", () => {
    const re = /--font-size-heading:\s*([^;]+);/g;
    for (const match of styles.matchAll(re)) {
      const value = match[1].trim();
      expect(value).not.toMatch(/^#/);
      expect(value).not.toMatch(/^rgba?\(/);
    }
  });

  it("exposes valid heading foreground colors in dark, light, and system-light themes", () => {
    expect(themeHeadingColor(":root")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(themeHeadingColor('[data-theme="light"]')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(systemLightHeadingColor()).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("uses --font-size-heading for semantic heading font sizes", () => {
    expect(styles).toMatch(/font-size:\s*var\(--font-size-heading\)/);
    expect(styles).not.toMatch(/font-size:\s*var\(--text-heading\)/);
  });

  it("does not use root zoom for typography scaling", () => {
    expect(styles).not.toMatch(/^\s*zoom:\s/m);
  });
});

describe("repo chart series tokens", () => {
  function themeBlockDeclarations(blockRe: RegExp): Map<string, string> {
    const match = styles.match(blockRe);
    expect(match).not.toBeNull();
    const declarations = new Map<string, string>();
    for (const line of match![1].split("\n")) {
      const decl = line.match(/^\s*(--[\w-]+):\s*(.+?);\s*$/);
      if (decl) declarations.set(decl[1], decl[2].trim());
    }
    return declarations;
  }

  function relativeLuminance(hex: string): number {
    const channel = (slice: string) => {
      const c = parseInt(slice, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return (
      0.2126 * channel(hex.slice(1, 3)) +
      0.7152 * channel(hex.slice(3, 5)) +
      0.0722 * channel(hex.slice(5, 7))
    );
  }

  function contrast(a: string, b: string): number {
    const l1 = relativeLuminance(a);
    const l2 = relativeLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  const seriesTokens = Array.from({ length: 8 }, (_, i) => `--repo-chart-series-${i + 1}`);

  it("keeps every dark-theme series visible on the dark background", () => {
    const dark = rootBlockDeclarations();
    const bg = dark.get("--bg")!;
    for (const token of seriesTokens) {
      const value = dark.get(token);
      expect(value, token).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrast(value!, bg), `${token} on dark bg`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps every light-theme series visible on the light background", () => {
    const light = themeBlockDeclarations(/\[data-theme="light"\]\s*\{([^}]+)\}/);
    const bg = light.get("--bg")!;
    for (const token of seriesTokens) {
      const value = light.get(token);
      expect(value, token).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrast(value!, bg), `${token} on light bg`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps system-light series identical to the light theme", () => {
    const light = themeBlockDeclarations(/\[data-theme="light"\]\s*\{([^}]+)\}/);
    const systemLight = themeBlockDeclarations(
      /@media \(prefers-color-scheme: light\)\s*\{\s*\[data-theme="system"\]\s*\{([^}]+)\}/,
    );
    for (const token of seriesTokens) {
      expect(systemLight.get(token), token).toBe(light.get(token));
    }
  });
});

describe("applyThemeSettings heading color override", () => {
  it("changes heading color without changing heading font size token", () => {
    applyThemeSettings({ ...defaultSettings(), foreground_color: "#336699" });
    expect(document.documentElement.style.getPropertyValue("--text-heading")).toBe("#336699");
    const fontSizeHeading = rootBlockDeclarations().get("--font-size-heading");
    expect(fontSizeHeading).toMatch(/rem$/);
    expect(document.documentElement.style.getPropertyValue("--font-size-heading")).toBe("");
  });
});
