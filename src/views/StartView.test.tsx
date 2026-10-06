import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartView } from "./StartView";
import type { WorkspaceDiagnostics } from "../types";

vi.mock("../components/HarnessInstallationCard", () => ({
  HarnessInstallationCard: () => <div data-testid="harness-installation-card" />,
}));

vi.mock("../components/InstalledStateMap", () => ({
  InstalledStateMap: () => <div data-testid="installed-state-map" />,
}));

vi.mock("../components/UninstallCard", () => ({
  UninstallCard: () => <div data-testid="uninstall-card" />,
}));

vi.mock("../components/WorkspaceVerify", () => ({
  WorkspaceVerify: () => <div data-testid="workspace-verify" />,
}));

vi.mock("../components/WorkspaceTerminal", () => ({
  WorkspaceTerminal: () => <div data-testid="workspace-terminal" />,
}));

const invalidDiagnostics: WorkspaceDiagnostics = {
  valid: false,
  candidate_path: "/tmp/workspace",
  resolved_path: null,
  release_check_available: false,
  issues: ["workspace missing"],
};

const baseProps = {
  workspaceDiagnostics: invalidDiagnostics,
  onManagedUpdate: vi.fn(),
  onUninstall: vi.fn(),
  onUninstallRollback: vi.fn(async () => false),
  onOpenFolder: vi.fn(),
  wsLog: null,
  wsLogCompletedAt: null,
  wsRunning: null,
  status: null,
  workspaceValid: false,
  gitAvailable: false,
  canRunReleaseCheck: false,
  onReleaseCheck: vi.fn(),
  backupCount: 0,
  onRefreshBackups: vi.fn(),
  onOpenBackupsFolder: vi.fn(),
};

describe("StartView uninstall recovery", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not render recovery without a transaction candidate", () => {
    render(
      <StartView
        {...baseProps}
        uninstallRecoveryTransactionId={null}
      />,
    );
    expect(screen.queryByRole("region", { name: /recover previous uninstall/i })).toBeNull();
  });

  it("renders recovery when workspace is invalid and a candidate exists", () => {
    render(
      <StartView
        {...baseProps}
        uninstallRecoveryTransactionId="1710000000000"
      />,
    );
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
  });
});
