import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLL_MS, RollingText } from "./RollingText";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
  cleanup();
});

function setMotion(level: "full" | "subtle" | "off") {
  document.documentElement.dataset.motion = level;
}

function leaving(container: HTMLElement) {
  return container.querySelector(".roll-old");
}

describe("RollingText", () => {
  it("renders the text without rolling on the first render", () => {
    setMotion("full");
    const { container } = render(<RollingText>3 to update</RollingText>);
    expect(screen.getByText("3 to update")).not.toBeNull();
    expect(leaving(container)).toBeNull();
    expect(container.querySelector(".roll")!.hasAttribute("data-rolling")).toBe(false);
  });

  it("rolls from the old value to the new one when the text changes, then drops the old one", () => {
    setMotion("full");
    const { container, rerender } = render(<RollingText>3 to update</RollingText>);
    rerender(<RollingText>current</RollingText>);

    const old = leaving(container)!;
    expect(old.textContent).toBe("3 to update");
    expect(old.getAttribute("aria-hidden")).toBe("true");
    // Assistive technology gets the current value only: the leaving copy is hidden, the new one is not.
    expect(container.querySelector(".roll-new")!.textContent).toBe("current");
    expect(container.querySelector(".roll-new")!.closest("[aria-hidden]")).toBeNull();
    expect(container.querySelector(".roll")!.hasAttribute("data-rolling")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(ROLL_MS + 50);
    });
    expect(leaving(container)).toBeNull();
    expect(container.querySelector(".roll")!.hasAttribute("data-rolling")).toBe(false);
    expect(container.textContent).toBe("current");
  });

  it.each(["subtle", "off"] as const)("swaps instantly at motion %s", level => {
    setMotion(level);
    const { container, rerender } = render(<RollingText>3 to update</RollingText>);
    rerender(<RollingText>current</RollingText>);
    expect(leaving(container)).toBeNull();
    expect(container.textContent).toBe("current");
  });

  it("does not roll on a re-render with the same text, or when only the class changes", () => {
    setMotion("full");
    const { container, rerender } = render(<RollingText className="c-warn">current</RollingText>);
    rerender(<RollingText className="c-warn">current</RollingText>);
    rerender(<RollingText className="c-ok">current</RollingText>);
    expect(leaving(container)).toBeNull();
    expect(container.querySelector(".roll-new")!.className).toContain("c-ok");
  });

  it("keeps the leaving value in its own tone", () => {
    setMotion("full");
    const { container, rerender } = render(<RollingText className="c-warn">update available</RollingText>);
    rerender(<RollingText className="c-ok">current</RollingText>);
    expect(leaving(container)!.className).toContain("c-warn");
    expect(container.querySelector(".roll-new")!.className).toContain("c-ok");
  });

  it("restarts from the latest value when it changes again mid-roll", () => {
    setMotion("full");
    const { container, rerender } = render(<RollingText>1</RollingText>);
    rerender(<RollingText>2</RollingText>);
    rerender(<RollingText>3</RollingText>);
    expect(leaving(container)!.textContent).toBe("2");
    expect(container.querySelector(".roll-new")!.textContent).toBe("3");
    act(() => {
      vi.advanceTimersByTime(ROLL_MS + 50);
    });
    expect(container.textContent).toBe("3");
  });

  it("does not roll when the caller re-keys it for a different subject", () => {
    setMotion("full");
    const { container, rerender } = render(<RollingText key="claude">3 to update</RollingText>);
    rerender(<RollingText key="codex">current</RollingText>);
    expect(leaving(container)).toBeNull();
    expect(container.textContent).toBe("current");
  });

  it("follows the OS preference when the app has not set a level", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const { container, rerender } = render(<RollingText>3 to update</RollingText>);
      rerender(<RollingText>current</RollingText>);
      expect(leaving(container)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
