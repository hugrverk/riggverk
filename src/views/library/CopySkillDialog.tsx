import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent } from "react";
import { TButton } from "../../ui/TButton";

interface CopySkillDialogProps {
  /** The bundled skill being copied. */
  source: string;
  name: string;
  /** Why the name will not do (checked as it is typed), or "". */
  problem: string;
  /** The backend's refusal of Create, shown under the name. */
  error: string | null;
  creating: boolean;
  onChangeName: (name: string) => void;
  onCreate: () => void;
  onClose: () => void;
}

/**
 * "Edit as my copy": names the new skill in pack:personal. A modal `<dialog>`, so the window's key layer stands down
 * while it is open; Escape and Cancel close it, Enter creates. The name is checked as it is typed; the backend's own
 * refusal, if any, stays in the dialog.
 */
export function CopySkillDialog({ source, name, problem, error, creating, onChangeName, onCreate, onClose }: CopySkillDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const noteId = useId();
  const shown = problem || error;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!creating && name !== "" && !problem) onCreate();
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
          <h2 id={headingId} className="app-modal-title">Edit as my copy</h2>
        </div>
        <div className="app-modal-body lib-newdoc-body">
          <p>
            The bundled <b>{source}</b> keeps its name and stays active. Your copy is a new skill in{" "}
            <span className="lib-mono">pack:personal</span> that Update installs next to it.
          </p>
          <label className="lib-label" htmlFor={`${headingId}-name`}>Name</label>
          <input
            id={`${headingId}-name`}
            ref={inputRef}
            className="lib-input lib-mono"
            type="text"
            value={name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={shown ? true : undefined}
            aria-describedby={noteId}
            onChange={event => onChangeName(event.target.value)}
          />
          <p id={noteId} className={shown ? "lib-newdoc-error" : "lib-dim"} role={error && !problem ? "alert" : undefined}>
            {shown || "Lowercase letters, digits and dashes."}
          </p>
        </div>
        <div className="app-modal-footer">
          <span className="tbtn-row">
            <TButton keys={[]} onClick={onClose}>Cancel</TButton>
            <button type="submit" className="tbtn tbtn-primary" aria-disabled={creating || name === "" || problem !== "" || undefined}>
              <span className="tbtn-label">{creating ? "Creating…" : "Create copy"}</span>
            </button>
          </span>
        </div>
      </form>
    </dialog>
  );
}
