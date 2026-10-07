import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInFrame, renderWithShell } from "../test/renderWithShell";
import { Pane } from "./Pane";
import { PaneList, type PaneListProps } from "./PaneList";

interface Row {
  id: string;
  name: string;
  group?: string;
}

const ROWS: Row[] = [
  { id: "a", name: "alpha", group: "first" },
  { id: "b", name: "bravo", group: "first" },
  { id: "c", name: "charlie", group: "second" },
  { id: "d", name: "delta", group: "second" },
];

type ListProps = Partial<PaneListProps<Row>> & { rows?: Row[] };

function List({ rows = ROWS, ...props }: ListProps) {
  return (
    <PaneList<Row>
      label="Harnesses"
      items={rows}
      getKey={row => row.id}
      renderItem={row => <span className="nm">{row.name}</span>}
      {...props}
    />
  );
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key, ...init });
}

function listbox() {
  return screen.getByRole("listbox", { name: "Harnesses" });
}

function cursorName() {
  const id = listbox().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent?.replace(/^[▸ ]/, "").trim() : null;
}

afterEach(cleanup);

describe("PaneList", () => {
  it("is one tab stop: a focusable listbox with options, aria-activedescendant and aria-selected on the cursor row", () => {
    renderWithShell(<List />);
    const list = listbox();
    expect(list.tabIndex).toBe(0);
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(4);
    options.forEach(option => expect(option.getAttribute("tabindex")).toBeNull());
    expect(list.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(options.map(option => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    expect(options[0]!.querySelector(".cur")!.textContent).toBe("▸");
    expect(options[1]!.querySelector(".cur")!.textContent).toBe(" ");
    expect(list.hasAttribute("data-pane-primary")).toBe(true);
    expect(list.getAttribute("data-keyscope")).toBe("list");
  });

  it("moves the cursor with j/k and arrow keys, clamping at both ends, and reports changes", () => {
    const onCursorChange = vi.fn();
    renderWithShell(<List onCursorChange={onCursorChange} />);
    const list = listbox();
    act(() => list.focus());
    press(list, "j");
    expect(cursorName()).toBe("bravo");
    press(list, "ArrowDown");
    expect(cursorName()).toBe("charlie");
    press(list, "k");
    press(list, "ArrowUp");
    press(list, "ArrowUp");
    expect(cursorName()).toBe("alpha");
    expect(onCursorChange).toHaveBeenLastCalledWith("a", ROWS[0]);
    for (let i = 0; i < 6; i++) press(list, "j");
    expect(cursorName()).toBe("delta");
    expect(within(list).getAllByRole("option").map(option => option.getAttribute("aria-selected"))).toEqual(["false", "false", "false", "true"]);
  });

  it("jumps with g g, G, Home, End and pages with PageDown/PageUp", () => {
    renderWithShell(<List pageSize={2} />);
    const list = listbox();
    press(list, "G");
    expect(cursorName()).toBe("delta");
    press(list, "g");
    expect(cursorName()).toBe("delta");
    press(list, "g");
    expect(cursorName()).toBe("alpha");
    press(list, "End");
    expect(cursorName()).toBe("delta");
    press(list, "Home");
    expect(cursorName()).toBe("alpha");
    press(list, "PageDown");
    expect(cursorName()).toBe("charlie");
    press(list, "PageUp");
    expect(cursorName()).toBe("alpha");
  });

  it("repeats navigation keys on auto-repeat", () => {
    renderWithShell(<List />);
    const list = listbox();
    press(list, "j", { repeat: true });
    press(list, "j", { repeat: true });
    expect(cursorName()).toBe("charlie");
  });

  it("Enter activates the cursor row and double-click activates the clicked row", () => {
    const onActivate = vi.fn();
    renderWithShell(<List onActivate={onActivate} />);
    const list = listbox();
    press(list, "j");
    press(list, "Enter");
    expect(onActivate).toHaveBeenLastCalledWith(ROWS[1]);
    fireEvent.doubleClick(within(list).getAllByRole("option")[3]!);
    expect(onActivate).toHaveBeenLastCalledWith(ROWS[3]);
  });

  it("does nothing on Enter when no activate handler is given", () => {
    renderWithShell(<List />);
    expect(press(listbox(), "Enter")).toBe(true);
  });

  it("moves the cursor and focuses the list when a row is clicked", () => {
    const onCursorChange = vi.fn();
    renderWithShell(<List onCursorChange={onCursorChange} />);
    fireEvent.click(within(listbox()).getAllByRole("option")[2]!);
    expect(cursorName()).toBe("charlie");
    expect(onCursorChange).toHaveBeenLastCalledWith("c", ROWS[2]);
    expect(document.activeElement).toBe(listbox());
  });

  it("supports a controlled cursor", () => {
    function Controlled() {
      const [key, setKey] = useState<string | null>("c");
      return <List cursorKey={key} onCursorChange={next => setKey(next)} />;
    }
    renderWithShell(<Controlled />);
    expect(cursorName()).toBe("charlie");
    press(listbox(), "j");
    expect(cursorName()).toBe("delta");
  });

  it("repairs the cursor when its item disappears", () => {
    const onCursorChange = vi.fn();
    const { rerender } = renderWithShell(<List defaultCursorKey="c" onCursorChange={onCursorChange} />);
    expect(cursorName()).toBe("charlie");
    onCursorChange.mockClear();
    rerender(<List rows={ROWS.filter(row => row.id !== "c")} defaultCursorKey="c" onCursorChange={onCursorChange} />);
    expect(cursorName()).toBe("alpha");
    expect(onCursorChange).toHaveBeenCalledWith("a", ROWS[0]);
  });

  describe("multi-select", () => {
    it("exposes aria-multiselectable, reflects selectedKeys and toggles with Space and click", () => {
      const onToggle = vi.fn();
      renderWithShell(<List multiSelectable selectedKeys={new Set(["b", "d"])} onToggle={onToggle} />);
      const list = listbox();
      expect(list.getAttribute("aria-multiselectable")).toBe("true");
      const options = within(list).getAllByRole("option");
      expect(options.map(option => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "true"]);
      press(list, " ");
      expect(onToggle).toHaveBeenLastCalledWith(ROWS[0]);
      fireEvent.click(options[2]!);
      expect(onToggle).toHaveBeenLastCalledWith(ROWS[2]);
    });

    it("toggles with Space but not on click in single-select lists", () => {
      const onToggle = vi.fn();
      renderWithShell(<List onToggle={onToggle} />);
      const list = listbox();
      const options = within(list).getAllByRole("option");
      fireEvent.click(options[2]!);
      // A click only moves the cursor (and the selection with it): inspecting a row never flips it.
      expect(onToggle).not.toHaveBeenCalled();
      expect(options.map(option => option.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false"]);
      press(list, " ");
      expect(onToggle).toHaveBeenLastCalledWith(ROWS[2]);
    });

    it("ignores Space without onToggle", () => {
      const onActivate = vi.fn();
      renderWithShell(<List onActivate={onActivate} />);
      press(listbox(), " ");
      expect(onActivate).not.toHaveBeenCalled();
    });
  });

  describe("filter", () => {
    function Filtered({ onChange = () => {} }: { onChange?: (value: string) => void }) {
      const [value, setValue] = useState("");
      return (
        <>
          <button type="button">elsewhere</button>
          <List
            rows={ROWS.filter(row => row.name.includes(value))}
            filter={{
              value,
              onChange: next => {
                setValue(next);
                onChange(next);
              },
              label: "Filter harnesses",
            }}
          />
        </>
      );
    }

    it("focuses the filter with / and keeps list keys out of the input", () => {
      renderWithShell(<Filtered />);
      const list = listbox();
      act(() => list.focus());
      press(list, "/");
      const input = screen.getByRole("searchbox", { name: "Filter harnesses" });
      expect(document.activeElement).toBe(input);
      press(input, "j");
      expect(cursorName()).toBe("alpha");
    });

    it("filters rows, and Escape in the input returns to the list while keeping the filter", () => {
      renderWithShell(<Filtered />);
      const input = screen.getByRole("searchbox", { name: "Filter harnesses" });
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "ar" } });
      expect(within(listbox()).getAllByRole("option")).toHaveLength(1);
      press(input, "Escape");
      expect(document.activeElement).toBe(listbox());
      expect((input as HTMLInputElement).value).toBe("ar");
    });

    it("clears an active filter with Escape on the list, and Enter in the input hands focus to the list", () => {
      const onChange = vi.fn();
      renderWithShell(<Filtered onChange={onChange} />);
      const input = screen.getByRole("searchbox", { name: "Filter harnesses" }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "ar" } });
      act(() => input.focus());
      press(input, "Enter");
      expect(document.activeElement).toBe(listbox());
      press(listbox(), "Escape");
      expect(onChange).toHaveBeenLastCalledWith("");
      expect(input.value).toBe("");
      expect(within(listbox()).getAllByRole("option")).toHaveLength(4);
    });

    it("moves the cursor with arrow keys while typing in the filter", () => {
      renderWithShell(<Filtered />);
      const input = screen.getByRole("searchbox", { name: "Filter harnesses" });
      act(() => input.focus());
      press(input, "ArrowDown");
      expect(cursorName()).toBe("bravo");
      expect(document.activeElement).toBe(input);
    });
  });

  it("renders group headings once per run and an empty message", () => {
    const { rerender } = renderWithShell(<List getGroup={row => row.group} />);
    const list = listbox();
    expect(Array.from(list.querySelectorAll("li.group")).map(el => el.textContent)).toEqual(["first", "second"]);
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    rerender(<List rows={[]} empty="no harnesses" />);
    expect(screen.getByText("no harnesses")).toBeTruthy();
    expect(within(listbox()).queryAllByRole("option")).toHaveLength(0);
  });

  it("announces the empty message as a status right under the filter, before the empty list", () => {
    renderWithShell(
      <List rows={[]} empty="no matching rows" filter={{ value: "zzz", onChange: () => {}, label: "Filter rows" }} />,
    );
    const message = screen.getByRole("status");
    expect(message.textContent).toBe("no matching rows");
    const filterInput = screen.getByRole("searchbox", { name: "Filter rows" });
    expect(filterInput.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(message.compareDocumentPosition(listbox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows an Enter hint in the status bar that activates the cursor row when clicked", () => {
    const onActivate = vi.fn();
    renderInFrame(
      <Pane id="harnesses" title="harnesses">
        <List onActivate={onActivate} activateHint="open" />
      </Pane>,
    );
    expect(within(screen.getByRole("region", { name: "harnesses" })).queryByRole("button")).toBeNull();
    act(() => listbox().focus());
    const hint = within(screen.getByLabelText("Status bar")).getByRole("button", { name: /open/ });
    expect(hint.textContent).toContain("↵");
    fireEvent.click(hint);
    expect(onActivate).toHaveBeenCalledWith(ROWS[0]);
  });

  it("shows a Space hint in the status bar when the list toggles, and toggles the cursor row when clicked", () => {
    const onToggle = vi.fn();
    const { rerenderFrame } = renderInFrame(
      <Pane id="harnesses" title="harnesses">
        <List multiSelectable onToggle={onToggle} toggleHint="toggle target" />
      </Pane>,
    );
    act(() => listbox().focus());
    const bar = within(screen.getByLabelText("Status bar"));
    const hint = bar.getByRole("button", { name: /toggle target/ });
    expect(hint.textContent).toContain("space");
    fireEvent.click(hint);
    expect(onToggle).toHaveBeenCalledWith(ROWS[0]);
    // Without onToggle there is nothing to toggle, so the hint is not offered.
    rerenderFrame(
      <Pane id="harnesses" title="harnesses">
        <List toggleHint="toggle target" />
      </Pane>,
    );
    expect(bar.queryByRole("button", { name: /toggle target/ })).toBeNull();
  });

  it("works under StrictMode without duplicate registrations", () => {
    renderWithShell(<List />, { strict: true });
    const list = listbox();
    press(list, "j");
    expect(cursorName()).toBe("bravo");
  });

  it("renders without a provider (keys inert)", () => {
    render(<List />);
    press(listbox(), "j");
    expect(cursorName()).toBe("alpha");
  });
});
