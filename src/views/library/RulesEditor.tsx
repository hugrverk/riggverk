import { useId, useMemo } from "react";
import { DiffView } from "../../components/DiffView";
import { HARNESS_LABELS } from "../../lib/harnessInstallation";
import { CONFLICT_TEXT } from "../../lib/rulesView";
import type { InstallAgent } from "../../types";
import { TButton } from "../../ui/TButton";
import type { LibraryEntry } from "./entry";
import { effectiveRulesText, overrideHint, refinementsDiff, refinementsEndingsNote, sharedHeadings } from "./rulesText";

export type RulesMode = "refinements" | "effective" | "diff";

const MODES: readonly { id: RulesMode; label: string }[] = [
  { id: "refinements", label: "Refinements" },
  { id: "effective", label: "Effective" },
  { id: "diff", label: "Diff against disk" },
];

type RulesEntry = LibraryEntry & { rules: NonNullable<LibraryEntry["rules"]> };

interface RulesEditorProps {
  entry: RulesEntry;
  mode: RulesMode;
  onMode: (mode: RulesMode) => void;
  /** Goes to the page of this harness, where the conflict is decided. */
  onOpenHarness?: (harness: InstallAgent) => void;
}

function harnessName(harness: InstallAgent | null): string {
  return harness ? HARNESS_LABELS[harness] : "harness";
}

/** The file of a rules conflict is read-only: what is wrong, where it is decided, and the file as it is on disk. */
function ConflictCard({ entry, onOpenHarness }: { entry: RulesEntry; onOpenHarness?: RulesEditorProps["onOpenHarness"] }) {
  const { file, harness } = entry.rules;
  const reason = file.conflict!;
  const name = harnessName(harness);
  return (
    <div className="lib-conflict">
      <div className="lib-conflict-card">
        <span className="lib-decide">Needs your decision</span>
        {reason === "base_block_edited" ? (
          <>
            <p>
              The managed block in this file was edited by hand. Riggverk does not merge or overwrite it, and the
              refinements below END are read-only until you decide.
            </p>
            <p className="lib-dim">Decide in the {name} view: keep the edits as refinements, or restore the base.</p>
          </>
        ) : (
          <>
            <p>{CONFLICT_TEXT[reason].replace(/^./, letter => letter.toUpperCase())}. Riggverk leaves the file alone until you decide.</p>
            <p className="lib-dim">The {name} view has what can be done about it.</p>
          </>
        )}
        {harness && onOpenHarness && (
          <div>
            <TButton keys={[]} onClick={() => onOpenHarness(harness)}>
              {`Open ${name} view ›`}
            </TButton>
          </div>
        )}
      </div>
      <p className="lib-label">file on disk</p>
      <pre className="lib-pre is-dim" tabIndex={0} aria-label="File on disk">
        {file.before + file.refinements}
      </pre>
    </div>
  );
}

/**
 * The sheet of a rules file: the refinements under the managed block, what the whole file will read after saving,
 * and the refinements against the disk. All three come from the file and the draft in hand; nothing is fetched.
 */
export function RulesEditor({ entry, mode, onMode, onOpenHarness }: RulesEditorProps) {
  const { file, harness, conflict } = entry.rules;
  const ids = useId();
  const effective = useMemo(() => effectiveRulesText(file, entry.draft), [file, entry.draft]);
  const diff = useMemo(() => refinementsDiff(file, entry.draft), [file, entry.draft]);
  const endingsNote = useMemo(() => refinementsEndingsNote(file, entry.draft), [file, entry.draft]);
  const hint = useMemo(() => overrideHint(sharedHeadings(file.before, entry.draft)), [file.before, entry.draft]);

  if (conflict) return <ConflictCard entry={entry} onOpenHarness={onOpenHarness} />;
  if (entry.readOnly) {
    return <p className="lib-ro">{entry.readOnlyReason}</p>;
  }

  return (
    <div className="lib-rules">
      <div className="lib-modes" role="tablist" aria-label="Rules view">
        {MODES.map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${ids}-tab-${item.id}`}
            aria-selected={mode === item.id}
            aria-controls={`${ids}-panel`}
            tabIndex={mode === item.id ? 0 : -1}
            onClick={() => onMode(item.id)}
            onKeyDown={event => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              const next = MODES[(MODES.findIndex(candidate => candidate.id === mode) + step + MODES.length) % MODES.length]!;
              onMode(next.id);
              queueMicrotask(() => document.getElementById(`${ids}-tab-${next.id}`)?.focus());
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="lib-rules-panel" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${mode}`}>
        {mode === "refinements" && (
          <>
            {file.before && (
              <details className="lib-base" open>
                <summary className="lib-label">managed base · read-only</summary>
                <pre className="lib-pre is-dim" tabIndex={0} aria-label="Managed base">{file.before}</pre>
              </details>
            )}
            <label className="lib-label" htmlFor={`${ids}-ta`}>your refinements · below END</label>
            <textarea
              id={`${ids}-ta`}
              key={entry.id}
              className="lib-textarea"
              value={entry.draft}
              onChange={event => entry.onChange(event.target.value)}
              placeholder="Add refinements here. They stay through every update."
              spellCheck={false}
              autoFocus
            />
            {hint && (
              <div className="lib-hint" role="status">
                {hint}
              </div>
            )}
          </>
        )}
        {mode === "effective" && (
          <>
            <p className="lib-dim">
              Exactly what {harnessName(harness)} reads from <span className="lib-mono">{entry.path}</span>
              {entry.dirty ? " after you save" : ""}.
            </p>
            <pre className="lib-pre" tabIndex={0} aria-label="Effective file">{effective}</pre>
          </>
        )}
        {mode === "diff" && (
          <>
            <p className="lib-dim">Your working copy against the file on disk. Save writes a backup first.</p>
            <DiffView diff={diff} labelled={false} label="Refinements against disk" empty={endingsNote ?? "No difference against disk."} />
          </>
        )}
      </div>
    </div>
  );
}
