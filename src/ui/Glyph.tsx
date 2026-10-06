import { cx, toneClass, type Tone } from "./tone";

export const GLYPHS = {
  ok: "●",
  partial: "◐",
  fail: "✗",
  none: "·",
  cursor: "▸",
  prompt: "❯",
  check: "✓",
  add: "+",
  change: "~",
  remove: "−",
  conflict: "!",
} as const;

export type GlyphName = keyof typeof GLYPHS;

interface GlyphProps {
  name: GlyphName;
  tone?: Tone;
  /** Accessible text. Without it the glyph is decorative (aria-hidden) and must be paired with visible text. */
  label?: string;
  className?: string;
}

/**
 * One fixed-width cell (`.g`) for symbols the monospace face lacks (▸ ● ◐ ✓ ✗ ❯). Never rely on the
 * glyph or its colour alone: either pass `label` or render a text label next to it.
 */
export function Glyph({ name, tone, label, className }: GlyphProps) {
  return (
    <span
      className={cx("g", toneClass(tone), className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {GLYPHS[name]}
    </span>
  );
}
