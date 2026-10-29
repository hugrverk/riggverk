import { describe, expect, it } from "vitest";
import { docSlug } from "./slug";

describe("docSlug", () => {
  it("makes a file name of a title", () => {
    expect(docSlug("Kretsverket release notes")).toBe("kretsverket-release-notes");
    expect(docSlug("  Släpp  &  Vänta! ")).toBe("slapp-vanta");
  });

  it("gives nothing for a title without letters or digits", () => {
    expect(docSlug("  ?!  ")).toBe("");
    expect(docSlug("")).toBe("");
  });

  it("keeps the slug short and never ends it with a hyphen", () => {
    const slug = docSlug(`${"word ".repeat(30)}end`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});
