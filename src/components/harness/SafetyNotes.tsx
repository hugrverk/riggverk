import type { PostureNote, PostureVerdict } from "../../lib/securityPostureRows";
import { StatePill } from "../../ui/StatePill";

export interface SafetyNotesProps {
  verdict: PostureVerdict;
  notes: readonly PostureNote[];
}

/**
 * The "Safety notes" zone of a harness page. Advice only: it reads the harness's global config, it never writes, and
 * nothing in it is a state or is counted. Each finding keeps its label, its text in mono and, where the level has
 * one, a quiet mark ("Worth a look", "Tip", "Set"); what is not checked has none.
 */
export function SafetyNotes({ verdict, notes }: SafetyNotesProps) {
  return (
    <section className="hp-cell hp-span3 hp-safety" aria-label="Safety notes">
      <div className="hp-safety-head">
        <b>Safety notes</b>
        <StatePill state="tip">Advice only</StatePill>
      </div>
      <p className="hp-safety-verdict">{verdict.text}</p>
      <ul className="hp-notes">
        {notes.map(note => (
          <li key={note.id} className="hp-note-row">
            <span>{note.label}</span>
            <span>{note.text}</span>
            {note.mark ? <StatePill state={note.mark.kind === "set" ? "ok" : "tip"}>{note.mark.text}</StatePill> : <span />}
          </li>
        ))}
      </ul>
    </section>
  );
}
