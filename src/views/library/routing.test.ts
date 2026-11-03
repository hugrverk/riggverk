import { describe, expect, it } from "vitest";
import { handWritten, ownWhen, routingLine, suggestWhen, whenProblem } from "./routing";

describe("imported skill routing", () => {
  it("suggests the use-when clause up to the end of its sentence", () => {
    expect(suggestWhen("A helper. Use it when fixing bugs. More text.", "mine")).toBe("Fixing bugs");
    expect(suggestWhen("Use when reviewing code.", "mine")).toBe("Reviewing code");
    expect(suggestWhen("Use when v1.2 ships", "mine")).toBe("V1.2 ships");
    expect(suggestWhen("No clause here.", "mine")).toBe("");
    expect(suggestWhen("Not for Word. Do not use when the user wants Word docs.", "mine")).toBe("");
    expect(suggestWhen("Never use when offline. Use when online.", "mine")).toBe("Online");
    expect(suggestWhen("Use when the change\n  spans files.", "mine")).toBe("The change spans files");
    expect(suggestWhen("Use when `code` or <html> appears.", "mine")).toBe("");
    expect(suggestWhen(`Use when ${"x".repeat(240)}.`, "mine")).toBe("");
  });

  it("checks the text the way the backend writes the line", () => {
    expect(routingLine("  Fix bugs  ", "mine")).toBe("- Fix bugs: `mine`.");
    expect(whenProblem("Fix bugs", "mine")).toBe("");
    for (const text of ["", "  ", "# heading", "a\nb", "a\tb", "x\u200b", "x\ufe0f", "x\u{e0101}", "x\u3164", "~~~", "<tag>", "`x`", "x".repeat(240)]) {
      expect(whenProblem(text, "mine")).not.toBe("");
    }
  });

  it("tells the app's own line from lines written by hand", () => {
    const lines = ["- Hand `other`: `mine`.", "- Fix bugs: `mine`.  ", "- Also for `mine` and `other`.", "- : `mine`."];
    expect(ownWhen(lines, "mine")).toBe("Fix bugs");
    expect(ownWhen(lines, "other")).toBeNull();
    expect(handWritten(lines, "mine")).toEqual(["- Hand `other`: `mine`.", "- Also for `mine` and `other`.", "- : `mine`."]);
  });
});
