import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeaderNav, type AppHeaderView } from "./AppHeaderNav";

describe("AppHeaderNav", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Repo Dashboard, Prompt Loops, and Library after Claude and before Settings", () => {
    const onSwitchView = vi.fn();
    const { container } = render(
      <AppHeaderNav
        view="start"
        libraryDirty={false}
        settingsErrored={false}
        onSwitchView={onSwitchView}
      />,
    );
    const nav = container.querySelector("nav.nav-icons");
    expect(nav).not.toBeNull();
    const labels = Array.from(nav?.querySelectorAll("button.nav-icon") ?? []).map(btn => btn.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Workspace",
      "Codex",
      "OpenCode",
      "Cursor",
      "Claude",
      "Repo Dashboard",
      "Prompt Loops",
      "Library",
      "Settings",
    ]);
  });

  it("does not render a Tools button", () => {
    render(
      <AppHeaderNav
        view="start"
        libraryDirty={false}
        settingsErrored={false}
        onSwitchView={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Tools" })).toBeNull();
  });

  it("uses exact accessible names 'Prompt Loops' and 'Repo Dashboard'", () => {
    render(
      <AppHeaderNav
        view="start"
        libraryDirty={false}
        settingsErrored={false}
        onSwitchView={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Prompt Loops" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Repo Dashboard" })).not.toBeNull();
  });

  it("routes clicks to the correct direct view", () => {
    const onSwitchView = vi.fn<(view: AppHeaderView) => void>();
    render(
      <AppHeaderNav
        view="start"
        libraryDirty={false}
        settingsErrored={false}
        onSwitchView={onSwitchView}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Prompt Loops" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("prompts");
    fireEvent.click(screen.getByRole("button", { name: "Repo Dashboard" }));
    expect(onSwitchView).toHaveBeenLastCalledWith("repo-dashboard");
  });

  it("applies the active class to the matching view", () => {
    const onSwitchView = vi.fn();
    const { rerender } = render(
      <AppHeaderNav
        view="prompts"
        libraryDirty={false}
        settingsErrored={false}
        onSwitchView={onSwitchView}
      />,
    );
    expect(screen.getByRole("button", { name: "Prompt Loops" }).className).toContain("nav-icon-active");
    expect(screen.getByRole("button", { name: "Repo Dashboard" }).className).not.toContain("nav-icon-active");

    rerender(
      <AppHeaderNav
        view="repo-dashboard"
        libraryDirty={false}
        settingsErrored={false}
        onSwitchView={onSwitchView}
      />,
    );
    expect(screen.getByRole("button", { name: "Prompt Loops" }).className).not.toContain("nav-icon-active");
    expect(screen.getByRole("button", { name: "Repo Dashboard" }).className).toContain("nav-icon-active");
  });

  it("exposes the buttons as keyboard-focusable", () => {
    render(
      <AppHeaderNav
        view="start"
        libraryDirty={false}
        settingsErrored={false}
        onSwitchView={vi.fn()}
      />,
    );
    for (const label of ["Prompt Loops", "Repo Dashboard"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      expect(button.tagName).toBe("BUTTON");
    }
  });
});
