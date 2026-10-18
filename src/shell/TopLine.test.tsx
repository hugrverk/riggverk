import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopLine } from "./TopLine";
import type { AppView } from "./views";

afterEach(() => {
  cleanup();
});

function tabLabels(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll("nav.tabs button.tab")).map(button => button.getAttribute("aria-label"));
}

describe("TopLine", () => {
  it("renders Library and Settings after the harnesses, in tab order", () => {
    const { container } = render(
      <TopLine view="start" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />,
    );
    expect(container.querySelector("header.topline")).not.toBeNull();
    expect(tabLabels(container)).toEqual([
      "Workspace",
      "Codex",
      "OpenCode",
      "Cursor",
      "Claude",
      "Library",
      "Settings",
    ]);
  });

  it("appends Copilot, Pi and Kilo after Claude, so the first five tabs keep their numbers", () => {
    const { container } = render(
      <TopLine
        view="start"
        libraryDirty={false}
        settingsErrored={false}
        enabledHarnessIds={["codex", "opencode", "claude", "cursor", "copilot", "pi", "kilo"]}
        onSwitchView={vi.fn()}
      />,
    );
    expect(tabLabels(container)).toEqual([
      "Workspace",
      "Codex",
      "OpenCode",
      "Cursor",
      "Claude",
      "Copilot",
      "Pi",
      "Kilo",
      "Library",
      "Settings",
    ]);
    const numbers = Array.from(container.querySelectorAll("button.tab b")).map(el => el.textContent);
    expect(numbers.slice(0, 5)).toEqual(["1", "2", "3", "4", "5"]);
    // With seven harnesses on, Settings is the tenth tab and loses its digit; the others keep theirs.
    expect(screen.getByRole("button", { name: "Kilo" }).getAttribute("aria-keyshortcuts")).toBe("8");
    expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-keyshortcuts")).toBe("9");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-keyshortcuts")).toBeNull();
    // Short labels for a narrow window.
    expect(Array.from(container.querySelectorAll("button.tab .short")).map(el => el.textContent).slice(5, 8)).toEqual([
      "cop",
      "pi",
      "kilo",
    ]);
  });

  it("shows no light tab on its own defaults", () => {
    const { container } = render(
      <TopLine view="start" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />,
    );
    for (const name of ["Copilot", "Pi", "Kilo"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(container.querySelectorAll("nav.tabs button.tab")).toHaveLength(7);
  });

  it("does not render a Tools button", () => {
    render(<TopLine view="start" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Tools" })).toBeNull();
  });

  it("hides only disabled harness tabs and renumbers the tabs after them", () => {
    const { container } = render(
      <TopLine
        view="start"
        libraryDirty={false}
        settingsErrored={false}
        enabledHarnessIds={["codex", "opencode", "cursor"]}
        onSwitchView={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
    expect(screen.getByRole("button", { name: "Codex" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Library" })).not.toBeNull();
    const numbers = Array.from(container.querySelectorAll("button.tab b")).map(el => el.textContent);
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-keyshortcuts")).toBe("5");
  });

  it("with every harness hidden, only workspace and the tools remain", () => {
    const { container } = render(
      <TopLine view="start" libraryDirty={false} settingsErrored={false} enabledHarnessIds={[]} onSwitchView={vi.fn()} />,
    );
    expect(tabLabels(container)).toEqual(["Workspace", "Library", "Settings"]);
  });

  it("routes clicks to the correct direct view", () => {
    const onSwitchView = vi.fn<(view: AppView) => void>();
    render(<TopLine view="start" libraryDirty={false} settingsErrored={false} onSwitchView={onSwitchView} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("settings");
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("library");
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("start");
  });

  it("marks the matching tab with aria-current=page", () => {
    const { rerender } = render(
      <TopLine view="settings" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-current")).toBeNull();

    rerender(<TopLine view="library" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-current")).toBe("page");
  });

  it("exposes positional aria-keyshortcuts on every tab", () => {
    render(<TopLine view="start" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Workspace" }).getAttribute("aria-keyshortcuts")).toBe("1");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-keyshortcuts")).toBe("7");
  });

  it("exposes unsaved and error state in the accessible names of Library and Settings, with a warning dot", () => {
    render(<TopLine view="start" libraryDirty settingsErrored onSwitchView={vi.fn()} />);
    const library = screen.getByRole("button", { name: "Library, unsaved changes" });
    expect(library.querySelector(".st.st-warn")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Settings, unsaved changes" }).querySelector(".st.st-warn")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Library" })).toBeNull();
  });

  it("marks only a dirty or errored tab: harness tabs carry no dot", () => {
    const { container } = render(
      <TopLine view="start" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />,
    );
    expect(container.querySelector("nav.tabs .st")).toBeNull();
    cleanup();
    const dirty = render(<TopLine view="start" libraryDirty settingsErrored={false} onSwitchView={vi.fn()} />);
    expect(Array.from(dirty.container.querySelectorAll("nav.tabs .st"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Codex" }).querySelector(".st")).toBeNull();
  });

  it("is a window drag region with tabs and a right slot, without a brand label", () => {
    const { container } = render(
      <TopLine view="start" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} right="main ✓" />,
    );
    const header = container.querySelector("header.topline")!;
    expect(header.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(header.querySelector(".brand")).toBeNull();
    expect(header.textContent).not.toMatch(/riggverk/i);
    expect(header.querySelector(".right")!.textContent).toBe("main ✓");
    expect(screen.getByRole("navigation", { name: "Main navigation" })).not.toBeNull();
  });
});
