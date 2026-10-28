import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverviewEntry } from "./useInstallationOverview";
import { useCheckedAt } from "./useCheckedAt";

afterEach(() => {
  vi.useRealTimers();
});

const entries = { workspace: { id: "workspace", status: null, loading: false, error: null } satisfies OverviewEntry };

describe("useCheckedAt", () => {
  it("is null until a fetch has settled, then the time it settled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 28, 15, 42));
    const { result, rerender } = renderHook((props: Parameters<typeof useCheckedAt>[0]) => useCheckedAt(props), {
      initialProps: { loading: false, entries: {} },
    });
    expect(result.current).toBeNull();
    rerender({ loading: true, entries });
    expect(result.current).toBeNull();
    vi.setSystemTime(new Date(2026, 9, 28, 15, 43));
    act(() => rerender({ loading: false, entries }));
    expect(result.current).toEqual(new Date(2026, 9, 28, 15, 43));
  });

  it("does not count a fetch that left no entries (unusable folder)", () => {
    const { result, rerender } = renderHook((props: Parameters<typeof useCheckedAt>[0]) => useCheckedAt(props), {
      initialProps: { loading: true, entries: {} },
    });
    rerender({ loading: false, entries: {} });
    expect(result.current).toBeNull();
  });
});
