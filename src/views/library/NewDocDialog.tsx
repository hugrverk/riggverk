import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent } from "react";
import { TButton } from "../../ui/TButton";
import { docSlug } from "./slug";

interface NewDocDialogProps {
  title: string;
  /** The file name the controller will create; derived from the title as it is typed. */
  slug: string;
  error: string | null;
  creating: boolean;
  onChangeTitle: (title: string, slug: string) => void;
  onCreate: () => void;
  onClose: () => void;
}

/**
 * "New doc": a title and the file it becomes, `docs/context/<slug>.md`, shown live. A modal `<dialog>`, so the
 * window's key layer stands down while it is open; Escape and Cancel close it, Enter creates.
 */
export function NewDocDialog({ title, slug, error, creating, onChangeTitle, onCreate, onClose }: NewDocDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const errorId = useId();
  const hintId = useId();
  // A title with nothing usable in it (only symbols, or letters outside a-z) cannot become a file name.
  const unusable = title.trim() !== "" && slug === "";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!creating && slug) onCreate();
  };

  return (
    <dialog
      ref={dialogRef}
      className="app-modal lib-newdoc"
      aria-labelledby={headingId}
      data-keyscope="overlay"
      onKeyDown={onKeyDown}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="app-modal-header">
          <h2 id={headingId} className="app-modal-title">New doc</h2>
        </div>
        <div className="app-modal-body lib-newdoc-body">
          <label className="lib-label" htmlFor={`${headingId}-title`}>Title</label>
          <input
            id={`${headingId}-title`}
            ref={inputRef}
            className="lib-input"
            type="text"
            value={title}
            placeholder="Project notes"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={[error ? errorId : null, unusable ? hintId : null].filter(Boolean).join(" ") || undefined}
            onChange={event => onChangeTitle(event.target.value, docSlug(event.target.value))}
          />
          <p className="lib-slug" aria-live="polite">
            docs/context/<b>{slug || "…"}</b>.md
          </p>
          {unusable && (
            <p id={hintId} className="lib-newdoc-error" role="status">
              Use at least one letter a-z or digit. The file name is lowercase ASCII.
            </p>
          )}
          {error && (
            <p id={errorId} className="lib-newdoc-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="app-modal-footer">
          <span className="tbtn-row">
            <TButton keys={[]} onClick={onClose}>Cancel</TButton>
            <button type="submit" className="tbtn tbtn-primary" aria-disabled={creating || !slug || undefined}>
              <span className="tbtn-label">{creating ? "Creating…" : "Create"}</span>
            </button>
          </span>
        </div>
      </form>
    </dialog>
  );
}
