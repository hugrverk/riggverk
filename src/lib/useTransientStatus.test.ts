import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTransientStatus } from "./useTransientStatus";

describe("useTransientStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears status after the timeout and on unmount", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useTransientStatus(500));

    act(() => {
      result.current.showStatus("saved");
    });
    expect(result.current.status).toBe("saved");

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.status).toBeNull();

    act(() => {
      result.current.showStatus("again");
    });
    unmount();
    vi.advanceTimersByTime(500);
  });
});
