import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionLevel } from "../lib/motion";
import { ActivityLoader, Elapsed, formatElapsed, RunningState } from "./TerminalOutput";

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

function setMotion(level: MotionLevel) {
  document.documentElement.setAttribute("data-motion", level);
}

describe("motion-aware progress elements", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.removeAttribute("data-motion");
  });

  describe("ActivityLoader", () => {
    it("is the idle loader under motion off, with no timer", () => {
      setMotion("off");
      const { container } = render(<ActivityLoader />);
      expect(container.querySelector(".terminal-activity")!.classList.contains("terminal-activity-idle")).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(activeCellIndex(container)).toBe(0);
    });

    it.each(["full", "subtle"] as const)("runs under %s", level => {
      setMotion(level);
      const { container } = render(<ActivityLoader />);
      expect(container.querySelector(".terminal-activity")!.classList.contains("terminal-activity-idle")).toBe(false);
      act(() => {
        vi.advanceTimersByTime(110);
      });
      expect(activeCellIndex(container)).toBe(1);
    });
  });

  describe("Elapsed", () => {
    it("formats tenths while motion runs and whole seconds when it is off", () => {
      expect(formatElapsed(1234, "full")).toBe("1.2s");
      expect(formatElapsed(1234, "subtle")).toBe("1.2s");
      expect(formatElapsed(1999, "off")).toBe("1s");
      expect(formatElapsed(0, "off")).toBe("0s");
    });

    it.each(["full", "subtle"] as const)("ticks every 100 ms under %s", level => {
      setMotion(level);
      const { container } = render(<Elapsed />);
      const clock = container.querySelector(".elapsed")!;
      expect(clock.textContent).toBe("0.0s");
      expect(clock.getAttribute("aria-hidden")).toBe("true");
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(clock.textContent).toBe("0.1s");
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(clock.textContent).toBe("1.2s");
    });

    it("ticks once a second under off", () => {
      setMotion("off");
      const { container } = render(<Elapsed />);
      const clock = container.querySelector(".elapsed")!;
      expect(clock.textContent).toBe("0s");
      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(clock.textContent).toBe("0s");
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(clock.textContent).toBe("1s");
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(clock.textContent).toBe("3s");
    });
  });

  describe("RunningState", () => {
    it("keeps the changing numbers out of the live region", () => {
      render(<RunningState label="update claude" progress={{ task: "apply_setup", phase: "apply", done: 1, total: 3, file: "~/a.md" }} />);
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-label")).toBe("update claude running");
      expect(status.querySelector(".tui-progress-label")!.textContent).toBe("working… · 1/3 · ~/a.md · 0.0s");
      expect(status.querySelector("[aria-hidden='true'] .elapsed, .elapsed[aria-hidden='true']")).not.toBeNull();
    });

    it("counts whole seconds under off", () => {
      setMotion("off");
      render(<RunningState label="update claude" />);
      expect(screen.getByRole("status").textContent).toBe("working… · 0s");
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByRole("status").textContent).toBe("working… · 1s");
    });
  });
});
