import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptLoopsTool } from "./PromptLoopsTool";
import { PROMPT_LOOP_GROUPS } from "./data";
import { validatePromptLoopTemplates } from "./validateTemplates";

describe("PromptLoopsTool", () => {
  afterEach(() => {
    cleanup();
  });

  it("navigates prompt items with arrow keys outside editable controls", () => {
    const { container } = render(<PromptLoopsTool />);
    const cards = Array.from(container.querySelectorAll(".prompt-loops-card"));
    expect(cards.length).toBeGreaterThan(1);
    const firstActive = container.querySelector(".prompt-loops-card-active");
    expect(firstActive).toBe(cards[0]);

    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(container.querySelector(".prompt-loops-card-active")).toBe(cards[1]);

    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(container.querySelector(".prompt-loops-card-active")).toBe(cards[0]);
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

  it("selects prompt groups from tabs", () => {
    render(<PromptLoopsTool />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[1]!);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
  });

  it("applies a context seed once and reports it as consumed", () => {
    const onContextSeedConsumed = vi.fn();
    const seed = { id: "seed-1", taskContext: "Selected Repo Dashboard item: fix the thing" };
    const { rerender } = render(
      <PromptLoopsTool contextSeed={seed} onContextSeedConsumed={onContextSeedConsumed} />,
    );

    const textarea = screen.getByRole("textbox", { name: "Optional task or context" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe(seed.taskContext);
    expect(onContextSeedConsumed).toHaveBeenCalledTimes(1);
    expect(onContextSeedConsumed).toHaveBeenCalledWith("seed-1");

    // Re-rendering with the same seed (owner has not cleared it yet) must not re-apply or re-report it.
    fireEvent.change(textarea, { target: { value: "edited by the user" } });
    rerender(<PromptLoopsTool contextSeed={seed} onContextSeedConsumed={onContextSeedConsumed} />);
    expect((screen.getByRole("textbox", { name: "Optional task or context" }) as HTMLTextAreaElement).value).toBe("edited by the user");
    expect(onContextSeedConsumed).toHaveBeenCalledTimes(1);
  });

  it("does not apply anything when the owner has already cleared the seed", () => {
    const onContextSeedConsumed = vi.fn();
    render(<PromptLoopsTool contextSeed={null} onContextSeedConsumed={onContextSeedConsumed} />);
    const textarea = screen.getByRole("textbox", { name: "Optional task or context" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    expect(onContextSeedConsumed).not.toHaveBeenCalled();
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
