import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartView } from "./StartView";
import type { InstallAgent, WorkspaceDiagnostics } from "../types";

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
  candidate_path: "/tmp/workspace",
  resolved_path: null,
  valid: false,
  error: "workspace missing",
  markers: [],
  enabled_rule_targets: 0,
  total_rule_targets: 0,
  enabled_config_targets: 0,
  total_config_targets: 0,
  backup_root: "/tmp/backups",
  backup_root_exists: false,
  release_check_available: false,
  bundled_resources_status: "missing",
  missing_bundled_count: 0,
  missing_bundled_sample: [],
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
  enabledHarnessIds: ["codex", "opencode", "claude", "cursor"] as InstallAgent[],
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

  it("renders recovery when a transaction candidate exists", () => {
    render(
      <StartView
        {...baseProps}
        uninstallRecoveryTransactionId="1710000000000"
      />,
    );
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
  });

  it("keeps showing recovery after the workspace became valid again", () => {
    render(
      <StartView
        {...baseProps}
        workspaceValid={true}
        uninstallRecoveryTransactionId="1710000000000"
      />,
    );
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
  });
});
