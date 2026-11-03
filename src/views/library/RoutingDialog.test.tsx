import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { RoutingDialog } from "./RoutingDialog";

beforeAll(() => { HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute("open", ""); }; });
afterEach(cleanup);
it("disables an unchanged save and saves the edited line", async () => {
  const save = vi.fn(async () => "saved");
  const close = vi.fn();
  render(<RoutingDialog name="mine" description="Use when testing." lines={["- Testing: `mine`.", "- Hand `mine` and `other`."]} problem={null} onSave={save} onClose={close} />);
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText(/Written by hand in routing.md/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Use when"), { target: { value: "Checking" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("Checking"));
  expect(close).toHaveBeenCalled();
});
