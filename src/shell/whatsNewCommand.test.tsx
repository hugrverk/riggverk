import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import { Pane } from "../ui/Pane";
import { useAppCommands, type AppCommandDeps } from "./useAppCommands";

// The bundled notes are generated from release-notes/*.md; these tests bring their own.
const bundle = vi.hoisted(() => ({
  releases: [] as Array<{ version: string; sections: Array<{ title: string; items: string[] }> }>,
}));
vi.mock("../generated/release-notes.json", () => ({ default: bundle }));

afterEach(() => {
  cleanup();
  bundle.releases.length = 0;
});

function deps(): AppCommandDeps {
  return {
    enabledHarnessIds: ["codex", "opencode", "cursor", "claude"],
    dataFolderOk: true,
    dataFolderChecked: true,
    busyLabel: null,
    switchView: vi.fn(),
    appearance: "dark",
    setAppearance: vi.fn(),
    refresh: vi.fn(),
    openFolder: vi.fn(),
    openBackups: vi.fn(),
    clearOutput: vi.fn(),
    outputText: null,
    openInstall: vi.fn(),
    rollbackTransactionId: null,
    requestRollback: vi.fn(),
    requestUninstallPreview: vi.fn(),
    setError: vi.fn(),
  };
}

function Harness() {
  useAppCommands(deps());
  return (
    <Pane id="main" title="main" scrollable>
      <p>body</p>
    </Pane>
  );
}

function runLine(line: string) {
  fireEvent.keyDown(document.body, { key: ":", shiftKey: true });
  const input = screen.getByRole("combobox", { name: "Command" });
  fireEvent.change(input, { target: { value: line } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe(":whatsnew", () => {
  it("opens the overlay with every bundled release, newest first, and Esc closes it", () => {
    bundle.releases.push(
      { version: "2026.10.2", sections: [{ title: "Fixes", items: ["Close the gap"] }] },
      { version: "2026.10.1", sections: [{ title: "New", items: ["Manage the rules block"] }] },
    );
    renderInFrame(<Harness />);

    runLine("whatsnew");

    const dialog = screen.getByRole("dialog", { name: "What's new" });
    expect(within(dialog).getAllByRole("region").map(region => region.getAttribute("aria-label"))).toEqual([
      "2026.10.2",
      "2026.10.1",
    ]);
    expect(dialog.textContent).toContain("Close the gap");
    expect(dialog.textContent).toContain("Manage the rules block");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "What's new" })).toBeNull();
  });

  it("can be opened again at any time", () => {
    bundle.releases.push({ version: "2026.10.1", sections: [{ title: "New", items: ["Manage the rules block"] }] });
    renderInFrame(<Harness />);

    for (let round = 0; round < 2; round++) {
      runLine("whatsnew");
      expect(screen.getByRole("dialog", { name: "What's new" })).not.toBeNull();
      fireEvent.keyDown(screen.getByRole("dialog", { name: "What's new" }), { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "What's new" })).toBeNull();
    }
  });

  it("says so when the build has no release notes", () => {
    renderInFrame(<Harness />);

    runLine("whatsnew");

    expect(screen.getByRole("alert").textContent).toBe("whatsnew: this build has no release notes");
    expect(screen.queryByRole("dialog", { name: "What's new" })).toBeNull();
  });

  it("is listed in the help overlay with the other commands", () => {
    bundle.releases.push({ version: "2026.10.1", sections: [{ title: "New", items: ["x"] }] });
    renderInFrame(<Harness />);

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    const name = within(screen.getByRole("dialog", { name: "Keyboard help" })).getByText("whatsnew");
    expect(name.tagName).toBe("DT");
    expect(name.nextElementSibling!.textContent).toBe("show what changed in this and earlier releases");
  });
});
