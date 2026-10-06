import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

let shouldThrow = true;

function Fragile() {
  if (shouldThrow) throw new Error("render exploded");
  return <p>all good</p>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    shouldThrow = true;
    // React logs caught render errors; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders its children when nothing throws", () => {
    shouldThrow = false;
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a recoverable fallback instead of a blank window when a child throws", () => {
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("render exploded");
    expect(screen.getByRole("button", { name: "reload" })).toBeTruthy();
  });

  it("re-renders the children after try again once the cause is gone", () => {
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "try again" }));

    expect(screen.getByText("all good")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
