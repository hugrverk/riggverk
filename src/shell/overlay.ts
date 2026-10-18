import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { focusDefaultPane } from "../keyboard/focus";

/**
 * Remembers the element that had focus when the overlay mounted and gives focus back when it unmounts
 * (or to the default pane when that element is gone).
 */
export function useRestoreFocus(): void {
  const [previous] = useState<Element | null>(() => (typeof document === "undefined" ? null : document.activeElement));
  useEffect(
    () => () => {
      if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) previous.focus();
      else focusDefaultPane();
    },
    [previous],
  );
}

/** Keeps Tab inside `container`. */
export function trapTab(event: { key: string; shiftKey: boolean; preventDefault: () => void }, container: HTMLElement | null): void {
  if (event.key !== "Tab" || !container) return;
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])"),
  );
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Rows a j/k or arrow press scrolls. */
const SCROLL_STEP_LINES = 3;

/** Scrolls the box for a key the overlay owns while focus sits on the dialog; false: not a scroll key. */
export function scrollHelpBox(box: HTMLElement | null, event: Pick<ReactKeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  if (!box || event.ctrlKey || event.metaKey || event.altKey) return false;
  const line = parseFloat(getComputedStyle(box).lineHeight) || 20;
  const page = Math.max(line, box.clientHeight * 0.9);
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  let next: number;
  switch (event.key) {
    case "ArrowDown":
    case "j":
      next = box.scrollTop + line * SCROLL_STEP_LINES;
      break;
    case "ArrowUp":
    case "k":
      next = box.scrollTop - line * SCROLL_STEP_LINES;
      break;
    case "PageDown":
      next = box.scrollTop + page;
      break;
    case "PageUp":
      next = box.scrollTop - page;
      break;
    case "g":
    case "Home":
      next = 0;
      break;
    case "G":
    case "End":
      next = max;
      break;
    default:
      return false;
  }
  box.scrollTop = Math.min(max, Math.max(0, next));
  return true;
}
