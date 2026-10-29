import { describe, expect, it } from "vitest";
import type { SkillSummary } from "../../types";
import { skillCopyProblem, suggestedCopyName } from "./skillCopy";

function skill(id: string, name: string, packState?: SkillSummary["packState"]): SkillSummary {
  return { id, name, description: "", path: "", group: packState ? "pack:x" : "bundled", category: "", risk: "", targets: [], related: [], packState };
}

const SKILLS = [skill("tdd", "tdd"), skill("pack:personal/mine", "mine", "active"), skill("pack:team/shared", "shared", "active")];

describe("skillCopyProblem", () => {
  it("accepts a free, well-formed name and says nothing about an empty one", () => {
    expect(skillCopyProblem("tdd-mine", SKILLS)).toBe("");
    expect(skillCopyProblem("", SKILLS)).toBe("");
    expect(skillCopyProblem("a".repeat(64), SKILLS)).toBe("");
  });

  it("refuses what the backend refuses: characters, a leading dash, the length", () => {
    for (const name of ["Tdd", "my skill", "-mine", "mine_2", "a".repeat(65)]) {
      expect(skillCopyProblem(name, SKILLS)).toMatch(/^Use 1–64 lowercase letters/);
    }
  });

  it("refuses a bundled skill name and the name of a pack skill, with the pack named", () => {
    expect(skillCopyProblem("tdd", SKILLS)).toBe("A bundled skill is already named tdd. Choose another name.");
    expect(skillCopyProblem("mine", SKILLS)).toBe("pack:personal already has mine.");
    expect(skillCopyProblem("shared", SKILLS)).toBe("A pack already has a skill named shared.");
  });

  it("suggests <name>-mine, kept within the length", () => {
    expect(suggestedCopyName("tdd")).toBe("tdd-mine");
    expect(suggestedCopyName("a".repeat(64)).length).toBeLessThanOrEqual(64);
  });
});
