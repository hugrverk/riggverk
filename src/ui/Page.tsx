import type { MouseEvent, ReactNode, Ref } from "react";
import { PaneContext } from "./Pane";

/** `data-pane-id` of a page: bindings with `paneId: "page"` apply while focus is anywhere inside it. */
export const PAGE_PANE_ID = "page";

export interface PageProps {
  /** Accessible name of the page ("Overview", "Claude Code"). */
  label: string;
  className?: string;
  children: ReactNode;
  ref?: Ref<HTMLElement>;
}

/** A click on dead space, or on a button that keeps focus where it was, must not leave the keys without a home. */
function keepFocusInside(event: MouseEvent<HTMLElement>) {
  const page = event.currentTarget;
  if (!page.contains(document.activeElement)) page.focus({ preventScroll: true });
}

/**
 * The page-level focus container of Overview and the harness pages: a `section[data-pane-id="page"]` that takes focus
 * on click (`tabIndex=-1`) and is the default pane after a view switch, so the page keys (u, p, r, d, v, m, b, c, o, B)
 * work wherever focus sits inside it. It is not a stop in the tab order; the controls inside are. The context hands the
 * id to components that register their own page keys (`usePaneId`).
 */
export function Page({ label, className, children, ref }: PageProps) {
  return (
    <PaneContext.Provider value={PAGE_PANE_ID}>
      <section
        ref={ref}
        className={className}
        aria-label={label}
        data-pane-id={PAGE_PANE_ID}
        data-pane-default=""
        data-keyscope="pane"
        tabIndex={-1}
        onClickCapture={keepFocusInside}
      >
        {children}
      </section>
    </PaneContext.Provider>
  );
}
