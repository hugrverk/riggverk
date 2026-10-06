/**
 * Pane focus helpers. A pane is `section[data-pane-id][data-keyscope]`; its primary focus target
 * is `[data-pane-primary]` (the listbox, or a scrollable body with tabIndex=0).
 */

const PANE_SELECTOR = "[data-pane-id]";
const PRIMARY_SELECTOR = "[data-pane-primary]";

function isUnavailable(el: HTMLElement): boolean {
  return el.closest("[hidden], [inert]") !== null;
}

/** Panes in DOM order, skipping hidden or inert subtrees. */
export function listPanes(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(PANE_SELECTOR)).filter(pane => !isUnavailable(pane));
}

export function paneOf(el: Element | null): HTMLElement | null {
  return el ? el.closest<HTMLElement>(PANE_SELECTOR) : null;
}

export function paneIdOf(el: Element | null): string | null {
  return paneOf(el)?.dataset.paneId ?? null;
}

function primaryOf(pane: HTMLElement): HTMLElement {
  return pane.querySelector<HTMLElement>(PRIMARY_SELECTOR) ?? pane;
}

/** Focuses the pane's primary target (falling back to the pane element itself). */
export function focusPanePrimary(pane: HTMLElement): boolean {
  const target = primaryOf(pane);
  target.focus({ preventScroll: false });
  return document.activeElement === target;
}

export type PaneDirection = "next" | "prev";

/** Focuses the neighbouring pane in DOM order relative to the pane that holds focus. No wrap-around. */
export function focusPane(direction: PaneDirection, root: ParentNode = document): boolean {
  const panes = listPanes(root);
  if (panes.length === 0) return false;
  const current = paneOf(document.activeElement);
  const index = current ? panes.indexOf(current) : -1;
  let nextIndex: number;
  if (index === -1) nextIndex = direction === "next" ? 0 : panes.length - 1;
  else nextIndex = direction === "next" ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= panes.length) return false;
  return focusPanePrimary(panes[nextIndex]!);
}

/** Focuses a pane by its `data-pane-id`. */
export function focusPaneById(id: string, root: ParentNode = document): boolean {
  const pane = listPanes(root).find(candidate => candidate.dataset.paneId === id);
  return pane ? focusPanePrimary(pane) : false;
}

/** The pane marked `data-pane-default`, else the first pane in DOM order. */
export function focusDefaultPane(root: ParentNode = document): boolean {
  const panes = listPanes(root);
  const pane = panes.find(candidate => candidate.hasAttribute("data-pane-default")) ?? panes[0];
  return pane ? focusPanePrimary(pane) : false;
}

/** Moves focus from an editable control back to the primary target of the pane that contains it. */
export function blurToPane(from: Element | null): boolean {
  const pane = paneOf(from);
  if (pane) return focusPanePrimary(pane);
  if (from instanceof HTMLElement) from.blur();
  return focusDefaultPane();
}
