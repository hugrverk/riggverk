import { describe, expect, it } from "vitest";
import { effectiveRulesText, overrideHint, refinementsDiff, sharedHeadings } from "./rulesText";

const BEFORE = "<!-- BEGIN -->\n## Communication\nBe direct.\n\n## Verification\nEvidence first.\n<!-- END -->";

describe("rules text", () => {
  it("reads the file as before and draft joined byte for byte", () => {
    expect(effectiveRulesText({ before: BEFORE }, "\n\n## Mine\nText\n")).toBe(`${BEFORE}\n\n## Mine\nText\n`);
  });

  it("diffs the saved refinements against the draft, and is empty when they match", () => {
    expect(refinementsDiff({ refinements: "\nold\n" }, "\nold\n")).toBe("");
    expect(refinementsDiff({ refinements: "\nold\n" }, "\nnew\n")).toContain("-old\n+new");
  });

  it("finds the sections the draft shares with the managed block", () => {
    expect(sharedHeadings(BEFORE, "## Mine\n## Verification\n## Communication  \n## Verification")).toEqual([
      "Verification",
      "Communication",
    ]);
    expect(sharedHeadings(BEFORE, "### Verification\nno")).toEqual([]);
  });

  it("words the hint for one or several shared sections", () => {
    expect(overrideHint([])).toBeNull();
    expect(overrideHint(["Verification"])).toBe(
      "“Verification” is also a section in the managed base. The agent reads both; yours comes later in the file.",
    );
    expect(overrideHint(["A", "B"])).toContain("“A”, “B” are also sections");
  });
});
