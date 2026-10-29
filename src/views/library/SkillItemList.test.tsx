import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithShell } from "../../test/renderWithShell";
import type { SkillSummary } from "../../types";
import { mergeSkillGroups, SkillItemList, skillGroupKey } from "./SkillItemList";

afterEach(cleanup);

function skill(id: string, group: string): SkillSummary {
  return { id, name: id, description: "", path: "", group, category: "", risk: "low", targets: [], related: [] };
}

describe("mergeSkillGroups", () => {
  it("treats spelling, case and separator spacing as one group", () => {
    expect(skillGroupKey(" Workflow·Diagnosis ")).toBe("workflow · diagnosis");
    expect(skillGroupKey("workflow  ·  diagnosis")).toBe("workflow · diagnosis");
  });

  it("brings the skills of one group together and keeps first-seen order", () => {
    const { items, groupOf } = mergeSkillGroups([
      skill("a", "workflow · diagnosis"),
      skill("b", "frontend"),
      skill("c", "Workflow · Diagnosis"),
      skill("d", "frontend"),
    ]);
    expect(items.map(s => s.id)).toEqual(["a", "c", "b", "d"]);
    expect(groupOf.get("c")).toBe("workflow · diagnosis");
  });
});

describe("SkillItemList", () => {
  it("shows each group heading once", () => {
    renderWithShell(
      <SkillItemList
        skills={[skill("a", "workflow · diagnosis"), skill("b", "frontend"), skill("c", "workflow · diagnosis")]}
        activeKey="a"
        followCursor
        onSelect={() => {}}
        onActivate={() => {}}
        search=""
        onSearchChange={() => {}}
      />,
    );
    const headings = Array.from(screen.getByRole("listbox", { name: "Skills" }).querySelectorAll("li.group")).map(el => el.textContent);
    expect(headings).toEqual(["workflow · diagnosis", "frontend"]);
  });
});
