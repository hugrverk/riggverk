import { describe, expect, it } from "vitest";
import { postureOf } from "../test/pageFixtures";
import type { FindingCode, PostureFinding, PostureLevel, SecurityPosture } from "../types";
import { postureNotesFor, postureRowsFor } from "./securityPostureRows";

const LEVELS: Record<FindingCode, PostureLevel> = {
  claude_bypass_default: "risky",
  claude_bypass_disabled: "enforced",
  claude_bypass_available: "advice",
  claude_sandbox_on: "enforced",
  claude_sandbox_off: "advice",
  claude_env_read_denied: "enforced",
  claude_env_read_open: "advice",
  claude_config_dir_set: "not_covered",
  codex_no_sandbox: "risky",
  codex_sandbox_workspace: "enforced",
  codex_sandbox_read_only: "enforced",
  codex_sandbox_unset: "advice",
  codex_approvals_never: "risky",
  codex_approvals_on_request: "enforced",
  codex_network_on: "risky",
  codex_trusted_projects: "advice",
  opencode_allow_all: "risky",
  opencode_bash_allow: "risky",
  opencode_deny_rules: "enforced",
  opencode_deny_rules_missing: "advice",
  cursor_sandbox_off: "risky",
  cursor_network_open: "risky",
  cursor_run_mode: "not_covered",
  kilo_allow_all: "risky",
  kilo_bash_allow: "risky",
  kilo_no_rules: "advice",
  copilot_not_covered: "not_covered",
  pi_not_covered: "not_covered",
  config_only: "not_covered",
};

const finding = (code: FindingCode, extra: Partial<PostureFinding> = {}): PostureFinding => ({
  code,
  level: LEVELS[code],
  file: null,
  count: null,
  ...extra,
});

const codes = Object.keys(LEVELS) as FindingCode[];

describe("postureRowsFor", () => {
  it("has a row for every code, in its level's tone and never an ok tone", () => {
    for (const code of codes) {
      const { rows } = postureRowsFor(postureOf("claude", [finding(code, { file: "opencode.json", count: 2 })]));
      const row = rows[0]!;
      expect(row.label, code).toBeTruthy();
      expect(row.tone, code).not.toBe("ok");
      expect(String(row.value), code).toMatch(/^(risky|enforced|advice only|not covered) · \S/);
      const level = LEVELS[code];
      expect(row.tone, code).toBe(level === "risky" ? "warn" : level === "enforced" ? undefined : "dim");
    }
  });

  it("says nothing is secure, safe or all good, in any row or verdict", () => {
    const all = postureOf("claude", codes.map(code => finding(code)));
    const { rows, verdict } = postureRowsFor(all);
    const text = [verdict.text, ...rows.map(row => `${String(row.label)} ${String(row.value)}`)].join("\n");
    expect(text).not.toMatch(/\b(secure|safe)\b|all good/i);
  });

  it("orders risky, enforced, advice, not covered, with config_only last and the baseline row closing", () => {
    const posture = postureOf("claude", [
      finding("config_only"),
      finding("claude_env_read_open"),
      finding("claude_sandbox_on"),
      finding("claude_bypass_default"),
      finding("cursor_run_mode"),
    ]);
    const { rows } = postureRowsFor(posture);
    expect(rows.map(row => row.id)).toEqual([
      "claude_bypass_default",
      "claude_sandbox_on",
      "claude_env_read_open",
      "cursor_run_mode",
      "config_only",
      "baseline",
    ]);
    expect(rows.at(-2)!.label).toBe("not checked");
    expect(rows.at(-1)).toMatchObject({ label: "baseline", value: "Library > Docs > Security Baseline", tone: "dim" });
  });

  it("counts risky findings in the verdict, before any other state", () => {
    const posture: SecurityPosture = postureOf(
      "opencode",
      [finding("opencode_allow_all", { file: "opencode.jsonc" }), finding("opencode_bash_allow", { file: "opencode.json" })],
      [
        { file: "opencode.json", state: "read" },
        { file: "opencode.jsonc", state: "unreadable" },
      ],
    );
    expect(postureRowsFor(posture).verdict).toEqual({ text: "2 risky", tone: "warn" });
  });

  it("words the verdict by the state of the files", () => {
    const verdict = (sources: SecurityPosture["sources"]) => postureRowsFor(postureOf("claude", [finding("config_only")], sources)).verdict;
    expect(verdict([{ file: "~/.claude/settings.json", state: "unreadable" }])).toEqual({
      text: "could not read ~/.claude/settings.json",
      tone: "dim",
    });
    expect(verdict([{ file: "~/.claude/settings.json", state: "missing" }])).toEqual({
      text: "no ~/.claude/settings.json · defaults apply · config only",
      tone: "dim",
    });
    expect(verdict([{ file: "~/.claude/settings.json", state: "read" }])).toEqual({
      text: "no risky settings found in ~/.claude/settings.json · this checks config only",
      tone: "dim",
    });
    expect(verdict([])).toEqual({ text: "not covered", tone: "dim" });
    expect(verdict([{ file: "~/.claude/settings.json", state: "not_checked" }])).toEqual({ text: "not checked", tone: "dim" });
  });

  it("names the files read when several were", () => {
    const posture = postureOf("opencode", [], [
      { file: "opencode.json", state: "read" },
      { file: "opencode.jsonc", state: "missing" },
      { file: "config.json", state: "read" },
    ]);
    expect(postureRowsFor(posture).verdict.text).toBe("no risky settings found in opencode.json, config.json · this checks config only");
  });

  it("uses singular and plural for counts and names the file where it matters", () => {
    const value = (code: FindingCode, count: number, file: string | null = null) =>
      String(postureRowsFor(postureOf("codex", [finding(code, { count, file })])).rows[0]!.value);
    expect(value("codex_trusted_projects", 1)).toContain("1 project marked trusted");
    expect(value("codex_trusted_projects", 3)).toContain("3 projects marked trusted");
    expect(value("opencode_deny_rules", 1)).toContain("1 deny rule under");
    expect(value("opencode_deny_rules", 4)).toContain("4 deny rules under");
    expect(value("opencode_allow_all", 0, "opencode.jsonc")).toContain("allow in opencode.jsonc");
    expect(value("kilo_bash_allow", 0, "kilo.json")).toContain("allow in kilo.json");
  });
});

describe("postureNotesFor", () => {
  it("keeps the verdict and the order of the rows, and gives each level its mark instead of the level word", () => {
    const posture = postureOf("claude", [
      finding("claude_sandbox_off", { level: "advice" }),
      finding("claude_bypass_default", { level: "risky" }),
      finding("claude_sandbox_on", { level: "enforced" }),
      finding("claude_config_dir_set", { level: "not_covered" }),
      finding("config_only", { level: "not_covered" }),
    ]);
    const { verdict, notes } = postureNotesFor(posture);
    expect(verdict).toEqual(postureRowsFor(posture).verdict);
    expect(notes.map(note => [note.id, note.mark?.text ?? null, note.mark?.kind ?? null])).toEqual([
      ["claude_bypass_default", "Worth a look", "tip"],
      ["claude_sandbox_on", "Set", "set"],
      ["claude_sandbox_off", "Tip", "tip"],
      ["claude_config_dir_set", null, null],
      // "not checked" always sits last, before the baseline pointer.
      ["config_only", null, null],
      ["baseline", null, null],
    ]);
    // Same order as the kv rows, and the text is the phrase without the level word.
    expect(notes.map(note => note.id)).toEqual(postureRowsFor(posture).rows.map(row => row.id));
    expect(notes[0]!.text).toBe("starts in bypassPermissions mode: no permission prompts");
    expect(notes[0]!.label).toBe("bypass mode");
  });
});
