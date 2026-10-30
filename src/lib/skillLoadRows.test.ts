import { describe, expect, it } from "vitest";
import type {
  EffectiveSkillLoads,
  ForeignSkillDuplicate,
  HarnessSkillLoads,
  InstallAgent,
  SkillCopy,
  SkillLoad,
  SkillLoadFlag,
  SkillReadFolder,
} from "../types";
import {
  isWarningFlag,
  MAX_FLAGGED_ROWS,
  skillLoadProblemCount,
  skillLoadRows,
  skillReadsRows,
  summarizeSkillLoads,
} from "./skillLoadRows";

const PATHS: Record<SkillReadFolder, string> = {
  claude: "~/.claude/skills",
  agents: "~/.agents/skills",
  codex_home: "~/.codex/skills",
  dot_codex: "~/.codex/skills",
  open_code: "~/.config/opencode/skills",
  cursor: "~/.cursor/skills",
  copilot: "~/.copilot/skills",
  pi_agent: "~/.pi/agent/skills",
  kilo: "~/.kilo/skills",
  grok: "~/.grok/skills",
};

function copy(folder: SkillReadFolder, name: string, extra: Partial<SkillCopy> = {}): SkillCopy {
  return { folder, path: `${PATHS[folder]}/${name}`, hash: "aaaaaaaaaaaa", owner: "aw", current: true, ...extra };
}

function load(name: string, copies: SkillCopy[], flags: SkillLoadFlag[] = []): SkillLoad {
  return { name, copies, winner: copies.length === 1 ? 0 : null, flags };
}

function single(name: string, folder: SkillReadFolder = "agents"): SkillLoad {
  return load(name, [copy(folder, name)]);
}

function harnessOf(
  harness: InstallAgent,
  folders: SkillReadFolder[],
  skills: SkillLoad[],
  missing: SkillReadFolder[] = [],
): HarnessSkillLoads {
  return {
    harness,
    folders: folders.map((folder) => ({ folder, path: PATHS[folder], exists: !missing.includes(folder) })),
    skills,
  };
}

function loadsOf(harnesses: HarnessSkillLoads[], foreign: ForeignSkillDuplicate[] = []): { loads: EffectiveSkillLoads; error: null } {
  return { loads: { harnesses, foreign_duplicates: foreign }, error: null };
}

/** `count` names, each in the two folders Codex reads, flagged as Codex flags them. */
function codexTwice(count: number, start = 0): SkillLoad[] {
  return Array.from({ length: count }, (_, index) => {
    const name = `skill-${String(start + index).padStart(2, "0")}`;
    return load(name, [copy("agents", name), copy("codex_home", name)], ["plain_mention_ambiguous"]);
  });
}

const CODEX_FOLDERS: SkillReadFolder[] = ["agents", "codex_home"];

describe("skillLoadRows", () => {
  it("shows nothing while the loads are not read, and a dim row when reading them failed", () => {
    expect(skillLoadRows({ loads: null, error: null }, "codex")).toEqual([]);
    expect(skillLoadRows({ loads: null, error: "workspace invalid" }, "codex")).toEqual([
      { label: "skill loads", value: "not checked: workspace invalid", tone: "dim", wrap: true },
    ]);
    // A harness the view does not cover has no rows either.
    expect(skillLoadRows(loadsOf([harnessOf("claude", ["claude"], [])]), "codex")).toEqual([]);
  });

  it("says how many skills there are and that each has one copy when nothing is duplicated", () => {
    const view = loadsOf([harnessOf("codex", CODEX_FOLDERS, [single("a"), single("b"), single("c")])]);
    expect(skillLoadRows(view, "codex")).toEqual([{ label: "skill loads", value: "3 skills, 1 copy each", tone: "ok" }]);
    const one = loadsOf([harnessOf("codex", CODEX_FOLDERS, [single("a")])]);
    expect(skillLoadRows(one, "codex")[0]!.value).toBe("1 skill, 1 copy each");
  });

  it("says so when no skills are found", () => {
    const view = loadsOf([harnessOf("claude", ["claude"], [], ["claude"])]);
    expect(skillLoadRows(view, "claude")).toEqual([{ label: "skill loads", value: "no skills found", tone: "dim" }]);
  });

  it("summarises names with two copies as a warning and lists them with what it means for the harness", () => {
    const view = loadsOf([harnessOf("codex", CODEX_FOLDERS, [single("solo"), ...codexTwice(2)])]);
    const rows = skillLoadRows(view, "codex");
    expect(rows[0]).toMatchObject({ label: "skill loads", value: "2 names with 2 copies", tone: "warn" });
    expect(rows.slice(1).map((row) => [row.label, row.value, row.tone])).toEqual([
      ["", "skill-00 · ~/.agents/skills + ~/.codex/skills · plain $name mention is ambiguous", "warn"],
      ["", "skill-01 · ~/.agents/skills + ~/.codex/skills · plain $name mention is ambiguous", "warn"],
    ]);
  });

  it("lists at most five flagged names and counts the rest", () => {
    const view = loadsOf([harnessOf("codex", CODEX_FOLDERS, codexTwice(8))]);
    const rows = skillLoadRows(view, "codex");
    expect(MAX_FLAGGED_ROWS).toBe(5);
    expect(rows).toHaveLength(1 + 5 + 1);
    expect(rows[0]!.value).toBe("8 names with 2 copies");
    expect(rows.at(-1)).toMatchObject({ label: "", value: "+3 more", tone: "dim" });
    // Exactly five need no "more" row.
    expect(skillLoadRows(loadsOf([harnessOf("codex", CODEX_FOLDERS, codexTwice(5))]), "codex")).toHaveLength(1 + 5);
  });

  it("names the number of copies as 2+ when the flagged names do not all have the same number", () => {
    const three = load("three", [copy("agents", "three"), copy("codex_home", "three"), copy("codex_home", "three-b")], ["plain_mention_ambiguous"]);
    const view = loadsOf([harnessOf("codex", CODEX_FOLDERS, [...codexTwice(1), three])]);
    expect(skillLoadRows(view, "codex")[0]!.value).toBe("2 names with 2+ copies");
    expect(skillLoadRows(loadsOf([harnessOf("codex", CODEX_FOLDERS, [three])]), "codex")[0]!.value).toBe("1 name with 3 copies");
  });

  it("tells OpenCode's different copies apart from identical ones, which are information and no warning", () => {
    const folders: SkillReadFolder[] = ["claude", "agents", "open_code"];
    const differ = load("a", [copy("claude", "a"), copy("open_code", "a", { hash: "bbbbbbbbbbbb" })], ["winner_nondeterministic"]);
    const same = load("b", [copy("claude", "b"), copy("agents", "b")], ["duplicate_identical"]);

    const warned = skillLoadRows(loadsOf([harnessOf("opencode", folders, [differ, same, single("c", "claude")])]), "opencode");
    expect(warned[0]).toMatchObject({ value: "1 name with 2 copies", tone: "warn" });
    expect(warned[1]!.value).toBe("a · ~/.claude/skills + ~/.config/opencode/skills · winner varies between runs");
    expect(warned).toHaveLength(2);

    const info = skillLoadRows(loadsOf([harnessOf("opencode", folders, [same, single("c", "claude")])]), "opencode");
    expect(info).toEqual([{ label: "skill loads", value: "2 skills · 1 with identical copies", tone: "dim", wrap: true }]);
    expect(isWarningFlag("duplicate_identical")).toBe(false);
    expect(isWarningFlag("winner_nondeterministic")).toBe(true);
  });

  it("calls Cursor's duplicates possible and says the behaviour is not verified for the user's version", () => {
    const folders: SkillReadFolder[] = ["cursor", "agents", "claude", "dot_codex"];
    const dup = load("a", [copy("agents", "a"), copy("claude", "a")], ["possible_duplicate"]);
    const rows = skillLoadRows(loadsOf([harnessOf("cursor", folders, [dup])]), "cursor");
    expect(rows[0]!.value).toBe("1 name with 2 copies · not verified for your Cursor version");
    expect(rows[1]!.value).toBe("a · ~/.agents/skills + ~/.claude/skills · possible duplicate");
  });

  it("says which folder wins when Copilot, Pi or Kilo hold different copies, and keeps identical ones quiet", () => {
    const folders: SkillReadFolder[] = ["copilot", "agents"];
    const differing = {
      ...load("a", [copy("copilot", "a"), copy("agents", "a", { hash: "bbbbbbbbbbbb", current: false })], ["shadowed_by_folder_order"]),
      winner: 0,
    };
    const same = { ...load("b", [copy("copilot", "b"), copy("agents", "b")], ["duplicate_identical"]), winner: 0 };
    const rows = skillLoadRows(loadsOf([harnessOf("copilot", folders, [differing, same])]), "copilot");
    expect(rows[0]).toMatchObject({ value: "1 name with 2 copies", tone: "warn" });
    expect(rows[1]!.value).toBe("a · ~/.copilot/skills + ~/.agents/skills · first folder wins, the others are hidden");
    expect(rows).toHaveLength(2);
    expect(isWarningFlag("shadowed_by_folder_order")).toBe(true);

    const quiet = skillLoadRows(loadsOf([harnessOf("kilo", ["kilo", "agents", "claude"], [same])]), "kilo");
    expect(quiet).toEqual([{ label: "skill loads", value: "1 skill · 1 with identical copies", tone: "dim", wrap: true }]);
  });

  it("lists the user's own duplicates apart as theirs, and not among the names the app can fix", () => {
    const own = load("mine", [copy("agents", "mine", { owner: "foreign", current: false }), copy("codex_home", "mine", { owner: "foreign", current: false })], ["foreign_copy"]);
    const foreign: ForeignSkillDuplicate = { name: "mine", harnesses: ["codex"], copies: own.copies };
    const view = loadsOf([harnessOf("codex", CODEX_FOLDERS, [own, ...codexTwice(1)])], [foreign]);
    const summary = summarizeSkillLoads(view.loads, "codex")!;
    expect(summary.flagged.map((skill) => skill.name)).toEqual(["skill-00"]);
    expect(summary.foreign.map((duplicate) => duplicate.name)).toEqual(["mine"]);
    expect(skillLoadProblemCount(summary)).toBe(2);

    const rows = skillLoadRows(view, "codex");
    expect(rows[0]).toMatchObject({ value: "1 name with 2 copies · 1 name of yours with several copies", tone: "warn" });
    expect(rows[1]!.value).toContain("skill-00");
    expect(rows[2]).toMatchObject({ label: "", value: "mine · yours, Riggverk cannot fix · ~/.agents/skills + ~/.codex/skills", tone: "warn" });
  });

  it("says the app leaves the user's own copies alone when every one of them is kept", () => {
    const kept = (folder: SkillReadFolder) => copy(folder, "mine", { owner: "foreign", current: false, kept: true });
    const own = load("mine", [kept("agents"), kept("codex_home")], ["foreign_copy"]);
    const view = loadsOf([harnessOf("codex", CODEX_FOLDERS, [own])], [{ name: "mine", harnesses: ["codex"], copies: own.copies }]);
    expect(skillLoadRows(view, "codex")[1]).toMatchObject({
      value: "mine · yours (kept), Riggverk leaves it alone · ~/.agents/skills + ~/.codex/skills",
      tone: "warn",
    });
    // One copy that is not kept: the app still cannot fix it.
    const mixed = load("mine", [kept("agents"), copy("codex_home", "mine", { owner: "foreign", current: false })], ["foreign_copy"]);
    const mixedView = loadsOf([harnessOf("codex", CODEX_FOLDERS, [mixed])], [{ name: "mine", harnesses: ["codex"], copies: mixed.copies }]);
    expect(skillLoadRows(mixedView, "codex")[1]!.value).toContain("yours, Riggverk cannot fix");
  });

  it("shows a harness only the foreign duplicates that reach it", () => {
    const foreign: ForeignSkillDuplicate = { name: "mine", harnesses: ["cursor"], copies: [] };
    const view = loadsOf([harnessOf("codex", CODEX_FOLDERS, [single("a")]), harnessOf("cursor", ["cursor"], [])], [foreign]);
    expect(summarizeSkillLoads(view.loads, "codex")!.foreign).toEqual([]);
    expect(skillLoadRows(view, "codex")).toEqual([{ label: "skill loads", value: "1 skill, 1 copy each", tone: "ok" }]);
    expect(skillLoadProblemCount(summarizeSkillLoads(view.loads, "cursor"))).toBe(1);
  });

  it("names the folders a harness reads, the missing ones and the ones read only in part", () => {
    const harness = harnessOf("codex", CODEX_FOLDERS, [], ["codex_home"]);
    harness.folders[0] = { ...harness.folders[0]!, note: "1 not read (a link outside your home folder)" };
    expect(skillReadsRows(loadsOf([harness]), "codex")).toEqual([
      { label: "reads", value: "~/.agents/skills (1 not read (a link outside your home folder)), ~/.codex/skills (missing)", wrap: true },
    ]);
    expect(skillReadsRows({ loads: null, error: null }, "codex")).toEqual([]);
  });
});
