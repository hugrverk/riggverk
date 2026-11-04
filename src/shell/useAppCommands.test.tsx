import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallationOverview, OverviewEntry } from "../hooks/useInstallationOverview";
import { INSTALL_AGENTS, type InstallationStatus } from "../types";
import { useCommandList } from "../keyboard/context";
import { parseCommandLine, type CommandSpec } from "../keyboard/commands/parser";
import { renderInFrame } from "../test/renderWithShell";
import { Pane } from "../ui/Pane";
import { useAppCommands, type AppCommandDeps } from "./useAppCommands";

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  // jsdom has no native modal dialog; emulate open/close and the `close` event browsers fire.
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(() => {
  cleanup();
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

function makeDeps(overrides: Partial<AppCommandDeps> = {}): AppCommandDeps {
  return {
    enabledHarnessIds: ["codex", "opencode", "cursor", "claude"],
    dataFolderOk: true,
    dataFolderChecked: true,
    busyLabel: null,
    switchView: vi.fn(),
    setLibrarySource: vi.fn(),
    appearance: "dark",
    setAppearance: vi.fn(),
    refresh: vi.fn(),
    openFolder: vi.fn(),
    openBackups: vi.fn(),
    clearOutput: vi.fn(),
    outputText: "stdout line",
    openInstall: vi.fn(),
    rollbackTransactionId: null,
    requestRollback: vi.fn(),
    requestUninstallPreview: vi.fn(),
    setError: vi.fn(),
    ...overrides,
  };
}

function status(counts: Partial<InstallationStatus["counts"]>, state: InstallationStatus["state"] = "update_available"): InstallationStatus {
  return {
    state,
    summary: "",
    counts: { create_count: 0, update_count: 0, remove_count: 0, conflict_count: 0, ...counts },
    surfaces: [],
  };
}

function overviewWith(entries: Record<string, InstallationStatus>): InstallationOverview {
  const built: Record<string, OverviewEntry> = {};
  for (const [id, value] of Object.entries(entries)) {
    built[id] = { id: id as OverviewEntry["id"], status: value, loading: false, error: null };
  }
  return { entries: built, loading: false, refresh: vi.fn(async () => {}) };
}

function Harness({ deps }: { deps: AppCommandDeps }) {
  useAppCommands(deps);
  return (
    <Pane id="main" title="main" scrollable>
      <p>body</p>
    </Pane>
  );
}

/** Types `line` into the command line and presses Enter. */
function runLine(line: string) {
  fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
  const input = screen.getByRole("combobox", { name: "Command" });
  fireEvent.change(input, { target: { value: line } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function setup(deps: AppCommandDeps) {
  return renderInFrame(<Harness deps={deps} />);
}

function commandLineError() {
  return screen.getByRole("alert").textContent;
}

describe("useAppCommands", () => {
  describe("views", () => {
    it.each([
      ["workspace", "start"],
      ["ws", "start"],
      ["codex", "codex"],
      ["opencode", "opencode"],
      ["cursor", "cursor"],
      ["claude", "claude"],
      ["settings", "settings"],
      ["lib", "library"],
    ])(":%s switches to %s through switchView", (line, view) => {
      const deps = makeDeps();
      setup(deps);
      runLine(line);
      expect(deps.switchView).toHaveBeenCalledWith(view);
    });

    it.each([
      ["copilot", "copilot"],
      ["pi", "pi"],
      ["kilo", "kilo"],
    ])(":%s opens the %s page once the harness is on", (line, view) => {
      const deps = makeDeps({ enabledHarnessIds: [...INSTALL_AGENTS] });
      setup(deps);
      runLine(line);
      expect(deps.switchView).toHaveBeenCalledWith(view);
    });

    it("a light harness that is off is refused with the reason, like any hidden harness", () => {
      const deps = makeDeps();
      setup(deps);
      runLine("pi");
      expect(commandLineError()).toBe("pi: pi is hidden in Settings");
      expect(deps.switchView).not.toHaveBeenCalled();
    });

    it(":library <source> also selects the source", () => {
      const deps = makeDeps();
      setup(deps);
      runLine("library skills");
      expect(deps.switchView).toHaveBeenCalledWith("library");
      expect(deps.setLibrarySource).toHaveBeenCalledWith("skills");
    });

    describe(":workspace reset", () => {
      const workspaceReset = (overrides: Partial<NonNullable<AppCommandDeps["workspaceReset"]>> = {}) => ({
        reset: vi.fn(),
        isDefault: false,
        busy: false,
        ...overrides,
      });

      it("reset hands over to the confirmed workspace reset, without leaving the page", () => {
        const resetter = workspaceReset();
        const deps = makeDeps({ workspaceReset: resetter });
        setup(deps);
        runLine("ws reset");
        expect(resetter.reset).toHaveBeenCalledTimes(1);
        expect(deps.switchView).not.toHaveBeenCalled();
      });

      it("plain :workspace still opens the page", () => {
        const deps = makeDeps({ workspaceReset: workspaceReset() });
        setup(deps);
        runLine("workspace");
        expect(deps.switchView).toHaveBeenCalledWith("start");
      });

      it("refuses reset when the default is already active, and while a change runs", () => {
        const defaults = workspaceReset({ isDefault: true });
        setup(makeDeps({ workspaceReset: defaults }));
        runLine("workspace reset");
        expect(commandLineError()).toContain("already the default workspace");
        expect(defaults.reset).not.toHaveBeenCalled();
        cleanup();

        const busy = workspaceReset({ busy: true });
        setup(makeDeps({ workspaceReset: busy }));
        runLine("workspace reset");
        expect(commandLineError()).toContain("already running");
        expect(busy.reset).not.toHaveBeenCalled();
      });

      it("refuses while a workspace task runs, naming the task", () => {
        const resetter = workspaceReset();
        setup(makeDeps({ workspaceReset: resetter, busyLabel: "apply" }));
        runLine("workspace reset");
        expect(commandLineError()).toContain("apply is running");
        expect(resetter.reset).not.toHaveBeenCalled();
      });

      it("has no choose action any more, and rejects any other action", () => {
        const resetter = workspaceReset();
        const deps = makeDeps({ workspaceReset: resetter });
        setup(deps);
        runLine("workspace choose");
        expect(commandLineError()).toBeTruthy();
        runLine("workspace nowhere");
        expect(commandLineError()).toBeTruthy();
        expect(resetter.reset).not.toHaveBeenCalled();
        expect(deps.switchView).not.toHaveBeenCalled();
      });
    });

    it("a hidden harness is refused with the reason instead of falling back to the workspace", () => {
      const deps = makeDeps({ enabledHarnessIds: ["codex"] });
      setup(deps);
      runLine("claude");
      expect(commandLineError()).toBe("claude: claude is hidden in Settings");
      expect(deps.switchView).not.toHaveBeenCalled();
    });
  });

  describe("app commands", () => {
    it("theme sets, and toggles dark <-> light", () => {
      const deps = makeDeps();
      setup(deps);
      runLine("theme light");
      expect(deps.setAppearance).toHaveBeenLastCalledWith("light");
      runLine("theme toggle");
      expect(deps.setAppearance).toHaveBeenLastCalledWith("light");
    });

    it("theme toggle from light goes dark, and from system follows the resolved scheme", () => {
      const light = makeDeps({ appearance: "light" });
      const { unmount } = setup(light);
      runLine("theme toggle");
      expect(light.setAppearance).toHaveBeenLastCalledWith("dark");
      unmount();

      const spy = vi.fn(() => ({ matches: true }));
      const original = window.matchMedia;
      window.matchMedia = spy as unknown as typeof window.matchMedia;
      const system = makeDeps({ appearance: "system" });
      setup(system);
      runLine("theme toggle");
      expect(system.setAppearance).toHaveBeenLastCalledWith("light");
      window.matchMedia = original;
    });

    it("refresh, open folder|backups and clear run the existing actions", () => {
      const deps = makeDeps();
      setup(deps);
      runLine("refresh");
      expect(deps.refresh).toHaveBeenCalledTimes(1);
      runLine("open folder");
      expect(deps.openFolder).toHaveBeenCalledTimes(1);
      runLine("open backups");
      expect(deps.openBackups).toHaveBeenCalledTimes(1);
      runLine("clear");
      expect(deps.clearOutput).toHaveBeenCalledTimes(1);
    });

    it("clear is refused while a task is running", () => {
      const deps = makeDeps({ busyLabel: "uninstall" });
      setup(deps);
      runLine("clear");
      expect(commandLineError()).toBe("clear: uninstall is running");
      expect(deps.clearOutput).not.toHaveBeenCalled();
    });

    it("copy writes the redacted output text to the clipboard and reports it", async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const deps = makeDeps({ outputText: "line one\nline two" });
      setup(deps);
      runLine("copy");
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("line one\nline two"));
      await waitFor(() => expect(document.querySelector(".toast")!.textContent).toBe("copied output"));
      expect(document.querySelector(".toast-text")!.getAttribute("data-tone")).toBe("ok");
    });

    it("copy without output is disabled, and a clipboard failure surfaces as an error", async () => {
      const empty = makeDeps({ outputText: null });
      const { unmount } = setup(empty);
      runLine("copy");
      expect(commandLineError()).toBe("copy: no output to copy");
      unmount();

      Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("denied"); }) }, configurable: true });
      const deps = makeDeps();
      setup(deps);
      runLine("copy");
      await waitFor(() => expect(deps.setError).toHaveBeenCalledWith("Copy failed: clipboard is not available"));
    });

    it("help opens the help overlay", () => {
      setup(makeDeps());
      runLine("help");
      expect(screen.getByRole("dialog", { name: "Keyboard help" })).not.toBeNull();
    });
  });

  describe("update", () => {
    it("opens the install review for the target instead of writing anything", () => {
      const deps = makeDeps();
      setup(deps);
      runLine("update claude");
      expect(deps.openInstall).toHaveBeenCalledTimes(1);
      expect(deps.openInstall).toHaveBeenCalledWith("claude");
      // No confirm dialog: the review on the page is the confirmation.
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("covers the workspace, or the workspace plus every enabled harness with --all", () => {
      const deps = makeDeps();
      setup(deps);
      runLine("update workspace");
      expect(deps.openInstall).toHaveBeenLastCalledWith("workspace");
      runLine("update --all");
      expect(deps.openInstall).toHaveBeenLastCalledWith("all");
    });

    it("requires a target or --all, refuses both, and is disabled while busy", () => {
      const busy = makeDeps({ busyLabel: "apply" });
      const { unmount } = setup(busy);
      runLine("update claude");
      expect(commandLineError()).toBe("update: apply is running");
      expect(busy.openInstall).not.toHaveBeenCalled();
      unmount();

      const idle = makeDeps();
      let registered: readonly CommandSpec[] = [];
      function Probe() {
        registered = useCommandList();
        return null;
      }
      renderInFrame(
        <>
          <Harness deps={idle} />
          <Probe />
        </>,
      );
      const bare = parseCommandLine("update", registered);
      expect(bare).toMatchObject({ ok: false });
      expect(bare.ok ? "" : bare.error).toBe("update: name a target (workspace | codex | opencode | cursor | claude) or pass --all");
      fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
      fireEvent.change(screen.getByRole("combobox", { name: "Command" }), { target: { value: "update codex --all" } });
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Enter" });
      expect(commandLineError()).toBe("update: use either a target or --all");
      expect(idle.openInstall).not.toHaveBeenCalled();
    });

    it("does not call the folder unusable before the diagnostics have answered", () => {
      const unchecked = makeDeps({ dataFolderOk: false, dataFolderChecked: false });
      setup(unchecked);
      runLine("update --all");
      expect(commandLineError()).toBe("update: workspace folder not checked yet, press Enter to try again");
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Escape" });
      runLine("update claude");
      expect(commandLineError()).toBe("update: workspace folder not checked yet, press Enter to try again");
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Escape" });
      expect(unchecked.openInstall).not.toHaveBeenCalled();
      runLine("update workspace");
      expect(unchecked.openInstall).toHaveBeenCalledWith("workspace");
    });

    it("lets the workspace be installed without a valid workspace, but nothing that needs one", () => {
      const none = makeDeps({ dataFolderOk: false });
      setup(none);
      runLine("update workspace");
      expect(none.openInstall).toHaveBeenCalledWith("workspace");
      runLine("update --all");
      expect(commandLineError()).toBe("update: workspace folder unusable (the Overview says why)");
      runLine("update claude");
      expect(none.openInstall).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByRole("combobox", { name: "Command" }), { target: { value: "update " } });
      const text = screen.getAllByRole("option").map(option => option.textContent!).join("|");
      expect(text).toContain("update workspace");
      expect(text).not.toContain("update claude");
    });

    it("suggests targets with descriptions from the installation overview", () => {
      const deps = makeDeps({
        overview: overviewWith({
          claude: status({ create_count: 2, update_count: 4, remove_count: 1, conflict_count: 1 }),
          codex: status({}, "current"),
        }),
      });
      setup(deps);
      fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
      fireEvent.change(screen.getByRole("combobox", { name: "Command" }), { target: { value: "upd" } });
      const text = screen.getAllByRole("option").map(option => option.textContent);
      expect(text.some(line => line!.includes("update claude") && line!.includes("apply 7 safe, skip 1 conflict"))).toBe(true);
      expect(text.some(line => line!.includes("update codex") && line!.includes("current"))).toBe(true);
    });

    it("only offers enabled harnesses", () => {
      const deps = makeDeps({ enabledHarnessIds: ["codex"] });
      setup(deps);
      fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
      fireEvent.change(screen.getByRole("combobox", { name: "Command" }), { target: { value: "update " } });
      const text = screen.getAllByRole("option").map(option => option.textContent!).join("|");
      expect(text).toContain("update codex");
      expect(text).toContain("update workspace");
      expect(text).not.toContain("update claude");
    });
  });

  describe("preview", () => {
    it("opens the same review read-only", () => {
      const deps = makeDeps();
      setup(deps);
      runLine("preview codex");
      expect(deps.openInstall).toHaveBeenCalledWith("codex", { readOnly: true });
      runLine("preview --all");
      expect(deps.openInstall).toHaveBeenLastCalledWith("all", { readOnly: true });
    });

    it("stays available while a task runs, since it writes nothing", () => {
      const deps = makeDeps({ busyLabel: "uninstall" });
      setup(deps);
      runLine("preview claude");
      expect(deps.openInstall).toHaveBeenCalledWith("claude", { readOnly: true });
    });

    it(":p is still preview with :pi around, and :pi is the Pi page", () => {
      const deps = makeDeps({ enabledHarnessIds: [...INSTALL_AGENTS] });
      setup(deps);
      // Not ambiguous between preview and pi: the exact alias wins over a prefix match.
      runLine("p codex");
      expect(deps.openInstall).toHaveBeenCalledWith("codex", { readOnly: true });
      expect(deps.switchView).not.toHaveBeenCalled();
      runLine("p --all");
      expect(deps.openInstall).toHaveBeenLastCalledWith("all", { readOnly: true });
      runLine("pi");
      expect(deps.switchView).toHaveBeenLastCalledWith("pi");
      runLine("pr claude");
      expect(deps.openInstall).toHaveBeenLastCalledWith("claude", { readOnly: true });
    });

    it("updates a light harness by name", () => {
      const deps = makeDeps({ enabledHarnessIds: [...INSTALL_AGENTS] });
      setup(deps);
      runLine("update kilo");
      expect(deps.openInstall).toHaveBeenLastCalledWith("kilo");
      runLine("update pi");
      expect(deps.openInstall).toHaveBeenLastCalledWith("pi");
    });
  });

  describe("rollback and uninstall", () => {
    it("rollback is disabled with a reason when there is nothing to roll back", () => {
      const deps = makeDeps({ rollbackTransactionId: null });
      setup(deps);
      runLine("rollback");
      expect(commandLineError()).toBe("rollback: nothing to roll back in this session");
      expect(deps.requestRollback).not.toHaveBeenCalled();
    });

    it("rollback hands over to the dry-run and confirm flow", () => {
      const deps = makeDeps({ rollbackTransactionId: "tx-42" });
      setup(deps);
      runLine("rollback");
      expect(deps.requestRollback).toHaveBeenCalledTimes(1);
    });

    it("rollback waits for a running task", () => {
      const deps = makeDeps({ rollbackTransactionId: "tx-42", busyLabel: "apply" });
      setup(deps);
      runLine("rollback");
      expect(commandLineError()).toBe("rollback: apply is running");
      expect(deps.requestRollback).not.toHaveBeenCalled();
    });

    it("uninstall asks the Overview for its preview (no direct write)", () => {
      const deps = makeDeps();
      setup(deps);
      runLine("uninstall");
      expect(deps.requestUninstallPreview).toHaveBeenCalledTimes(1);
    });

    it("uninstall needs a valid workspace", () => {
      const deps = makeDeps({ dataFolderOk: false });
      setup(deps);
      runLine("uninstall");
      expect(commandLineError()).toBe("uninstall: workspace folder unusable");
      expect(deps.requestUninstallPreview).not.toHaveBeenCalled();
    });
  });

  it("registers every global command so the help overlay and suggestions list them", () => {
    setup(makeDeps());
    fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
    const names = screen.getAllByRole("option").map(option => option.querySelectorAll("span")[1]!.textContent);
    // The suggestion list is capped; the full set is visible in the help overlay.
    expect(names.length).toBeGreaterThan(0);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Command" }), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const help = screen.getByRole("dialog", { name: "Keyboard help" }).textContent!;
    for (const command of [
      "workspace",
      "codex",
      "opencode",
      "cursor",
      "claude",
      "library",
      "settings",
      "theme",
      "refresh",
      "open",
      "clear",
      "copy",
      "help",
      "whatsnew",
      "update",
      "preview",
      "rollback",
      "uninstall",
    ]) {
      expect(help).toContain(command);
    }
  });
});
