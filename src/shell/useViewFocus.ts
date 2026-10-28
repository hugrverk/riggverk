import { useEffect, type RefObject } from "react";
import { focusDefaultPane } from "../keyboard/focus";
import type { AppView } from "./views";

/** How long a view switch may wait for its first pane (lazy chunks, async data) before giving up. */
const FOCUS_WINDOW_MS = 2000;

/** Focus may be taken when nothing meaningful holds it: the body, the sidebar or top bar (`.topline`), or an element that was just unmounted. */
function focusIsFree(container: HTMLElement): boolean {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return true;
  if (active.closest(".topline")) return true;
  return !active.isConnected || (!container.contains(active) && !active.closest("[data-keyscope='overlay'], dialog[open]"));
}

/**
 * After every view change (keyboard, mouse, command, landing view), moves focus to the new view's default
 * pane. Waits for lazy or async content with a MutationObserver, and never steals focus the user has
 * already placed inside the view.
 */
export function useViewFocus(view: AppView, containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(timer);
      container.removeEventListener("focusin", onUserFocus);
    };
    const attempt = () => {
      if (finished) return;
      if (!focusIsFree(container)) {
        finish();
        return;
      }
      if (focusDefaultPane(container)) finish();
    };
    const onUserFocus = (event: FocusEvent) => {
      // Focus the user placed inside the view wins; our own focus() call also lands here and ends the wait.
      if (event.target instanceof Element && container.contains(event.target)) finish();
    };
    const observer = new MutationObserver(attempt);
    const timer = setTimeout(finish, FOCUS_WINDOW_MS);
    observer.observe(container, { childList: true, subtree: true });
    container.addEventListener("focusin", onUserFocus);
    attempt();
    return finish;
  }, [view, containerRef]);
}
