import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { useConfirm } from "../components/ConfirmDialog";

interface CloseGuardOptions {
  /** Whether anything is unsaved right now (the Library drafts or a settings change). Read synchronously. */
  hasUnsaved: () => boolean;
  /**
   * The Library's leave guard: Save and quit, Discard or Keep editing. Resolves true when the window may go on,
   * with the draft settled.
   */
  confirmLeave: (confirmLabel?: string) => Promise<boolean>;
  /** Writes a settings change still inside the autosave delay. Resolves false when it could not be written. */
  flushSettings: () => Promise<boolean>;
}

/**
 * Guards closing the window against unsaved work, which nothing else catches: Library drafts live in memory and a
 * settings edit waits out a short autosave delay. In the app, a close request goes through the Library's three-way
 * question (Save and quit, Discard, Keep editing), then writes a pending settings change; a settings write that fails
 * is put to the user, who may quit anyway. In the browser build (`vite dev`, the mock backend) the browser's own
 * "leave this page?" prompt does the same job through `beforeunload`.
 */
export function useCloseGuard({ hasUnsaved, confirmLeave, flushSettings }: CloseGuardOptions): void {
  const confirm = useConfirm();
  const latest = useRef({ hasUnsaved, confirmLeave, flushSettings, confirm });
  latest.current = { hasUnsaved, confirmLeave, flushSettings, confirm };

  useEffect(() => {
    if (!isTauri()) {
      const onBeforeUnload = (event: BeforeUnloadEvent) => {
        if (!latest.current.hasUnsaved()) return;
        event.preventDefault();
        // Older engines read the return value instead.
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", onBeforeUnload);
      return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    const mayClose = async (): Promise<boolean> => {
      const { confirmLeave: leave, flushSettings: flush, confirm: ask } = latest.current;
      if (!(await leave("Save and quit"))) return false;
      if (await flush()) return true;
      return ask({
        title: "Settings not saved",
        message: "Your latest settings change could not be saved. Quit anyway?",
        confirmLabel: "Quit anyway",
        destructive: true,
      });
    };
    try {
      void getCurrentWindow()
        .onCloseRequested(async event => {
          // The window closes after the handler unless it is prevented; the answer decides.
          if (!(await mayClose())) event.preventDefault();
        })
        .then(stop => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => {});
    } catch {
      // No window object (a test renderer): nothing to guard.
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
