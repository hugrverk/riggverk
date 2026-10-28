import type { KeyboardEvent, ReactNode, Ref } from "react";
import { TButton } from "./TButton";

export interface ApplyButtonProps {
  /** Display tokens for the key cap. Default `y`. */
  keys?: readonly string[];
  /** aria-keyshortcuts value. Default `y`. */
  shortcut?: string;
  children?: ReactNode;
  onClick?: () => void;
  /** true or a reason string: rendered aria-disabled, never calls onClick. The reason becomes the tooltip. */
  disabled?: boolean | string;
  ref?: Ref<HTMLButtonElement>;
}

/** Enter never applies: a focused button would otherwise click on Enter. Space and a mouse click still do. */
function swallowEnter(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === "Enter") event.preventDefault();
}

/**
 * The primary button of a review: the one that writes. Same markup and rules as `TButton` (aria-disabled with the
 * reason as tooltip, focus stays where it was on a click), plus the review safety rule: Enter on the focused
 * button is swallowed, so applying takes `y`, a click or Space, never a stray Enter.
 */
export function ApplyButton({ keys = ["y"], shortcut = "y", children = "apply", onClick, disabled, ref }: ApplyButtonProps) {
  return (
    <TButton
      ref={ref}
      keys={keys}
      shortcut={shortcut}
      variant="primary"
      className="tbtn-apply"
      disabled={disabled}
      onClick={onClick}
      onKeyDown={swallowEnter}
    >
      {children}
    </TButton>
  );
}
