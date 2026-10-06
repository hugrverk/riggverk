import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLoader } from "./TerminalOutput";

function activeCellIndex(container: HTMLElement): number {
  const cells = Array.from(container.querySelectorAll(".terminal-activity-cell"));
  return cells.findIndex(cell => cell.classList.contains("terminal-activity-cell-active"));
}

describe("ActivityLoader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("animates by itself while running", () => {
    const { container } = render(<ActivityLoader />);
    expect(container.querySelectorAll(".terminal-activity-cell")).toHaveLength(8);
    expect(activeCellIndex(container)).toBe(0);

    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(activeCellIndex(container)).toBe(1);

    act(() => {
      vi.advanceTimersByTime(110 * 7);
    });
    expect(activeCellIndex(container)).toBe(0);
  });

  it("does not tick while idle and stops its timer on unmount", () => {
    const idle = render(<ActivityLoader idle />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(activeCellIndex(idle.container)).toBe(0);
    idle.unmount();

    const running = render(<ActivityLoader />);
    running.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
