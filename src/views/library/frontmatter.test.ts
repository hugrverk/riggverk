import { describe, expect, it } from "vitest";
import { stripFrontmatter } from "./frontmatter";

describe("stripFrontmatter", () => {
  it("removes a leading YAML block and the blank lines after it", () => {
    expect(stripFrontmatter("---\nname: tdd\ndescription: x\n---\n\n# Title\n")).toBe("# Title\n");
  });

  it("handles CRLF line endings and a block at the very end", () => {
    expect(stripFrontmatter("---\r\nname: tdd\r\n---\r\n# Title")).toBe("# Title");
    expect(stripFrontmatter("---\nname: tdd\n---")).toBe("");
  });

  it("leaves documents without front matter alone", () => {
    const body = "# Title\n\n---\nname: not front matter\n---\n";
    expect(stripFrontmatter(body)).toBe(body);
    expect(stripFrontmatter("")).toBe("");
  });

  it("does not treat a document that starts with a horizontal rule as front matter", () => {
    const rule = "---\n\nSome paragraph.\n\n---\n\nMore.";
    expect(stripFrontmatter(rule)).toBe(rule);
  });

  it("keeps an unterminated block", () => {
    const open = "---\nname: tdd\n\n# Title";
    expect(stripFrontmatter(open)).toBe(open);
  });

  it("rejects a long unterminated CRLF block in linear time", () => {
    const open = `---\r\n${"name: tdd\r\n".repeat(200)}\r\n# Title`;
    const started = performance.now();
    expect(stripFrontmatter(open)).toBe(open);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
