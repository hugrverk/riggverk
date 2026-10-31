import { describe, expect, it } from "vitest";
import type { PackLibrary } from "../types";
import { packGroup, packNoticeLines, packSkillSummaries } from "./packSkills";

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

  it("has no rows without a library", () => {
    expect(packSkillSummaries(null)).toEqual([]);
  });

  it("tells why a pack's routing.md is not used, and nothing for a pack whose routing applies", () => {
    const routed: PackLibrary = {
      ...library,
      packs: [
        { ...library.packs[0]!, routing: ["- A: `a`."], routing_problem: null },
        { ...library.packs[1]!, routing: [], routing_problem: "routing.md is not used: it is a symlink" },
      ],
    };
    expect(packNoticeLines(routed, null)).toEqual([
      { key: "routing:gone", label: packGroup("gone"), text: "routing.md is not used: it is a symlink" },
    ]);
  });
});
