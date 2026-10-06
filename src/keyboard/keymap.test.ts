import { describe, expect, it } from "vitest";
import {
  ariaKeyShortcuts,
  formatKeys,
  isAllowedModCombo,
  matchesPrefix,
  matchStep,
  parseChord,
  parseKeys,
  type KeyEventLike,
} from "./keymap";

function ev(key: string, mods: Partial<Omit<KeyEventLike, "key">> = {}): KeyEventLike {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("parseChord", () => {
  it("parses single keys, named keys and aliases", () => {
    expect(parseChord("j")).toEqual([{ key: "j", mod: false, ctrl: false, shift: false }]);
    expect(parseChord("Esc")[0]!.key).toBe("Escape");
    expect(parseChord("Space")[0]!.key).toBe(" ");
    expect(parseChord("Down")[0]!.key).toBe("ArrowDown");
    expect(parseChord("PageUp")[0]!.key).toBe("PageUp");
  });

  it("parses modifiers and the plus key", () => {
    expect(parseChord("Mod+s")[0]).toMatchObject({ key: "s", mod: true });
    expect(parseChord("Mod+,")[0]).toMatchObject({ key: ",", mod: true });
    expect(parseChord("Shift+Tab")[0]).toMatchObject({ key: "Tab", shift: true });
    expect(parseChord("Ctrl+n")[0]).toMatchObject({ key: "n", ctrl: true });
    expect(parseChord("Mod++")[0]).toMatchObject({ key: "+", mod: true });
  });

  it("parses chords as ordered steps", () => {
    expect(parseChord("g g").map(step => step.key)).toEqual(["g", "g"]);
  });

  it("rejects Alt/Option and Cmd/Meta (Nordic layouts type characters with Option; use Mod)", () => {
    expect(() => parseChord("Alt+x")).toThrow(/Alt/);
    expect(() => parseChord("Option+x")).toThrow();
    expect(() => parseChord("Cmd+x")).toThrow();
    expect(() => parseChord("Meta+x")).toThrow();
  });

  it("rejects unknown named keys and empty specs", () => {
    expect(() => parseChord("Banana")).toThrow(/Unknown key/);
    expect(() => parseChord("   ")).toThrow();
  });

  it("parseKeys accepts alternatives", () => {
    expect(parseKeys(["j", "ArrowDown"]).map(chord => chord[0]!.key)).toEqual(["j", "ArrowDown"]);
  });
});

describe("matchStep", () => {
  it("matches on event.key, never on code", () => {
    const step = parseChord("/")[0]!;
    expect(matchStep(step, ev("/"), "other")).toBe(true);
    expect(matchStep(step, { ...ev("7"), shiftKey: true }, "other")).toBe(false);
  });

  it("matches shifted printable characters without comparing Shift (Nordic layouts need Shift for / : ?)", () => {
    expect(matchStep(parseChord("?")[0]!, ev("?", { shiftKey: true }), "other")).toBe(true);
    expect(matchStep(parseChord(":")[0]!, ev(":", { shiftKey: true }), "mac")).toBe(true);
    expect(matchStep(parseChord("G")[0]!, ev("G", { shiftKey: true }), "other")).toBe(true);
    expect(matchStep(parseChord("g")[0]!, ev("G", { shiftKey: true }), "other")).toBe(false);
  });

  it("compares Shift for named keys", () => {
    expect(matchStep(parseChord("Tab")[0]!, ev("Tab"), "other")).toBe(true);
    expect(matchStep(parseChord("Tab")[0]!, ev("Tab", { shiftKey: true }), "other")).toBe(false);
    expect(matchStep(parseChord("Shift+Tab")[0]!, ev("Tab", { shiftKey: true }), "other")).toBe(true);
  });

  it("maps Mod to Cmd on macOS and Ctrl elsewhere", () => {
    const step = parseChord("Mod+s")[0]!;
    expect(matchStep(step, ev("s", { metaKey: true }), "mac")).toBe(true);
    expect(matchStep(step, ev("s", { ctrlKey: true }), "mac")).toBe(false);
    expect(matchStep(step, ev("s", { ctrlKey: true }), "other")).toBe(true);
    expect(matchStep(step, ev("s", { metaKey: true }), "other")).toBe(false);
    expect(matchStep(step, ev("S", { metaKey: true }), "mac")).toBe(true);
  });

  it("does not match plain keys while Cmd/Ctrl is held, and never while Alt is held", () => {
    const step = parseChord("s")[0]!;
    expect(matchStep(step, ev("s", { metaKey: true }), "mac")).toBe(false);
    expect(matchStep(step, ev("s", { ctrlKey: true }), "other")).toBe(false);
    expect(matchStep(step, ev("s", { altKey: true }), "other")).toBe(false);
  });

  it("explicit Ctrl matches Ctrl on every platform and not Cmd", () => {
    const step = parseChord("Ctrl+n")[0]!;
    expect(matchStep(step, ev("n", { ctrlKey: true }), "mac")).toBe(true);
    expect(matchStep(step, ev("n", { ctrlKey: true }), "other")).toBe(true);
    expect(matchStep(step, ev("n", { metaKey: true }), "mac")).toBe(false);
  });
});

describe("matchesPrefix (chords)", () => {
  const chord = parseChord("g g");

  it("reports prefix and full matches", () => {
    expect(matchesPrefix(chord, [ev("g")], "other")).toBe(true);
    expect(matchesPrefix(chord, [ev("g"), ev("g")], "other")).toBe(true);
    expect(matchesPrefix(chord, [ev("g"), ev("h")], "other")).toBe(false);
    expect(matchesPrefix(chord, [ev("g"), ev("g"), ev("g")], "other")).toBe(false);
  });
});

describe("isAllowedModCombo", () => {
  it("allows only Mod+s, Mod+k and Mod+,", () => {
    expect(isAllowedModCombo(ev("s", { metaKey: true }), "mac")).toBe(true);
    expect(isAllowedModCombo(ev("k", { ctrlKey: true }), "other")).toBe(true);
    expect(isAllowedModCombo(ev(",", { metaKey: true }), "mac")).toBe(true);
  });

  it.each(["q", "w", "m", "h", "c", "v", "x", "a", "z", "r", "n", "t", "f", "1"])(
    "never claims Cmd+%s (reserved by macOS/the webview)",
    key => {
      expect(isAllowedModCombo(ev(key, { metaKey: true }), "mac")).toBe(false);
    },
  );

  it("rejects the foreign modifier, Shift and Alt", () => {
    expect(isAllowedModCombo(ev("s", { ctrlKey: true }), "mac")).toBe(false);
    expect(isAllowedModCombo(ev("s", { metaKey: true, shiftKey: true }), "mac")).toBe(false);
    expect(isAllowedModCombo(ev("s", { metaKey: true, altKey: true }), "mac")).toBe(false);
  });
});

describe("formatting", () => {
  it("formats Mod per platform", () => {
    expect(formatKeys("Mod+s", "mac")).toEqual(["⌘S"]);
    expect(formatKeys("Mod+s", "other")).toEqual(["Ctrl+S"]);
    expect(formatKeys("Mod+,", "mac")).toEqual(["⌘,"]);
  });

  it("formats named keys and chords", () => {
    expect(formatKeys("Enter", "other")).toEqual(["↵"]);
    expect(formatKeys("Escape", "other")).toEqual(["esc"]);
    expect(formatKeys("g g", "other")).toEqual(["g", "g"]);
    expect(formatKeys(["j", "ArrowDown"], "other")).toEqual(["j"]);
  });

  it("builds aria-keyshortcuts for single-step bindings only", () => {
    expect(ariaKeyShortcuts("1", "mac")).toBe("1");
    expect(ariaKeyShortcuts("Mod+k", "mac")).toBe("Meta+K");
    expect(ariaKeyShortcuts("Mod+k", "other")).toBe("Control+K");
    expect(ariaKeyShortcuts("g g", "mac")).toBeUndefined();
  });
});
