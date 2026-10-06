import { useEffect, useState } from "react";
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
