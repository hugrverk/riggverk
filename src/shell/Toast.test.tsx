import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import { useShellState } from "./ShellState";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Toast", () => {
  function Notifier({ text = "applied", options }: { text?: string; options?: Parameters<ReturnType<typeof useShellState>["notify"]>[1] }) {
    const { notify } = useShellState();
    return <button type="button" onClick={() => notify(text, options)}>notify</button>;
  }
  const toast = () => document.querySelector(".toast")!;

  it("is an always-mounted polite live region, empty until a notice", () => {
    renderInFrame(<Notifier />);
    expect(toast().getAttribute("role")).toBe("status");
    expect(toast().getAttribute("aria-live")).toBe("polite");
    expect(toast().textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(toast().textContent).toBe("applied");
  });

  it.each(["ok", "warn", "fail"] as const)("carries the %s tone, with the text unchanged", tone => {
    renderInFrame(<Notifier text="nothing to update" options={{ tone }} />);
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(toast().querySelector(".toast-text")!.getAttribute("data-tone")).toBe(tone);
    expect(toast().textContent).toBe("nothing to update");
  });

  it("goes away with its notice, and the tone goes with it", () => {
    vi.useFakeTimers();
    renderInFrame(<Notifier options={{ tone: "ok" }} />);
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(toast().querySelector(".toast-text")!.getAttribute("data-tone")).toBe("ok");
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(toast().querySelector(".toast-text")).toBeNull();
  });

  it("takes a bare number as the duration, as before", () => {
    vi.useFakeTimers();
    renderInFrame(<Notifier options={1000} />);
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(toast().textContent).toBe("applied");
    expect(toast().querySelector(".toast-text")!.hasAttribute("data-tone")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(toast().textContent).toBe("");
  });

  it("restarts the entrance for a repeat of the same text", () => {
    renderInFrame(<Notifier />);
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    const first = toast().querySelector(".toast-text");
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(toast().querySelector(".toast-text")).not.toBe(first);
  });
});
