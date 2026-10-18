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
import type { FilesStatus, FileUnit } from "../types";
import { StartView, type StartViewProps } from "./StartView";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected invoke");
  }),
}));

afterEach(cleanup);

function unit(overrides: Partial<FileUnit> = {}): FileUnit {
  return {
    key: "skill:claude:tdd",
    kind: "skill",
    name: "tdd",
    folder: "~/.claude/skills",
    wanted: true,
    state: "conflict",
    reason: "edited",
    bundle_changed: false,
    read_by: ["Claude"],
    files: [{ rel: "SKILL.md", state: "conflict", reason: "edited", bundle_changed: false }],
    more_files: 0,
    ...overrides,
  };
}

const CONFLICT: FilesStatus = { conflicts: 1, kept: 0, kept_updates: 0, units: [unit()], more: 0 };
const KEPT: FilesStatus = {
  conflicts: 0,
  kept: 1,
  kept_updates: 0,
  units: [unit({ state: "kept", files: [{ rel: "SKILL.md", state: "kept", reason: "edited", bundle_changed: false }] })],
  more: 0,
};

function overviewWith(files: FilesStatus, counts: { conflict_count?: number; kept_count?: number }) {
  return overviewOf({
    workspace: installationStatus("current", [surfaceStatus("workspace_bundle", "current")]),
    claude: installationStatus(files.conflicts > 0 ? "conflict" : "current", [{ ...surfaceStatus("skills", files.conflicts > 0 ? "conflict" : "current"), files }], counts),
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
    backupCount: 2,
    onOpenBackupsFolder: vi.fn(),
    wsLog: null,
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    status: STATUS_DATA,
    workspaceValid: true,
    gitAvailable: true,
    onClearOutput: vi.fn(),
    ...overrides,
  };
}

function moveTo(name: string) {
  const list = screen.getByRole("listbox", { name: "Harnesses" });
  fireEvent.click(within(list).getAllByRole("option").find(option => option.textContent!.includes(name))!);
}

function detail() {
  return screen.getByRole("region", { name: / detail$/ });
}

function listRow(name: string) {
  const list = screen.getByRole("listbox", { name: "Harnesses" });
  return within(list).getAllByRole("option").find(option => option.textContent!.includes(name))!;
}

describe("StartView skill and agent files", () => {
  it("tells the files in conflict of the harness under the cursor and where the keys are", () => {
    renderInFrame(<StartView {...props({ overview: overviewWith(CONFLICT, { conflict_count: 1 }) })} />);
    expect(detail().textContent).not.toContain("in conflict");
    moveTo("claude");
    expect(detail().textContent).toContain("1 in conflict · open the claude page: d diff · b take bundled · m keep mine");
  });

  it("tells the files the user keeps beside a current harness, and does not call it plain current", () => {
    renderInFrame(<StartView {...props({ overview: overviewWith(KEPT, { kept_count: 1 }) })} />);
    expect(listRow("claude").textContent).toContain("current · you manage 1");
    moveTo("claude");
    expect(detail().textContent).toContain("you manage 1 · open the claude page: d diff · b take bundled · m hand back");
    const skills = within(screen.getByRole("list", { name: "claude surfaces" })).getAllByRole("listitem").find(row => row.textContent!.includes("skills"))!;
    expect(skills.querySelector(".meta")!.textContent).toBe("you manage");
  });
});
