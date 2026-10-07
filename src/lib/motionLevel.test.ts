import { afterEach, describe, expect, it, vi } from "vitest";
import { motionLevel } from "./motionLevel";

afterEach(() => {
  delete document.documentElement.dataset.motion;
  delete document.documentElement.dataset.reduceMotion;
  vi.unstubAllGlobals();
});

describe("motionLevel", () => {
  it("is full when nothing says otherwise", () => {
    expect(motionLevel()).toBe("full");
  });

  it.each(["full", "subtle", "off"] as const)("reads data-motion=%s", level => {
    document.documentElement.dataset.motion = level;
    expect(motionLevel()).toBe(level);
  });

  it("ignores an unknown data-motion value", () => {
    document.documentElement.dataset.motion = "wild";
    expect(motionLevel()).toBe("full");
  });

  it("follows the OS preference and the legacy reduce-motion setting while data-motion is unset", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(motionLevel()).toBe("off");
    vi.unstubAllGlobals();
    document.documentElement.dataset.reduceMotion = "true";
    expect(motionLevel()).toBe("off");
  });

  it("lets an explicit data-motion win over both", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.documentElement.dataset.reduceMotion = "true";
    document.documentElement.dataset.motion = "subtle";
    expect(motionLevel()).toBe("subtle");
  });
});
