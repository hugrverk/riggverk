import { describe, expect, it } from "vitest";
import { echoOf } from "./echo";
import { parseChord } from "./keymap";
import type { Binding, BindingRun } from "./registry";

function run(overrides: Partial<Binding> & { spec: string }, extra: Partial<BindingRun> = {}): BindingRun {
  const { spec, ...binding } = overrides;
  return {
    binding: { id: "t.update", keys: spec, title: "Update", scope: "global", run: () => {}, ...binding },
    chord: parseChord(spec),
    source: "key",
    editable: false,
    repeat: false,
    ...extra,
  };
}

describe("echoOf", () => {
  it("echoes a hinted binding with its key caps and hint", () => {
    expect(echoOf(run({ spec: "u", hint: "update" }), "other")).toEqual({ keys: ["u"], label: "update" });
  });

  it("formats modifier chords for the platform", () => {
    const save = run({ spec: "Mod+s", hint: "save" });
    expect(echoOf(save, "mac")).toEqual({ keys: ["⌘S"], label: "save" });
    expect(echoOf(save, "other")).toEqual({ keys: ["Ctrl+S"], label: "save" });
  });

  it("has nothing to say for a binding without a hint", () => {
    expect(echoOf(run({ spec: "3" }), "other")).toBeNull();
    expect(echoOf(run({ spec: "Escape" }), "other")).toBeNull();
  });

  it.each(["j", "k", "h", "l", "ArrowDown", "PageUp", "G", "["])("skips the movement key %s when it is pressed", key => {
    expect(echoOf(run({ spec: key, hint: "next" }), "other")).toBeNull();
  });

  it("echoes a click on a movement hint", () => {
    expect(echoOf(run({ spec: "j", hint: "next" }, { source: "click" }), "other")).toEqual({ keys: ["j"], label: "next" });
  });

  it("skips typing, auto-repeat and the overlay openers", () => {
    expect(echoOf(run({ spec: "u", hint: "update" }, { editable: true }), "other")).toBeNull();
    expect(echoOf(run({ spec: "u", hint: "update" }, { repeat: true }), "other")).toBeNull();
    expect(echoOf(run({ spec: ":", hint: "command", id: "shell.command" }), "other")).toBeNull();
    expect(echoOf(run({ spec: "?", hint: "help", id: "shell.help" }, { source: "click" }), "other")).toBeNull();
  });
});
