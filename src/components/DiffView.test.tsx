import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffView, parseUnifiedDiff } from "./DiffView";

afterEach(cleanup);

const DIFF = [
  "--- installed",
  "+++ after update",
  "@@ -1,4 +1,4 @@",
  " # Global Agent Rules",
  "-old line",
  "+new line",
  "--- starts with dashes",
  " unchanged",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("types the labels, hunk header, changes, context and the no-newline note", () => {
    expect(parseUnifiedDiff(DIFF).map(line => [line.kind, line.mark, line.text])).toEqual([
      ["file", "", "--- installed"],
      ["file", "", "+++ after update"],
      ["hunk", "", "@@ -1,4 +1,4 @@"],
      ["context", " ", "# Global Agent Rules"],
      ["remove", "-", "old line"],
      ["add", "+", "new line"],
      // Only the first two lines are labels: a removed line that reads "-- ..." stays a removal.
      ["remove", "-", "-- starts with dashes"],
      ["context", " ", "unchanged"],
      ["note", "", "\\ No newline at end of file"],
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("DiffView", () => {
  it("marks every added and removed line with + or - in its own column, not by colour alone", () => {
    render(<DiffView diff={DIFF} label="Diff" />);
    const group = screen.getByRole("group", { name: "Diff" });
    const marks = Array.from(group.querySelectorAll(".diff-line")).map(row => [row.className, row.querySelector(".diff-mark")!.textContent]);
    expect(marks.filter(([cls]) => (cls as string).includes("add")).map(([, mark]) => mark)).toEqual(["+"]);
    expect(marks.filter(([cls]) => (cls as string).includes("remove")).map(([, mark]) => mark)).toEqual(["-", "-"]);
    expect(group.textContent).toContain("old line");
    expect(group.textContent).toContain("new line");
  });

  it("is read-only: no inputs or editable content", () => {
    const { container } = render(<DiffView diff={DIFF} label="Diff" />);
    expect(container.querySelector("input, textarea, [contenteditable]")).toBeNull();
  });

  it("says so when both sides are equal", () => {
    render(<DiffView diff="" label="Diff" empty="the base is already current" />);
    expect(screen.getByRole("status").textContent).toBe("the base is already current");
  });
});
