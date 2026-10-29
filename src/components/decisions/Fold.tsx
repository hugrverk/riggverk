import { useEffect, useRef, type ReactNode } from "react";
import { currentMotion } from "../../lib/motion";

/** How long after it opens the fold keeps itself in view while its content settles (loading line, then the diff). */
const SETTLE_MS = 1500;

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
 * preference, drop the animation and show it at once. It opens below the cards it belongs to, often under the
 * fold of the window, so it scrolls itself into view (nearest edge, instantly when motion is off) and keeps doing so
 * for a moment while the diff replaces the loading line and makes it taller. Focus stays where it was.
 */
export function Fold({ id, label, children }: FoldProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fold = ref.current;
    if (!fold) return;
    const reveal = () => fold.scrollIntoView?.({ block: "nearest", behavior: currentMotion() === "off" ? "auto" : "smooth" });
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const until = Date.now() + SETTLE_MS;
    const observer = new ResizeObserver(() => {
      if (Date.now() < until) reveal();
    });
    observer.observe(fold);
    return () => observer.disconnect();
  }, []);
  return (
    <div id={id} ref={ref} className="hp-fold" role="group" aria-label={label}>
      <div className="hp-fold-in">{children}</div>
    </div>
  );
}
