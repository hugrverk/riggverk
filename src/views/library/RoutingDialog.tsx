import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { TButton } from "../../ui/TButton";
import { handWritten, ownWhen, suggestWhen, whenProblem } from "./routing";
import { RoutingField, type RoutingValue } from "./RoutingField";

interface RoutingDialogProps {
  /** The imported skill. */
  name: string;
  /** Its description, for the suggestion. */
  description: string;
  /** The imported pack's routing lines, as the Library lists them. */
  lines: readonly string[];
  /** Why the imported pack's `routing.md` is not used, or null. */
  problem: string | null;
  /** Saves the line (null removes it); resolves with the notice, or throws the refusal. */
  onSave: (when: string | null) => Promise<string>;
  onClose: () => void;
}

/**
 * "Routing…" on an imported skill: adds, changes or removes the line the app keeps for it in the imported pack's
 * `routing.md`. Lines written by hand that name the skill are shown and left as they are. A modal `<dialog>` like
 * "Edit as my copy"; nothing reaches the agents before the next Update, which shows the rules diff.
 */
export function RoutingDialog({ name, description, lines, problem, onSave, onClose }: RoutingDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const own = ownWhen(lines, name);
  const suggestion = suggestWhen(description, name);
  const [value, setValue] = useState<RoutingValue>({ checked: own !== null, when: own ?? suggestion });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = handWritten(lines, name);
  const changed = value.checked ? value.when.trim() !== own : own !== null;
  const ready = changed && !busy && (!value.checked || whenProblem(value.when, name) === "");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  // A save under way cannot be called off from here: closing would hide its outcome.
  const close = () => {
    if (!busy) onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    close();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(value.checked ? value.when.trim() : null);
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
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
        close();
      }}
    >
      <form onSubmit={event => void submit(event)}>
        <div className="app-modal-header">
          <h2 id={headingId} className="app-modal-title">Routing for {name}</h2>
        </div>
        <div className="app-modal-body lib-newdoc-body">
          <p>
            The line tells every agent when to use <b>{name}</b>. It goes into{" "}
            <span className="lib-mono">pack:imported</span>; the next Update adds it to your rules files.
          </p>
          {problem && <p className="lib-newdoc-error">{problem}</p>}
          {others.map(line => (
            <p key={line} className="lib-import-routing-line">
              Written by hand in routing.md, kept as it is: <code className="lib-mono">{line}</code>
            </p>
          ))}
          <RoutingField name={name} suggestion={suggestion} value={value} onChange={setValue} disabled={busy} />
          {error && <p className="lib-newdoc-error" role="alert">{error}</p>}
        </div>
        <div className="app-modal-footer">
          <span className="tbtn-row">
            <TButton keys={[]} onClick={close} disabled={busy ? "saving the routing" : false}>Cancel</TButton>
            <button type="submit" className="tbtn tbtn-primary" aria-disabled={!ready || undefined}>
              <span className="tbtn-label">{busy ? "Saving…" : "Save"}</span>
            </button>
          </span>
        </div>
      </form>
    </dialog>
  );
}
