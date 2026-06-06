import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useResourceRequestGuard } from "./useResourceRequestGuard";

describe("useResourceRequestGuard", () => {
  it("invalidates stale responses when selection changes", () => {
    const { result } = renderHook(() => useResourceRequestGuard());
    let firstToken = 0;
    act(() => {
      firstToken = result.current.beginRequest();
    });
    act(() => {
      result.current.invalidate();
    });
    expect(result.current.isCurrentRequest(firstToken)).toBe(false);
  });

  it("accepts only the latest request token", async () => {
    const { result } = renderHook(() => useResourceRequestGuard());
    let slowToken = 0;
    let fastToken = 0;
    act(() => {
      slowToken = result.current.beginRequest();
      fastToken = result.current.beginRequest();
    });
    await Promise.resolve();
    expect(result.current.isCurrentRequest(slowToken)).toBe(false);
    expect(result.current.isCurrentRequest(fastToken)).toBe(true);
  });
});
