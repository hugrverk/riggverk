import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "../keyboard/commands/parser";
import { useCommands } from "../keyboard/commands/useCommands";
import { renderInFrame } from "../test/renderWithShell";
import { Pane } from "../ui/Pane";

afterEach(cleanup);

const HARNESSES = ["claude", "codex", "opencode"];

function Commands({ commands }: { commands: CommandSpec[] }) {
  useCommands(commands);
  return null;
}

function setup(commands: CommandSpec[]) {
  return renderInFrame(
    <>
      <Commands commands={commands} />
      <Pane id="main" title="main" scrollable>
        <button type="button">anchor</button>
      </Pane>
    </>,
  );
}

function openCommandLine() {
  fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
  return screen.getByRole("combobox", { name: "Command" }) as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function options() {
  return screen.queryAllByRole("option").map(option => option.textContent!.replace(/\s+/g, " ").trim());
}

function optionNames() {
  return screen.queryAllByRole("option").map(option => option.querySelectorAll("span")[1]!.textContent);
}

function selectedOption() {
  return screen.getAllByRole("option").find(option => option.getAttribute("aria-selected") === "true");
}

function commandSet(run = vi.fn()): CommandSpec[] {
  return [
    {
      name: "update",
      summary: "preview, then apply",
      args: [
        { name: "target", kind: "enum", values: HARNESSES, describe: value => (value === "claude" ? "apply 7 safe, skip 1 conflict" : undefined) },
        { name: "all", kind: "flag" },
      ],
      validate: parsed => (parsed.named.target || parsed.flags.all ? null : "update: name a target or pass --all"),
      run,
    },
    { name: "theme", summary: "set appearance", args: [{ name: "mode", kind: "enum", values: ["dark", "light"] }], run },
    { name: "help", summary: "keyboard help", run },
    { name: "rollback", summary: "restore", enabled: () => "no uninstall to roll back", run },
    { name: "boom", summary: "fails", run: () => Promise.reject(new Error("exploded")) },
  ];
}

describe("CommandLine", () => {
  it("is a modal dialog with a combobox, focused on open, and focus returns to the opener on close", () => {
    setup(commandSet());
    const anchor = screen.getByRole("button", { name: "anchor" });
    act(() => anchor.focus());
    const input = openCommandLine();
    expect(screen.getByRole("dialog", { name: "Command line" }).getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command line" })).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it("keeps focus in the input when the box chrome is clicked, and Escape still closes", () => {
    setup(commandSet());
    const input = openCommandLine();
    const box = screen.getByRole("dialog", { name: "Command line" });
    // preventDefault on mousedown is what keeps the browser from moving focus off the input.
    for (const chrome of [box, box.querySelector(".colon")!, box.querySelector("kbd")!, box.querySelector(".line")!]) {
      expect(fireEvent.mouseDown(chrome)).toBe(false);
    }
    // The input itself keeps its normal mouse behaviour (caret placement, selection).
    expect(fireEvent.mouseDown(input)).toBe(true);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command line" })).toBeNull();
  });

  it("renders the suggestions as direct children of .sug and errors as .err below it", () => {
    setup(commandSet());
    const input = openCommandLine();
    type(input, "upd");
    const sug = screen.getByRole("listbox", { name: "Suggestions" });
    expect(sug.className).toBe("sug");
    expect(Array.from(sug.children).every(child => child.getAttribute("role") === "option")).toBe(true);
    type(input, "nope");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").className).toBe("err");
  });

  it("lists commands for an empty line and filters while typing, with the first suggestion selected", () => {
    setup(commandSet());
    const input = openCommandLine();
    expect(optionNames()).toEqual(["update", "theme", "help", "rollback", "boom"]);
    type(input, "upd");
    expect(options()).toEqual([
      "▸ update claude apply 7 safe, skip 1 conflict",
      "update codex preview, then apply",
      "update opencode preview, then apply",
      "update --all preview, then apply",
    ]);
    expect(selectedOption()!.textContent).toContain("update claude");
    expect(input.getAttribute("aria-activedescendant")).toBe(selectedOption()!.id);
  });

  it("moves the selection with arrows and Ctrl-n / Ctrl-p, wrapping around", () => {
    setup(commandSet());
    const input = openCommandLine();
    type(input, "upd");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedOption()!.textContent).toContain("update codex");
    fireEvent.keyDown(input, { key: "n", ctrlKey: true });
    expect(selectedOption()!.textContent).toContain("update opencode");
    fireEvent.keyDown(input, { key: "p", ctrlKey: true });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selectedOption()!.textContent).toContain("update --all");
  });

  it("Tab completes the highlighted suggestion and keeps the dialog open", () => {
    setup(commandSet());
    const input = openCommandLine();
    type(input, "upd");
    const prevented = !fireEvent.keyDown(input, { key: "Tab" });
    expect(prevented).toBe(true);
    expect(input.value).toBe("update claude ");
    expect(screen.getByRole("dialog", { name: "Command line" })).not.toBeNull();
  });

  it("Enter runs the typed line, closes, and hands the parsed args to the command", () => {
    const run = vi.fn();
    setup(commandSet(run));
    const input = openCommandLine();
    type(input, "update cl");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({ named: { target: "claude" } });
    expect(screen.queryByRole("dialog", { name: "Command line" })).toBeNull();
  });

  it("Enter on a navigated suggestion runs that suggestion", () => {
    const run = vi.fn();
    setup(commandSet(run));
    const input = openCommandLine();
    type(input, "upd");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run.mock.calls[0]![0]).toMatchObject({ named: { target: "codex" } });
  });

  it("Enter on an incomplete line completes instead of guessing a target", () => {
    const run = vi.fn();
    setup(commandSet(run));
    const input = openCommandLine();
    type(input, "update");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
    expect(input.value).toBe("update claude ");
    expect(screen.getByRole("dialog", { name: "Command line" })).not.toBeNull();
  });

  it("runs a suggestion when it is clicked", () => {
    const run = vi.fn();
    setup(commandSet(run));
    const input = openCommandLine();
    type(input, "theme ");
    fireEvent.click(screen.getByRole("option", { name: /theme light/ }));
    expect(run.mock.calls[0]![0]).toMatchObject({ named: { mode: "light" } });
  });

  it("shows why a line cannot run and stays open", () => {
    const run = vi.fn();
    setup(commandSet(run));
    const input = openCommandLine();
    type(input, "frobnicate");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toMatch(/unknown command "frobnicate"/);
    type(input, "update nope");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toMatch(/invalid target "nope"/);
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Command line" })).not.toBeNull();
  });

  it("refuses disabled commands with their reason", () => {
    const run = vi.fn();
    setup(commandSet(run));
    const input = openCommandLine();
    type(input, "rollback");
    expect(options()[0]).toContain("no uninstall to roll back");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("rollback: no uninstall to roll back");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a command that rejects through the toast", async () => {
    setup(commandSet());
    const input = openCommandLine();
    type(input, "boom");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.querySelector(".toast")!.textContent).toBe("boom: exploded"));
    expect(document.querySelector(".toast-text")!.getAttribute("data-tone")).toBe("fail");
  });

  it("Mod+k opens it with an empty line", () => {
    setup(commandSet());
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox", { name: "Command" }) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("ignores keys while composing", () => {
    const run = vi.fn();
    setup(commandSet(run));
    const input = openCommandLine();
    type(input, "help");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(run).not.toHaveBeenCalled();
  });
});
