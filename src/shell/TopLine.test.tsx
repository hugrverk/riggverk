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
  it("renders Library, Repo Dashboard, Prompt Builder and Settings after the harnesses, in tab order", () => {
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
      "Repo Dashboard",
      "Prompt Builder",
      "Settings",
    ]);
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
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-keyshortcuts")).toBe("5");
  });

  it("with every harness hidden, only workspace and the tools remain", () => {
    const { container } = render(
      <TopLine view="start" libraryDirty={false} settingsErrored={false} enabledHarnessIds={[]} onSwitchView={vi.fn()} />,
    );
    expect(tabLabels(container)).toEqual(["Workspace", "Library", "Repo Dashboard", "Prompt Builder", "Settings"]);
  });

  it("routes clicks to the correct direct view", () => {
    const onSwitchView = vi.fn<(view: AppView) => void>();
    render(<TopLine view="start" libraryDirty={false} settingsErrored={false} onSwitchView={onSwitchView} />);
    fireEvent.click(screen.getByRole("button", { name: "Prompt Builder" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("prompts");
    fireEvent.click(screen.getByRole("button", { name: "Repo Dashboard" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("repo-dashboard");
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("start");
  });

  it("marks the matching tab with aria-current=page", () => {
    const { rerender } = render(
      <TopLine view="prompts" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Prompt Builder" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Repo Dashboard" }).getAttribute("aria-current")).toBeNull();

    rerender(<TopLine view="repo-dashboard" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Prompt Builder" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: "Repo Dashboard" }).getAttribute("aria-current")).toBe("page");
  });

  it("exposes positional aria-keyshortcuts on every tab", () => {
    render(<TopLine view="start" libraryDirty={false} settingsErrored={false} onSwitchView={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Workspace" }).getAttribute("aria-keyshortcuts")).toBe("1");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-keyshortcuts")).toBe("9");
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
    expect(header.textContent).not.toContain("agent-workspace");
    expect(header.querySelector(".right")!.textContent).toBe("main ✓");
    expect(screen.getByRole("navigation", { name: "Main navigation" })).not.toBeNull();
  });
});
