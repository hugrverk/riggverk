import type { ReactNode } from "react";
import { displayPath } from "../lib/displayPath";

export interface ReviewFooterProps {
  /** The question or status line, announced politely. */
  question: string;
  /** The action buttons (`BindingButton`s). */
  children: ReactNode;
  /** Set when applying writes: shows where the backup goes and the consequence line. */
  backup?: { root?: string | null } | false;
}

/**
 * The action bar of a review card: the question, the buttons beside it and, when applying writes, the backup note
 * and the consequence line ("Preview first · Backed up · Undo any time"). Rendered as the `Pane` footer.
 */
export function ReviewFooter({ question, children, backup = false }: ReviewFooterProps) {
  return (
    <>
      <span className="q" role="status">
        {question}
      </span>
      <span className="tbtn-row">{children}</span>
      {backup && (
        <>
          <span className="bk">
            Backup: {backup.root ? `${displayPath(backup.root)}/` : ""}&lt;run&gt; · transaction recorded
          </span>
          <span className="rv-conseq">
            <span>Preview first</span>
            <span>Backed up</span>
            <span>Undo any time</span>
          </span>
        </>
      )}
    </>
  );
}
