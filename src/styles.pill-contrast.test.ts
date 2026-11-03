import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(resolve(import.meta.dirname, "styles/_tokens.scss"), "utf8");
const styles = readFileSync(resolve(import.meta.dirname, "styles/_overview.scss"), "utf8");
type Color = [number, number, number];

function declarations(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}

function mix(a: Color, b: Color, weight: number): Color {
  return a.map((channel, i) => channel * weight + b[i] * (1 - weight)) as Color;
}

function color(value: string, vars: Map<string, string>, surface: Color = [0, 0, 0]): Color {
  const reference = value.match(/^var\((--[\w-]+)(?:, (.+))?\)$/);
  if (reference) {
    const resolved = vars.get(reference[1]) ?? reference[2];
    if (!resolved) throw new Error(`Missing token ${reference[1]}`);
    return color(resolved, vars, surface);
  }
  const mixed = value.match(/^color-mix\(in srgb, (var\(--[\w-]+\)) ([\d.]+)%, (white|black|transparent)\)$/);
  if (mixed) return mix(color(mixed[1], vars, surface), color(mixed[3], vars, surface), Number(mixed[2]) / 100);
  if (value === "transparent") return surface;
  if (value === "white") return [255, 255, 255];
  if (value === "black") return [0, 0, 0];
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error(`Unsupported color: ${value}`);
  return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as Color;
}

function contrast(a: Color, b: Color): number {
  const luminance = (rgb: Color) => rgb.reduce((sum, channel, i) => {
    const c = channel / 255;
    return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light + 0.05) / (dark + 0.05);
}

const root = declarations(tokens.match(/:root\s*\{([^}]+)\}/)![1]);
const theme = (selector: string) => new Map([...root, ...declarations(tokens.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`))![1])]);
const themes = {
  dark: root,
  light: theme('\\[data-theme="light"\\]'),
  systemLight: theme('\\[data-theme="system"\\]'),
};

describe("status pill contrast", () => {
  for (const [name, vars] of Object.entries(themes)) {
    for (const tone of ["ok", "ready", "yours", "fix", "off", "tip", "decide"]) {
      for (const surface of ["--bg", "--bg-panel", "--bg-raised"]) {
        it(`${name} ${tone} on ${surface}`, () => {
          const rule = styles.match(new RegExp(`\\.state-pill\\.is-${tone}\\s*\\{([^}]+)\\}`))![1];
          const ink = rule.match(/(?:^|;)\s*color:\s*([^;]+)/)![1].trim();
          const background = rule.match(/(?:^|;)\s*background:\s*([^;]+)/)![1].trim();
          const base = color(`var(${surface})`, vars);
          const ratio = contrast(color(ink, vars), color(background, vars, base));
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});
