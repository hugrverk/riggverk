/** Semantic text tones; each maps to a `.c-*` utility class styled by the token layer. */
export type Tone = "ok" | "warn" | "fail" | "acc" | "dim" | "head";

export function toneClass(tone: Tone | null | undefined): string {
  return tone ? `c-${tone}` : "";
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
