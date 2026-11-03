import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RoutingDialog } from "./RoutingDialog";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
});
afterEach(cleanup);

function renderDialog(lines: string[], onSave = vi.fn(async (_when: string | null) => "saved")) {
  const onClose = vi.fn();
  render(<RoutingDialog name="mine" description="Use when testing." lines={lines} problem={null} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose, save: () => screen.getByRole("button", { name: "Save" }) };
}

describe("RoutingDialog", () => {
  it("saves an edited line and keeps lines written by hand", async () => {
    const { onSave, onClose, save } = renderDialog(["- Testing: `mine`.", "- Hand `mine` and `other`."]);
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Written by hand in routing.md/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Use when"), { target: { value: "Checking" } });
    expect(screen.getByText("- Checking: `mine`.")).toBeInTheDocument();
    fireEvent.click(save());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Checking"));
    expect(onClose).toHaveBeenCalled();
  });

  it("removes the line when unticked", async () => {
    const { onSave, save } = renderDialog(["- Testing: `mine`."]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Add a routing line" }));
    fireEvent.click(save());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it("starts unticked from the suggestion and blocks a line it cannot write", () => {
    const { onSave, save } = renderDialog([]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Add a routing line" }));
    expect(screen.getByLabelText("Use when")).toHaveValue("Testing");
    fireEvent.change(screen.getByLabelText("Use when"), { target: { value: "use `other`" } });
    expect(screen.getByLabelText("Use when")).toHaveAttribute("aria-invalid", "true");
    expect(save()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(save());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("stays open with the refusal when saving fails", async () => {
    const { onClose, save } = renderDialog([], vi.fn(async () => { throw new Error("mine is not active"); }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Add a routing line" }));
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("mine is not active");
    expect(onClose).not.toHaveBeenCalled();
    expect(save()).not.toHaveAttribute("aria-disabled");
  });
});
