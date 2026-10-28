import { useEffect, useRef } from "react";
import { focusPaneById, listPanes, paneOf } from "../../keyboard/focus";

/**
 * For the page that owns a run panel: when a new rollback transaction appears (an apply or uninstall just
 * finished) the panel takes focus, so its result and `z` are in reach instead of dead behind the page the closing
 * review handed focus to. Focus the user placed on another pane is left alone, and a transaction that was already
 * there when the page mounted does nothing. Call it from a component that stays mounted across the review (the
 * page), not from RunPanel itself, which remounts with the review.
 */
export function useFocusRunOnNewTransaction(transactionId: string | null | undefined, paneId = "output"): void {
  const seen = useRef(transactionId);
  useEffect(() => {
    const previous = seen.current;
    seen.current = transactionId;
    if (!transactionId || transactionId === previous) return;
    const active = document.activeElement;
    const activePane = active ? paneOf(active) : null;
    const panes = listPanes();
    const defaultPane = panes.find(pane => pane.hasAttribute("data-pane-default")) ?? panes[0];
    // Free: nothing holds focus, or it sits where the closing review left it (the page's default pane).
    const free = !active || active === document.body || active.closest(".shell-chrome") !== null || !activePane || activePane === defaultPane;
    if (free) focusPaneById(paneId);
  }, [transactionId, paneId]);
}
