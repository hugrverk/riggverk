import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { TButton } from "../../ui/TButton";
import { RoutingField, type RoutingValue } from "./RoutingField";
import { ownWhen, suggestWhen, whenProblem } from "./routing";

export function RoutingDialog({ name, description, lines, problem, onSave, onClose }: {
  name: string; description: string; lines: readonly string[]; problem: string | null; onSave: (when: string | null) => Promise<string>; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const own = ownWhen(lines, name);
  const suggestion = suggestWhen(description);
  const [value, setValue] = useState<RoutingValue>({ checked: own !== null, when: own ?? suggestion });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = value.checked ? own === null || value.when.trim() !== own : own !== null;
  const ready = changed && !busy && (!value.checked || !whenProblem(value.when, name));
  useEffect(() => { dialogRef.current?.showModal(); dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }, []);
  const close = () => { if (!busy) onClose(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); close(); } };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true); setError("");
    try { await onSave(value.checked ? value.when : null); onClose(); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); setBusy(false); }
  };
  const handwritten = lines.filter(line => line.includes(`\`${name}\``) && ownWhen([line], name) === null);
  return <dialog ref={dialogRef} className="app-modal lib-newdoc" aria-labelledby={headingId} data-keyscope="overlay" onKeyDown={onKeyDown} onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={event => void submit(event)}>
      <div className="app-modal-header"><h2 id={headingId} className="app-modal-title">Routing for {name}</h2></div>
      <div className="app-modal-body lib-newdoc-body">
        {problem && <p className="lib-newdoc-error">{problem}</p>}
        {handwritten.map((line, index) => <p key={index}>Written by hand in routing.md: <code className="lib-mono">{line}</code></p>)}
        <RoutingField name={name} suggestion={suggestion} value={value} onChange={setValue} disabled={busy} />
        {error && <p className="lib-newdoc-error" role="alert">{error}</p>}
      </div>
      <div className="app-modal-footer"><span className="tbtn-row"><TButton keys={[]} onClick={close} disabled={busy}>Cancel</TButton><button type="submit" className="tbtn tbtn-primary" aria-disabled={!ready || undefined}><span className="tbtn-label">{busy ? "Saving…" : "Save"}</span></button></span></div>
    </form>
  </dialog>;
}
