import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMotionSetting, currentMotion, effectiveMotion, normalizeMotion, useMotion } from "./motion";
import { applyThemeSettings, defaultSettings } from "./settingsDraft";

type ChangeListener = (event: { matches: boolean }) => void;

/** A controllable `prefers-reduced-motion` media query. */
function installReducedMotionQuery(initial: boolean) {
  const listeners = new Set<ChangeListener>();
  const query = {
    matches: initial,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn((_type: string, listener: ChangeListener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: ChangeListener) => listeners.delete(listener)),
  };
  window.matchMedia = vi.fn(() => query) as unknown as typeof window.matchMedia;
  return {
    listeners,
    setReduced(matches: boolean) {
      query.matches = matches;
      listeners.forEach(listener => listener({ matches }));
    },
  };
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  document.documentElement.removeAttribute("data-motion");
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  // Drop the OS-preference watcher a test may have left behind.
  applyMotionSetting("full");
  document.documentElement.removeAttribute("data-motion");
});

describe("normalizeMotion", () => {
  it("keeps the three levels and falls back to full", () => {
    expect(normalizeMotion("full")).toBe("full");
    expect(normalizeMotion("subtle")).toBe("subtle");
    expect(normalizeMotion("off")).toBe("off");
    expect(normalizeMotion("reduced")).toBe("full");
    expect(normalizeMotion(undefined)).toBe("full");
    expect(normalizeMotion(true)).toBe("full");
  });
});

describe("effectiveMotion", () => {
  it("returns the setting when the OS asks for nothing", () => {
    expect(effectiveMotion("full", false)).toBe("full");
    expect(effectiveMotion("subtle", false)).toBe("subtle");
    expect(effectiveMotion("off", false)).toBe("off");
  });

  it("lets the OS reduced-motion preference win over every setting", () => {
    expect(effectiveMotion("full", true)).toBe("off");
    expect(effectiveMotion("subtle", true)).toBe("off");
    expect(effectiveMotion("off", true)).toBe("off");
  });
});

describe("currentMotion", () => {
  it("reads data-motion from the root element", () => {
    document.documentElement.setAttribute("data-motion", "subtle");
    expect(currentMotion()).toBe("subtle");
  });

  it("defaults to full without the attribute or matchMedia", () => {
    expect(currentMotion()).toBe("full");
  });

  it("honours the OS preference before the attribute exists", () => {
    installReducedMotionQuery(true);
    expect(currentMotion()).toBe("off");
  });
});

describe("applyMotionSetting", () => {
  it("writes the effective level to data-motion", () => {
    applyMotionSetting("subtle");
    expect(document.documentElement.getAttribute("data-motion")).toBe("subtle");
    applyMotionSetting("bogus");
    expect(document.documentElement.getAttribute("data-motion")).toBe("full");
  });

  it("applies off while the OS asks for reduced motion and follows later changes", () => {
    const os = installReducedMotionQuery(true);
    applyMotionSetting("full");
    expect(document.documentElement.getAttribute("data-motion")).toBe("off");

    os.setReduced(false);
    expect(document.documentElement.getAttribute("data-motion")).toBe("full");
    os.setReduced(true);
    expect(document.documentElement.getAttribute("data-motion")).toBe("off");
  });

  it("keeps a single watcher across repeated applies", () => {
    const os = installReducedMotionQuery(false);
    applyMotionSetting("full");
    applyMotionSetting("subtle");
    applyMotionSetting("off");
    expect(os.listeners.size).toBe(1);

    os.setReduced(false);
    expect(document.documentElement.getAttribute("data-motion")).toBe("off");
  });
});

describe("applyThemeSettings", () => {
  it("sets data-motion from the motion setting and no longer sets data-reduce-motion", () => {
    applyThemeSettings({ ...defaultSettings(), motion: "off" });
    expect(document.documentElement.getAttribute("data-motion")).toBe("off");
    expect(document.documentElement.hasAttribute("data-reduce-motion")).toBe(false);
    applyThemeSettings({ ...defaultSettings(), motion: "subtle" });
    expect(document.documentElement.getAttribute("data-motion")).toBe("subtle");
  });

  it("runs with motion off while the OS asks for reduced motion", () => {
    installReducedMotionQuery(true);
    applyThemeSettings({ ...defaultSettings(), motion: "full" });
    expect(document.documentElement.getAttribute("data-motion")).toBe("off");
  });
});

describe("useMotion", () => {
  it("follows the setting and the OS preference", async () => {
    const os = installReducedMotionQuery(false);
    applyMotionSetting("subtle");
    const { result } = renderHook(() => useMotion());
    expect(result.current).toBe("subtle");

    act(() => applyMotionSetting("full"));
    await waitFor(() => expect(result.current).toBe("full"));

    act(() => os.setReduced(true));
    await waitFor(() => expect(result.current).toBe("off"));

    act(() => os.setReduced(false));
    await waitFor(() => expect(result.current).toBe("full"));
  });
});
