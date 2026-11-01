import type { ReactNode } from "react";
import { displayPath } from "../lib/displayPath";

export interface ReviewFooterProps {
  /** The question or status line, announced politely. */
  question: string;
  /** The action buttons (`BindingButton`s). */
  children: ReactNode;
  /**
   * Set when applying writes: shows where the backup goes and the consequence line. `transaction` is the run that was
   * recorded, once an apply has finished.
   */
  backup?: { root?: string | null; transaction?: string | null } | false;
  /** The consequence line's facts; default "Preview first · Backed up · Undo any time". */
  facts?: readonly string[];
}

const FACTS = ["Preview first", "Backed up", "Undo any time"] as const;

/**
 * The action bar of a review card: the question, the buttons beside it and, when applying writes, the backup note
 * and the consequence line ("Preview first · Backed up · Undo any time"). Rendered as the `Pane` footer.
 */
export function ReviewFooter({ question, children, backup = false, facts = FACTS }: ReviewFooterProps) {
  return (
    <>
      <span className="q" role="status">
        {question}
      </span>
      <span className="tbtn-row">{children}</span>
      {backup && (
        <>
          <span className="bk">
            Backup: {backup.root ? `${displayPath(backup.root)}/` : ""}&lt;run&gt; ·{" "}
            {backup.transaction ? `transaction ${backup.transaction} recorded · rollback available` : "transaction recorded"}
          </span>
          <span className="rv-conseq">
            {facts.map(fact => (
              <span key={fact}>{fact}</span>
            ))}
          </span>
        </>
      )}
    </>
  );
}
