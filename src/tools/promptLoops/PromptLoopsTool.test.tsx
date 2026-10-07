import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInFrame, renderWithShell } from "../../test/renderWithShell";
import { PromptLoopsTool } from "./PromptLoopsTool";
import { PROMPT_LOOP_GROUPS } from "./data";
import { validatePromptLoopTemplates } from "./validateTemplates";

function renderTool(props: Parameters<typeof PromptLoopsTool>[0] = {}) {
  return renderWithShell(<PromptLoopsTool {...props} />);
}

/** Rows of the prompt list (the group and repo selects also expose role=option elements). */
function promptRows(): HTMLElement[] {
  return within(screen.getByRole("listbox", { name: "Prompts" })).queryAllByRole("option");
}

function selectedTitle(): string {
  const selected = promptRows().find(option => option.getAttribute("aria-selected") === "true");
  return selected?.querySelector(".nm")?.textContent ?? "";
}

describe("PromptLoopsTool", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("moves the prompt cursor with arrow keys and j/k from the list", () => {
    renderTool();
    const list = screen.getByRole("listbox", { name: "Prompts" });
    const options = promptRows();
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(PROMPT_LOOP_GROUPS[0]!.items[0]!.title);

    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(promptRows()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(PROMPT_LOOP_GROUPS[0]!.items[1]!.title);

    fireEvent.keyDown(list, { key: "k" });
    expect(promptRows()[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "j" });
    expect(promptRows()[2]?.getAttribute("aria-selected")).toBe("true");
  });

  it("ignores list and group shortcuts while an editable control is focused", () => {
    renderTool();
    const textarea = screen.getByRole("textbox", { name: "Optional task or context" });
    textarea.focus();
    const before = selectedTitle();
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "j" });
    fireEvent.keyDown(textarea, { key: "]" });
    fireEvent.keyDown(textarea, { key: ">", shiftKey: true });
    fireEvent.keyDown(textarea, { key: "y" });
    expect(selectedTitle()).toBe(before);
    expect(screen.getAllByRole("tab")[0]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(textarea);
  });

  it("renders prompt group tabs and narrow fallback select", () => {
    renderTool();
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
    renderTool();
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
    renderTool();
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[1]!);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(PROMPT_LOOP_GROUPS[1]!.items[0]!.title);
  });

  it("applies a context seed once and reports it as consumed", () => {
    const onContextSeedConsumed = vi.fn();
    const seed = { id: "seed-1", taskContext: "Selected Repo Dashboard item: fix the thing" };
    const { rerender } = renderTool({ contextSeed: seed, onContextSeedConsumed });

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
    renderTool({ contextSeed: null, onContextSeedConsumed });
    const textarea = screen.getByRole("textbox", { name: "Optional task or context" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    expect(onContextSeedConsumed).not.toHaveBeenCalled();
  });

  it("leaves number keys to the shell tab layer and does not switch groups with them", () => {
    renderTool();
    const tabs = screen.getAllByRole("tab");
    const digit = fireEvent.keyDown(document.body, { key: "2" });
    expect(digit).toBe(true);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
  });

  it("switches prompt groups with [ and ] and wraps around", () => {
    renderTool();
    const groups = PROMPT_LOOP_GROUPS;
    const selectedTab = () => screen.getAllByRole("tab").findIndex(tab => tab.getAttribute("aria-selected") === "true");
    expect(selectedTab()).toBe(0);

    fireEvent.keyDown(document.body, { key: "]" });
    expect(selectedTab()).toBe(1);
    expect(selectedTitle()).toBe(groups[1]!.items[0]!.title);

    fireEvent.keyDown(document.body, { key: "[" });
    fireEvent.keyDown(document.body, { key: "[" });
    expect(selectedTab()).toBe(groups.length - 1);

    fireEvent.keyDown(document.body, { key: "]" });
    expect(selectedTab()).toBe(0);
  });

  it("switches prompt groups with < and > as well (the Nordic Mac <> key)", () => {
    renderTool();
    const selectedTab = () => screen.getAllByRole("tab").findIndex(tab => tab.getAttribute("aria-selected") === "true");
    // `>` arrives with Shift held on that layout; Shift is not part of the match for printable keys.
    fireEvent.keyDown(document.body, { key: ">", shiftKey: true });
    expect(selectedTab()).toBe(1);
    fireEvent.keyDown(document.body, { key: "<" });
    expect(selectedTab()).toBe(0);
    fireEvent.keyDown(document.body, { key: "<" });
    expect(selectedTab()).toBe(PROMPT_LOOP_GROUPS.length - 1);
    fireEvent.keyDown(document.body, { key: ">", shiftKey: true });
    expect(selectedTab()).toBe(0);
  });

  it("resets the cursor to the first prompt of the new group", () => {
    renderTool();
    const list = screen.getByRole("listbox", { name: "Prompts" });
    list.focus();
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(document.body, { key: "]" });
    expect(promptRows()[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("focuses the filter with / from the list, filters prompts, and clears with Escape", () => {
    renderTool();
    const list = screen.getByRole("listbox", { name: "Prompts" });
    const filter = screen.getByRole("searchbox", { name: "Filter prompts" }) as HTMLInputElement;
    list.focus();
    fireEvent.keyDown(list, { key: "/" });
    expect(document.activeElement).toBe(filter);

    fireEvent.change(filter, { target: { value: "merge" } });
    const options = promptRows();
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("Merge readiness");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Merge readiness");

    // Escape in the field hands focus back to the list; Escape on the list then clears the filter.
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: "Escape" });
    expect(filter.value).toBe("");
    expect(promptRows().length).toBe(PROMPT_LOOP_GROUPS[0]!.items.length);
  });

  it("shows an empty state when the filter matches nothing", () => {
    renderTool();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter prompts" }), { target: { value: "zzzz-no-match" } });
    expect(screen.getByRole("status").textContent).toBe("no matching prompts");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("moves focus to the detail pane with Enter on a prompt", () => {
    renderTool();
    const list = screen.getByRole("listbox", { name: "Prompts" });
    list.focus();
    fireEvent.keyDown(list, { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Composed prompt" }));
  });

  it("copies the composed prompt with y and reports it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderTool({ contextSeed: { id: "seed-y", taskContext: "ship the fix" } });

    fireEvent.keyDown(document.body, { key: "y" });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("ship the fix");
    expect(writeText.mock.calls[0]?.[0]).toContain(PROMPT_LOOP_GROUPS[0]!.items[0]!.prompt.slice(0, 40));
    await waitFor(() => expect(screen.getByText("prompt copied")).not.toBeNull());
  });

  it("reports a failed copy instead of throwing", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    renderTool();
    fireEvent.keyDown(document.body, { key: "y" });
    await waitFor(() => expect(screen.getByText("copy failed")).not.toBeNull());
  });

  it("focuses the task context field with i", () => {
    renderTool();
    fireEvent.keyDown(document.body, { key: "i" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Optional task or context" }));
  });

  it("offers the group, copy and context keys as clickable hints", () => {
    renderInFrame(<PromptLoopsTool />);
    fireEvent.click(screen.getByRole("button", { name: /^> next group$/ }));
    expect(screen.getAllByRole("tab")[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^< prev$/ }));
    expect(screen.getAllByRole("tab")[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /^y copy$/ })).not.toBeNull();
    // The list's Enter binding shows up in the status bar.
    expect(screen.getAllByRole("button", { name: /compose/ }).length).toBeGreaterThan(0);
    // Hints are offered in NORMAL mode; clicking "context" moves into the text field (INSERT).
    fireEvent.click(screen.getByRole("button", { name: /context/ }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Optional task or context" }));
  });

  it("still switches prompt groups through the group tabs", () => {
    renderTool();
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[1]!);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  });
});
