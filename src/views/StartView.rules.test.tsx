import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import {
  installationStatus,
  installScreenOf,
  overviewOf,
  settingsOf,
  STATUS_DATA,
  surfaceStatus,
  VALID_DIAGNOSTICS,
} from "../test/pageFixtures";
import type { CodexRuntimeHealth, InstallationState, RulesStatus, SetupSurfaceId } from "../types";
import { StartView, type StartViewProps } from "./StartView";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected invoke");
  }),
}));

afterEach(cleanup);

function overviewWith(surface: SetupSurfaceId, harness: "claude" | "codex", state: InstallationState, rules: RulesStatus) {
  return overviewOf({
    workspace: installationStatus("current", [surfaceStatus("workspace_bundle", "current")]),
    [harness]: installationStatus(state, [{ ...surfaceStatus(surface, state, "rules detail"), rules }], state === "conflict" ? { conflict_count: 1 } : {}),
  });
}

function props(overrides: Partial<StartViewProps> = {}): StartViewProps {
  return {
    workspaceDiagnostics: VALID_DIAGNOSTICS,
    appSettings: settingsOf(),
    enabledHarnessIds: ["codex", "claude"],
    onNavigate: vi.fn(),
    overview: overviewOf({}),
    install: installScreenOf(),
    backupRoot: "/tmp/backups",
    rollbackTransactionId: null,
    onRollback: vi.fn(),
    onRefresh: vi.fn(),
    onUninstall: vi.fn(),
    uninstallRecoveryTransactionId: null,
    onUninstallRollback: vi.fn(async () => false),
    uninstallPreviewRequested: false,
    onUninstallPreviewHandled: vi.fn(),
    onOpenFolder: vi.fn(),
    onReleaseCheck: vi.fn(),
    backupCount: 2,
    onOpenBackupsFolder: vi.fn(),
    wsLog: null,
    wsLogCompletedAt: null,
    wsRunning: null,
    status: STATUS_DATA,
    workspaceValid: true,
    gitAvailable: true,
    canRunReleaseCheck: true,
    onClearOutput: vi.fn(),
    ...overrides,
  };
}

function moveTo(name: string) {
  const list = screen.getByRole("listbox", { name: "Harnesses" });
  fireEvent.click(within(list).getAllByRole("option").find(option => option.textContent!.includes(name))!);
}

function status() {
  return screen.getByRole("region", { name: "Status" });
}

describe("StartView rules file", () => {
  it("tells the state of the rules file of the harness under the cursor and where its actions are", () => {
    renderInFrame(
      <StartView
        {...props({ overview: overviewWith("claude_rules", "claude", "conflict", { layout: "block", refinement_lines: 2, conflict_reason: "base_block_edited", user_managed: false }) })}
      />,
    );
    // The workspace row is under the cursor first: no rules line.
    expect(status().textContent).not.toContain("refinement");
    moveTo("claude");
    expect(status().textContent).toContain("base block edited: left as is · 2 refinement lines preserved");
    expect(status().textContent).toContain("the base block was edited");
    expect(status().textContent).toContain("open the claude page: d diff · v convert · m leave as is");
  });

  it("shows a file the user manages as base updates available, with a text label instead of a conflict", () => {
    renderInFrame(
      <StartView
        {...props({ overview: overviewWith("claude_rules", "claude", "current", { layout: "block", refinement_lines: 0, conflict_reason: "legacy_diverged", user_managed: true }) })}
      />,
    );
    moveTo("claude");
    const rules = within(screen.getByRole("listbox", { name: "claude surfaces" })).getAllByRole("option").find(row => row.textContent!.includes("rules"))!;
    expect(rules.querySelector(".meta")!.textContent).toContain("you manage");
    expect(status().textContent).toContain("base updates available, you manage this file");
    expect(status().textContent).toContain("m hand back");
  });

  it("warns on the Codex row when AGENTS.override.md replaces AGENTS.md", () => {
    const health = {
      checks: [{ id: "rules_override", label: "AGENTS.override.md replaces AGENTS.md", status: "warn", detail: "the Agent Workspace base is not loaded until it is removed or emptied" }],
    } as unknown as CodexRuntimeHealth;
    renderInFrame(
      <StartView
        {...props({ overview: overviewWith("codex_rules", "codex", "current", { layout: "block", refinement_lines: 0, user_managed: false }) })}
        codexRuntimeHealth={health}
      />,
    );
    expect(within(status()).queryByRole("alert")).toBeNull();
    moveTo("codex");
    expect(within(status()).getByRole("alert").textContent).toContain("AGENTS.override.md replaces AGENTS.md");
    moveTo("claude");
    expect(within(status()).queryByRole("alert")).toBeNull();
  });
});
