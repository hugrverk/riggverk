import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import App from "../App";

afterEach(cleanup);

it("shows Update all actions in the receipt with the default mock backend", async () => {
  window.history.replaceState(null, "", "/?mock=default");
  await import("./mockBackend");
  render(<App />);
  await within(screen.getByRole("navigation", { name: "Main navigation" })).findByRole("button", { name: "Claude" }, { timeout: 10000 });
  // `--all` needs the folder's verdict, which arrives after the sidebar; an enabled Update all shows it is in.
  await waitFor(() => expect(screen.getByRole("button", { name: "Update all" }).getAttribute("aria-disabled")).toBeNull(), { timeout: 10000 });
  fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
  const input = screen.getByRole("combobox", { name: "Command" });
  fireEvent.change(input, { target: { value: "update --all" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const receipt = await screen.findByRole("region", { name: "Workspace install review" }, { timeout: 10000 });
  fireEvent.click(await within(receipt).findByRole("button", { name: /apply/i }, { timeout: 10000 }));
  await within(receipt).findByRole("button", { name: "Undo this update…" }, { timeout: 10000 });
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Run" })).getByRole("button", { name: "Details" })).toBeTruthy(), { timeout: 10000 });
  const run = screen.getByRole("region", { name: "Run" });
  expect(within(receipt).getByRole("button", { name: "dismiss" })).toBeTruthy();
  expect(within(run).queryByRole("button", { name: /Undo|Dismiss/ })).toBeNull();
  fireEvent.click(within(receipt).getByRole("button", { name: "dismiss" }));
  expect(within(run).getByRole("button", { name: "Undo last update…" })).toBeTruthy();
  expect(within(run).getByRole("button", { name: "Dismiss" })).toBeTruthy();
}, 20000);
