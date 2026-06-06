import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptLoopsTool } from "./PromptLoopsTool";

describe("PromptLoopsTool", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not render obsolete switcher or shortcut hint blocks", () => {
    const { container } = render(<PromptLoopsTool />);
    expect(container.querySelector(".tools-switcher")).toBeNull();
    expect(container.querySelector(".tool-sidebar-footer")).toBeNull();
    expect(container.querySelector(".tool-sidebar-hints")).toBeNull();
    expect(screen.queryByText(/1–4/)).toBeNull();
    expect(screen.queryByText(/↑↓/)).toBeNull();
  });

  it("navigates prompt items with arrow keys outside editable controls", () => {
    const { container } = render(<PromptLoopsTool />);
    const cards = () => container.querySelectorAll(".prompt-loops-card");
    expect(cards().length).toBeGreaterThan(1);
    const firstActive = container.querySelector(".prompt-loops-card-active");
    expect(firstActive).not.toBeNull();

    fireEvent.keyDown(document, { key: "ArrowDown" });
    const secondActive = container.querySelector(".prompt-loops-card-active");
    expect(secondActive).not.toBe(firstActive);
  });

  it("ignores global shortcuts while an editable control is focused", () => {
    const { container } = render(<PromptLoopsTool />);
    const textarea = screen.getByRole("textbox", { name: "Optional task or context" });
    textarea.focus();
    const before = container.querySelector(".prompt-loops-card-active");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    const after = container.querySelector(".prompt-loops-card-active");
    expect(after).toBe(before);
  });

  it("switches prompt groups with number keys outside editable controls", () => {
    render(<PromptLoopsTool />);
    const groupNav = screen.getByRole("navigation", { name: "Prompt groups" });
    const buttons = groupNav.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons[0]?.className).toContain("prompt-loops-nav-btn-active");

    fireEvent.keyDown(document, { key: "2" });
    expect(buttons[1]?.className).toContain("prompt-loops-nav-btn-active");
  });
});
