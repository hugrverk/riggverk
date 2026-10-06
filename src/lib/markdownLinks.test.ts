import { describe, expect, it } from "vitest";
import { classifyMarkdownHref, isSafeExternalMarkdownHref } from "./markdownLinks";

describe("classifyMarkdownHref", () => {
  it.each([
    "https://example.com",
    "http://example.com/path?q=1#frag",
    "HTTPS://EXAMPLE.COM",
    "  https://example.com  ",
    "\nhttps://example.com\n",
  ])("treats %j as an external link", href => {
    expect(classifyMarkdownHref(href)).toBe("external");
  });

  it.each(["#section", "#", "  #top  "])("treats %j as an in-page anchor", href => {
    expect(classifyMarkdownHref(href)).toBe("anchor");
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "mailto:someone@example.com",
    "tel:+4600000000",
    "ftp://example.com/file",
    "vscode://file/etc/passwd",
    "custom-scheme+v1.0:thing",
    "//evil.example.com/path",
    "///evil.example.com",
    "/etc/passwd",
    "~/.ssh/id_rsa",
    "docs/readme.md",
    "./relative.md",
    "../up.md",
    "example.com",
    "httpx://example.com",
  ])("blocks %j", href => {
    expect(classifyMarkdownHref(href)).toBe("blocked");
  });
});

describe("isSafeExternalMarkdownHref", () => {
  it("is true only for http(s) links", () => {
    expect(isSafeExternalMarkdownHref("https://example.com")).toBe(true);
    expect(isSafeExternalMarkdownHref("#anchor")).toBe(false);
    expect(isSafeExternalMarkdownHref("mailto:a@b.c")).toBe(false);
  });
});
