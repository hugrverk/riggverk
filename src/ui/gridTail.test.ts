import { describe, expect, it } from "vitest";
import { tailSpan, tailStyle } from "./gridTail";

describe("tailSpan", () => {
  it("lets the last cell take the empty slots of its row", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(count => tailSpan(count, 3))).toEqual([3, 2, 1, 3, 2, 1, 3]);
    expect([1, 2, 3, 4].map(count => tailSpan(count, 2))).toEqual([2, 1, 2, 1]);
  });

  it("is a single slot for an empty grid", () => {
    expect(tailSpan(0, 3)).toBe(1);
  });

  it("exposes the spans of both layouts as custom properties", () => {
    expect(tailStyle(4)).toEqual({ "--tail3": 3, "--tail2": 1 });
  });
});
