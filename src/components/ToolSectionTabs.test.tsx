import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolSectionTabs } from "./ToolSectionTabs";

const ITEMS = [
  { id: "a", label: "Alpha", count: 1 },
  { id: "b", label: "Beta", count: 2 },
  { id: "c", label: "Gamma", count: 3 },
];

describe("ToolSectionTabs", () => {
  afterEach(() => {
    cleanup();
  });

  it("exposes tablist semantics and active selection", () => {
    render(
      <ToolSectionTabs
        items={ITEMS}
        activeId="b"
        onSelect={() => {}}
        ariaLabel="Sections"
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("tabindex")).toBe("-1");
    expect(tabs[1]?.getAttribute("tabindex")).toBe("0");
  });

  it("keeps the accessible name on the tab and the bracketed look purely visual", () => {
    render(<ToolSectionTabs items={ITEMS} activeId="b" onSelect={() => {}} ariaLabel="Sections" />);
    const active = screen.getByRole("tab", { name: "Beta, 2" });
    // `[beta 2]` is drawn with CSS brackets on the active class; the visible text nodes are decoration for the aria-label.
    expect(active.className).toContain("tool-section-tab-active");
    expect(screen.getByRole("tab", { name: "Alpha, 1" }).className).not.toContain("tool-section-tab-active");
    expect(active.querySelector(".tool-section-tab-label")?.getAttribute("aria-hidden")).toBe("true");
    expect(active.querySelector(".tool-section-tab-count")?.getAttribute("aria-hidden")).toBe("true");
    expect(active.textContent).toBe("Beta2");
  });

  it("moves selection with arrow keys", () => {
    const onSelect = vi.fn();
    render(
      <ToolSectionTabs
        items={ITEMS}
        activeId="a"
        onSelect={onSelect}
        ariaLabel="Sections"
      />,
    );
    const first = screen.getByRole("tab", { name: "Alpha, 1" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("jumps to ends with Home and End", () => {
    const onSelect = vi.fn();
    render(
      <ToolSectionTabs
        items={ITEMS}
        activeId="b"
        onSelect={onSelect}
        ariaLabel="Sections"
      />,
    );
    const active = screen.getByRole("tab", { name: "Beta, 2" });
    active.focus();
    fireEvent.keyDown(active, { key: "End" });
    expect(onSelect).toHaveBeenCalledWith("c");
    onSelect.mockClear();
    fireEvent.keyDown(active, { key: "Home" });
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});
