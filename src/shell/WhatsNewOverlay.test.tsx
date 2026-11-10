import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseNotes } from "../lib/releaseNotes";
import { renderInFrame } from "../test/renderWithShell";
import { Pane } from "../ui/Pane";
import { useShellState } from "./ShellState";

afterEach(cleanup);

const RELEASES: ReleaseNotes[] = [
  {
    version: "2026.10.2",
    sections: [{ title: "Fixes", items: ["Close the gap", "**Routing** reads `opencode.json` and a lone ` or *"] }],
  },
  {
    version: "2026.10.1",
    sections: [
      { title: "New", items: ["Manage the rules block", "Show skill copies"] },
      { title: "Fixes", items: ["Wait for the apply hint"] },
    ],
  },
];

function Opener({ onClose }: { onClose?: () => void }) {
  const { openWhatsNew } = useShellState();
  return (
    <Pane id="main" title="main" scrollable>
      <button type="button" onClick={() => openWhatsNew({ releases: RELEASES, onClose })}>
        show notes
      </button>
    </Pane>
  );
}

function open(onClose?: () => void) {
  renderInFrame(<Opener onClose={onClose} />);
  const trigger = screen.getByRole("button", { name: "show notes" });
  act(() => trigger.focus());
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "What's new" }) };
}

describe("WhatsNewOverlay", () => {
  it("lists each release as a section of labelled rows, newest first", () => {
    const { dialog } = open();

    const sections = within(dialog).getAllByRole("region");
    expect(sections.map(section => section.getAttribute("aria-label"))).toEqual(["2026.10.2", "2026.10.1"]);
    const rows = Array.from(sections[1]!.querySelectorAll("dt")).map(dt => [dt.textContent, dt.nextElementSibling!.textContent]);
    expect(rows).toEqual([
      ["new", "Manage the rules block"],
      ["new", "Show skill copies"],
      ["fixes", "Wait for the apply hint"],
    ]);
  });

  it("shows the notes' `code` and **bold** as code and bold, without the marks", () => {
    const { dialog } = open();

    const row = within(dialog).getAllByRole("region")[0]!.querySelectorAll("dd")[1]!;
    expect(row.textContent).toBe("Routing reads opencode.json and a lone ` or *");
    expect(row.querySelector("strong")!.textContent).toBe("Routing");
    expect(row.querySelector("code.markdown-inline-code")!.textContent).toBe("opencode.json");
  });

  it("reuses the help overlay structure and styling hooks, with its own modifier", () => {
    const { dialog } = open();

    expect(dialog.className).toBe("help-overlay whatsnew");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("data-keyscope")).toBe("overlay");
    expect(dialog.querySelector(":scope > .help-box > h2")).not.toBeNull();
    expect(dialog.querySelector(".help-box .help-cols > section > h3.group")).not.toBeNull();
    expect(dialog.querySelector(".help-box .help-cols dl.kv")).not.toBeNull();
    expect(dialog.querySelector(".help-box p.foot")).not.toBeNull();
  });

  it("takes focus and gives focus back on close", () => {
    const { trigger, dialog } = open();
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "What's new" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes with Escape, q, its close button and a backdrop click, running onClose once each time", () => {
    const onClose = vi.fn();
    const closers: Array<(dialog: HTMLElement) => void> = [
      dialog => fireEvent.keyDown(dialog, { key: "Escape" }),
      dialog => fireEvent.keyDown(dialog, { key: "q" }),
      dialog => fireEvent.click(within(dialog).getByRole("button", { name: /close/ })),
      dialog => fireEvent.mouseDown(dialog),
    ];
    closers.forEach((close, index) => {
      const { dialog } = open(onClose);
      fireEvent.mouseDown(dialog.querySelector(".help-box")!);
      expect(screen.queryByRole("dialog", { name: "What's new" })).not.toBeNull();
      close(dialog);
      expect(screen.queryByRole("dialog", { name: "What's new" })).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(index + 1);
      cleanup();
    });
  });

  it("keeps Tab inside and scrolls from the keyboard like the help overlay", () => {
    const { dialog } = open();
    const close = within(dialog).getByRole("button", { name: /close/ });
    act(() => close.focus());
    expect(!fireEvent.keyDown(close, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(close);

    const box = dialog.querySelector<HTMLElement>(".help-box")!;
    Object.defineProperty(box, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(box, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(box, "scrollTop", { value: 0, writable: true, configurable: true });
    expect(!fireEvent.keyDown(dialog, { key: "j" })).toBe(true);
    expect(box.scrollTop).toBeGreaterThan(0);
    expect(!fireEvent.keyDown(dialog, { key: "G" })).toBe(true);
    expect(box.scrollTop).toBe(800);
    expect(screen.queryByRole("dialog", { name: "What's new" })).not.toBeNull();
  });

  it("does not run background bindings while open", () => {
    const { dialog } = open();
    // `?` would open the help overlay from the global layer.
    fireEvent.keyDown(dialog, { key: "?", shiftKey: true });
    expect(screen.queryByRole("dialog", { name: "Keyboard help" })).toBeNull();
  });
});
