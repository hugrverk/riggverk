import { describe, expect, it } from "vitest";
import type { PackLibrary } from "../types";
import { forgettablePacks, packGroup, packSkillSummaries } from "./packSkills";

const library: PackLibrary = {
  folder: "~/.config/riggverk/packs",
  packs: [
    { name: "mine", state: "ok", reason: "", forgettable: false },
    { name: "gone", state: "missing", reason: "the pack folder is gone", forgettable: true },
  ],
  skills: [
    { id: "pack:mine/a", name: "a", description: "A", pack: "mine", state: "active", reason: "", path: "skills/a/SKILL.md" },
    { id: "pack:gone/b", name: "b", description: "", pack: "gone", state: "missing", reason: "pack missing", path: "" },
  ],
  ignored: [],
};

describe("pack skills in the Library", () => {
  it("lists them under a pack:<name> group with their state", () => {
    const rows = packSkillSummaries(library);
    expect(rows.map(row => [row.id, row.group, row.packState])).toEqual([
      ["pack:mine/a", packGroup("mine"), "active"],
      ["pack:gone/b", "pack:gone", "missing"],
    ]);
    expect(rows[1]?.packReason).toBe("pack missing");
  });

  it("offers Forget pack only for packs whose installed skills are held", () => {
    expect(forgettablePacks(library).map(pack => pack.name)).toEqual(["gone"]);
    expect(forgettablePacks(null)).toEqual([]);
    expect(packSkillSummaries(null)).toEqual([]);
  });
});
