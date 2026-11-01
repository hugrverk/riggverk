import type { KeyboardEventHandler, ReactNode, Ref } from "react";
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
  /** `primary`: the silver fill. `danger`: hairline button with `--fix` text, never a red fill. Default: a hairline button. */
  variant?: "primary" | "danger";
  className?: string;
  /** The button opens and closes a region (a Compare fold-out): its state. Renders `aria-expanded`. */
  expanded?: boolean;
  /** The id of the region `expanded` controls. Renders `aria-controls`. */
  controls?: string;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * A real `<button>` in the Bläck button style: primary is the silver fill, the default is a hairline button,
 * `danger` a hairline button with `--fix` text. The key cap sits inside as a quiet chip; the accessible name is the
 * label (the cap is aria-hidden and `aria-keyshortcuts` carries the key). CSS capitalises the label's first letter,
 * so the name stays what the caller passed. Use it where the answer has to sit next to the question: a review's
 * action bar, a dialog footer, a result's rollback. A click leaves focus where it was (the pane that holds the keys keeps them), and a disabled
 * button stays focusable with its reason as the tooltip.
 */
export function TButton({ keys, children, onClick, disabled = false, shortcut, variant, className, expanded, controls, onKeyDown, ref }: TButtonProps) {
  const isDisabled = disabled !== false;
  return (
    <button
      ref={ref}
      type="button"
      className={cx("tbtn", variant && `tbtn-${variant}`, className)}
      aria-disabled={isDisabled || undefined}
      aria-keyshortcuts={shortcut}
      aria-expanded={expanded}
      aria-controls={controls}
      title={typeof disabled === "string" ? disabled : undefined}
      onMouseDown={event => event.preventDefault()}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (!isDisabled) onClick?.();
      }}
    >
      {keys.map((token, index) => (
        <kbd key={`${index}:${token}`} aria-hidden="true">
          {token}
        </kbd>
      ))}
      <span className="tbtn-label">{children}</span>
    </button>
  );
}
