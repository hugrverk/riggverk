import { describe, expect, it } from "vitest";
import { ownWhen, routingLine, suggestWhen, whenProblem } from "./routing";

describe("routing", () => {
  it("suggests the first use-when clause without markup", () => {
    expect(suggestWhen("A helper. use it when fixing bugs. More text.")).toBe("Fixing bugs");
    expect(suggestWhen("Use when reviewing code")).toBe("Reviewing code");
    expect(suggestWhen("No clause here")).toBe("");
    expect(suggestWhen("Use when `code` or <html> appears.")).toBe("");
  });
  it("recognises only app lines and rejects unsafe descriptions", () => {
    expect(routingLine("  Fix bugs  ", "mine")).toBe("- Fix bugs: `mine`.");
    expect(ownWhen(["- Hand `other`: `mine`.", "- Fix bugs: `mine`."], "mine")).toBe("Fix bugs");
    for (const text of ["", "# heading", "a\nb", "x\u200b", "~~~", "<tag>", "`x`", "x".repeat(240)]) expect(whenProblem(text, "mine")).not.toBe("");
  });
});
