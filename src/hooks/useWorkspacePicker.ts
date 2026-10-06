import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useRef, useState } from "react";
import { useConfirm } from "../components/ConfirmDialog";
import type { WorkspaceSwitchResult } from "./useAppSettingsController";

/** What the user is told after a choose or reset. */
export interface WorkspaceMessage {
  ok: boolean;
  text: string;
}

export interface UseWorkspacePickerOptions {
  /** Absolute path of the active workspace: where the folder picker opens. */
  activePath: string | null;
  /** True while the Library holds unsaved edits that switching workspace would drop. */
  libraryDirty: boolean;
  /** Validates, persists and reloads (`useAppSettingsController`); null switches back to the default. */
  switchWorkspace: (path: string | null) => Promise<WorkspaceSwitchResult>;
}

export interface WorkspacePicker {
  /** A choose or reset is running (picker open, confirm open or reloading). */
  busy: boolean;
  /** Opens the folder picker and switches to the chosen folder. null: cancelled or nothing happened. */
  choose: () => Promise<WorkspaceMessage | null>;
  /** Back to the default workspace. null: declined or nothing happened. */
  reset: () => Promise<WorkspaceMessage | null>;
}

/** The backend names the first missing marker in parentheses; keep it, say what the folder is. */
export function describeRefusedWorkspace(path: string, message: string): string {
  if (!message.toLowerCase().includes("invalid workspace path")) return message;
  const detail = message.match(/\(([^()]+)\)\s*$/)?.[1];
  return `${path} is not an Agent Workspace folder${detail ? ` (${detail})` : ""}`;
}

/**
 * The workspace picker behind Settings and `:workspace choose|reset`: native folder dialog, confirmation when a
 * switch would drop unsaved Library edits, then the backend validation and the existing workspace reload.
 * Never reloads the app; a refused folder changes nothing and comes back as a message.
 */
export function useWorkspacePicker({ activePath, libraryDirty, switchWorkspace }: UseWorkspacePickerOptions): WorkspacePicker {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const latest = useRef({ activePath, libraryDirty, switchWorkspace });
  latest.current = { activePath, libraryDirty, switchWorkspace };

  const guarded = useCallback(async (run: () => Promise<WorkspaceMessage | null>): Promise<WorkspaceMessage | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    try {
      return await run();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const apply = useCallback(async (path: string | null, done: string): Promise<WorkspaceMessage | null> => {
    if (latest.current.libraryDirty) {
      const approved = await confirm({
        title: "Switch workspace",
        message: "The Library has unsaved changes. Switching workspace discards them. Switch anyway?",
        confirmLabel: "switch",
        destructive: true,
      });
      if (!approved) return null;
    }
    const result = await latest.current.switchWorkspace(path);
    if (result.ok) return { ok: true, text: done };
    return { ok: false, text: path === null ? result.message : describeRefusedWorkspace(path, result.message) };
  }, [confirm]);

  const choose = useCallback(() => guarded(async () => {
    const start = latest.current.activePath;
    let picked: string | string[] | null;
    try {
      picked = await open({
        title: "Choose workspace folder",
        directory: true,
        multiple: false,
        defaultPath: start && /^(\/|[a-zA-Z]:[\\/])/.test(start) ? start : undefined,
      });
    } catch {
      return { ok: false, text: "the folder picker is not available here" };
    }
    if (typeof picked !== "string") return null;
    return apply(picked, `workspace set to ${picked}`);
  }), [apply, guarded]);

  const reset = useCallback(() => guarded(() => apply(null, "workspace reset to the default")), [apply, guarded]);

  return { busy, choose, reset };
}
