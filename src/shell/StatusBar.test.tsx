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
      <Pane id="main" title="main" defaultFocus>
        <PaneList label="rows" items={[{ id: "a" }]} getKey={row => row.id} renderItem={row => <span>{row.id}</span>} />
        <input aria-label="field" />
      </Pane>
      <Pane id="other" title="other" scrollable>
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

  it("keeps focus in the pane when a hint is pressed with the mouse, so the hint is still there for the click", () => {
    const update = vi.fn();
    renderInFrame(<View bindings={[{ id: "t.update", keys: "u", title: "Update", hint: "update", scope: "pane", paneId: "main", run: update }]} />);
    const list = screen.getByRole("listbox", { name: "rows" });
    act(() => list.focus());
    const hint = within(status()).getByRole("button", { name: /update/ });
    // fireEvent returns false when the default (focusing the button) was prevented.
    expect(fireEvent.mouseDown(hint)).toBe(false);
    expect(document.activeElement).toBe(list);
    fireEvent.click(hint);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("shows a disabled hint with the reason when when() returns a string, and hides it when false", () => {
    const run = vi.fn();
    renderInFrame(
      <View
        bindings={[
          { id: "t.a", keys: "a", title: "A", hint: "apply", scope: "pane", paneId: "main", when: () => "nothing to apply", run },
          { id: "t.b", keys: "b", title: "B", hint: "hidden", scope: "pane", paneId: "main", when: () => false, run },
        ]}
      />,
    );
    act(() => screen.getByRole("listbox", { name: "rows" }).focus());
    const apply = within(status()).getByRole("button", { name: /apply/ });
    expect(apply.getAttribute("aria-disabled")).toBe("true");
    expect(apply.getAttribute("title")).toBe("nothing to apply");
    fireEvent.click(apply);
    expect(run).not.toHaveBeenCalled();
    expect(within(status()).queryByRole("button", { name: /hidden/ })).toBeNull();
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

describe("StatusBar key echo", () => {
  const update: Binding = { id: "t.update", keys: "u", title: "Update", hint: "update", scope: "pane", paneId: "main", run: () => {} };
  const echo = () => status().querySelector(".echo");

  function focusRows() {
    const list = screen.getByRole("listbox", { name: "rows" });
    act(() => list.focus());
    return list;
  }

  it("shows the key that ran and its hint next to the mode badge, visual only, then clears it", () => {
    vi.useFakeTimers();
    renderInFrame(<View bindings={[update]} />);
    expect(echo()).toBeNull();
    fireEvent.keyDown(focusRows(), { key: "u" });
    expect(echo()!.textContent).toBe("u update");
    expect(echo()!.querySelector("kbd")!.textContent).toBe("u");
    expect(echo()!.getAttribute("aria-hidden")).toBe("true");
    expect(echo()!.previousElementSibling).toBe(status().querySelector(".mode"));
    act(() => {
      vi.advanceTimersByTime(950);
    });
    expect(echo()).toBeNull();
  });

  it("echoes the latest key, restarting the timer", () => {
    vi.useFakeTimers();
    const preview: Binding = { ...update, id: "t.preview", keys: "p", hint: "preview" };
    renderInFrame(<View bindings={[update, preview]} />);
    const list = focusRows();
    fireEvent.keyDown(list, { key: "u" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.keyDown(list, { key: "p" });
    expect(echo()!.textContent).toBe("p preview");
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(echo()!.textContent).toBe("p preview");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(echo()).toBeNull();
  });

  it("echoes a click on a status-bar hint like the key", () => {
    const run = vi.fn();
    renderInFrame(<View bindings={[{ ...update, run }]} />);
    focusRows();
    fireEvent.click(within(status()).getByRole("button", { name: /update/ }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(echo()!.textContent).toBe("u update");
  });

  it("does not echo a click on a disabled hint, or one whose binding declined", () => {
    renderInFrame(
      <View
        bindings={[
          { ...update, id: "t.off", keys: "o", hint: "off", when: () => "not now" },
          { ...update, id: "t.declines", keys: "d", hint: "declines", run: () => false },
        ]}
      />,
    );
    focusRows();
    fireEvent.click(within(status()).getByRole("button", { name: /off/ }));
    fireEvent.click(within(status()).getByRole("button", { name: /declines/ }));
    expect(echo()).toBeNull();
  });

  it("stays silent for movement keys, for bindings without a hint, and for the overlay openers", () => {
    renderInFrame(
      <View
        bindings={[
          { ...update, id: "t.down", keys: "j", hint: "next" },
          { ...update, id: "t.plain", keys: "x", hint: undefined },
        ]}
      />,
    );
    const list = focusRows();
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "x" });
    fireEvent.keyDown(list, { key: "3" });
    expect(echo()).toBeNull();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(mode()).toBe("HELP");
    expect(echo()).toBeNull();
  });

  it("does echo a click on a movement hint, since the click is the deliberate act", () => {
    renderInFrame(<View bindings={[{ ...update, id: "t.down", keys: "j", hint: "next" }]} />);
    focusRows();
    fireEvent.click(within(status()).getByRole("button", { name: /next/ }));
    expect(echo()!.textContent).toBe("j next");
  });

  it("stays silent while typing in a text field, even for a binding that fires there", () => {
    const save = vi.fn();
    renderInFrame(
      <View bindings={[{ id: "t.save", keys: "Mod+s", title: "Save", hint: "save", scope: "pane", paneId: "main", inEditable: true, run: save }]} />,
    );
    const field = screen.getByLabelText("field");
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "s", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(echo()).toBeNull();
  });

  it("stays silent for auto-repeat", () => {
    renderInFrame(<View bindings={[{ ...update, repeat: true }]} />);
    fireEvent.keyDown(focusRows(), { key: "u", repeat: true });
    expect(echo()).toBeNull();
  });

  it("leaves the pending chord display alone", () => {
    renderInFrame(<View bindings={[{ ...update, id: "t.chord", keys: "x y" }]} />);
    const list = focusRows();
    fireEvent.keyDown(list, { key: "x" });
    expect(status().querySelector(".chord")!.textContent).toBe("x");
    expect(echo()).toBeNull();
    fireEvent.keyDown(list, { key: "y" });
    expect([...echo()!.querySelectorAll("kbd")].map(kbd => kbd.textContent)).toEqual(["x", "y"]);
    expect(echo()!.textContent).toContain("update");
  });
});

describe("StatusBar notices", () => {
  function Notifier({ text = "applied", options }: { text?: string; options?: Parameters<ReturnType<typeof useShellState>["notify"]>[1] }) {
    const { notify } = useShellState();
    return <button type="button" onClick={() => notify(text, options)}>notify</button>;
  }
  const ctx = () => status().querySelector(".ctx")!;

  it.each(["ok", "warn", "fail"] as const)("carries the %s tone, with the text unchanged", tone => {
    renderInFrame(<Notifier text="nothing to update" options={{ tone }} />);
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(ctx().getAttribute("data-tone")).toBe(tone);
    expect(ctx().textContent).toBe("nothing to update");
    expect(ctx().getAttribute("role")).toBe("status");
  });

  it("is plain without a tone, and the tone goes with the notice", () => {
    vi.useFakeTimers();
    renderInFrame(<Notifier options={{ tone: "ok" }} />);
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(ctx().getAttribute("data-tone")).toBe("ok");
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(ctx().hasAttribute("data-tone")).toBe(false);
    expect(ctx().textContent).toBe("workspace");
  });

  it("takes a bare number as the duration, as before", () => {
    vi.useFakeTimers();
    renderInFrame(<Notifier options={1000} />);
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(ctx().textContent).toBe("applied");
    expect(ctx().hasAttribute("data-tone")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(ctx().textContent).toBe("workspace");
  });

  it("restarts the entrance for a repeat of the same text", () => {
    renderInFrame(<Notifier />);
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    const first = ctx().querySelector(".notice");
    fireEvent.click(screen.getByRole("button", { name: "notify" }));
    expect(ctx().querySelector(".notice")).not.toBe(first);
  });
});

describe("StatusBar right text", () => {
  afterEach(() => {
    delete document.documentElement.dataset.motion;
  });

  it("rolls when the text changes under full motion, and not on the first render", () => {
    document.documentElement.dataset.motion = "full";
    const { rerenderFrame } = renderInFrame(<View />, { statusRight: "2 backups" });
    const rt = () => status().querySelector(".rt")!;
    expect(rt().textContent).toBe("2 backups");
    expect(rt().querySelector(".roll-old")).toBeNull();
    rerenderFrame(<View />, { statusRight: "3 backups" });
    expect(rt().querySelector(".roll-old")!.textContent).toBe("2 backups");
    expect(rt().querySelector(".roll-new")!.textContent).toBe("3 backups");
  });

  it("swaps instantly when motion is off, and leaves non-text content alone", () => {
    document.documentElement.dataset.motion = "off";
    const { rerenderFrame } = renderInFrame(<View />, { statusRight: "2 backups" });
    rerenderFrame(<View />, { statusRight: "3 backups" });
    expect(status().querySelector(".rt .roll-old")).toBeNull();
    expect(status().querySelector(".rt")!.textContent).toBe("3 backups");
    rerenderFrame(<View />, { statusRight: <b>custom</b> });
    expect(status().querySelector(".rt b")!.textContent).toBe("custom");
  });
});
