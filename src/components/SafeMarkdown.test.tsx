import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeMarkdown } from "./SafeMarkdown";

describe("SafeMarkdown", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders fenced code with exactly one pre element", () => {
    const { container } = render(<SafeMarkdown content={"```ts\nconst x = 1;\n```"} />);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("pre code")?.textContent?.trim()).toBe("const x = 1;");
  });

  it("renders inline code without a pre element", () => {
    const { container } = render(<SafeMarkdown content={"Use `inline` here."} />);
    expect(container.querySelectorAll("pre")).toHaveLength(0);
    expect(container.querySelector("code.markdown-inline-code")?.textContent).toBe("inline");
  });

  it("passes exact fenced code text to the copy control", async () => {
    render(<SafeMarkdown content={"```\nline one\nline two\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("line one\nline two");
  });

  it("keeps external and blocked link safety behavior", () => {
    const { container } = render(
      <SafeMarkdown content={"[safe](https://example.com) [blocked](/etc/passwd)"} />,
    );
    const safe = container.querySelector("a[href='https://example.com']");
    expect(safe).not.toBeNull();
    expect(safe?.getAttribute("target")).toBe("_blank");
    expect(safe?.getAttribute("rel")).toContain("noopener");
    expect(container.querySelector(".markdown-link-blocked")).not.toBeNull();
  });

  it("renders tables and prose", () => {
    const { container } = render(
      <SafeMarkdown content={"Hello world\n\n| A | B |\n|---|---|\n| 1 | 2 |"} />,
    );
    expect(container.textContent).toContain("Hello world");
    expect(container.querySelector("table")).not.toBeNull();
  });
});
