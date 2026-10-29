import { describe, expect, it } from "vitest";
import { docSlug } from "./slug";

describe("docSlug", () => {
  it("makes a file name of a title", () => {
    expect(docSlug("Kretsverket release notes")).toBe("kretsverket-release-notes");
    expect(docSlug("  Släpp  &  Vänta! ")).toBe("slapp-vanta");
  });

  it("turns common accented letters into plain ones", () => {
    expect(docSlug("Åsa & Örjan på Ängön")).toBe("asa-orjan-pa-angon");
    expect(docSlug("Café déjà vu")).toBe("cafe-deja-vu");
    expect(docSlug("Smørrebrød Æble Straße")).toBe("smorrebrod-aeble-strasse");
  });

  it("gives nothing for a title without letters or digits", () => {
    expect(docSlug("日本語")).toBe("");
    expect(docSlug("---")).toBe("");
    expect(docSlug("  ?!  ")).toBe("");
    expect(docSlug("")).toBe("");
  });

  it("keeps the slug short and never ends it with a hyphen", () => {
    const slug = docSlug(`${"word ".repeat(30)}end`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});
