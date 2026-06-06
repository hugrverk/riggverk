import { describe, expect, it } from "vitest";
import { classifyMarkdownHref } from "./markdownLinks";

describe("classifyMarkdownHref", () => {
  it("allows https links and blocks unsafe schemes", () => {
    expect(classifyMarkdownHref("https://example.com")).toBe("external");
    expect(classifyMarkdownHref("#section")).toBe("anchor");
    expect(classifyMarkdownHref("javascript:alert(1)")).toBe("blocked");
    expect(classifyMarkdownHref("/etc/passwd")).toBe("blocked");
  });
});
