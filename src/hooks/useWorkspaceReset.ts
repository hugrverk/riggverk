import { useCallback, useRef, useState } from "react";
import { useConfirm } from "../components/ConfirmDialog";
import { displayPath } from "../lib/displayPath";
import { DEFAULT_WORKSPACE_PATH } from "../lib/settingsDraft";
import type { WorkspaceSwitchResult } from "./useAppSettingsController";

/** What the user is told after a reset. */
export interface WorkspaceMessage {
  ok: boolean;
  text: string;
}

export interface UseWorkspaceResetOptions {
  /** Absolute path of the active workspace folder: named in the confirmation. */
  activePath: string | null;
  /** True while the Library holds unsaved edits that the reload after a reset would drop. */
  libraryDirty: boolean;
  /** Clears the saved custom folder and reloads (`useAppSettingsController`). */
  resetWorkspace: () => Promise<WorkspaceSwitchResult>;
  /** Why a reset is refused right now (a workspace task is running), or null. Checked before the confirm opens. */
  blockedReason?: string | null;
}

export interface WorkspaceReset {
  /** A reset is running (confirm open or reloading). */
  busy: boolean;
  /** Asks first, then goes back to the default folder. null: declined or nothing happened. */
  reset: () => Promise<WorkspaceMessage | null>;
}

/**
 * The only workspace folder action left, behind Settings (`R`) and `:workspace reset`: the app no longer picks a
 * folder, it only drops a custom one saved by an earlier version. The status bar shows CONFIRM while the dialog
 * is open and nothing is written unless it is confirmed. Never reloads the app; a refusal comes back as a message.
 */
export function useWorkspaceReset({
  activePath,
  libraryDirty,
  resetWorkspace,
  blockedReason = null,
}: UseWorkspaceResetOptions): WorkspaceReset {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const latest = useRef({ activePath, libraryDirty, resetWorkspace, blockedReason });
  latest.current = { activePath, libraryDirty, resetWorkspace, blockedReason };

  const reset = useCallback(async (): Promise<WorkspaceMessage | null> => {
    if (busyRef.current) return null;
    if (latest.current.blockedReason) return { ok: false, text: latest.current.blockedReason };
    busyRef.current = true;
    setBusy(true);
    try {
      const current = latest.current.activePath ? displayPath(latest.current.activePath) : "the current folder";
      const approved = await confirm({
        title: "Reset workspace folder",
        message:
          `Switch to the default folder ${DEFAULT_WORKSPACE_PATH}? Ownership records of installed files and your personal docs stay in ${current}, and Riggverk cannot switch back to it.`
          + (latest.current.libraryDirty ? " The Library has unsaved changes; resetting discards them." : ""),
        confirmLabel: "reset",
        destructive: true,
      });
      if (!approved) return null;
      const result = await latest.current.resetWorkspace();
      return result.ok ? { ok: true, text: "workspace reset to the default" } : { ok: false, text: result.message };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [confirm]);

  return { busy, reset };
}
