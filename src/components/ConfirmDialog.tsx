import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useConfirmMode } from "../shell/ShellState";
import { TButton } from "../ui/TButton";

export interface ConfirmConfig {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface ConfirmContextValue {
  confirm: (config: ConfirmConfig | string) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue>({
  confirm: () => Promise.resolve(false),
});

/**
 * Returns an async `confirm(config)` function that shows a themed modal
 * dialog and resolves with `true` on confirm or `false` on cancel/Escape.
 * Keys: `y` confirms, `n` and Escape cancel. Focus starts on cancel, so Enter only
 * confirms after the user moved to the confirm button (native button activation).
 *
 * Use it to replace synchronous `window.confirm()` in React code:
 *
 *   const ok = await confirm("Leave with unsaved changes?");
 *   if (!ok) return;
 */
export function useConfirm() {
  return useContext(ConfirmContext).confirm;
}

/**
 * Wraps the app tree and provides the `confirm` function via `useConfirm()`.
 * Renders a single themed `<dialog>` at the root level. Mounted by `ShellProviders` inside the shell
 * state: the status bar shows CONFIRM while the dialog is open, for every caller.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useConfirmMode(open);
  const [config, setConfig] = useState<ConfirmConfig | null>(null);
  const resolveRef = useRef<(value: boolean) => void>(() => {});
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  const confirm = useCallback((cfg: ConfirmConfig | string) => {
    const resolved = typeof cfg === "string" ? { message: cfg } : cfg;
    return new Promise<boolean>((resolve) => {
      // A confirmation that is still open is superseded: settle it as declined instead of leaking its promise.
      resolveRef.current(false);
      resolveRef.current = resolve;
      setConfig(resolved);
      setOpen(true);
    });
  }, []);

  useEffect(() => () => resolveRef.current(false), []);

  // Show the native dialog when a confirm is triggered; the safe choice (cancel) takes focus.
  useEffect(() => {
    if (open && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
    }
    if (open) cancelRef.current?.focus();
  }, [open]);

  const handleConfirm = useCallback(() => {
    const resolve = resolveRef.current;
    // Detach the resolver first: close() may fire the `close` event synchronously, and onClose
    // would otherwise settle this confirmation as declined before `resolve(true)` runs.
    resolveRef.current = () => {};
    setOpen(false);
    dialogRef.current?.close();
    resolve(true);
  }, []);

  const handleCancel = useCallback(() => {
    const resolve = resolveRef.current;
    resolveRef.current = () => {};
    setOpen(false);
    dialogRef.current?.close();
    resolve(false);
  }, []);

  // Dialog close event: fires on Escape or form method="dialog" submit
  const handleClose = useCallback(() => {
    if (open) {
      // Dialog was closed externally (Escape) — treat as cancel
      setOpen(false);
      resolveRef.current(false);
    }
  }, [open]);

  // The window keymap stands down while a modal dialog is open (`data-keyscope="overlay"`), and this handler
  // consumes the key (preventDefault) before the keymap sees it, so the dialog owns y/n/Esc without double
  // handling. Enter is left alone: it activates whichever button has focus.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      handleCancel();
      return;
    }
    if (event.repeat) return;
    const key = event.key.toLowerCase();
    if (key === "y") {
      event.preventDefault();
      handleConfirm();
    } else if (key === "n") {
      event.preventDefault();
      handleCancel();
    }
  };

  // The bracket buttons keep the plain accessible names "cancel" / "confirm" (their key caps are aria-hidden);
  // aria-keyshortcuts exposes the keys to assistive technology instead.
  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="app-modal"
        data-keyscope="overlay"
        onClose={handleClose}
        onKeyDown={handleKeyDown}
      >
        <div className="app-modal-header">
          <h2 id={titleId} className="app-modal-title">
            {config?.title ?? "Confirm"}
          </h2>
        </div>
        <div className="app-modal-body">
          <p id={messageId}>{config?.message}</p>
        </div>
        <div className="app-modal-footer">
          <span className="tbtn-row">
            <TButton ref={cancelRef} keys={["n"]} shortcut="n" onClick={handleCancel}>
              {config?.cancelLabel ?? "cancel"}
            </TButton>
            <TButton
              keys={["y"]}
              shortcut="y"
              variant={config?.destructive ? "danger" : "primary"}
              onClick={handleConfirm}
            >
              {config?.confirmLabel ?? "confirm"}
            </TButton>
          </span>
        </div>
      </dialog>
    </ConfirmContext.Provider>
  );
}
