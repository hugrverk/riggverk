import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeMarkdown } from "./SafeMarkdown";

const markdownRenders = vi.fn();

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    markdownRenders(children);
    return <p>{children}</p>;
  },
}));

describe("SafeMarkdown memoization", () => {
  afterEach(() => {
    cleanup();
    markdownRenders.mockClear();
  });

  it("does not re-parse when a parent re-renders with the same content", () => {
    const { rerender } = render(<SafeMarkdown content="# Title" />);
    expect(markdownRenders).toHaveBeenCalledTimes(1);

    rerender(<SafeMarkdown content="# Title" />);
    expect(markdownRenders).toHaveBeenCalledTimes(1);

    rerender(<SafeMarkdown content="# Changed" />);
    expect(markdownRenders).toHaveBeenCalledTimes(2);
  });
});
