import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar, formatCheckedAt } from "./Sidebar";
import type { AppView } from "./views";

afterEach(cleanup);

function items(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll("nav button.nav:not(.dim)")).map(button => button.getAttribute("aria-label"));
}

function plain(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return render(<Sidebar view="start" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} {...props} />);
}

describe("Sidebar", () => {
  it("lists Overview, the enabled agents, Library and Settings in order, under section labels", () => {
    const { container } = plain();
    expect(items(container)).toEqual(["Overview", "Codex", "OpenCode", "Cursor", "Claude", "Library", "Settings"]);
    expect(Array.from(container.querySelectorAll(".nl")).map(label => label.textContent)).toEqual(["Agents", "Workspace"]);
    expect(within(screen.getByRole("group", { name: "Agents" })).getAllByRole("button").map(b => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Codex", "OpenCode", "Cursor", "Claude", "3 more agents",
    ]);
    expect(within(screen.getByRole("group", { name: "Workspace" })).getAllByRole("button").map(b => b.getAttribute("aria-label"))).toEqual([
      "Library", "Settings",
    ]);
    expect(screen.getByRole("navigation", { name: "Main navigation" })).not.toBeNull();
  });

  it("numbers the destinations with aria-keyshortcuts and a tooltip, and stops at 9", () => {
    plain({ enabledHarnessIds: ["codex", "opencode", "cursor", "claude", "copilot", "pi", "kilo"] });
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-keyshortcuts")).toBe("1");
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("title")).toBe("Overview (1)");
    expect(screen.getByRole("button", { name: "Kilo" }).getAttribute("aria-keyshortcuts")).toBe("8");
    expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-keyshortcuts")).toBe("9");
    // With every agent on, Settings falls beyond the digit keys.
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-keyshortcuts")).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("title")).toBe("Settings");
    expect(screen.queryByText(/more agents?$/)).toBeNull();
  });

  it("hides only disabled agents and renumbers the items after them", () => {
    const { container } = plain({ enabledHarnessIds: ["codex", "opencode", "cursor"] });
    expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
    expect(items(container)).toEqual(["Overview", "Codex", "OpenCode", "Cursor", "Library", "Settings"]);
    expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-keyshortcuts")).toBe("5");
  });

  it("with every agent hidden, only Overview, Library and Settings remain", () => {
    const { container } = plain({ enabledHarnessIds: [] });
    expect(items(container)).toEqual(["Overview", "Library", "Settings"]);
    expect(screen.getByRole("button", { name: "7 more agents" })).not.toBeNull();
  });

  it("folds disabled agents into one dim row that names them and leads to Settings", () => {
    const onSwitchView = vi.fn<(view: AppView) => void>();
    plain({ onSwitchView });
    const more = screen.getByRole("button", { name: "3 more agents" });
    expect(more.getAttribute("title")).toBe("Copilot, Pi and Kilo are off. Turn them on in Settings.");
    expect(more.getAttribute("aria-keyshortcuts")).toBeNull();
    fireEvent.click(more);
    expect(onSwitchView).toHaveBeenLastCalledWith("settings");
  });

  it("says 'is off' for a single disabled agent", () => {
    plain({ enabledHarnessIds: ["codex", "opencode", "cursor", "claude", "copilot", "pi"] });
    const more = screen.getByRole("button", { name: "1 more agent" });
    expect(more.getAttribute("title")).toBe("Kilo is off. Turn it on in Settings.");
  });

  it("routes clicks to the right view", () => {
    const onSwitchView = vi.fn<(view: AppView) => void>();
    plain({ onSwitchView });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("settings");
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("library");
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("start");
    fireEvent.click(screen.getByRole("button", { name: "Cursor" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("cursor");
  });

  it("marks the current item with aria-current=page", () => {
    const { rerender } = plain({ view: "settings" });
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-current")).toBeNull();
    rerender(<Sidebar view="library" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-current")).toBe("page");
  });

  it("exposes unsaved and error state in the accessible names of Library and Settings, with a marker", () => {
    plain({ libraryDirty: true, settingsErrored: true });
    const library = screen.getByRole("button", { name: "Library, unsaved changes" });
    expect(library.querySelector(".mark")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Settings, unsaved changes" }).querySelector(".mark")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Library" })).toBeNull();
  });

  it("marks nothing on a clean sidebar", () => {
    const { container } = plain();
    expect(container.querySelector(".mark, .nb")).toBeNull();
  });

  it("shows the number of decisions per agent as a badge, read out as the description, and no badge for zero", () => {
    plain({ decideCounts: { claude: 1, codex: 12 } });
    const claude = screen.getByRole("button", { name: "Claude" });
    expect(claude.querySelector(".nb")!.textContent).toBe("01");
    expect(claude).toHaveAccessibleDescription("1 to decide");
    expect(screen.getByRole("button", { name: "Codex" }).querySelector(".nb")!.textContent).toBe("12");
    expect(screen.getByRole("button", { name: "Cursor" }).querySelector(".nb")).toBeNull();
    // Overview and the workspace pages never carry an agent badge.
    expect(screen.getByRole("button", { name: "Overview" }).querySelector(".nb")).toBeNull();
  });

  it("is a window drag region with a brand row and a foot, clear of the traffic lights", () => {
    const { container } = plain({ version: "2026.10.5", backupCount: 19, checkedAt: new Date(2026, 9, 28, 15, 42) });
    const side = container.querySelector("aside.side")!;
    expect(side.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(side.querySelector(".brand")!.textContent).toBe("Riggverk2026.10.5");
    expect(side.querySelector(".foot")!.textContent).toBe("19 backupschecked 15:42");
  });

  it("words the foot for one backup, and omits what is not known yet", () => {
    const { container, rerender } = plain({ backupCount: 1 });
    expect(container.querySelector(".foot")!.textContent).toBe("1 backup");
    rerender(<Sidebar view="start" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />);
    expect(container.querySelector(".foot")!.textContent).toBe("");
  });
});

describe("formatCheckedAt", () => {
  it("is 24-hour HH:MM", () => {
    expect(formatCheckedAt(new Date(2026, 9, 28, 9, 5))).toBe("09:05");
    expect(formatCheckedAt(new Date(2026, 9, 28, 23, 59))).toBe("23:59");
  });
});
