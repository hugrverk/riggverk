import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "./Switch";

afterEach(cleanup);

describe("Switch", () => {
  it("is a named switch whose state is aria-checked", () => {
    const { rerender } = render(<Switch checked={false} onChange={() => {}} label="Let Riggverk manage codex rules" />);
    const control = screen.getByRole("switch", { name: "Let Riggverk manage codex rules" });
    expect(control.tagName).toBe("BUTTON");
    expect(control.getAttribute("aria-checked")).toBe("false");
    rerender(<Switch checked onChange={() => {}} label="Let Riggverk manage codex rules" />);
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("asks for the opposite value on a click", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked={false} onChange={onChange} label="x" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Switch checked onChange={onChange} label="x" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("stays focusable when disabled, says why, and never calls onChange", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="x" disabled="saving target changes" />);
    const control = screen.getByRole("switch");
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.getAttribute("title")).toBe("saving target changes");
    expect(control.hasAttribute("disabled")).toBe(false);
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});
