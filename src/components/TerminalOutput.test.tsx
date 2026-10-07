import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionLevel } from "../lib/motion";
import { ActivityLoader, Elapsed, formatElapsed, ProgressBar, RunningProgress, RunningState, Spinner } from "./TerminalOutput";

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

  describe("Spinner", () => {
    it.each(["full", "subtle"] as const)("turns through braille frames in one cell under %s", level => {
      setMotion(level);
      const { container } = render(<Spinner />);
      const spinner = container.querySelector(".spin")!;
      expect(spinner.getAttribute("aria-hidden")).toBe("true");
      expect(spinner.classList.contains("g")).toBe(true);
      expect(spinner.textContent).toBe("⠋");
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(spinner.textContent).toBe("⠙");
      act(() => {
        vi.advanceTimersByTime(900);
      });
      // Ten frames, then around again.
      expect(spinner.textContent).toBe("⠋");
    });

    it("is a still dot under off and never ticks", () => {
      setMotion("off");
      const { container } = render(<Spinner />);
      expect(container.querySelector(".spin")!.textContent).toBe("·");
      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(container.querySelector(".spin")!.textContent).toBe("·");
    });

    it("follows the motion level when it changes, and stops its timer on unmount", async () => {
      setMotion("full");
      const { container, unmount } = render(<Spinner />);
      expect(vi.getTimerCount()).toBe(1);
      // The attribute change reaches the component through a MutationObserver, a microtask.
      await act(async () => setMotion("off"));
      expect(container.querySelector(".spin")!.textContent).toBe("·");
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => setMotion("subtle"));
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
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

  describe("ProgressBar", () => {
    it.each(["full", "subtle", "off"] as const)("is a ten-cell progressbar under %s", level => {
      setMotion(level);
      const { container } = render(<ProgressBar done={4} total={7} />);
      const bar = screen.getByRole("progressbar");
      expect(bar.getAttribute("aria-valuemin")).toBe("0");
      expect(bar.getAttribute("aria-valuemax")).toBe("7");
      expect(bar.getAttribute("aria-valuenow")).toBe("4");
      expect(bar.getAttribute("aria-valuetext")).toBe("4 of 7");
      expect(container.querySelectorAll(".track .g")).toHaveLength(10);
      expect(container.querySelectorAll(".fill .g")).toHaveLength(10);
      expect(bar.textContent).toBe("░".repeat(10) + "█".repeat(10));
      expect(bar.getAttribute("style")).toContain("--p: 57%");
      expect(bar.classList.contains("done")).toBe(false);
      // The cells are decorative; the role carries the value.
      expect(container.querySelector(".track")!.getAttribute("aria-hidden")).toBe("true");
      expect(container.querySelector(".fill")!.getAttribute("aria-hidden")).toBe("true");
    });

    it("clamps to its range and marks a full bar done", () => {
      const { rerender } = render(<ProgressBar done={9} total={7} />);
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("7");
      expect(screen.getByRole("progressbar").getAttribute("style")).toContain("--p: 100%");
      expect(screen.getByRole("progressbar").classList.contains("done")).toBe(true);
      rerender(<ProgressBar done={0} total={7} />);
      expect(screen.getByRole("progressbar").getAttribute("style")).toContain("--p: 0%");
      expect(screen.getByRole("progressbar").classList.contains("done")).toBe(false);
    });

    it("moves by its custom property only, so the stylesheet decides whether it glides", () => {
      const { rerender } = render(<ProgressBar done={1} total={10} />);
      const fill = screen.getByRole("progressbar").querySelector(".fill")!;
      rerender(<ProgressBar done={5} total={10} />);
      // The same node, a new --p: the 160 ms transition (off under motion off) does the rest.
      expect(screen.getByRole("progressbar").querySelector(".fill")).toBe(fill);
      expect(screen.getByRole("progressbar").getAttribute("style")).toContain("--p: 50%");
    });
  });

  describe("RunningProgress", () => {
    it("shows the bar, count and file once files are counted", () => {
      render(<RunningProgress progress={{ task: "apply_setup", phase: "apply", done: 2, total: 5, file: "~/a.md" }} />);
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
      expect(document.body.textContent).toContain("2/5");
      expect(document.body.textContent).toContain("~/a.md");
    });

    it("shows a word instead of a bar while backing up or without progress", () => {
      const { rerender, container } = render(<RunningProgress />);
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(container.textContent).toBe("working…");
      rerender(<RunningProgress progress={{ task: "apply_setup", phase: "backup", done: 1, total: 5, file: "~/a.md" }} />);
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(container.textContent).toBe("backing up…");
      expect(container.querySelector(".terminal-activity")).not.toBeNull();
      rerender(<RunningProgress loader={false} />);
      expect(container.querySelector(".terminal-activity")).toBeNull();
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
