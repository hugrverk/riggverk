import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptLoopsTool } from "./PromptLoopsTool";
import { PROMPT_LOOP_GROUPS } from "./data";
import { validatePromptLoopTemplates } from "./validateTemplates";

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

  it("renders prompt group tabs and narrow fallback select", () => {
    render(<PromptLoopsTool />);
    expect(screen.queryByRole("navigation", { name: "Prompt groups" })).toBeNull();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(1);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Prompt group" })).not.toBeNull();
  });

  it("uses the current Prompt, Goal Prompt, Batch Prompt taxonomy", () => {
    expect(PROMPT_LOOP_GROUPS.map(group => [group.group, group.key])).toEqual([
      ["Prompt", "prompt"],
      ["Goal Prompt", "goal-prompt"],
      ["Batch Prompt", "batch-prompt"],
      ["Rewrite", "rewrite"],
    ]);
    render(<PromptLoopsTool />);
    expect(screen.getByRole("tab", { name: /^Prompt, 3$/ })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /^Goal Prompt, 3$/ })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /^Batch Prompt, 3$/ })).not.toBeNull();
    expect(screen.queryByRole("tab", { name: /Masterprompt/i })).toBeNull();
  });

  it("keeps prompt templates on the modern contract", () => {
    expect(validatePromptLoopTemplates()).toEqual([]);
    const serialized = JSON.stringify(PROMPT_LOOP_GROUPS);
    expect(serialized).toContain("4000 characters");
    expect(serialized).not.toMatch(/Operator metadata:|Recommended executor:|Recommended target:|masterprompt/i);
  });

  it("does not render legacy sidebar chrome", () => {
    const { container } = render(<PromptLoopsTool />);
    expect(container.querySelector(".prompt-loops-sidebar")).toBeNull();
  });

  it("selects prompt groups from tabs", () => {
    render(<PromptLoopsTool />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[1]!);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
  });

  it("switches prompt groups with number keys outside editable controls", () => {
    render(<PromptLoopsTool />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(1);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(document, { key: "2" });
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  });
});
