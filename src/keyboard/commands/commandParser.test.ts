import { describe, expect, it, vi } from "vitest";
import { parseCommandLine, tokenize, type CommandSpec } from "./parser";

const HARNESSES = ["codex", "opencode", "cursor", "claude", "workspace"];

function commands(): CommandSpec[] {
  const run = vi.fn();
  return [
    {
      name: "update",
      summary: "update",
      args: [
        { name: "target", kind: "enum", values: HARNESSES },
        { name: "all", kind: "flag" },
      ],
      validate: parsed => {
        if (!parsed.named.target && !parsed.flags.all) return "update: name a target or pass --all";
        if (parsed.named.target && parsed.flags.all) return "update: use either a target or --all";
        return null;
      },
      run,
    },
    { name: "uninstall", summary: "uninstall", run },
    { name: "refresh", summary: "refresh", run },
    { name: "release-check", aliases: ["rc"], summary: "release check", run },
    { name: "rollback", summary: "rollback", run },
    { name: "theme", summary: "theme", args: [{ name: "mode", kind: "enum", values: ["dark", "light", "system", "toggle"] }], run },
    { name: "w", summary: "write", run },
    { name: "wq", summary: "write and close", run },
    {
      name: "library",
      aliases: ["lib"],
      summary: "library",
      args: [
        { name: "source", kind: "enum", values: ["docs", "skills"], optional: true },
        { name: "item", kind: "rest", optional: true },
      ],
      run,
    },
  ];
}

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("update  claude").tokens.map(token => token.text)).toEqual(["update", "claude"]);
  });

  it("honours double and single quotes and marks tokens as quoted", () => {
    const { tokens } = tokenize(`library skills "current docs" 'a b'`);
    expect(tokens.map(token => token.text)).toEqual(["library", "skills", "current docs", "a b"]);
    expect(tokens[2]!.quoted).toBe(true);
  });

  it("handles escapes and reports unterminated quotes", () => {
    expect(tokenize(`say "he said \\"hi\\""`).tokens[1]!.text).toBe('he said "hi"');
    expect(tokenize(`foo\\ bar`).tokens.map(token => token.text)).toEqual(["foo bar"]);
    expect(tokenize(`open "unclosed`).unterminated).toBe(true);
  });
});

describe("parseCommandLine", () => {
  it("resolves exact names and aliases", () => {
    const result = parseCommandLine("rc", commands());
    expect(result.ok && result.cmd.name).toBe("release-check");
    const lib = parseCommandLine("lib", commands());
    expect(lib.ok && lib.cmd.name).toBe("library");
  });

  it("strips a leading colon", () => {
    const result = parseCommandLine(":theme dark", commands());
    expect(result.ok && result.named.mode).toBe("dark");
  });

  it("resolves a unique prefix", () => {
    const result = parseCommandLine("unin", commands());
    expect(result.ok && result.cmd.name).toBe("uninstall");
  });

  it("prefers an exact match over a longer prefix match (w vs wq)", () => {
    const result = parseCommandLine("w", commands());
    expect(result.ok && result.cmd.name).toBe("w");
  });

  it("reports ambiguity with the candidates", () => {
    const result = parseCommandLine("re", commands());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/ambiguous/);
    expect(result.suggestions.map(cmd => cmd.name).sort()).toEqual(["refresh", "release-check"]);
  });

  it("reports unknown commands", () => {
    const result = parseCommandLine("frobnicate", commands());
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/unknown command/);
  });

  it("resolves enum values by exact value and unique prefix", () => {
    const exact = parseCommandLine("update claude", commands());
    expect(exact.ok && exact.named.target).toBe("claude");
    const prefix = parseCommandLine("update cl", commands());
    expect(prefix.ok && prefix.named.target).toBe("claude");
  });

  it("rejects ambiguous and invalid enum values", () => {
    const ambiguous = parseCommandLine("update c", commands());
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error).toMatch(/ambiguous target/);
    const invalid = parseCommandLine("update nope", commands());
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatch(/invalid target/);
  });

  it("parses --flags and lets validate() decide what a missing argument means", () => {
    const all = parseCommandLine("update --all", commands());
    expect(all.ok && all.flags.all).toBe(true);
    const abbreviated = parseCommandLine("update --al", commands());
    expect(abbreviated.ok && abbreviated.flags.all).toBe(true);
    const neither = parseCommandLine("update", commands());
    expect(neither).toMatchObject({ ok: false, error: "update: name a target or pass --all" });
    const both = parseCommandLine("update codex --all", commands());
    expect(both).toMatchObject({ ok: false, error: "update: use either a target or --all" });
  });

  it("rejects unknown flags and surplus arguments", () => {
    expect(parseCommandLine("update --bogus", commands())).toMatchObject({ ok: false });
    expect(parseCommandLine("theme dark extra", commands())).toMatchObject({ ok: false, error: "theme: too many arguments" });
  });

  it("requires mandatory positional arguments when no validate() exists", () => {
    expect(parseCommandLine("theme", commands())).toMatchObject({ ok: false, error: "theme: missing mode" });
  });

  it("joins rest arguments, keeping quoted phrases together", () => {
    const result = parseCommandLine(`library skills "current docs" extra`, commands());
    expect(result.ok && result.named).toEqual({ source: "skills", item: "current docs extra" });
  });

  it("reports an empty line and unterminated quotes", () => {
    expect(parseCommandLine("   ", commands())).toMatchObject({ ok: false, error: "type a command" });
    expect(parseCommandLine(`library skills "oops`, commands())).toMatchObject({ ok: false, error: "unterminated quote" });
  });
});
