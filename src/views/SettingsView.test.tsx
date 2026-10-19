import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  themeAccentDefault,
  themeColorDefaults,
  type SettingsSaveStatus,
} from "../lib/settingsDraft";
import { renderInFrame } from "../test/renderWithShell";
import type { AppSettings } from "../types";
import { SettingsView } from "./SettingsView";

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  // jsdom has no matchMedia; "system" appearance reads it for the colour defaults.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

type Props = ComponentProps<typeof SettingsView>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    appSettings: { ...defaultSettings(), revision: 1 },
    settingsMsg: null,
    settingsSaveStatus: "saved",
    onSetAppearance: vi.fn(),
    onSetAppFontSize: vi.fn(),
    onSetAccentColor: vi.fn(),
    onSetBackgroundColor: vi.fn(),
    onSetForegroundColor: vi.fn(),
    onSetMotion: vi.fn(),
    onSetLandingView: vi.fn(),
    onToggleHarness: vi.fn(),
    onRetrySave: vi.fn(),
    onReset: vi.fn(),
    colorResetKey: 0,
    ...overrides,
  };
}

function renderSettings(overrides: Partial<Props> = {}) {
  const props = makeProps(overrides);
  const view = renderInFrame(<SettingsView {...props} />, { view: "settings" });
  return { props, ...view };
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key, ...init });
}

function focus(element: HTMLElement) {
  act(() => element.focus());
}

function mode(): string {
  return screen.getByLabelText("Status bar").querySelector(".mode")!.textContent!;
}

function radios(group: string): HTMLElement[] {
  return within(screen.getByRole("radiogroup", { name: group })).getAllByRole("radio");
}

function pane(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** Key hints of the focused pane live in the status bar. */
function hints() {
  return within(screen.getByLabelText("Status bar"));
}

/** Keeps the draft in state so radio selections re-render like they do under App. */
function StatefulSettings({ onAppearance }: { onAppearance?: (value: AppSettings["appearance"]) => void }) {
  const [settings, setSettings] = useState<AppSettings>({ ...defaultSettings(), revision: 1 });
  const props = makeProps({
    appSettings: settings,
    onSetAppearance: appearance => {
      onAppearance?.(appearance);
      setSettings(current => ({ ...current, appearance }));
    },
    onSetAppFontSize: size => setSettings(current => ({ ...current, app_font_size: size })),
  });
  return <SettingsView {...props} />;
}

describe("SettingsView layout", () => {
  it("renders an appearance pane and an app pane of key/value rows", () => {
    renderSettings();
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    const appearance = pane("Appearance");
    expect(within(appearance).getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(within(appearance).getByRole("radiogroup", { name: "Global app text size" })).toBeTruthy();
    expect(within(appearance).getByRole("radiogroup", { name: "Motion" })).toBeTruthy();
    expect(within(appearance).getByLabelText("Accent hex code")).toBeTruthy();
    const app = pane("App");
    expect(within(app).getByRole("radiogroup", { name: "Landing page" })).toBeTruthy();
    expect(within(app).getByRole("checkbox", { name: "codex" })).toBeTruthy();
  });

  it("offers the four persisted text sizes", () => {
    renderSettings();
    expect(radios("Global app text size").map(radio => radio.textContent!.replace(/^\(.\)/, "").trim())).toEqual([
      "small",
      "medium",
      "large",
      "extra large",
    ]);
  });

  it("shows a loading pane until settings arrive", () => {
    renderSettings({ appSettings: null });
    expect(screen.getByRole("region", { name: "Loading settings" }).textContent).toContain("loading");
  });
});

describe("SettingsView radio groups", () => {
  it("keeps one tab stop per group, on the checked option", () => {
    const { props, rerenderFrame } = renderSettings();
    expect(radios("Theme").map(radio => radio.tabIndex)).toEqual([0, -1, -1]);
    expect(radios("Theme").map(radio => radio.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(radios("Landing page").map(radio => radio.tabIndex)).toEqual([0, -1]);

    rerenderFrame(<SettingsView {...props} appSettings={{ ...props.appSettings!, appearance: "system" }} />);
    expect(radios("Theme").map(radio => radio.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("falls back to the first option as tab stop when the saved value is not offered", () => {
    renderSettings({ appSettings: { ...defaultSettings(), landing_view: "codex" } });
    expect(radios("Landing page").map(radio => radio.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(radios("Landing page").map(radio => radio.tabIndex)).toEqual([0, -1]);
  });

  it("moves and selects with the arrow keys, wrapping at both ends", () => {
    const onAppearance = vi.fn();
    renderInFrame(<StatefulSettings onAppearance={onAppearance} />, { view: "settings" });
    const [dark] = radios("Theme");
    focus(dark!);

    press(dark!, "ArrowRight");
    expect(onAppearance).toHaveBeenLastCalledWith("light");
    expect(document.activeElement).toBe(radios("Theme")[1]);
    expect(radios("Theme")[1]!.getAttribute("aria-checked")).toBe("true");

    press(document.activeElement!, "ArrowDown");
    expect(onAppearance).toHaveBeenLastCalledWith("system");
    press(document.activeElement!, "ArrowRight");
    expect(onAppearance).toHaveBeenLastCalledWith("dark");
    expect(document.activeElement).toBe(radios("Theme")[0]);

    press(document.activeElement!, "ArrowLeft");
    expect(onAppearance).toHaveBeenLastCalledWith("system");
    press(document.activeElement!, "ArrowUp");
    expect(onAppearance).toHaveBeenLastCalledWith("light");
  });

  it("selects text size with the arrow keys", () => {
    const { props } = renderSettings();
    const [small, medium] = radios("Global app text size");
    focus(medium!);
    press(medium!, "ArrowRight");
    expect(props.onSetAppFontSize).toHaveBeenLastCalledWith("large");
    press(medium!, "ArrowLeft");
    expect(props.onSetAppFontSize).toHaveBeenLastCalledWith("small");
    expect(small).toBeTruthy();
  });

  it("ignores arrow keys with a modifier held", () => {
    const { props } = renderSettings();
    const [dark] = radios("Theme");
    focus(dark!);
    press(dark!, "ArrowRight", { metaKey: true });
    press(dark!, "ArrowRight", { altKey: true });
    expect(props.onSetAppearance).not.toHaveBeenCalled();
  });

  it("selects by click for motion and landing page", () => {
    const { props } = renderSettings();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Motion" })).getByRole("radio", { name: "off" }));
    expect(props.onSetMotion).toHaveBeenCalledWith("off");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Landing page" })).getByRole("radio", { name: "library" }));
    expect(props.onSetLandingView).toHaveBeenCalledWith("library");
  });

  it("toggles a harness with a checkbox button", () => {
    const { props } = renderSettings({ appSettings: { ...defaultSettings(), enabled_harness_ids: ["codex"] } });
    expect(screen.getByRole("checkbox", { name: "codex" }).getAttribute("aria-checked")).toBe("true");
    const cursor = screen.getByRole("checkbox", { name: "cursor" });
    expect(cursor.getAttribute("aria-checked")).toBe("false");
    expect(cursor.textContent).toContain("disabled");
    fireEvent.click(cursor);
    expect(props.onToggleHarness).toHaveBeenCalledWith("cursor");
  });

  it("offers Copilot, Pi and Kilo after the four central harnesses, off by default", () => {
    const { props } = renderSettings();
    const harnesses = ["codex", "opencode", "claude", "cursor", "copilot", "pi", "kilo"];
    const boxes = harnesses.map(name => screen.getByRole("checkbox", { name }));
    boxes.slice(1).forEach((box, index) => {
      expect(boxes[index]!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(boxes.map(box => box.getAttribute("aria-checked"))).toEqual(
      ["true", "true", "true", "true", "false", "false", "false"],
    );
    for (const box of boxes.slice(4)) expect(box.textContent).toContain("disabled");
    fireEvent.click(screen.getByRole("checkbox", { name: "pi" }));
    expect(props.onToggleHarness).toHaveBeenCalledWith("pi");
  });
});

describe("SettingsView motion control", () => {
  const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
  const NOTE = "the system asks for reduced motion: motion is off until that changes";

  /** A controllable `prefers-reduced-motion` query; every other query stays false. */
  function stubOsReducedMotion(initial: boolean) {
    const listeners = new Set<() => void>();
    const state = { reduced: initial };
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query === MOTION_QUERY && state.reduced;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    })) as unknown as typeof window.matchMedia;
    return {
      set(reduced: boolean) {
        state.reduced = reduced;
        act(() => listeners.forEach(listener => listener()));
      },
    };
  }

  it("offers full, subtle and off as radios in that order, with the setting checked", () => {
    renderSettings({ appSettings: { ...defaultSettings(), revision: 1, motion: "subtle" } });
    const options = radios("Motion");
    expect(options.map(option => option.textContent)).toEqual(["( )full", "(•)subtle", "( )off"]);
    expect(options.map(option => option.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    // The roving tab stop is on the checked option.
    expect(options.map(option => option.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("selects each level by click and with the arrow keys", () => {
    const { props } = renderSettings();
    const [full, subtle, off] = radios("Motion");
    fireEvent.click(subtle!);
    expect(props.onSetMotion).toHaveBeenLastCalledWith("subtle");
    fireEvent.click(off!);
    expect(props.onSetMotion).toHaveBeenLastCalledWith("off");
    focus(full!);
    press(full!, "ArrowRight");
    expect(props.onSetMotion).toHaveBeenLastCalledWith("subtle");
    press(full!, "ArrowLeft");
    expect(props.onSetMotion).toHaveBeenLastCalledWith("off");
  });

  it("shows no note while the system asks for nothing", () => {
    stubOsReducedMotion(false);
    renderSettings();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("says in a dim note that the system's reduced-motion request puts motion off, and follows the preference", () => {
    const os = stubOsReducedMotion(true);
    renderSettings({ appSettings: { ...defaultSettings(), revision: 1, motion: "full" } });
    const note = screen.getByText(NOTE);
    expect(note.className).toContain("c-dim");
    // On the motion row, beside the radios, not in another pane.
    expect(note.closest("dd")!.contains(screen.getByRole("radiogroup", { name: "Motion" }))).toBe(true);
    // The saved choice is still shown: the system overrides it, it does not rewrite it.
    expect(radios("Motion")[0]!.getAttribute("aria-checked")).toBe("true");
    os.set(false);
    expect(screen.queryByText(NOTE)).toBeNull();
    os.set(true);
    expect(screen.getByText(NOTE)).toBeTruthy();
  });
});

describe("SettingsView keyboard navigation", () => {
  it("j and k move focus between settings rows inside the pane", () => {
    renderSettings();
    const [dark] = radios("Theme");
    focus(dark!);

    press(dark!, "j");
    expect(document.activeElement).toBe(radios("Global app text size")[1]);
    press(document.activeElement!, "j");
    expect(document.activeElement).toBe(radios("Motion")[0]);
    press(document.activeElement!, "j");
    expect(document.activeElement).toBe(screen.getByLabelText("Accent hex code"));
  });

  it("hints j and k in the status bar from both panes, clickable, and keeps pane footers free of key hints", () => {
    renderSettings();
    focus(radios("Theme")[0]!);
    fireEvent.click(hints().getByRole("button", { name: "j next setting" }));
    expect(document.activeElement).toBe(radios("Global app text size")[1]);
    fireEvent.click(hints().getByRole("button", { name: "k prev setting" }));
    expect(document.activeElement).toBe(radios("Theme")[0]);

    focus(radios("Landing page")[0]!);
    expect(hints().getByRole("button", { name: "j next setting" })).not.toBeNull();
    expect(hints().getByRole("button", { name: "k prev setting" })).not.toBeNull();

    expect(pane("Appearance").querySelector(".pane-foot")).toBeNull();
    expect(pane("App").querySelector(".pane-foot")).toBeNull();
  });

  it("does not move focus with j in a hex field, and Escape leaves the field", () => {
    renderSettings();
    const accent = screen.getByLabelText("Accent hex code");
    focus(accent);
    expect(mode()).toBe("INSERT");

    press(accent, "j");
    expect(document.activeElement).toBe(accent);

    press(accent, "Escape");
    expect(document.activeElement).toBe(radios("Theme")[0]);
    expect(mode()).toBe("NORMAL");
  });

  it("k from the first row and j from the last row leave focus where it is", () => {
    renderSettings();
    const [dark] = radios("Theme");
    focus(dark!);
    expect(press(dark!, "k")).toBe(true);
    expect(document.activeElement).toBe(dark);

    const landing = radios("Landing page")[0]!;
    focus(landing);
    press(landing, "k");
    expect(document.activeElement).toBe(landing);
  });

  it("h and l move between the two panes and land on their first setting", () => {
    renderSettings();
    focus(radios("Theme")[0]!);
    press(document.activeElement!, "l");
    expect(document.activeElement).toBe(radios("Landing page")[0]);
    press(document.activeElement!, "h");
    expect(document.activeElement).toBe(radios("Theme")[0]);
  });

  it("does not steal Enter or Space from the focused radio", () => {
    renderSettings();
    const [dark] = radios("Theme");
    focus(dark!);
    expect(press(dark!, "Enter")).toBe(true);
    expect(press(dark!, " ")).toBe(true);
  });
});

describe("SettingsView colour fields", () => {
  it("applies a valid hex as lowercase and clears the override when emptied", () => {
    const { props } = renderSettings();
    const accent = screen.getByLabelText("Accent hex code");
    fireEvent.change(accent, { target: { value: "#AABBCC" } });
    expect(props.onSetAccentColor).toHaveBeenLastCalledWith("#aabbcc");
    fireEvent.change(accent, { target: { value: "" } });
    expect(props.onSetAccentColor).toHaveBeenLastCalledWith(null);
  });

  it("flags an invalid hex without applying it", () => {
    const { props } = renderSettings();
    const accent = screen.getByLabelText("Accent hex code");
    fireEvent.change(accent, { target: { value: "#12" } });
    expect(props.onSetAccentColor).not.toHaveBeenCalled();
    expect(accent.getAttribute("aria-invalid")).toBe("true");
    expect(accent.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(accent.getAttribute("aria-describedby")!)!.textContent).toContain("valid hex color");
  });

  it("the default button clears one override", () => {
    const { props } = renderSettings({ appSettings: { ...defaultSettings(), background_color: "#202020" } });
    fireEvent.click(screen.getByRole("button", { name: "Use default background color" }));
    expect(props.onSetBackgroundColor).toHaveBeenLastCalledWith(null);
  });

  it("uses the theme defaults as placeholders", () => {
    renderSettings({ appSettings: { ...defaultSettings(), appearance: "light" } });
    const defaults = themeColorDefaults("light");
    expect((screen.getByLabelText("Background hex code") as HTMLInputElement).placeholder).toBe(defaults.background);
    expect((screen.getByLabelText("Foreground hex code") as HTMLInputElement).placeholder).toBe(defaults.foreground);
  });

  it("uses the current theme accent as the placeholder", () => {
    renderSettings({ appSettings: { ...defaultSettings(), appearance: "dark" } });
    expect((screen.getByLabelText("Accent hex code") as HTMLInputElement).placeholder).toBe(themeAccentDefault("dark"));
    cleanup();
    renderSettings({ appSettings: { ...defaultSettings(), appearance: "light" } });
    expect((screen.getByLabelText("Accent hex code") as HTMLInputElement).placeholder).toBe(themeAccentDefault("light"));
  });

  it("warns when the custom foreground and background are hard to read", () => {
    renderSettings({
      appSettings: { ...defaultSettings(), foreground_color: "#777777", background_color: "#808080" },
    });
    expect(within(pane("Appearance")).getByRole("status").textContent).toContain("below 4.5:1");
  });

  it("shows no contrast warning for a readable pair", () => {
    renderSettings({
      appSettings: { ...defaultSettings(), foreground_color: "#ffffff", background_color: "#000000" },
    });
    expect(within(pane("Appearance")).queryByRole("status")).toBeNull();
  });
});

describe("SettingsView autosave status", () => {
  const cases: Array<[SettingsSaveStatus, string]> = [
    ["saved", "saved"],
    ["pending", "pending"],
    ["saving", "saving"],
    ["error", "error"],
  ];

  it.each(cases)("shows %s in the pane title and the autosave row", (status, label) => {
    renderSettings({ settingsSaveStatus: status });
    expect(pane("Appearance").querySelector(".pane-title")!.textContent).toContain(label);
    expect(screen.getByRole("status", { name: "autosave" }).textContent).toContain(label);
  });

  it("calls a failed save with a settings conflict message a conflict", () => {
    renderSettings({
      settingsSaveStatus: "error",
      settingsMsg: { ok: false, text: "settings conflict: revision 3 is stale" },
    });
    const row = screen.getByRole("status", { name: "autosave" });
    expect(row.textContent).toContain("conflict");
    expect(row.textContent).toContain("revision 3 is stale");
  });

  it("shows the message of a successful action as dim text", () => {
    renderSettings({ settingsMsg: { ok: true, text: "appearance reset to defaults" } });
    const message = within(screen.getByRole("status", { name: "autosave" })).getByText("appearance reset to defaults");
    expect(message.className).toContain("c-dim");
  });

  it("offers retry only after a failed save, from the footer and with s", () => {
    const { props, rerenderFrame } = renderSettings();
    focus(radios("Landing page")[0]!);
    expect(hints().queryByRole("button", { name: /retry save/ })).toBeNull();

    rerenderFrame(<SettingsView {...props} settingsSaveStatus="error" />);
    const retry = hints().getByRole("button", { name: /retry save/ });
    fireEvent.click(retry);
    expect(props.onRetrySave).toHaveBeenCalledTimes(1);

    press(document.activeElement!, "s");
    expect(props.onRetrySave).toHaveBeenCalledTimes(2);
  });

  it("disables retry while a colour is invalid", () => {
    const { props } = renderSettings({ settingsSaveStatus: "error" });
    fireEvent.change(screen.getByLabelText("Accent hex code"), { target: { value: "nope" } });
    focus(radios("Landing page")[0]!);
    const retry = hints().getByRole("button", { name: /retry save/ });
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(retry);
    expect(props.onRetrySave).not.toHaveBeenCalled();
  });
});

describe("SettingsView reset", () => {
  it("resets appearance from the footer key and from r, through onReset", async () => {
    const { props } = renderSettings();
    focus(radios("Theme")[0]!);
    fireEvent.click(hints().getByRole("button", { name: /reset appearance/ }));
    expect(props.onReset).toHaveBeenCalledTimes(1);
    await act(async () => {});

    focus(radios("Theme")[0]!);
    press(document.activeElement!, "r");
    expect(props.onReset).toHaveBeenCalledTimes(2);
  });

  it("does not offer reset from the app pane", () => {
    const { props } = renderSettings();
    focus(radios("Landing page")[0]!);
    press(document.activeElement!, "r");
    expect(props.onReset).not.toHaveBeenCalled();
  });

  it("ignores a second request while the reset is pending", async () => {
    let finish: () => void = () => {};
    const onReset = vi.fn(() => new Promise<void>(resolveReset => {
      finish = resolveReset;
    }));
    renderSettings({ onReset });
    focus(radios("Theme")[0]!);

    press(document.activeElement!, "r");
    press(document.activeElement!, "r");
    expect(onReset).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    press(document.activeElement!, "r");
    expect(onReset).toHaveBeenCalledTimes(2);
  });
});

describe("SettingsView workspace row", () => {
  const custom = { ...defaultSettings(), workspace_path: "/Users/dev/other-workspace", revision: 1 };

  function workspaceRow() {
    return within(pane("App")).getByRole("group", { name: "workspace" });
  }

  it("shows the default workspace and offers a reset that has nothing to do", () => {
    renderSettings({
      workspacePath: "/Users/dev/.config/agent-workspace",
      onResetWorkspace: vi.fn(async () => null),
    });
    const row = workspaceRow();
    expect(row.textContent).toContain("/Users/dev/.config/agent-workspace");
    expect(row.textContent).toContain("default");
    const reset = within(row).getByRole("button", { name: /reset to default/ });
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    expect(reset.title).toBe("already the default workspace");
  });

  it("shows a saved custom folder and offers reset", () => {
    renderSettings({
      appSettings: custom,
      workspacePath: "/Users/dev/other-workspace",
      onResetWorkspace: vi.fn(async () => null),
    });
    const row = workspaceRow();
    expect(row.textContent).toContain("/Users/dev/other-workspace");
    expect(row.textContent).toContain("custom folder");
    expect(within(row).getByRole("button", { name: /reset to default/ }).getAttribute("aria-disabled")).toBeNull();
  });

  it("falls back to the saved path and then the default display path", () => {
    renderSettings({ appSettings: custom });
    expect(workspaceRow().textContent).toContain("/Users/dev/other-workspace");
    cleanup();
    renderSettings();
    expect(workspaceRow().textContent).toContain("~/.config/agent-workspace");
  });

  it("has no folder chooser: no choose button or hint, and c does nothing", async () => {
    const onResetWorkspace = vi.fn(async () => null);
    renderSettings({ appSettings: custom, onResetWorkspace });

    expect(within(workspaceRow()).queryByRole("button", { name: /choose/ })).toBeNull();
    focus(radios("Theme")[0]!);
    expect(hints().queryByRole("button", { name: /choose/ })).toBeNull();
    focus(radios("Landing page")[0]!);
    press(document.activeElement!, "c");
    expect(onResetWorkspace).not.toHaveBeenCalled();
    expect(workspaceRow().querySelector("[role=status]")!.textContent).toBe("");
    await act(async () => {});
  });

  it("reaches reset from the appearance pane, and hints it in the status bar", async () => {
    const onResetWorkspace = vi.fn(async () => null);
    const { rerenderFrame, props } = renderSettings({ onResetWorkspace });

    focus(radios("Theme")[0]!);
    expect(within(pane("Appearance")).queryByRole("button", { name: /reset folder/ })).toBeNull();
    expect(hints().getByRole("button", { name: /reset folder/ }).getAttribute("aria-disabled")).toBe("true");

    rerenderFrame(<SettingsView {...props} appSettings={custom} />);
    focus(radios("Theme")[0]!);
    expect(hints().getByRole("button", { name: /reset folder/ }).getAttribute("aria-disabled")).toBeNull();
    press(document.activeElement!, "R", { shiftKey: true });
    expect(onResetWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });

  it("resets from the shifted R key and the button only when a custom folder is active", async () => {
    const onResetWorkspace = vi.fn(async () => null);
    const { rerenderFrame, props } = renderSettings({ onResetWorkspace });

    focus(radios("Landing page")[0]!);
    press(document.activeElement!, "R", { shiftKey: true });
    fireEvent.click(within(workspaceRow()).getByRole("button", { name: /reset to default/ }));
    expect(onResetWorkspace).not.toHaveBeenCalled();

    rerenderFrame(<SettingsView {...props} appSettings={custom} />);
    focus(radios("Landing page")[0]!);
    press(document.activeElement!, "R", { shiftKey: true });
    expect(onResetWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {});
    fireEvent.click(within(workspaceRow()).getByRole("button", { name: /reset to default/ }));
    expect(onResetWorkspace).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });

  it("keeps the appearance reset on lower-case r", () => {
    const { props } = renderSettings({ onResetWorkspace: vi.fn(async () => null) });
    focus(radios("Theme")[0]!);
    press(document.activeElement!, "r");
    expect(props.onReset).toHaveBeenCalledTimes(1);
    expect(props.onResetWorkspace).toHaveBeenCalledTimes(0);
  });

  it("shows what came back: a notice for a reset, an error for a refusal, nothing for a declined one", async () => {
    const onResetWorkspace = vi
      .fn<() => Promise<{ ok: boolean; text: string } | null>>()
      .mockResolvedValueOnce({ ok: false, text: "AGENT_WORKSPACE_PATH is set and overrides the saved workspace" })
      .mockResolvedValueOnce({ ok: true, text: "workspace reset to the default" })
      .mockResolvedValueOnce(null);
    renderSettings({ appSettings: custom, onResetWorkspace });
    const reset = () => within(workspaceRow()).getByRole("button", { name: /reset to default/ });
    const status = () => within(workspaceRow()).getByRole("status", { name: "Workspace change" });

    fireEvent.click(reset());
    await vi.waitFor(() => expect(status().textContent).toContain("AGENT_WORKSPACE_PATH is set"));
    expect(status().querySelector(".c-fail")).not.toBeNull();

    fireEvent.click(reset());
    await vi.waitFor(() => expect(status().textContent).toContain("workspace reset to the default"));
    expect(status().querySelector(".c-ok")).not.toBeNull();

    // A declined confirmation clears the previous message and shows nothing.
    fireEvent.click(reset());
    await vi.waitFor(() => expect(status().textContent).toBe(""));
  });

  it("disables the action and says so while a reset is running", () => {
    const onResetWorkspace = vi.fn(async () => null);
    renderSettings({ appSettings: custom, workspaceBusy: true, onResetWorkspace });
    const row = workspaceRow();
    const button = within(row).getByRole("button", { name: /reset to default/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(row.textContent).toContain("resetting workspace…");
    focus(radios("Landing page")[0]!);
    press(document.activeElement!, "R", { shiftKey: true });
    expect(onResetWorkspace).not.toHaveBeenCalled();
  });

  it("reaches the reset action with j and k like every other row", () => {
    renderSettings({ appSettings: custom, onResetWorkspace: vi.fn(async () => null) });
    const reset = within(workspaceRow()).getByRole("button", { name: /reset to default/ });
    focus(radios("Landing page")[0]!);
    // Landing page, harness checkboxes, then the workspace action.
    for (let step = 0; step < 8; step += 1) press(document.activeElement!, "j");
    expect(document.activeElement).toBe(reset);
    press(document.activeElement!, "k");
    expect(document.activeElement).not.toBe(reset);
  });

  it("offers no workspace actions without a handler", () => {
    renderSettings();
    expect(within(workspaceRow()).queryByRole("button")).toBeNull();
  });
});
