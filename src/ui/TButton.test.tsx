import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Binding } from "../keyboard/registry";
import { renderWithShell } from "../test/renderWithShell";
import { BindingButton } from "./BindingActionKey";
import { TButton } from "./TButton";

afterEach(cleanup);

describe("TButton", () => {
  it("is a real button named by its label, with the key as a hidden cap and a shortcut hint", () => {
    render(
      <TButton keys={["y"]} shortcut="Y">
        apply
      </TButton>,
    );
    const button = screen.getByRole("button", { name: "apply" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.classList.contains("tbtn")).toBe(true);
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Y");
    const cap = button.querySelector("kbd")!;
    expect(cap.textContent).toBe("y");
    expect(cap.getAttribute("aria-hidden")).toBe("true");
  });

  it("calls onClick and leaves focus where it was on mouse down", () => {
    const onClick = vi.fn();
    render(
      <TButton keys={["y"]} onClick={onClick}>
        apply
      </TButton>,
    );
    const button = screen.getByRole("button", { name: "apply" });
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("carries the primary and danger variants as classes", () => {
    render(
      <>
        <TButton keys={["y"]} variant="primary">
          apply
        </TButton>
        <TButton keys={["y"]} variant="danger">
          remove
        </TButton>
        <TButton keys={["n"]}>cancel</TButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "apply" }).className).toBe("tbtn tbtn-primary");
    expect(screen.getByRole("button", { name: "remove" }).className).toBe("tbtn tbtn-danger");
    expect(screen.getByRole("button", { name: "cancel" }).className).toBe("tbtn");
  });

  it("stays focusable but never clicks while disabled, and shows the reason as its tooltip", () => {
    const onClick = vi.fn();
    render(
      <TButton keys={["y"]} onClick={onClick} disabled="applying…">
        apply
      </TButton>,
    );
    const button = screen.getByRole("button", { name: "apply" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("applying…");
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is plainly disabled without a reason when disabled is true", () => {
    const onClick = vi.fn();
    render(
      <TButton keys={["y"]} onClick={onClick} disabled>
        apply
      </TButton>,
    );
    const button = screen.getByRole("button", { name: "apply" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("forwards a ref to the button", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(
      <TButton keys={["n"]} ref={ref}>
        cancel
      </TButton>,
    );
    expect(ref.current).toBe(screen.getByRole("button", { name: "cancel" }));
  });
});

describe("BindingButton", () => {
  function binding(overrides: Partial<Binding> = {}): Binding {
    return { id: "test.apply", keys: "y", title: "Apply", hint: "apply", scope: "global", run: vi.fn(), ...overrides };
  }

  it("runs the binding on click with a synthetic keydown of its first key", () => {
    const run = vi.fn();
    renderWithShell(<BindingButton binding={binding({ keys: ["n", "Escape"], hint: "cancel", run })} />);
    const button = screen.getByRole("button", { name: "cancel" });
    expect(button.querySelector("kbd")!.textContent).toBe("n");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("N Escape");
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0]![0] as KeyboardEvent).key).toBe("n");
  });

  it("is hidden while the binding is inactive and disabled with the reason while it returns one", () => {
    const run = vi.fn();
    const { rerender } = renderWithShell(<BindingButton binding={binding({ when: () => false, run })} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<BindingButton binding={binding({ when: () => "a task is running", run })} />);
    const button = screen.getByRole("button", { name: "apply" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("a task is running");
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
  });

  it("renders nothing for a binding without a hint", () => {
    renderWithShell(<BindingButton binding={binding({ hint: undefined })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
