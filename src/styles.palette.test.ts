import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Resolves the palette tokens in _tokens.scss (hex, var() references and the
 * color-mix(in srgb, X P%, white|black) surfaces) and asserts WCAG AA contrast
 * for both themes: 4.5:1 for text colours on every surface, 3:1 for strong borders.
 */

const tokens = readFileSync(resolve(import.meta.dirname, "styles", "_tokens.scss"), "utf8");

type Rgb = [number, number, number];
type Declarations = Map<string, string>;

function declarations(blockRe: RegExp): Declarations {
  const match = tokens.match(blockRe);
  expect(match, `block ${blockRe}`).not.toBeNull();
  const decls = new Map<string, string>();
  for (const line of match![1].split("\n")) {
    const decl = line.match(/^\s*(--[\w-]+):\s*(.+?);\s*$/);
    if (decl) decls.set(decl[1], decl[2].trim());
  }
  return decls;
}

const dark = declarations(/:root\s*\{([^}]+)\}/);
const light = declarations(/\[data-theme="light"\]\s*\{([^}]+)\}/);
const systemLight = declarations(
  /@media \(prefers-color-scheme: light\)\s*\{\s*\[data-theme="system"\]\s*\{([^}]+)\}/,
);

const NAMED: Record<string, Rgb> = { white: [255, 255, 255], black: [0, 0, 0] };

function parseHex(hex: string): Rgb {
  return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map(part => parseInt(part, 16)) as Rgb;
}

function resolveValue(value: string, theme: Declarations, depth = 0): Rgb {
  if (depth > 10) throw new Error(`token cycle while resolving ${value}`);
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return parseHex(trimmed);
  if (trimmed in NAMED) return NAMED[trimmed];
  const ref = trimmed.match(/^var\((--[\w-]+)\)$/);
  if (ref) return resolveToken(ref[1], theme, depth + 1);
  const mix = trimmed.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+?)\)$/);
  if (mix) {
    const a = resolveValue(mix[1], theme, depth + 1);
    const b = resolveValue(mix[3], theme, depth + 1);
    const p = Number(mix[2]) / 100;
    return a.map((channel, i) => Math.round(channel * p + b[i] * (1 - p))) as Rgb;
  }
  throw new Error(`unsupported colour value: ${value}`);
}

function resolveToken(name: string, theme: Declarations, depth = 0): Rgb {
  const value = theme.get(name) ?? dark.get(name);
  if (value === undefined) throw new Error(`missing token ${name}`);
  return resolveValue(value, theme, depth);
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function hueSaturation([r, g, b]: Rgb): [number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return [0, 0];
  const l = (max + min) / 2;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, sat];
}

const SURFACES = ["--bg", "--bg-panel", "--bg-raised", "--bg-inset"];
const TEXT_TOKENS = [
  "--text",
  "--text-muted",
  "--text-heading",
  "--accent",
  "--ok",
  "--warn",
  "--fail",
  "--ready",
  "--yours",
  "--fix",
  "--off",
  "--decide",
];

describe.each([
  ["dark", dark],
  ["light", light],
  ["system-light", systemLight],
])("%s palette", (_name, theme) => {
  it.each(TEXT_TOKENS)("%s reads at 4.5:1 on every surface", token => {
    for (const surface of SURFACES) {
      const ratio = contrast(resolveToken(token, theme), resolveToken(surface, theme));
      expect(ratio, `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps --border-strong at 3:1 on every surface (input and key-cap borders)", () => {
    for (const surface of SURFACES) {
      const ratio = contrast(resolveToken("--border-strong", theme), resolveToken(surface, theme));
      expect(ratio, `--border-strong on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps --primary-fg at 4.5:1 on --primary (filled primary button)", () => {
    const ratio = contrast(resolveToken("--primary-fg", theme), resolveToken("--primary", theme));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("uses no warm hue (ochre/amber) in any text or state token", () => {
    for (const token of [...TEXT_TOKENS, "--dirty", "--primary"]) {
      const [h, s] = hueSaturation(resolveToken(token, theme));
      const warm = h >= 20 && h <= 65 && s >= 0.15;
      expect(warm, `${token} hue ${h.toFixed(0)} sat ${s.toFixed(2)}`).toBe(false);
    }
  });

  it("keeps the inverse pair (active tab, mode badge) at 4.5:1", () => {
    const ratio = contrast(resolveToken("--inv-fg", theme), resolveToken("--inv-bg", theme));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("derives panel and inset from --bg with color-mix", () => {
    expect(theme.get("--bg-panel") ?? dark.get("--bg-panel")).toMatch(/^color-mix\(in srgb, var\(--bg\)/);
    expect(theme.get("--bg-inset") ?? dark.get("--bg-inset")).toMatch(/^color-mix\(in srgb, var\(--bg\)/);
  });
});

describe("theme blocks", () => {
  it("repeats the paper palette identically for data-theme=system under a light OS", () => {
    expect([...systemLight.keys()].sort()).toEqual([...light.keys()].sort());
    for (const [token, value] of light) {
      expect(systemLight.get(token), token).toBe(value);
    }
  });

  it("uses a solid accent focus ring", () => {
    expect(dark.get("--focus-ring")).toBe("var(--accent)");
  });

  it("keeps success distinct from the accent", () => {
    for (const theme of [dark, light]) {
      expect(resolveToken("--ok", theme)).not.toEqual(resolveToken("--accent", theme));
    }
  });
});
