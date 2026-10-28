import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const frame = readFileSync(resolve(import.meta.dirname, "styles", "_frame.scss"), "utf8");

/** The declaration block of the first rule whose selector list is exactly `selector`. */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frame.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `rule ${selector}`).not.toBeNull();
  return match![1]!;
}

describe("frame styles", () => {
  it("keeps the macOS traffic lights (80 x 40 from the window corner) clear and draggable", () => {
    const side = block(".side");
    expect(side).toMatch(/width:\s*200px/);
    // padding: <top> 0 <bottom>; the top band must cover the lights.
    const top = Number(side.match(/padding:\s*(\d+)px/)?.[1]);
    expect(top).toBeGreaterThanOrEqual(40);
    expect(side).toMatch(/app-region:\s*drag/);
    expect(block(".side nav")).toMatch(/app-region:\s*no-drag/);
  });

  it("makes the top bar 54px and draggable, with no-drag buttons", () => {
    expect(block(".bar")).toMatch(/height:\s*54px/);
    expect(block(".bar")).toMatch(/app-region:\s*drag/);
    expect(block(".bar .b")).toMatch(/app-region:\s*no-drag/);
  });

  it("draws the current item's hairline with a 2px scaleY bar, never a border", () => {
    const before = block(".side .nav::before");
    expect(before).toMatch(/width:\s*2px/);
    expect(before).toMatch(/transform:\s*scaleY\(0\)/);
    expect(before).toMatch(/transition:\s*transform var\(--dur-nav\) var\(--ease\)/);
    expect(frame).toMatch(/\.side \.nav\[aria-current="page"\]::before\s*\{\s*transform:\s*scaleY\(1\)/);
    expect(frame).not.toMatch(/border-left/);
  });

  it("keeps the toast out of the pointer's way", () => {
    expect(block(".toast")).toMatch(/pointer-events:\s*none/);
  });

  it("uses no radius and no amber", () => {
    expect(frame).not.toMatch(/border-radius/);
    expect(frame).not.toMatch(/#(?:e9c05a|7a4d00|cfa65c|8a6412)/i);
  });
});
