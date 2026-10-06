import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import { Pane } from "../ui/Pane";
import { PaneList } from "../ui/PaneList";
import type { AppView } from "./views";

afterEach(cleanup);

function press(target: Element | Document, key: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key, ...init });
}

function Panes({ withInput = false }: { withInput?: boolean }) {
  return (
    <>
      <Pane id="harnesses" index={1} title="harnesses" defaultFocus>
        <PaneList
          label="Harnesses"
          items={[{ id: "a" }, { id: "b" }]}
          getKey={item => item.id}
          renderItem={item => <span className="nm">{item.id}</span>}
        />
      </Pane>
      <Pane id="surfaces" index={2} title="surfaces" scrollable>
        {withInput && <input aria-label="name" />}
        <p>body</p>
      </Pane>
      <Pane id="output" index={3} title="output" scrollable>
        <p>log</p>
      </Pane>
    </>
  );
}

describe("AppFrame", () => {
  describe("tab keys", () => {
    it("1-9 navigate positionally through the visible tabs", () => {
      const onSwitchView = vi.fn<(view: AppView) => void>();
      renderInFrame(<Panes />, { onSwitchView });
      press(document.body, "1");
      expect(onSwitchView).toHaveBeenLastCalledWith("start");
      press(document.body, "3");
      expect(onSwitchView).toHaveBeenLastCalledWith("opencode");
      press(document.body, "6");
      expect(onSwitchView).toHaveBeenLastCalledWith("library");
      press(document.body, "9");
      expect(onSwitchView).toHaveBeenLastCalledWith("settings");
    });

    it("renumbers when a harness is hidden and ignores digits past the last tab", () => {
      const onSwitchView = vi.fn<(view: AppView) => void>();
      renderInFrame(<Panes />, { onSwitchView, enabledHarnessIds: ["codex", "cursor"] });
      press(document.body, "3");
      expect(onSwitchView).toHaveBeenLastCalledWith("cursor");
      onSwitchView.mockClear();
      const notPrevented = press(document.body, "9");
      expect(notPrevented).toBe(true);
      expect(onSwitchView).not.toHaveBeenCalled();
    });

    it("does not switch tabs while typing in a text field", () => {
      const onSwitchView = vi.fn();
      renderInFrame(<Panes withInput />, { onSwitchView });
      const input = screen.getByLabelText("name");
      act(() => input.focus());
      press(input, "2");
      expect(onSwitchView).not.toHaveBeenCalled();
    });

    it("Mod+, opens settings, even from a text field", () => {
      const onSwitchView = vi.fn();
      renderInFrame(<Panes withInput />, { onSwitchView });
      const input = screen.getByLabelText("name");
      act(() => input.focus());
      press(input, ",", { ctrlKey: true });
      expect(onSwitchView).toHaveBeenLastCalledWith("settings");
    });

    it("clicking a tab switches, and clicking the current tab re-focuses its default pane", async () => {
      const onSwitchView = vi.fn();
      renderInFrame(<Panes />, { onSwitchView });
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Harnesses" })));
      act(() => screen.getByRole("group", { name: "output" }).focus());
      fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
      expect(onSwitchView).toHaveBeenLastCalledWith("start");
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Harnesses" })));
    });
  });

  describe("pane focus", () => {
    it("h and l move between panes in DOM order", () => {
      renderInFrame(<Panes />);
      act(() => screen.getByRole("listbox", { name: "Harnesses" }).focus());
      press(document.activeElement!, "l");
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "surfaces" }));
      press(document.activeElement!, "l");
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "output" }));
      const atEnd = press(document.activeElement!, "l");
      expect(atEnd).toBe(true);
      press(document.activeElement!, "h");
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "surfaces" }));
    });

    it("Escape in a text field returns focus to the pane's primary target", () => {
      renderInFrame(<Panes withInput />);
      const input = screen.getByLabelText("name");
      act(() => input.focus());
      press(input, "Escape");
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "surfaces" }));
    });

    it("focuses the default pane on mount and again after the view changes", async () => {
      const { rerenderFrame } = renderInFrame(<Panes />, { view: "start" });
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Harnesses" })));
      rerenderFrame(
        <Pane id="only" index={1} title="only" scrollable>
          <p>settings</p>
        </Pane>,
        { view: "settings" },
      );
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("group", { name: "only" })));
    });

    it("waits for a pane that mounts late (lazy view) and then focuses it", async () => {
      const { rerenderFrame } = renderInFrame(<p>loading</p>, { view: "library" });
      expect(document.querySelector(".view-area")!.contains(document.activeElement)).toBe(false);
      rerenderFrame(<Panes />, { view: "library" });
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Harnesses" })));
    });

    it("never steals focus the user already placed inside the view", async () => {
      const { rerenderFrame } = renderInFrame(<p>loading</p>, { view: "library" });
      const field = document.createElement("input");
      field.setAttribute("aria-label", "late field");
      document.querySelector(".view-area")!.append(field);
      act(() => field.focus());
      rerenderFrame(<Panes />, { view: "library" });
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.activeElement).toBe(field);
    });
  });

  describe("overlays", () => {
    it(": and Mod+k open the command line, ? opens help", () => {
      renderInFrame(<Panes />);
      press(document.body, ":", { shiftKey: true });
      expect(screen.getByRole("dialog", { name: "Command line" })).not.toBeNull();
      press(screen.getByRole("combobox", { name: "Command" }), "Escape");
      expect(screen.queryByRole("dialog", { name: "Command line" })).toBeNull();

      press(document.body, "k", { ctrlKey: true });
      expect(screen.getByRole("dialog", { name: "Command line" })).not.toBeNull();
      press(screen.getByRole("combobox", { name: "Command" }), "k", { ctrlKey: true });
      expect(screen.queryByRole("dialog", { name: "Command line" })).toBeNull();

      press(document.body, "?", { shiftKey: true });
      expect(screen.getByRole("dialog", { name: "Keyboard help" })).not.toBeNull();
    });

    it("blocks tab and pane keys while an overlay is open", () => {
      const onSwitchView = vi.fn();
      renderInFrame(<Panes />, { onSwitchView });
      press(document.body, "?", { shiftKey: true });
      const help = screen.getByRole("dialog", { name: "Keyboard help" });
      press(help, "2");
      press(help, "l");
      expect(onSwitchView).not.toHaveBeenCalled();
    });

    it("the status bar's command and help hints are buttons that open the overlays", () => {
      renderInFrame(<Panes />);
      const status = screen.getByLabelText("Status bar");
      fireEvent.click(within(status).getByRole("button", { name: /command/ }));
      expect(screen.getByRole("dialog", { name: "Command line" })).not.toBeNull();
    });
  });

  describe("error line", () => {
    it("renders a role=alert line and dismisses by button and by Escape", () => {
      const onDismissError = vi.fn();
      renderInFrame(<Panes />, { error: "backups: boom", onDismissError });
      const alert = screen.getByRole("alert");
      expect(alert.className).toContain("error-line");
      expect(alert.textContent).toContain("backups: boom");
      expect(alert.querySelector(".error-line-text")!.textContent).toBe("backups: boom");
      fireEvent.click(within(alert).getByRole("button", { name: "Dismiss error" }));
      expect(onDismissError).toHaveBeenCalledTimes(1);
      press(document.body, "Escape");
      expect(onDismissError).toHaveBeenCalledTimes(2);
    });

    it("renders nothing without an error", () => {
      renderInFrame(<Panes />);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("renders top line, view area and status bar", () => {
    const { container } = renderInFrame(<Panes />);
    expect(container.querySelector(".app-shell > header.topline")).not.toBeNull();
    expect(container.querySelector(".app-shell > .view-area")).not.toBeNull();
    expect(container.querySelector(".app-shell > footer.statusbar")).not.toBeNull();
  });
});
