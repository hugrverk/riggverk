import type { ReactNode } from "react";
import { cx } from "./tone";
import { KeyCaps } from "./Kbd";

export interface ActionKeyProps {
  /** Display tokens for the key caps ("u", "↵", "⌘S"). */
  keys: readonly string[];
  children: ReactNode;
  onClick?: () => void;
  /** true or a reason string: rendered aria-disabled, never calls onClick. The reason becomes the tooltip. */
  disabled?: boolean | string;
  /** aria-keyshortcuts value, when the key is a single step. */
  shortcut?: string;
  className?: string;
}

/**
 * `<button class="action-key"><kbd>u</kbd> update</button>`: a key hint that is also the control.
 * Status-bar hints are real buttons, so every keyboard action stays mouse-reachable. A click leaves focus where
 * it was: in Chromium webviews (WebView2 on Windows) the mousedown would focus the button, the status bar would
 * lose the focused pane, and the pane's hint would unmount before its click landed.
 */
export function ActionKey({ keys, children, onClick, disabled = false, shortcut, className }: ActionKeyProps) {
  const isDisabled = disabled !== false;
  return (
    <button
      type="button"
      className={cx("action-key", className)}
      aria-disabled={isDisabled || undefined}
      aria-keyshortcuts={shortcut}
      title={typeof disabled === "string" ? disabled : undefined}
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        if (!isDisabled) onClick?.();
      }}
    >
      <KeyCaps keys={keys} /> {children}
    </button>
  );
}
