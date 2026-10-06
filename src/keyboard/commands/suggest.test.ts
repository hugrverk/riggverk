import { describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "./parser";
import { suggest } from "./suggest";

const run = vi.fn();

function commands(): CommandSpec[] {
  return [
    {
      name: "update",
      summary: "preview, then apply managed files",
      args: [
        {
          name: "target",
          kind: "enum",
          values: ["claude", "opencode", "workspace"],
          describe: value => (value === "claude" ? "apply 7 safe, skip 1 conflict" : undefined),
        },
        { name: "all", kind: "flag", description: "every enabled harness" },
      ],
      validate: parsed => (parsed.named.target || parsed.flags.all ? null : "update: name a target or pass --all"),
      run,
    },
    { name: "uninstall", summary: "remove managed files", run },
    { name: "theme", summary: "set appearance", args: [{ name: "mode", kind: "enum", values: ["dark", "light", "system", "toggle"] }], run },
    { name: "release-check", aliases: ["rc"], summary: "run release-check", enabled: () => "no release-check script", run },
    { name: "help", summary: "keyboard help", run },
    {
      name: "library",
      aliases: ["lib"],
      summary: "open the library",
      args: [{ name: "source", kind: "enum", values: ["docs", "skills"], optional: true }, { name: "item", kind: "rest", optional: true }],
      complete: ({ args, partial }) =>
        args[0] === "skills" ? [{ value: "current-docs", description: "skill" }, { value: "tdd" }].filter(item => item.value.includes(partial)) : [],
      run,
    },
  ];
}

const texts = (input: string) => suggest(input, commands()).map(item => item.text);

describe("suggest", () => {
  it("lists every command for an empty line", () => {
    expect(texts("")).toEqual(["update", "uninstall", "theme", "release-check", "help", "library"]);
  });

  it("matches the first word by prefix, alias and substring, best first", () => {
    expect(texts("he")[0]).toBe("help");
    expect(texts("rc")).toEqual(["release-check"]);
    expect(texts("check")).toEqual(["release-check"]);
    expect(texts("zzz")).toEqual([]);
  });

  it("expands commands with a required enum into their argument lines, with descriptions", () => {
    const result = suggest("upd", commands());
    expect(result.map(item => item.text)).toEqual(["update claude", "update opencode", "update workspace", "update --all"]);
    expect(result[0]!.description).toBe("apply 7 safe, skip 1 conflict");
    expect(result[1]!.description).toBe("preview, then apply managed files");
  });

  it("keeps the bare command when its first argument is optional", () => {
    expect(texts("lib")).toEqual(["library", "library docs", "library skills"]);
  });

  it("completes enum values after the command, filtered by what was typed", () => {
    expect(texts("theme ")).toEqual(["theme dark", "theme light", "theme system", "theme toggle"]);
    expect(texts("theme s")).toEqual(["theme system"]);
    expect(texts(":theme d")).toEqual(["theme dark"]);
  });

  it("offers flags when the partial starts with a dash and hides flags already used", () => {
    expect(texts("update --")).toEqual(["update --all"]);
    expect(texts("update --all ")).toEqual(["update --all claude", "update --all opencode", "update --all workspace"]);
  });

  it("uses the command's own completions for the current argument", () => {
    expect(texts("library skills cur")).toEqual(["library skills current-docs"]);
    expect(texts("library skills ")).toEqual(["library skills current-docs", "library skills tdd"]);
  });

  it("quotes completions that contain spaces", () => {
    const spaced: CommandSpec[] = [{
      name: "open",
      summary: "open",
      args: [{ name: "what", kind: "enum", values: ["my notes"] }],
      run,
    }];
    expect(suggest("open ", spaced).map(item => item.text)).toEqual([`open "my notes"`]);
  });

  it("marks suggestions of disabled commands with the reason", () => {
    const [first] = suggest("rc", commands());
    expect(first).toMatchObject({ text: "release-check", disabled: "no release-check script" });
  });

  it("returns the typed line when nothing is left to complete", () => {
    expect(texts("theme dark")).toEqual(["theme dark"]);
    expect(texts("help ")).toEqual(["help"]);
  });

  it("falls back to name matches when the first word is not a unique command", () => {
    expect(texts("u ")).toEqual(texts("u"));
  });

  it("honours the limit", () => {
    expect(suggest("", commands(), { limit: 2 })).toHaveLength(2);
  });
});
