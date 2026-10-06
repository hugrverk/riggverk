/**
 * Pure key-spec parsing and matching. No DOM, no React.
 *
 * Specs: "j", "G", "?", "Escape", "Shift+Tab", "Mod+s", "Ctrl+n", "g g" (chord).
 * - Matching uses `event.key` only (never `code`) so Nordic layouts work: `/`, `:` and `?`
 *   arrive as those characters whatever the physical key is.
 * - `Mod` is Cmd on macOS and Ctrl elsewhere. `Alt` is rejected: Option types characters on
 *   Nordic Mac keyboards, so no binding may depend on it.
 */

export type Platform = "mac" | "other";

export interface KeyStep {
  /** Normalised `event.key` value ("j", "Enter", "ArrowDown", " "). */
  key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
  /** Explicit Ctrl on every platform (command-line Ctrl-n / Ctrl-p). */
  ctrl: boolean;
  shift: boolean;
}

export type KeyChord = KeyStep[];

/** The subset of KeyboardEvent the matcher reads (lets tests and the chord buffer use plain objects). */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const CHORD_TIMEOUT_MS = 800;

/** The only combos that may use Cmd/Ctrl (conflict rule 3). Everything else with Cmd/Ctrl held is left to the OS/webview. */
export const MOD_ALLOWLIST: readonly string[] = ["Mod+s", "Mod+k", "Mod+,"];

const NAMED_KEYS: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: " ",
  spacebar: " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  plus: "+",
};

const MODIFIER_KEYS = new Set(["Shift", "Control", "Meta", "Alt", "AltGraph", "CapsLock", "NumLock", "Fn", "Hyper", "Super", "OS"]);

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const source = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(source) ? "mac" : "other";
}

function normaliseKeyName(token: string, spec: string): string {
  if (token.length === 1) return token;
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-2])$/i.test(token)) return token.toUpperCase();
  throw new Error(`Unknown key "${token}" in key spec "${spec}"`);
}

function parseStep(raw: string, spec: string): KeyStep {
  let modifierPart = "";
  let keyPart = raw;
  if (raw === "+") {
    keyPart = "+";
  } else if (raw.endsWith("++")) {
    modifierPart = raw.slice(0, -2);
    keyPart = "+";
  } else {
    const idx = raw.lastIndexOf("+");
    if (idx > 0) {
      modifierPart = raw.slice(0, idx);
      keyPart = raw.slice(idx + 1);
    }
  }
  const step: KeyStep = { key: "", mod: false, ctrl: false, shift: false };
  for (const modifier of modifierPart.split("+").filter(Boolean)) {
    switch (modifier.toLowerCase()) {
      case "mod": step.mod = true; break;
      case "ctrl":
      case "control": step.ctrl = true; break;
      case "shift": step.shift = true; break;
      default:
        throw new Error(
          `Unsupported modifier "${modifier}" in key spec "${spec}" (use Mod, Ctrl or Shift; Alt/Option and Cmd are not bindable)`,
        );
    }
  }
  if (!keyPart) throw new Error(`Missing key in key spec "${spec}"`);
  step.key = normaliseKeyName(keyPart, spec);
  return step;
}

/** Parses one chord spec ("g g", "Mod+s") into steps. */
export function parseChord(spec: string): KeyChord {
  const tokens = spec.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("Empty key spec");
  return tokens.map(token => parseStep(token, spec));
}

/** Parses the `keys` field of a binding: one spec or several alternatives. */
export function parseKeys(keys: string | readonly string[]): KeyChord[] {
  return (typeof keys === "string" ? [keys] : [...keys]).map(parseChord);
}

function modifierState(event: KeyEventLike, platform: Platform) {
  return platform === "mac"
    ? { mod: event.metaKey, other: event.ctrlKey }
    : { mod: event.ctrlKey, other: event.metaKey };
}

/** True when the event is exactly the platform modifier plus a key (no Alt, no Shift, no foreign modifier). */
export function isModOnly(event: KeyEventLike, platform: Platform): boolean {
  const { mod, other } = modifierState(event, platform);
  return mod && !other && !event.altKey && !event.shiftKey;
}

/** True for the Cmd/Ctrl combos the app may bind (see MOD_ALLOWLIST). */
export function isAllowedModCombo(event: KeyEventLike, platform: Platform): boolean {
  if (!isModOnly(event, platform)) return false;
  const key = event.key.toLowerCase();
  return MOD_ALLOWLIST.some(spec => {
    const step = parseChord(spec)[0]!;
    return step.key.toLowerCase() === key;
  });
}

export function matchStep(step: KeyStep, event: KeyEventLike, platform: Platform): boolean {
  if (event.altKey) return false;
  const { mod, other } = modifierState(event, platform);
  if (step.mod) {
    if (!mod || other) return false;
  } else if (step.ctrl) {
    if (!event.ctrlKey || event.metaKey) return false;
  } else if (event.metaKey || event.ctrlKey) {
    return false;
  }
  const printable = step.key.length === 1;
  // A printable character already encodes Shift ("G", "?", ":"), so Shift is not compared for it.
  if (!printable && event.shiftKey !== step.shift) return false;
  if (step.mod || step.ctrl) return event.key.toLowerCase() === step.key.toLowerCase();
  return event.key === step.key;
}

/** True when `chord` begins with the given events (full match when lengths are equal). */
export function matchesPrefix(chord: KeyChord, events: readonly KeyEventLike[], platform: Platform): boolean {
  if (chord.length < events.length) return false;
  return events.every((event, index) => matchStep(chord[index]!, event, platform));
}

const SYMBOLS_MAC: Record<string, string> = { mod: "⌘", ctrl: "⌃", shift: "⇧" };

const KEY_LABELS: Record<string, string> = {
  Enter: "↵",
  Escape: "esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Tab: "tab",
  " ": "space",
  Backspace: "⌫",
  Delete: "del",
  PageUp: "pgup",
  PageDown: "pgdn",
  Home: "home",
  End: "end",
};

/** Display text for one step: "⌘S" on macOS, "Ctrl+S" elsewhere, "↵", "esc", "g". */
export function formatStep(step: KeyStep, platform: Platform): string {
  const label = KEY_LABELS[step.key] ?? (step.mod || step.ctrl ? step.key.toUpperCase() : step.key);
  const parts: string[] = [];
  if (platform === "mac") {
    if (step.ctrl) parts.push(SYMBOLS_MAC.ctrl!);
    if (step.shift) parts.push(SYMBOLS_MAC.shift!);
    if (step.mod) parts.push(SYMBOLS_MAC.mod!);
    return parts.join("") + label;
  }
  if (step.mod || step.ctrl) parts.push("Ctrl");
  if (step.shift) parts.push("Shift");
  parts.push(label);
  return parts.join("+");
}

/** Display tokens of one chord, one entry per step ("g g" -> ["g", "g"]). */
export function formatChord(chord: KeyChord, platform: Platform): string[] {
  return chord.map(step => formatStep(step, platform));
}

/** Display tokens for the first key alternative of a `keys` field. */
export function formatKeys(keys: string | readonly string[], platform: Platform): string[] {
  const chords = parseKeys(keys);
  return chords[0] ? formatChord(chords[0], platform) : [];
}

/** Value for aria-keyshortcuts ("Meta+S" / "Control+S", "G"). Chords are not expressible, so only single steps are returned. */
export function ariaKeyShortcuts(keys: string | readonly string[], platform: Platform): string | undefined {
  const parts = parseKeys(keys)
    .filter(chord => chord.length === 1)
    .map(chord => {
      const step = chord[0]!;
      const mods: string[] = [];
      if (step.mod) mods.push(platform === "mac" ? "Meta" : "Control");
      if (step.ctrl) mods.push("Control");
      if (step.shift) mods.push("Shift");
      const key = step.key === " " ? "Space" : step.key.length === 1 ? step.key.toUpperCase() : step.key;
      return [...mods, key].join("+");
    });
  return parts.length > 0 ? parts.join(" ") : undefined;
}
