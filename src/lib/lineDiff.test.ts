import { describe, expect, it } from "vitest";
import { unifiedLineDiff } from "./lineDiff";

describe("unifiedLineDiff", () => {
  it("is empty when the texts are equal", () => {
    expect(unifiedLineDiff("a\nb", "a\nb")).toBe("");
  });

  it("marks added and removed lines and keeps nearby context", () => {
    expect(unifiedLineDiff("one\ntwo\nthree", "one\n2\nthree")).toBe(" one\n-two\n+2\n three");
  });

  it("folds long unchanged stretches", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const edited = [...lines];
    edited[10] = "changed";
    const diff = unifiedLineDiff(lines.join("\n"), edited.join("\n"), 2).split("\n");
    expect(diff[0]).toBe("@@ 8 unchanged lines @@");
    expect(diff).toContain("-line 10");
    expect(diff).toContain("+changed");
    expect(diff[diff.length - 1]).toBe("@@ 7 unchanged lines @@");
  });

  it("shows an appended block as additions", () => {
    expect(unifiedLineDiff("", "## New\ntext")).toBe("-\n+## New\n+text");
  });
});
