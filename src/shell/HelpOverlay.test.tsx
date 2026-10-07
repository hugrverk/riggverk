import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "../keyboard/commands/parser";
import { useCommands } from "../keyboard/commands/useCommands";
import { useKeymapEntries } from "../keyboard/context";
import { groupBindings } from "./HelpOverlay";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { renderInFrame } from "../test/renderWithShell";
import { Pane } from "../ui/Pane";
import { PaneList } from "../ui/PaneList";

afterEach(cleanup);

const noop = () => {};

function Registrar({ bindings, commands = [] }: { bindings: Binding[]; commands?: CommandSpec[] }) {
  useKeymap(bindings);
  useCommands(commands);
  return null;
}

function openHelp() {
  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
  return screen.getByRole("dialog", { name: "Keyboard help" });
}

describe("HelpOverlay", () => {
  it("lists every registered binding grouped, generated from the registry", () => {
    const extra: Binding[] = [
      { id: "t.update", keys: "u", title: "Update harness", group: "Harness", hint: "update", scope: "pane", paneId: "main", run: noop },
      { id: "t.save", keys: "Mod+s", title: "Save", group: "Editor", scope: "editor", inEditable: true, run: noop },
      { id: "t.top", keys: "g g", title: "Jump to top", group: "Harness", scope: "pane", paneId: "main", run: noop },
      { id: "t.off", keys: "x", title: "Needs a plan", group: "Harness", scope: "pane", paneId: "main", when: () => "no plan yet", run: noop },
    ];
    let registered: readonly string[] = [];
    function Probe() {
      registered = useKeymapEntries().map(entry => entry.binding.id);
      return null;
    }
    renderInFrame(
      <>
        <Registrar bindings={extra} />
        <Probe />
        <Pane id="main" title="main">
          <PaneList label="rows" items={[{ id: "a" }]} getKey={row => row.id} renderItem={row => <span>{row.id}</span>} />
        </Pane>
      </>,
    );
    const help = openHelp();
    // Every registered binding id has a line (list bindings of one pane collapse into the same titles).
    const entries = registered;
    expect(entries.length).toBeGreaterThan(15);
    const text = help.textContent!;
    for (const title of [
      "Go to Workspace",
      "Go to Settings",
      "Focus previous pane",
      "Focus next pane",
      "Command line",
      "Keyboard help",
      "Open settings",
      "Leave text field, dismiss error",
      "Move down",
      "Move up",
      "First item",
      "Last item",
      "Update harness",
      "Save",
      "Jump to top",
      "Needs a plan (no plan yet)",
    ]) {
      expect(text).toContain(title);
    }
    expect(within(help).getByRole("region", { name: "Harness" })).not.toBeNull();
    expect(within(help).getByRole("region", { name: "Editor" })).not.toBeNull();
    expect(within(help).getByRole("region", { name: "Navigate" })).not.toBeNull();
    expect(within(help).getByRole("region", { name: "Lists" })).not.toBeNull();
  });

  it("renders key caps per binding (chords as separate caps, Mod per platform)", () => {
    renderInFrame(
      <Registrar
        bindings={[
          { id: "t.top", keys: "g g", title: "Jump to top", group: "Harness", scope: "pane", paneId: "main", run: noop },
          { id: "t.save", keys: "Mod+s", title: "Save", group: "Editor", scope: "editor", run: noop },
        ]}
      />,
      {},
      { platform: "mac" },
    );
    const help = openHelp();
    const row = (title: string) => within(help).getByText(title).previousElementSibling as HTMLElement;
    expect(Array.from(row("Jump to top").querySelectorAll("kbd")).map(kbd => kbd.textContent)).toEqual(["g", "g"]);
    expect(Array.from(row("Save").querySelectorAll("kbd")).map(kbd => kbd.textContent)).toEqual(["⌘S"]);
  });

  it("lists the registered commands with their aliases", () => {
    renderInFrame(
      <Registrar
        bindings={[]}
        commands={[{ name: "release-check", aliases: ["rc"], summary: "run the workspace release check", run: noop }]}
      />,
    );
    const help = openHelp();
    const name = within(help).getByText("release-check");
    expect(name.tagName).toBe("DT");
    expect(name.nextElementSibling!.textContent).toBe("run the workspace release check · rc");
  });

  it("closes with Escape, ? and q, restoring focus to where it was", () => {
    renderInFrame(
      <Pane id="main" title="main" scrollable>
        <button type="button">anchor</button>
      </Pane>,
    );
    const anchor = screen.getByRole("button", { name: "anchor" });
    for (const key of ["Escape", "?", "q"]) {
      act(() => anchor.focus());
      const help = openHelp();
      expect(document.activeElement).toBe(help);
      fireEvent.keyDown(help, { key });
      expect(screen.queryByRole("dialog", { name: "Keyboard help" })).toBeNull();
      expect(document.activeElement).toBe(anchor);
    }
  });

  it("closes from its close button and traps Tab inside", () => {
    renderInFrame(<Pane id="main" title="main" scrollable><p>body</p></Pane>);
    const help = openHelp();
    const close = within(help).getByRole("button", { name: /close/ });
    act(() => close.focus());
    const prevented = !fireEvent.keyDown(close, { key: "Tab" });
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(screen.queryByRole("dialog", { name: "Keyboard help" })).toBeNull();
  });

  it("uses the styled structure: backdrop dialog, .help-box with sections and kv rows, and closes on backdrop click", () => {
    renderInFrame(<Pane id="main" title="main" scrollable><p>body</p></Pane>);
    const help = openHelp();
    expect(help.className).toBe("help-overlay");
    const box = help.querySelector(":scope > .help-box")!;
    expect(box.querySelector("h2")).not.toBeNull();
    expect(box.querySelector(".help-cols > section > h3.group")).not.toBeNull();
    expect(box.querySelector(".help-cols dl.kv > dt kbd")).not.toBeNull();
    expect(box.querySelector("p.foot")).not.toBeNull();
    fireEvent.mouseDown(box);
    expect(screen.queryByRole("dialog", { name: "Keyboard help" })).not.toBeNull();
    fireEvent.mouseDown(help);
    expect(screen.queryByRole("dialog", { name: "Keyboard help" })).toBeNull();
  });

  it("scrolls the help box from the keyboard while focus is on the dialog", () => {
    renderInFrame(<Pane id="main" title="main" scrollable><p>body</p></Pane>);
    const help = openHelp();
    const box = help.querySelector<HTMLElement>(".help-box")!;
    // jsdom has no layout: give the box a scrollable extent.
    Object.defineProperty(box, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(box, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(box, "scrollTop", { value: 0, writable: true, configurable: true });
    const press = (key: string, init: KeyboardEventInit = {}) => !fireEvent.keyDown(help, { key, ...init });

    expect(press("ArrowDown")).toBe(true);
    const afterLine = box.scrollTop;
    expect(afterLine).toBeGreaterThan(0);
    expect(press("j")).toBe(true);
    expect(box.scrollTop).toBeGreaterThan(afterLine);
    expect(press("k")).toBe(true);
    expect(box.scrollTop).toBe(afterLine);
    expect(press("PageDown")).toBe(true);
    expect(box.scrollTop).toBeGreaterThanOrEqual(afterLine + 180);
    expect(press("G")).toBe(true);
    expect(box.scrollTop).toBe(800);
    expect(press("PageDown")).toBe(true);
    expect(box.scrollTop).toBe(800);
    expect(press("g")).toBe(true);
    expect(box.scrollTop).toBe(0);
    expect(press("ArrowUp")).toBe(true);
    expect(box.scrollTop).toBe(0);
    // Shortcuts with a modifier are left alone, and the overlay stays open.
    expect(press("j", { ctrlKey: true })).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Keyboard help" })).not.toBeNull();
  });

  it("does not run background bindings while open", () => {
    const run = vi.fn();
    renderInFrame(<Registrar bindings={[{ id: "t.j", keys: "j", title: "J", scope: "global", run }]} />);
    const help = openHelp();
    fireEvent.keyDown(help, { key: "j" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("groupBindings", () => {
  it("collapses identical lines from several panes and orders well-known groups first", () => {
    const entry = (id: string, keys: string, title: string, group?: string, scope: Binding["scope"] = "global") => ({
      binding: { id, keys, title, group, scope, run: noop } satisfies Binding,
      chords: [],
      seq: 0,
    });
    const groups = groupBindings(
      [
        entry("a", "j", "Move down", "Lists", "list"),
        entry("b", "j", "Move down", "Lists", "list"),
        entry("c", "z", "Zed thing", "Zed"),
        entry("d", "1", "Go to Workspace", "Navigate"),
      ],
      "other",
    );
    expect(groups.map(group => group.name)).toEqual(["Navigate", "Lists", "Zed"]);
    expect(groups[1]!.lines).toHaveLength(1);
  });
});
