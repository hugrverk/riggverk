import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { renderInFrame } from "../test/renderWithShell";
import { Pane } from "../ui/Pane";
import { PaneList } from "../ui/PaneList";
import { useConfirmMode, useStatusContext, useShellState } from "./ShellState";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function status() {
  return screen.getByLabelText("Status bar");
}

function mode() {
  return status().querySelector(".mode")!.textContent;
}

function View({ bindings = [] as Binding[], confirm = false, context = null as string | null }) {
  useKeymap(bindings);
  useConfirmMode(confirm);
  useStatusContext(context);
  return (
    <>
      <Pane id="main" index={1} title="main" defaultFocus>
        <PaneList label="rows" items={[{ id: "a" }]} getKey={row => row.id} renderItem={row => <span>{row.id}</span>} />
        <input aria-label="field" />
      </Pane>
      <Pane id="other" index={2} title="other" scrollable>
        <p>x</p>
      </Pane>
    </>
  );
}

describe("StatusBar", () => {
  it("shows NORMAL, INSERT while a text field has focus, and NORMAL again after blur", () => {
    renderInFrame(<View />);
    expect(mode()).toBe("NORMAL");
    expect(status().querySelector(".mode")!.getAttribute("data-mode")).toBe("normal");
    act(() => screen.getByLabelText("field").focus());
    expect(mode()).toBe("INSERT");
    expect(status().querySelector(".mode")!.getAttribute("data-mode")).toBe("insert");
    act(() => screen.getByLabelText("field").blur());
    expect(mode()).toBe("NORMAL");
  });

  it("shows COMMAND while the command line is open and HELP while help is open", () => {
    renderInFrame(<View />);
    fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
    expect(mode()).toBe("COMMAND");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Escape" });
    expect(mode()).toBe("NORMAL");
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(mode()).toBe("HELP");
  });

  it("shows CONFIRM while a view reports a review/confirm surface", () => {
    const { rerenderFrame } = renderInFrame(<View />);
    rerenderFrame(<View confirm />);
    expect(mode()).toBe("CONFIRM");
    rerenderFrame(<View confirm={false} />);
    expect(mode()).toBe("NORMAL");
  });

  it("shows the view and an optional sub-context, and a transient notice over it", () => {
    function Notifier() {
      const { notify } = useShellState();
      return <button type="button" onClick={() => notify("copied output")}>notify</button>;
    }
    vi.useFakeTimers();
    const { rerenderFrame } = renderInFrame(<View />);
    const ctx = () => status().querySelector(".ctx")!.textContent;
    expect(ctx()).toBe("workspace");
    rerenderFrame(<View context="claude" />);
    expect(ctx()).toBe("workspace › claude");
    rerenderFrame(
      <>
        <View context="claude" />
        <Notifier />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(ctx()).toBe("copied output");
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(ctx()).toBe("workspace › claude");
  });

  it("shows the pending chord", () => {
    renderInFrame(<View />);
    fireEvent.keyDown(screen.getByRole("listbox", { name: "rows" }), { key: "g" });
    expect(status().querySelector(".chord")!.textContent).toBe("g");
    fireEvent.keyDown(screen.getByRole("listbox", { name: "rows" }), { key: "g" });
    expect(status().querySelector(".chord")).toBeNull();
  });

  it("shows the focused pane's hinted bindings as ActionKeys and swaps them when focus moves", () => {
    const update = vi.fn();
    const copy = vi.fn();
    renderInFrame(
      <View
        bindings={[
          { id: "t.update", keys: "u", title: "Update", hint: "update", scope: "pane", paneId: "main", run: update },
          { id: "t.copy", keys: "y", title: "Copy", hint: "copy output", scope: "pane", paneId: "other", run: copy },
        ]}
      />,
    );
    act(() => screen.getByRole("listbox", { name: "rows" }).focus());
    const bar = within(status());
    fireEvent.click(bar.getByRole("button", { name: /update/ }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(bar.queryByRole("button", { name: /copy output/ })).toBeNull();
    act(() => screen.getByRole("group", { name: "other" }).focus());
    expect(bar.queryByRole("button", { name: /update/ })).toBeNull();
    fireEvent.click(bar.getByRole("button", { name: /copy output/ }));
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it("offers the command-line and help hints in NORMAL mode and row hints while a list has focus", () => {
    renderInFrame(<View />);
    const bar = within(status());
    expect(bar.getByRole("button", { name: /command/ })).not.toBeNull();
    expect(bar.getByRole("button", { name: /help/ })).not.toBeNull();
    act(() => screen.getByRole("group", { name: "other" }).focus());
    expect(status().textContent).not.toContain("move");
    act(() => screen.getByRole("listbox", { name: "rows" }).focus());
    expect(status().textContent).toContain("move");
  });

  it("keeps the command and help hints in their own group after the droppable ones", () => {
    renderInFrame(
      <View
        bindings={[{ id: "t.update", keys: "u", title: "Update", hint: "update", scope: "pane", paneId: "main", run: () => {} }]}
      />,
    );
    act(() => screen.getByRole("listbox", { name: "rows" }).focus());
    const hints = status().querySelector(".hints")!;
    const keep = status().querySelector(".hints-keep")!;
    expect(hints.compareDocumentPosition(keep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(keep as HTMLElement).getAllByRole("button").map(button => button.textContent)).toEqual([
      expect.stringContaining("command"),
      expect.stringContaining("help"),
    ]);
    // Everything else lives in the part that drops from the end when the bar is narrow.
    expect(within(hints as HTMLElement).queryByRole("button", { name: /command|help/ })).toBeNull();
    expect(within(hints as HTMLElement).getByRole("button", { name: /update/ })).not.toBeNull();
  });

  it("while typing, drops hints that cannot fire in a text field and shows how to leave", () => {
    const save = vi.fn();
    renderInFrame(
      <View
        bindings={[
          { id: "t.save", keys: "Mod+s", title: "Save", hint: "save", scope: "pane", paneId: "main", inEditable: true, run: save },
          { id: "t.update", keys: "u", title: "Update", hint: "update", scope: "pane", paneId: "main", run: () => {} },
        ]}
      />,
    );
    act(() => screen.getByLabelText("field").focus());
    const bar = within(status());
    expect(bar.getByRole("button", { name: /save/ })).not.toBeNull();
    expect(bar.queryByRole("button", { name: /update/ })).toBeNull();
    expect(bar.queryByRole("button", { name: /command/ })).toBeNull();
    expect(status().textContent).toContain("leave field");
    expect(status().textContent).not.toContain("move");
    expect(status().textContent).not.toContain("pane");
  });

  it("shows command-line key hints in COMMAND mode and only a close hint in HELP mode", () => {
    renderInFrame(<View />);
    fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
    expect(status().textContent).toContain("complete");
    expect(status().textContent).toContain("run");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(status().textContent).toContain("close");
    expect(within(status()).queryByRole("button")).toBeNull();
  });
});
