import { describe, expect, it } from "vitest";
import { endingsOnlyNote, unifiedLineDiff } from "./lineDiff";

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
    expect(unifiedLineDiff("", "## New\ntext")).toBe("+## New\n+text");
  });

  it("does not invent a removed blank line when a line is appended after a final newline", () => {
    expect(unifiedLineDiff("a\nb\n", "a\nb\nc")).toBe(" a\n b\n+c");
    expect(unifiedLineDiff("a\nb\n", "a\nb\nc\n")).toBe(" a\n b\n+c");
  });

  it("still shows an added blank line", () => {
    expect(unifiedLineDiff("a\n", "a\n\n")).toBe(" a\n+");
  });

  it("compares CRLF text as LF, so one edit shows as one change", () => {
    expect(unifiedLineDiff("a\r\nb\r\nc\r\n", "a\nb\nc\nd")).toBe(" a\n b\n c\n+d");
    expect(unifiedLineDiff("a\r\nb\r\n", "a\nB\n")).toBe(" a\n-b\n+B");
  });

  it("is empty when only the line endings or the final newline differ, and says which", () => {
    expect(unifiedLineDiff("a\r\nb\r\n", "a\nb\n")).toBe("");
    expect(endingsOnlyNote("a\r\nb\r\n", "a\nb\n")).toBe("Only the line endings differ.");
    expect(unifiedLineDiff("a\nb\n", "a\nb")).toBe("");
    expect(endingsOnlyNote("a\nb\n", "a\nb")).toBe("Only the final newline differs.");
    expect(endingsOnlyNote("a\nb", "a\nb")).toBeNull();
    expect(endingsOnlyNote("a\nb", "a\nc")).toBeNull();
  });
});
