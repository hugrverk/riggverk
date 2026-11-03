import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { DiffView } from "../../components/DiffView";
import { StateMark } from "../../ui/StatePill";
import { TButton } from "../../ui/TButton";
import type { ImportCandidate, ImportRouting, SkillImportPreview, SkillImportResult, SkillSummary } from "../../types";
import { ownWhen, suggestWhen, whenProblem } from "./routing";
import { RoutingField, type RoutingValue } from "./RoutingField";
import {
  canImport,
  changeDiff,
  cloneCommand,
  formatSize,
  IMPORT_DESTINATION,
  importNameProblem,
  importStatus,
  orderedFlags,
  renamedSkillMd,
  suggestedImportName,
} from "./skillImport";
import { unifiedLineDiff } from "../../lib/lineDiff";

/** Paths dropped onto the window; `seq` tells two drops of the same paths apart. */
export interface DroppedPaths {
  paths: string[];
  seq: number;
}

interface ImportSkillDialogProps {
  /** Paths to preview at once (a drop onto the Packs view opened the dialog). */
  dropped: DroppedPaths | null;
  /** True while something is dragged over the window. */
  dragging: boolean;
  /** Every skill the Library lists, for the name checks. */
  skills: readonly SkillSummary[];
  /** The packs folder, as `~/...`, for the `git clone` hint. */
  packsFolder: string;
  /** The imported pack's routing lines, so an import in place starts from the skill's current line. */
  routingLines?: readonly string[];
  onPreview: (paths: string[]) => Promise<SkillImportPreview>;
  onCommit: (token: string, selection: string[], renames: Record<string, string>, routing: ImportRouting) => Promise<SkillImportResult>;
  onDone: (result: SkillImportResult) => void;
  onClose: () => void;
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/**
 * "Import skill…": a skill folder, a loose SKILL.md or a folder of skills, dropped onto the window or given as a path,
 * is previewed from the backend's private copy: what it holds, the flags first, its SKILL.md as plain text (never
 * rendered) and, for an import in place, the diff. Import publishes exactly that copy into pack:imported; nothing
 * reaches an agent before the next Update. A modal `<dialog>` like "Edit as my copy".
 */
export function ImportSkillDialog({ dropped, dragging, skills, packsFolder, routingLines = [], onPreview, onCommit, onDone, onClose }: ImportSkillDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const statusId = useId();
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [routing, setRouting] = useState<Record<string, RoutingValue>>({});
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
  }, []);

  const runPreview = async (paths: string[]) => {
    if (paths.length === 0 || busy === "import") return;
    const request = ++requestRef.current;
    setBusy("preview");
    setError(null);
    setPreview(null);
    try {
      const shown = await onPreview(paths);
      if (request !== requestRef.current) return;
      setPreview(shown);
      const importable = shown.candidates.filter(canImport);
      setSelected(new Set(importable.map(candidate => candidate.key)));
      setRouting({});
      setRenames(Object.fromEntries(importable.filter(c => c.collision === "bundled").map(c => [c.key, suggestedImportName(c.name)])));
    } catch (e) {
      if (request === requestRef.current) setError(errorText(e));
    } finally {
      if (request === requestRef.current) setBusy(null);
    }
  };

  // A drop previews what was dropped; the path field shows it when it was one item.
  useEffect(() => {
    if (!dropped || dropped.paths.length === 0) return;
    setPath(dropped.paths.length === 1 ? dropped.paths[0]! : "");
    void runPreview(dropped.paths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped?.seq]);

  const close = () => {
    if (busy !== "import") onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    close();
  };

  const candidates = preview?.candidates ?? [];
  const nameOf = (candidate: ImportCandidate) => renames[candidate.key] ?? candidate.name;
  const problemOf = (candidate: ImportCandidate) => {
    if (candidate.collision !== "bundled" && renames[candidate.key] === undefined) return "";
    const problem = importNameProblem(nameOf(candidate), candidate, skills);
    if (problem || nameOf(candidate) === candidate.name) return problem;
    return renamedSkillMd(candidate.skill_md, nameOf(candidate)) === null ? "This SKILL.md has no plain name: line to rewrite, so it cannot be imported under another name." : "";
  };
  const picked = candidates.filter(candidate => selected.has(candidate.key) && canImport(candidate));
  // Until the field is touched, a skill keeps the line it has, or starts from the suggestion in its description.
  const routingOf = (candidate: ImportCandidate): RoutingValue => {
    const own = ownWhen(routingLines, nameOf(candidate));
    const suggestion = suggestWhen(candidate.description, nameOf(candidate));
    return routing[candidate.key] ?? { checked: own !== null || suggestion !== "", when: own ?? suggestion };
  };
  const routingProblem = (candidate: ImportCandidate) => {
    const value = routingOf(candidate);
    return value.checked ? whenProblem(value.when, nameOf(candidate)) : "";
  };
  const blocked = picked.some(candidate => problemOf(candidate) !== "" || routingProblem(candidate) !== "");
  const ready = preview?.token != null && picked.length > 0 && !blocked && busy === null;
  const single = candidates.length === 1;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !preview?.token) return;
    setBusy("import");
    setError(null);
    try {
      const chosen = Object.fromEntries(picked.filter(c => renames[c.key] !== undefined).map(c => [c.key, nameOf(c)]));
      // A key left out keeps routing as it is; null takes out the line the skill had.
      const edits: ImportRouting = {};
      for (const candidate of picked) {
        const value = routingOf(candidate);
        if (value.checked) edits[candidate.key] = value.when.trim();
        else if (ownWhen(routingLines, nameOf(candidate)) !== null) edits[candidate.key] = null;
      }
      const result = await onCommit(preview.token, picked.map(candidate => candidate.key), chosen, edits);
      setBusy(null);
      onDone(result);
    } catch (e) {
      setBusy(null);
      // The token is spent either way: a new preview is needed. A refusal that names skills as imported came after
      // they were published; the Library already lists them.
      setPreview(current => (current ? { ...current, token: null } : current));
      const message = errorText(e);
      setError(/\bimported\b/.test(message) ? `${message} The Library lists what is in.` : `${message} Preview again to import.`);
    }
  };

  const toggle = (key: string, on: boolean) =>
    setSelected(current => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const statusText =
    busy === "preview" ? "Reading and copying the skill…" : busy === "import" ? "Importing…" : preview ? `${candidates.length === 1 ? "1 skill" : `${candidates.length} skills`} found.` : "";

  return (
    <dialog
      ref={dialogRef}
      className="app-modal lib-import"
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
          <h2 id={headingId} className="app-modal-title">Import skill</h2>
        </div>
        <div className="app-modal-body lib-import-body">
          <div className={`lib-import-drop${dragging ? " is-over" : ""}`}>
            {dragging ? "Release to preview" : "Drop a skill folder, a SKILL.md or a folder of skills onto this window."}
          </div>
          <label className="lib-label" htmlFor={`${headingId}-path`}>Or give its path</label>
          <div className="lib-import-path">
            <input
              id={`${headingId}-path`}
              ref={inputRef}
              className="lib-input lib-mono"
              type="text"
              value={path}
              placeholder="~/Downloads/my-skill"
              autoComplete="off"
              spellCheck={false}
              onChange={event => setPath(event.target.value)}
              onKeyDown={event => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void runPreview([path.trim()].filter(Boolean));
              }}
            />
            <TButton keys={[]} onClick={() => void runPreview([path.trim()].filter(Boolean))} disabled={path.trim() === "" ? "give a path first" : busy !== null}>
              Preview
            </TButton>
          </div>
          <p id={statusId} className="lib-dim" role="status">{statusText}</p>
          {error && <p className="lib-newdoc-error" role="alert">{error}</p>}
          {preview && preview.problems.length > 0 && (
            <ul className="lib-import-problems" aria-label="Not imported">
              {preview.problems.map(problem => <li key={problem}>{problem}</li>)}
            </ul>
          )}
          {candidates.length > 0 && (
            <fieldset className="lib-import-candidates">
              <legend className="lib-label">Skills found</legend>
              {candidates.map(candidate => (
                <CandidateView
                  key={candidate.key}
                  candidate={candidate}
                  open={single}
                  checked={selected.has(candidate.key)}
                  name={nameOf(candidate)}
                  nameProblem={problemOf(candidate)}
                  disabled={busy !== null || preview?.token == null}
                  onToggle={on => toggle(candidate.key, on)}
                  routing={routingOf(candidate)}
                  onRouting={value => setRouting(current => ({ ...current, [candidate.key]: value }))}
                  onRename={name => setRenames(current => ({ ...current, [candidate.key]: name }))}
                />
              ))}
            </fieldset>
          )}
          <p className="lib-import-dest">{IMPORT_DESTINATION}</p>
          <p className="lib-dim">
            From GitHub: the app fetches nothing. Clone the repository into your packs folder in a terminal, and its skills
            show up as a pack: <code className="lib-mono">{cloneCommand(packsFolder)}</code>
          </p>
        </div>
        <div className="app-modal-footer">
          <span className="tbtn-row">
            <TButton keys={[]} onClick={close} disabled={busy === "import" ? "importing" : false}>Cancel</TButton>
            <button type="submit" className="tbtn tbtn-primary" aria-disabled={!ready || undefined}>
              <span className="tbtn-label">{busy === "import" ? "Importing…" : picked.length > 1 ? `Import ${picked.length}` : "Import"}</span>
            </button>
          </span>
        </div>
      </form>
    </dialog>
  );
}

interface CandidateViewProps {
  candidate: ImportCandidate;
  open: boolean;
  checked: boolean;
  name: string;
  nameProblem: string;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onRename: (name: string) => void;
  /** Its "Use when" line, shown while it is ticked. */
  routing: RoutingValue;
  onRouting: (value: RoutingValue) => void;
}

function CandidateView({ candidate, open, checked, name, nameProblem, disabled, onToggle, onRename, routing, onRouting }: CandidateViewProps) {
  const id = useId();
  const importable = canImport(candidate);
  const flags = orderedFlags(candidate.flags);
  const renaming = candidate.collision === "bundled";
  // Under another name the SKILL.md that is written differs from the source by its name: line: show that text.
  const renamed = name !== candidate.name && !nameProblem ? renamedSkillMd(candidate.skill_md, name) : null;
  const written = renamed ?? candidate.skill_md;
  return (
    <section className="lib-import-candidate" aria-labelledby={`${id}-name`}>
      <div className="lib-import-head">
        <input
          id={`${id}-check`}
          type="checkbox"
          checked={checked && importable}
          disabled={!importable || disabled}
          aria-describedby={`${id}-status`}
          onChange={event => onToggle(event.target.checked)}
        />
        <label htmlFor={`${id}-check`} id={`${id}-name`} className="lib-import-name">{candidate.name || candidate.source}</label>
        <span id={`${id}-status`} className="lib-tag">{importStatus(candidate)}</span>
      </div>
      <div className="lib-row-path">{candidate.source}</div>
      {candidate.description && <p className="lib-import-desc">{candidate.description}</p>}
      {candidate.problems.length > 0 && (
        <ul className="lib-import-problems" aria-label={`Why ${candidate.name || "it"} cannot be imported`}>
          {candidate.problems.map(problem => <li key={problem}>{problem}</li>)}
        </ul>
      )}
      {flags.length > 0 && (
        <ul className="lib-import-flags" aria-label={`What ${candidate.name} does without asking`}>
          {flags.map(flag => (
            <li key={`${flag.kind}:${flag.label}`}>
              <StateMark state="fix" />
              <span><b>{flag.label}</b> · {flag.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {renaming && importable && (
        <div className="lib-import-rename">
          <label className="lib-label" htmlFor={`${id}-rename`}>Import as</label>
          <input
            id={`${id}-rename`}
            className="lib-input lib-mono"
            type="text"
            value={name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={nameProblem ? true : undefined}
            aria-describedby={`${id}-rename-note`}
            disabled={disabled}
            onChange={event => onRename(event.target.value)}
          />
          <p id={`${id}-rename-note`} className={nameProblem ? "lib-newdoc-error" : "lib-dim"}>
            {nameProblem || `The bundled ${candidate.name} keeps its name; the name in this SKILL.md is changed to the one above.`}
          </p>
          {renamed !== null && (
            <DiffView diff={unifiedLineDiff(candidate.skill_md, renamed)} labelled={false} label={`SKILL.md of ${candidate.name} as it will be written`} />
          )}
        </div>
      )}
      {checked && importable && (
        <RoutingField name={name} suggestion={suggestWhen(candidate.description, name)} value={routing} onChange={onRouting} disabled={disabled} />
      )}
      {candidate.files.length > 0 && (
        <details className="lib-import-details" open={open}>
          <summary>Files ({candidate.files.length}){candidate.skill_md ? " and SKILL.md" : ""}</summary>
          <ul className="lib-import-files" aria-label="Files">
            {candidate.files.map(file => (
              <li key={file.path}>
                <span className="lib-mono">{file.path}</span>
                <span className="lib-dim">
                  {formatSize(file.size)}
                  {file.executable ? " · executable" : ""}
                  {file.binary ? " · binary" : ""}
                </span>
                {file.problem && <span className="lib-newdoc-error"> · {file.problem}</span>}
              </li>
            ))}
            {candidate.omitted.map(path => (
              <li key={`omitted:${path}`} className="lib-dim">
                <span className="lib-mono">{path}</span> · skipped (dot entries are never copied)
              </li>
            ))}
          </ul>
          {candidate.changes.length > 0 && (
            <div className="lib-import-changes">
              <p className="lib-label">Against the import in place</p>
              {candidate.changes.map(change => {
                const diff = changeDiff(change);
                return (
                  <div key={change.path} className="lib-import-change">
                    <p className="lib-mono">{change.path} · {change.change}</p>
                    {change.executable_before != null && change.executable_after != null && change.executable_before !== change.executable_after && (
                      <p>Executable: {change.executable_before ? "yes" : "no"} → {change.executable_after ? "yes" : "no"}</p>
                    )}
                    {diff ? (
                      <DiffView diff={diff} labelled={false} label={`${change.path} against the import in place`} />
                    ) : change.before === null && change.after === null ? (
                      <p className="lib-dim">Binary or too large to show.</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {candidate.skill_md && (
            <>
              <p className="lib-label">{renamed !== null ? `SKILL.md, as it will be written (as ${name})` : "SKILL.md, as it is"}</p>
              <pre className="lib-import-raw" tabIndex={0} aria-label={`SKILL.md of ${candidate.name}`}>{written}</pre>
            </>
          )}
        </details>
      )}
    </section>
  );
}
