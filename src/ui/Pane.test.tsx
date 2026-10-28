import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusDefaultPane, focusPane } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { renderWithShell } from "../test/renderWithShell";
import { ActionKey } from "./ActionKey";
import { Glyph } from "./Glyph";
import { Kv } from "./Kv";
import { Pane } from "./Pane";

afterEach(cleanup);

function Panes({ bindings = [] as Binding[] }) {
  useKeymap(bindings);
  return (
    <>
      <Pane id="one" title="harnesses" meta="· 5">
        <button type="button">first</button>
      </Pane>
      <Pane id="two" title="surfaces" scrollable footer={<span>static hint</span>}>
        <p>body</p>
      </Pane>
      <Pane id="three" title="output" defaultFocus scrollable>
        <p>log</p>
      </Pane>
    </>
  );
}

describe("Pane", () => {
  it("renders the contract markup: section, title, body, and a footer only when one is given", () => {
    const { container } = renderWithShell(<Panes />);
    const pane = screen.getByRole("region", { name: "harnesses" });
    expect(pane.tagName).toBe("SECTION");
    expect(pane.className).toContain("pane");
    expect(pane.getAttribute("data-pane-id")).toBe("one");
    expect(pane.getAttribute("data-keyscope")).toBe("pane");
    const title = pane.querySelector(".pane-title")!;
    expect(title.querySelector(".k")).toBeNull();
    expect(title.textContent).toBe("harnesses · 5");
    expect(pane.querySelector(".pane-body")).not.toBeNull();
    expect(pane.querySelector(".pane-foot")).toBeNull();
    expect(container.querySelector("[data-pane-id='two'] .pane-foot")!.textContent).toBe("static hint");
  });

  it("carries the review card variant as a class and keeps the same contract markup", () => {
    renderWithShell(
      <Pane id="card" title="Install plan" variant="card" footer={<span>bar</span>}>
        <p>body</p>
      </Pane>,
    );
    const pane = screen.getByRole("region", { name: "Install plan" });
    expect(pane.classList.contains("pane")).toBe(true);
    expect(pane.classList.contains("pane-card")).toBe(true);
    expect(pane.getAttribute("data-pane-id")).toBe("card");
    expect(pane.querySelector(".pane-foot")!.textContent).toBe("bar");
  });

  it("makes a scrollable body the focus target and marks the default pane", () => {
    renderWithShell(<Panes />);
    const body = screen.getByRole("group", { name: "surfaces" });
    expect(body.tabIndex).toBe(0);
    expect(body.hasAttribute("data-pane-primary")).toBe(true);
    act(() => {
      focusDefaultPane();
    });
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "output" }));
  });

  it("moves focus to the pane's primary target when the pane itself is focused (click on dead space)", () => {
    renderWithShell(<Panes />);
    const pane = screen.getByRole("region", { name: "surfaces" });
    act(() => pane.focus());
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "surfaces" }));
  });

  it("focuses the next and previous pane in DOM order without wrapping", () => {
    renderWithShell(<Panes />);
    act(() => {
      screen.getByRole("button", { name: "first" }).focus();
    });
    act(() => {
      focusPane("next");
    });
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "surfaces" }));
    act(() => {
      focusPane("next");
    });
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "output" }));
    act(() => {
      focusPane("next");
    });
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "output" }));
    act(() => {
      focusPane("prev");
    });
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "surfaces" }));
  });

  describe("binding hints", () => {
    it("does not render hinted bindings in the pane: they live in the status bar", () => {
      const { container } = renderWithShell(
        <Panes
          bindings={[
            { id: "t.update", keys: "u", title: "Update", hint: "update", scope: "pane", paneId: "one", run: () => {} },
            { id: "t.other", keys: "o", title: "Other", hint: "other", scope: "pane", paneId: "two", run: () => {} },
          ]}
        />,
      );
      expect(container.querySelector("[data-pane-id='one'] .pane-foot")).toBeNull();
      expect(screen.queryByRole("button", { name: /update/ })).toBeNull();
      // A pane that has a static footer shows only that content.
      expect(container.querySelector("[data-pane-id='two'] .pane-foot")!.textContent).toBe("static hint");
    });

    it("still fires the binding from the keyboard while focus is inside the pane", () => {
      const run = vi.fn();
      renderWithShell(
        <Panes bindings={[{ id: "t.update", keys: "u", title: "Update", hint: "update", scope: "pane", paneId: "one", run }]} />,
      );
      fireEvent.keyDown(screen.getByRole("button", { name: "first" }), { key: "u" });
      expect(run).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(screen.getByRole("group", { name: "surfaces" }), { key: "u" });
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});

describe("ui primitives", () => {
  it("ActionKey renders key caps plus label and never calls onClick while disabled", () => {
    const onClick = vi.fn();
    const { rerender } = renderWithShell(
      <ActionKey keys={["g", "g"]} onClick={onClick}>
        top
      </ActionKey>,
    );
    const button = screen.getByRole("button", { name: /top/ });
    expect(Array.from(button.querySelectorAll("kbd")).map(kbd => kbd.textContent)).toEqual(["g", "g"]);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <ActionKey keys={["g", "g"]} onClick={onClick} disabled="not now">
        top
      </ActionKey>,
    );
    fireEvent.click(screen.getByRole("button", { name: /top/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Kv renders dl/dt/dd rows with tone and wrap classes", () => {
    const { container } = renderWithShell(
      <Kv
        items={[
          { label: "state", value: "current", tone: "ok" },
          { label: "conflict", value: "preserved", wrap: true, tone: "warn" },
          { label: "plain", value: "x" },
        ]}
      />,
    );
    const dl = container.querySelector("dl.kv")!;
    expect(Array.from(dl.querySelectorAll("dt")).map(dt => dt.textContent)).toEqual(["state", "conflict", "plain"]);
    const dds = Array.from(dl.querySelectorAll("dd"));
    expect(dds[0]!.className).toBe("c-ok");
    expect(dds[1]!.className).toBe("c-warn wrap");
    expect(dds[2]!.getAttribute("class")).toBeNull();
  });

  it("Glyph is decorative without a label and an image with one", () => {
    const { container } = renderWithShell(
      <>
        <Glyph name="ok" tone="ok" />
        <Glyph name="fail" tone="fail" label="conflict" />
      </>,
    );
    const [decor, labelled] = Array.from(container.querySelectorAll(".g"));
    expect(decor!.textContent).toBe("●");
    expect(decor!.getAttribute("aria-hidden")).toBe("true");
    expect(decor!.className).toBe("g c-ok");
    expect(labelled!.textContent).toBe("✗");
    expect(labelled!.getAttribute("role")).toBe("img");
    expect(labelled!.getAttribute("aria-label")).toBe("conflict");
  });
});
