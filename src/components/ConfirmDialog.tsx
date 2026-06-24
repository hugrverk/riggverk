import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

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
 * Renders a single themed `<dialog>` at the root level.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<ConfirmConfig | null>(null);
  const resolveRef = useRef<(value: boolean) => void>(() => {});
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const confirm = useCallback((cfg: ConfirmConfig | string) => {
    const resolved = typeof cfg === "string" ? { message: cfg } : cfg;
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setConfig(resolved);
      setOpen(true);
    });
  }, []);

  // Show the native dialog when a confirm is triggered
  useEffect(() => {
    if (open && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
    }
  }, [open]);

  const handleConfirm = useCallback(() => {
    const resolve = resolveRef.current;
    // Close before resolving so onClose sees open=false and no-ops
    setOpen(false);
    dialogRef.current?.close();
    resolve(true);
  }, []);

  const handleCancel = useCallback(() => {
    const resolve = resolveRef.current;
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

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="app-modal"
        onClose={handleClose}
      >
        <div className="app-modal-header">
          <h2 id={titleId} className="app-modal-title">
            {config?.title ?? "Confirm"}
          </h2>
        </div>
        <div className="app-modal-body">
          <p>{config?.message}</p>
        </div>
        <div className="app-modal-footer">
          <button
            type="button"
            className="btn btn-sm"
            autoFocus
            onClick={handleCancel}
          >
            {config?.cancelLabel ?? "cancel"}
          </button>
          <button
            type="button"
            className={`btn btn-sm${config?.destructive ? " btn-danger" : " btn-primary"}`}
            onClick={handleConfirm}
          >
            {config?.confirmLabel ?? "confirm"}
          </button>
        </div>
      </dialog>
    </ConfirmContext.Provider>
  );
}
