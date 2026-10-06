import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeaderNav, type AppHeaderView } from "./AppHeaderNav";

describe("AppHeaderNav", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Repo Dashboard, Prompt Builder, and Library after Claude and before Settings", () => {
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
      "Prompt Builder",
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

  it("hides only disabled harness navigation", () => {
    render(
      <AppHeaderNav
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
    fireEvent.click(screen.getByRole("button", { name: "Prompt Builder" }));
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
    expect(screen.getByRole("button", { name: "Prompt Builder" }).className).toContain("nav-icon-active");
    expect(screen.getByRole("button", { name: "Repo Dashboard" }).className).not.toContain("nav-icon-active");

    rerender(
      <AppHeaderNav
        view="repo-dashboard"
        libraryDirty={false}
        settingsErrored={false}
        onSwitchView={onSwitchView}
      />,
    );
    expect(screen.getByRole("button", { name: "Prompt Builder" }).className).not.toContain("nav-icon-active");
    expect(screen.getByRole("button", { name: "Repo Dashboard" }).className).toContain("nav-icon-active");
  });

  it("exposes unsaved and error state in the accessible names of Library and Settings", () => {
    render(
      <AppHeaderNav
        view="start"
        libraryDirty={true}
        settingsErrored={true}
        onSwitchView={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Library, unsaved changes" }).className).toContain("nav-icon-dirty");
    expect(screen.getByRole("button", { name: "Settings, unsaved changes" }).className).toContain("nav-icon-dirty");
    expect(screen.queryByRole("button", { name: "Library" })).toBeNull();
  });
});
