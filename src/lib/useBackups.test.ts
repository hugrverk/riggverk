import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBackups } from "./useBackups";
import type { BackupRunDetails, BackupRunSummary } from "../types";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const run: BackupRunSummary = {
  id: "20260101-101010",
  timestamp: "2026-01-01T10:10:10",
  path: "/tmp/backups/20260101-101010",
  targets: ["codex-agents"],
  file_count: 2,
};

describe("useBackups", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("loads the backup list", async () => {
    invoke.mockResolvedValue([run]);
    const { result } = renderHook(() => useBackups(vi.fn()));

    await act(async () => {
      await result.current.loadBackups();
    });

    expect(invoke).toHaveBeenCalledWith("list_backups");
    expect(result.current.backups).toEqual([run]);
  });

  it("drops the selected backup when it disappears from the refreshed list", async () => {
    const details = { id: run.id } as unknown as BackupRunDetails;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_backup_details") return Promise.resolve(details);
      return Promise.resolve([run]);
    });
    const { result } = renderHook(() => useBackups(vi.fn()));
    await act(async () => {
      await result.current.loadBackups();
      await result.current.loadBackupDetails(run.id);
    });
    expect(result.current.backupDetails).toBe(details);

    invoke.mockResolvedValue([]);
    await act(async () => {
      await result.current.loadBackups();
    });

    expect(result.current.selectedBackupId).toBeNull();
    expect(result.current.backupDetails).toBeNull();
  });

  it("reports a soft failure when opening the backups folder", async () => {
    invoke.mockResolvedValue({ success: false, action: "open_backups_folder", stdout: "", stderr: "open failed", exit_code: 1 });
    const setError = vi.fn();
    const { result } = renderHook(() => useBackups(setError));

    await act(async () => {
      result.current.openBackupsFolder();
    });

    expect(setError).toHaveBeenCalledWith("Open backups: open failed");
  });
});
