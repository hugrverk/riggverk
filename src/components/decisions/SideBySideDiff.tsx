import { redactDiffText } from "../../lib/redactTerminalOutput";
import { DiffView } from "../DiffView";

export interface DiffNote {
  text: string;
  /** `warn`: something is cut or withheld. Default: a quiet note. */
  tone?: "dim" | "warn";
}

export interface SideBySideDiffProps {
  /** Unified diff text, as the backend sends it. */
  diff: string;
  /** Accessible name of the diff. */
  label: string;
  /** Shown when the two sides are equal. */
  empty: string;
  /** What the two sides are, one sentence above them. */
  intro?: string;
  notes?: readonly DiffNote[];
  /** Mask secret shapes before they reach the screen (file diffs); the backend already withholds key blocks. */
  redact?: boolean;
}

/**
 * The read-only Compare view: what the two sides are, any cut or withheld notes the backend sent, and the diff side by
 * side (`DiffView` `layout="split"`, the old text left and the new text right). It renders the same payload the
 * unified review did, so the 64 KB cap and the notes about withheld files show as before. A removed line is a 9% ink
 * tint with its `-` in its own column; nothing is coloured red or amber.
 */
export function SideBySideDiff({ diff, label, empty, intro, notes = [], redact = false }: SideBySideDiffProps) {
  return (
    <div className="hp-sbs">
      {intro && <p className="hp-sbs-intro">{intro}</p>}
      {notes.map(note => (
        <p key={note.text} className={note.tone === "warn" ? "hp-sbs-note hp-sbs-warn" : "hp-sbs-note"} role="status">
          {note.text}
        </p>
      ))}
      <DiffView diff={redact ? redactDiffText(diff) : diff} label={label} empty={empty} layout="split" />
    </div>
  );
}
