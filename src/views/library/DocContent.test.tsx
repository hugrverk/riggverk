import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocContent } from "./DocContent";

afterEach(cleanup);

const sample = "# Heading\n\nParagraph with [safe link](https://example.com).\n\n| A | B |\n|---|---|\n| 1 | 2 |";

describe("DocContent", () => {
  it("renders the scoped library docs surface with tables and links", () => {
    const { container } = render(<DocContent content={sample} />);
    const surface = container.querySelector(".lib-docs-markdown");
    expect(surface).not.toBeNull();
    expect(surface!.classList.contains("markdown-body")).toBe(true);
    expect(container.querySelector("table")).not.toBeNull();
    const link = container.querySelector("a[href='https://example.com']");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("blocks unsafe links instead of rendering them", () => {
    const { container } = render(<DocContent content="[local](/etc/passwd) [script](javascript:alert(1))" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".markdown-link-blocked")!.textContent).toBe("local");
    expect(container.textContent).toContain("script");
  });

  it("wraps fenced code in a copyable block", () => {
    const { container, getByRole } = render(<DocContent content={"```sh\nnpm test\n```"} />);
    expect(container.querySelector(".copyable-block pre.markdown-code")).not.toBeNull();
    expect(getByRole("button", { name: "Copy" })).not.toBeNull();
  });

  it("leaves YAML front matter out of the rendered text", () => {
    const { container } = render(<DocContent content={"---\nname: tdd\n---\n\n# Tdd"} />);
    expect(container.querySelector("hr")).toBeNull();
    expect(container.textContent).not.toContain("name: tdd");
    expect(container.querySelector("h1")!.textContent).toBe("Tdd");
  });
});
