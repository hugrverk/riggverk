import type { ReactNode, Ref } from "react";
import { cx } from "./tone";

export interface TButtonProps {
  /** Display tokens for the key caps ("y", "↵", "⌘S"). */
  keys: readonly string[];
  children: ReactNode;
  onClick?: () => void;
  /** true or a reason string: rendered aria-disabled, never calls onClick. The reason becomes the tooltip. */
  disabled?: boolean | string;
  /** aria-keyshortcuts value, when the key is a single step. */
  shortcut?: string;
  /** `primary`: accent brackets and a bold label. `danger`: the fail colour. Default: a plain button. */
  variant?: "primary" | "danger";
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * `[ y apply ]`: a real `<button>` whose key cap sits inside and whose brackets are pseudo-elements, so the
 * accessible name is the label (the cap is aria-hidden; `aria-keyshortcuts` carries the key). Use it only where
 * the answer has to sit next to the question: a confirm line, a dialog footer, a result's rollback. Everywhere
 * else a key hint is an `ActionKey`.
 *
 * Like `ActionKey`, a click leaves focus where it was (the pane that holds the keys keeps them), a disabled
 * button stays focusable with its reason as the tooltip, and keyboard focus inverts the whole button.
 */
export function TButton({ keys, children, onClick, disabled = false, shortcut, variant, className, ref }: TButtonProps) {
  const isDisabled = disabled !== false;
  return (
    <button
      ref={ref}
      type="button"
      className={cx("tbtn", variant && `tbtn-${variant}`, className)}
      aria-disabled={isDisabled || undefined}
      aria-keyshortcuts={shortcut}
      title={typeof disabled === "string" ? disabled : undefined}
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        if (!isDisabled) onClick?.();
      }}
    >
      {keys.map((token, index) => (
        <kbd key={`${index}:${token}`} aria-hidden="true">
          {token}
        </kbd>
      ))}
      {children}
    </button>
  );
}
