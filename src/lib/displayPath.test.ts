import { describe, expect, it } from "vitest";
import { displayPath } from "./displayPath";

describe("displayPath", () => {
  it("strips extended Windows prefix", () => {
    expect(displayPath(String.raw`\\?\C:\Users\Example\.cursor\mcp.json`)).toBe(
      "C:/Users/Example/.cursor/mcp.json",
    );
  });

  it("normalizes Windows separators for display", () => {
    expect(displayPath(String.raw`C:\Users\Example\My Workspace\doc.md`)).toBe(
      "C:/Users/Example/My Workspace/doc.md",
    );
  });

  it("leaves unix paths unchanged", () => {
    expect(displayPath("/home/example/.cursor/mcp.json")).toBe(
      "/home/example/.cursor/mcp.json",
    );
  });
});
