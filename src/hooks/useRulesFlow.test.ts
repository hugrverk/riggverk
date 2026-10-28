import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RulesDiffView } from "../types";
import { isInlineFileState, type FileReviewState } from "./useFileConflictFlow";
import { isInlineRulesState, useRulesFlow, type RulesReviewState } from "./useRulesFlow";
import type { RunWorkspaceTask } from "./useInstallScreen";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const DIFF = { surface: "claude_rules", mode: "edits", from_label: "a", to_label: "b", diff: "", added: 0, removed: 0, truncated: false, applicable: true, note: null, compared_base: null } as RulesDiffView;

beforeEach(() => {
  invokeMock.mockReset();
});

describe("which rules review is inline", () => {
  it("is the diff, while it loads, while it shows and when it failed; the conversion takes the page's place", () => {
    const inline: RulesReviewState[] = [
      { status: "loading", surface: "claude_rules", what: "diff" },
      { status: "diff", surface: "claude_rules", diff: DIFF },
      { status: "error", surface: "claude_rules", what: "diff", message: "x" },
    ];
    const replacing: RulesReviewState[] = [
      { status: "idle" },
      { status: "loading", surface: "claude_rules", what: "conversion" },
      { status: "error", surface: "claude_rules", what: "conversion", message: "x" },
      { status: "error", surface: "claude_rules", what: "apply", message: "x" },
    ];
    expect(inline.map(isInlineRulesState)).toEqual([true, true, true]);
    expect(replacing.map(isInlineRulesState)).toEqual([false, false, false, false]);
  });
});

describe("which file review is inline", () => {
  it("is the diff of a unit in the same three states; take bundled takes the page's place", () => {
    const inline: FileReviewState[] = [
      { status: "loading", surface: "skills", unit: "u", what: "diff" },
      { status: "error", surface: "skills", unit: "u", what: "diff", message: "x" },
    ];
    const replacing: FileReviewState[] = [
      { status: "idle" },
      { status: "loading", surface: "skills", unit: "u", what: "bundled" },
      { status: "error", surface: "skills", unit: "u", what: "apply", message: "x" },
    ];
    expect(inline.map(isInlineFileState)).toEqual([true, true]);
    expect(replacing.map(isInlineFileState)).toEqual([false, false, false]);
  });
});

describe("useRulesFlow inline and reviewing", () => {
  function setup() {
    return renderHook(() => useRulesFlow({ runWorkspaceTask: vi.fn() as unknown as RunWorkspaceTask, refresh: vi.fn(), onApplied: vi.fn() }));
  }

  it("keeps the page for a diff (open and inline, not reviewing) and replaces it for a conversion", async () => {
    invokeMock.mockImplementation(async (command: string) => (command === "preview_rules_diff" ? DIFF : { applicable: true }));
    const { result } = setup();
    expect([result.current.open, result.current.inline, result.current.reviewing]).toEqual([false, false, false]);
    await act(async () => {
      await result.current.openDiff("claude_rules", "edits");
    });
    expect([result.current.open, result.current.inline, result.current.reviewing]).toEqual([true, true, false]);
    // Closing the diff, and opening a conversion from it, are the same transitions as before.
    await act(async () => {
      await result.current.openConversion("claude_rules");
    });
    expect([result.current.open, result.current.inline, result.current.reviewing]).toEqual([true, false, true]);
    act(() => result.current.close());
    expect([result.current.open, result.current.inline, result.current.reviewing]).toEqual([false, false, false]);
  });
});
