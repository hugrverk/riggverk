import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Page } from "./Page";
import { usePaneId } from "./Pane";
import { TButton } from "./TButton";

afterEach(cleanup);

function PaneIdProbe() {
  return <output data-testid="pane-id">{usePaneId()}</output>;
}

describe("Page", () => {
  it("is a named page-level focus container for the page keys", () => {
    render(
      <Page label="Claude" className="hp-page">
        <p>content</p>
      </Page>,
    );
    const page = screen.getByRole("region", { name: "Claude" });
    expect(page.className).toBe("hp-page");
    expect(page.getAttribute("data-pane-id")).toBe("page");
    expect(page.getAttribute("data-keyscope")).toBe("pane");
    expect(page.hasAttribute("data-pane-default")).toBe(true);
    // Focusable by click and by script, but not a stop in the tab order.
    expect(page.getAttribute("tabindex")).toBe("-1");
  });

  it("hands its pane id to the components inside, for the keys they register", () => {
    render(
      <Page label="OpenCode">
        <PaneIdProbe />
      </Page>,
    );
    expect(screen.getByTestId("pane-id").textContent).toBe("page");
  });

  it("takes focus when a click lands inside while focus is elsewhere", () => {
    render(
      <>
        <button type="button">outside</button>
        <Page label="Claude">
          <p>dead space</p>
        </Page>
      </>,
    );
    act(() => screen.getByRole("button", { name: "outside" }).focus());
    fireEvent.click(screen.getByText("dead space"));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Claude" }));
  });

  it("keeps focus where it is inside the page, and takes it for a button that keeps focus where it was", () => {
    const onClick = vi.fn();
    render(
      <>
        <button type="button">outside</button>
        <Page label="Claude">
          <input aria-label="field" />
          <TButton keys={[]} onClick={onClick}>
            Compare
          </TButton>
        </Page>
      </>,
    );
    act(() => screen.getByRole("textbox", { name: "field" }).focus());
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "field" }));

    act(() => screen.getByRole("button", { name: "outside" }).focus());
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Claude" }));
  });
});
