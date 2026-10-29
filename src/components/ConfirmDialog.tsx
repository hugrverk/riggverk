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
import { TButton } from "../ui/TButton";

export interface ConfirmConfig {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/** A question with a third answer between the two: "Discard" / "Keep editing" / "Save and continue". */
export interface ConfirmChoiceConfig extends ConfirmConfig {
  /** The third button, shown first. */
  alternateLabel: string;
}

/** Which button settled a choice. Escape and closing the dialog are `cancel`. */
export type ConfirmChoice = "confirm" | "alternate" | "cancel";

interface ConfirmContextValue {
  confirm: (config: ConfirmConfig | string) => Promise<boolean>;
  choose: (config: ConfirmChoiceConfig) => Promise<ConfirmChoice>;
}

const ConfirmContext = createContext<ConfirmContextValue>({
  confirm: () => Promise.resolve(false),
  choose: () => Promise.resolve("cancel"),
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
 * Like `useConfirm`, with a third button: resolves `"confirm"`, `"alternate"` or `"cancel"` (Escape included).
 * The y/n keys of the plain confirmation do not apply: three answers are chosen by button.
 */
export function useConfirmChoice() {
  return useContext(ConfirmContext).choose;
}

/**
 * Wraps the app tree and provides the `confirm` function via `useConfirm()`.
 * Renders a single themed `<dialog>` at the root level, mounted by `ShellProviders`.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<(ConfirmConfig & { alternateLabel?: string }) | null>(null);
  const resolveRef = useRef<(value: ConfirmChoice) => void>(() => {});
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  const ask = useCallback(<T,>(cfg: ConfirmConfig & { alternateLabel?: string }, settle: (choice: ConfirmChoice) => T) => {
    return new Promise<T>((resolve) => {
      // A confirmation that is still open is superseded: settle it as declined instead of leaking its promise.
      resolveRef.current("cancel");
      resolveRef.current = choice => resolve(settle(choice));
      setConfig(cfg);
      setOpen(true);
    });
  }, []);

  const confirm = useCallback(
    (cfg: ConfirmConfig | string) => ask(typeof cfg === "string" ? { message: cfg } : cfg, choice => choice === "confirm"),
    [ask],
  );

  const choose = useCallback((cfg: ConfirmChoiceConfig) => ask(cfg, choice => choice), [ask]);

  useEffect(() => () => resolveRef.current("cancel"), []);

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
    resolve("confirm");
  }, []);

  const handleAlternate = useCallback(() => {
    const resolve = resolveRef.current;
    resolveRef.current = () => {};
    setOpen(false);
    dialogRef.current?.close();
    resolve("alternate");
  }, []);

  const handleCancel = useCallback(() => {
    const resolve = resolveRef.current;
    resolveRef.current = () => {};
    setOpen(false);
    dialogRef.current?.close();
    resolve("cancel");
  }, []);

  // Dialog close event: fires on Escape or form method="dialog" submit
  const handleClose = useCallback(() => {
    if (open) {
      // Dialog was closed externally (Escape) — treat as cancel
      setOpen(false);
      resolveRef.current("cancel");
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
    if (event.repeat || config?.alternateLabel) return;
    const key = event.key.toLowerCase();
    if (key === "y") {
      event.preventDefault();
      handleConfirm();
    } else if (key === "n") {
      event.preventDefault();
      handleCancel();
    }
  };

  // The buttons keep the plain accessible names "cancel" / "confirm" (their key caps are aria-hidden);
  // aria-keyshortcuts exposes the keys to assistive technology instead.
  const three = config?.alternateLabel !== undefined;
  return (
    <ConfirmContext.Provider value={{ confirm, choose }}>
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
            {three && (
              <TButton keys={[]} onClick={handleAlternate}>
                {config?.alternateLabel}
              </TButton>
            )}
            <TButton ref={cancelRef} keys={three ? [] : ["n"]} shortcut={three ? undefined : "n"} onClick={handleCancel}>
              {config?.cancelLabel ?? "cancel"}
            </TButton>
            <TButton
              keys={three ? [] : ["y"]}
              shortcut={three ? undefined : "y"}
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
