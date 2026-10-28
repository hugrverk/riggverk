import type { ReactNode } from "react";

export interface FoldProps {
  /** The id the Compare button's `aria-controls` names. */
  id: string;
  /** Accessible name of the region ("Compare CLAUDE.md with Riggverk's rules"). */
  label: string;
  children: ReactNode;
}

/**
 * The inline fold-out under a decision card. It is mounted only while it has something to show (loading, the diff,
 * a failed preview), so a closed Compare leaves nothing in the page for a reader or the Tab order. It unfolds with a
 * height animation of `--dur-fold` on mount (`_harness.scss`); the subtle and off motion levels, and the OS
 * preference, drop the animation and show it at once.
 */
export function Fold({ id, label, children }: FoldProps) {
  return (
    <div id={id} className="hp-fold" role="group" aria-label={label}>
      <div className="hp-fold-in">{children}</div>
    </div>
  );
}
