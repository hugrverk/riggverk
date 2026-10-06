import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallationOverview, OverviewEntry } from "../hooks/useInstallationOverview";
import type { InstallationStatus, SetupPlan } from "../types";
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
    workspaceValid: true,
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
    canRunReleaseCheck: true,
    runReleaseCheck: vi.fn(),
    previewSetup: vi.fn(),
    runUpdate: vi.fn(),
    rollbackTransactionId: null,
    runRollback: vi.fn(),
    setError: vi.fn(),
    ...overrides,
  };
}

function plan(overrides: Partial<SetupPlan> = {}): SetupPlan {
  return {
    operations: [{ surface: "claude_rules", kind: "update", summary: "update CLAUDE.md" }],
    synced: [],
    conflicts: [],
    manual_steps: [],
    summary: "1 to update",
    has_pending_changes: true,
    is_blocked: false,
    plan_fingerprint: "fp-1",
    preview_token: "tok-1",
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
    <Pane id="main" index={1} title="main" scrollable>
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
      ["repo", "repo-dashboard"],
      ["prompts", "prompts"],
      ["settings", "settings"],
      ["lib", "library"],
    ])(":%s switches to %s through switchView", (line, view) => {
      const deps = makeDeps();
      setup(deps);
      runLine(line);
      expect(deps.switchView).toHaveBeenCalledWith(view);
    });

    it(":library <source> also selects the source", () => {
      const deps = makeDeps();
      setup(deps);
      runLine("library skills");
      expect(deps.switchView).toHaveBeenCalledWith("library");
      expect(deps.setLibrarySource).toHaveBeenCalledWith("skills");
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
      const deps = makeDeps({ busyLabel: "release-check" });
      setup(deps);
      runLine("clear");
      expect(commandLineError()).toBe("clear: release-check is running");
      expect(deps.clearOutput).not.toHaveBeenCalled();
    });

    it("copy writes the redacted output text to the clipboard and reports it", async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const deps = makeDeps({ outputText: "line one\nline two" });
      setup(deps);
      runLine("copy");
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("line one\nline two"));
      await waitFor(() => expect(within(screen.getByLabelText("Status bar")).getByRole("status").textContent).toBe("copied output"));
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

    it("release-check (rc) runs when available and explains when it is not", () => {
      const ok = makeDeps();
      const { unmount } = setup(ok);
      runLine("rc");
      expect(ok.runReleaseCheck).toHaveBeenCalledTimes(1);
      unmount();

      const unavailable = makeDeps({ canRunReleaseCheck: false });
      const second = setup(unavailable);
      runLine("release-check");
      expect(commandLineError()).toBe("release-check: release-check is not available in this workspace");
      second.unmount();

      const noWorkspace = makeDeps({ workspaceValid: false });
      setup(noWorkspace);
      runLine("rc");
      expect(commandLineError()).toBe("release-check: no valid workspace installed");
    });
  });

  describe("update", () => {
    it("previews, asks through the confirm dialog with the plan summary, and only then runs the existing apply", async () => {
      const deps = makeDeps({ previewSetup: vi.fn(async () => plan({ summary: "apply 7 safe, skip 1 conflict" })) });
      setup(deps);
      runLine("update claude");
      const dialog = await screen.findByRole("dialog");
      expect(deps.previewSetup).toHaveBeenCalledWith(["claude_rules", "claude_agents", "claude_skills"]);
      expect(within(dialog).getByText("apply 7 safe, skip 1 conflict")).not.toBeNull();
      expect(deps.runUpdate).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Status bar").querySelector(".mode")!.textContent).toBe("CONFIRM");
      fireEvent.click(within(dialog).getByRole("button", { name: "update" }));
      await waitFor(() => expect(deps.runUpdate).toHaveBeenCalledWith(
        ["claude_rules", "claude_agents", "claude_skills"],
        "claude update",
      ));
    });

    it("does nothing when the dialog is cancelled", async () => {
      const deps = makeDeps({ previewSetup: vi.fn(async () => plan()) });
      setup(deps);
      runLine("update workspace");
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(deps.runUpdate).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Status bar").querySelector(".mode")!.textContent).not.toBe("CONFIRM");
    });

    it("--all previews the union of the workspace and every enabled harness", async () => {
      const deps = makeDeps({
        enabledHarnessIds: ["codex", "claude"],
        previewSetup: vi.fn(async () => plan()),
      });
      setup(deps);
      runLine("update --all");
      await screen.findByRole("dialog");
      expect(deps.previewSetup).toHaveBeenCalledWith([
        "workspace_bundle",
        "codex_config",
        "codex_agents",
        "codex_rules",
        "codex_skills",
        "claude_rules",
        "claude_agents",
        "claude_skills",
      ]);
    });

    it("reports 'nothing to apply' without opening a dialog, mentioning preserved conflicts", async () => {
      const conflict = { surface: "claude_rules" as const, kind: "conflict" as const, summary: "x" };
      const deps = makeDeps({
        previewSetup: vi.fn(async () => plan({ operations: [conflict], conflicts: [conflict], plan_fingerprint: null, preview_token: null })),
      });
      setup(deps);
      runLine("update claude");
      await waitFor(() =>
        expect(within(screen.getByLabelText("Status bar")).getByRole("status").textContent).toBe(
          "update claude: nothing to apply, 1 conflict preserved",
        ),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(deps.runUpdate).not.toHaveBeenCalled();
    });

    it("requires a target or --all, refuses both, and is disabled while busy or without a workspace", () => {
      const deps = makeDeps({ busyLabel: "apply" });
      const { unmount } = setup(deps);
      runLine("update claude");
      expect(commandLineError()).toBe("update: apply is running");
      unmount();

      const idle = makeDeps();
      let registered: readonly CommandSpec[] = [];
      function Probe() {
        registered = useCommandList();
        return null;
      }
      const second = renderInFrame(
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
      second.unmount();

      const none = makeDeps({ workspaceValid: false });
      setup(none);
      runLine("update workspace");
      expect(commandLineError()).toBe("update: no valid workspace installed");
      expect(idle.previewSetup).not.toHaveBeenCalled();
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
    it("shows the plan summary without asking for confirmation or applying", async () => {
      const deps = makeDeps({ previewSetup: vi.fn(async () => plan({ summary: "2 to create, 1 conflict" })) });
      setup(deps);
      runLine("preview codex");
      await waitFor(() =>
        expect(within(screen.getByLabelText("Status bar")).getByRole("status").textContent).toBe("preview codex: 2 to create, 1 conflict"),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(deps.runUpdate).not.toHaveBeenCalled();
    });

    it("reports a failing preview through the status bar", async () => {
      const deps = makeDeps({ previewSetup: vi.fn(async () => { throw new Error("backend down"); }) });
      setup(deps);
      runLine("preview codex");
      await waitFor(() =>
        expect(within(screen.getByLabelText("Status bar")).getByRole("status").textContent).toBe("preview: backend down"),
      );
    });
  });

  describe("rollback and uninstall", () => {
    it("rollback is disabled with a reason when there is no recovery transaction", () => {
      const deps = makeDeps({ rollbackTransactionId: null });
      setup(deps);
      runLine("rollback");
      expect(commandLineError()).toBe("rollback: no uninstall to roll back in this session");
      expect(deps.runRollback).not.toHaveBeenCalled();
    });

    it("rollback confirms first, then runs the existing rollback", async () => {
      const deps = makeDeps({ rollbackTransactionId: "tx-42" });
      setup(deps);
      runLine("rollback");
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/tx-42/)).not.toBeNull();
      expect(deps.runRollback).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "roll back" }));
      await waitFor(() => expect(deps.runRollback).toHaveBeenCalledTimes(1));
    });

    it("uninstall routes to the workspace page and points at its preview (no direct write)", async () => {
      const deps = makeDeps();
      setup(deps);
      runLine("uninstall");
      await waitFor(() => expect(deps.switchView).toHaveBeenCalledWith("start"));
      await waitFor(() =>
        expect(within(screen.getByLabelText("Status bar")).getByRole("status").textContent).toMatch(/^uninstall: use the Uninstall card/),
      );
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
      "repo",
      "prompts",
      "library",
      "settings",
      "theme",
      "refresh",
      "open",
      "clear",
      "copy",
      "help",
      "release-check",
      "update",
      "preview",
      "rollback",
      "uninstall",
    ]) {
      expect(help).toContain(command);
    }
  });
});
