import { useId } from "react";
import { CLAUDE_ENV_DENY_LINES, type PostureNote, type PostureVerdict } from "../../lib/securityPostureRows";
import { StatePill } from "../../ui/StatePill";
import { CopyButton } from "../CopyButton";

export interface SafetyNotesProps {
  verdict: PostureVerdict;
  notes: readonly PostureNote[];
  /** Show the `.env` deny lines to paste into `~/.claude/settings.json` (Claude Code, while `.env` reads are allowed). */
  envDenySnippet?: boolean;
}

/**
 * The lines that stop Claude's file tools from reading `.env` files, with a Copy button. A suggestion only: Riggverk
 * never writes them, and the text says what the rule does not cover.
 */
function EnvDenySnippet() {
  const codeId = `env-deny-${useId().replace(/:/g, "")}`;
  return (
    <div className="hp-env-deny">
      <p>
        Paste these lines into the <code>deny</code> array under <code>permissions</code> in{" "}
        <code>~/.claude/settings.json</code>; Riggverk does not add them for you. They block <code>.env.example</code>{" "}
        too. They cover Claude's file tools and the Bash file commands it recognizes (cat, head, tail, sed, tee, redirects),
        not <code>grep -r</code> run from the folder or scripts that open files themselves; Claude Code's sandbox blocks at
        the OS level (Claude Code docs: Configure permissions).
      </p>
      <div className="copyable-block">
        <CopyButton getText={() => CLAUDE_ENV_DENY_LINES} fallbackElementId={codeId} copyLabel="Copy the .env deny lines" />
        <pre id={codeId} className="markdown-code">
          {CLAUDE_ENV_DENY_LINES}
        </pre>
      </div>
    </div>
  );
}

/**
 * The "Safety notes" zone of a harness page. Advice only: it reads the harness's global config, it never writes, and
 * nothing in it is a state or is counted. Each finding keeps its label, its text in mono and, where the level has
 * one, a quiet mark ("Worth a look", "Tip", "Set"); what is not checked has none. On the Claude Code page, while
 * `.env` reads are allowed, it also suggests the deny lines to paste (never written by the app).
 */
export function SafetyNotes({ verdict, notes, envDenySnippet = false }: SafetyNotesProps) {
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
      {envDenySnippet ? <EnvDenySnippet /> : null}
    </section>
  );
}
