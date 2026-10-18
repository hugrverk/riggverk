import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "../types";
import { useScanOnSuccess } from "./useScanOnSuccess";

const APPLY: ActionResult = { success: true, action: "apply_setup update claude", stdout: "", stderr: "", exit_code: 0 };
const ROLLBACK: ActionResult = { ...APPLY, action: "rollback_setup_transaction" };

let area: HTMLDivElement;

beforeEach(() => {
  area = document.createElement("div");
  area.className = "view-area";
  document.body.appendChild(area);
  document.documentElement.setAttribute("data-motion", "full");
});

afterEach(() => {
  cleanup();
  area.remove();
  document.documentElement.removeAttribute("data-motion");
  vi.useRealTimers();
});

function scanning() {
  return area.classList.contains("scan");
}

/** jsdom has no AnimationEvent; the hook only reads `animationName`. */
function animationEnd(animationName: string) {
  act(() => {
    area.dispatchEvent(Object.assign(new Event("animationend", { bubbles: true }), { animationName }));
  });
}

type Props = { running: string | null; log: ActionResult | null };

function mount(initial: Props = { running: null, log: null }) {
  return renderHook(({ running, log }: Props) => useScanOnSuccess(running, log), { initialProps: initial });
}

describe("useScanOnSuccess", () => {
  it("sweeps once when an apply succeeds and stops when the sweep animation ends", () => {
    const { rerender } = mount({ running: "update claude", log: null });
    expect(scanning()).toBe(false);
    rerender({ running: null, log: APPLY });
    expect(scanning()).toBe(true);
    // Other animations inside the view bubble up and do not end it.
    animationEnd("tick-pop");
    expect(scanning()).toBe(true);
    animationEnd("view-scan");
    expect(scanning()).toBe(false);
  });

  it("sweeps for a rollback, a rules conversion and a take bundled", () => {
    const { rerender } = mount();
    rerender({ running: null, log: ROLLBACK });
    expect(scanning()).toBe(true);
    animationEnd("view-scan");
    rerender({ running: null, log: { ...APPLY, action: "apply_rules_conversion codex rules" } });
    expect(scanning()).toBe(true);
    animationEnd("view-scan");
    rerender({ running: null, log: { ...APPLY, action: "apply_take_bundled tdd" } });
    expect(scanning()).toBe(true);
  });

  it("waits for the task to stop running before it sweeps", () => {
    const { rerender } = mount({ running: "update claude", log: null });
    rerender({ running: "update claude", log: APPLY });
    expect(scanning()).toBe(false);
    rerender({ running: null, log: APPLY });
    expect(scanning()).toBe(true);
  });

  it("does nothing for a failure, an uninstall or an action it does not know", () => {
    const { rerender } = mount();
    for (const log of [
      { ...APPLY, success: false },
      { ...APPLY, action: "apply_uninstall" },
      { ...APPLY, action: "apply_setup_extra" },
    ]) {
      rerender({ running: null, log });
      expect(scanning()).toBe(false);
    }
  });

  it("does nothing for a result that was already there on mount", () => {
    const { rerender } = mount({ running: null, log: APPLY });
    expect(scanning()).toBe(false);
    rerender({ running: null, log: APPLY });
    expect(scanning()).toBe(false);
  });

  it("sweeps under full motion only", () => {
    for (const level of ["subtle", "off"]) {
      document.documentElement.setAttribute("data-motion", level);
      const { rerender, unmount } = mount();
      rerender({ running: null, log: APPLY });
      expect(scanning(), level).toBe(false);
      unmount();
    }
  });

  it("starts the next sweep over one that is still on screen", () => {
    const { rerender } = mount();
    rerender({ running: null, log: APPLY });
    expect(scanning()).toBe(true);
    rerender({ running: null, log: { ...APPLY } });
    expect(scanning()).toBe(true);
    animationEnd("view-scan");
    expect(scanning()).toBe(false);
  });

  it("clears the class by itself when the animation never reports its end, and on unmount", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = mount();
    rerender({ running: null, log: APPLY });
    expect(scanning()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(scanning()).toBe(false);

    rerender({ running: null, log: ROLLBACK });
    expect(scanning()).toBe(true);
    unmount();
    expect(scanning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is harmless without a view area", () => {
    area.remove();
    const { rerender } = mount();
    expect(() => rerender({ running: null, log: APPLY })).not.toThrow();
  });
});
