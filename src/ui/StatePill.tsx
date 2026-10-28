import type { ReactNode } from "react";
import type { UiState } from "../lib/uiState";
import { cx } from "./tone";

/** A security finding mark ("Worth a look", "Tip"): quiet outline, never part of a state. */
export type StatePillKind = UiState | "tip";

/**
 * The marker in front of a state: a hollow ring for every state, one filled square for the decision. It is
 * decorative (`aria-hidden`): the state is always said in words next to it. Colour, shape and weight come from the
 * `.state-mark` rules in `_overview.scss`.
 */
export function StateMark({ state, className }: { state: StatePillKind; className?: string }) {
  return <i className={cx("state-mark", `is-${state}`, className)} aria-hidden="true" />;
}

export interface StatePillProps {
  state: StatePillKind;
  /** The state in words ("Up to date", "1 to decide"). Always present: the marker and the hue never carry it alone. */
  children: ReactNode;
  className?: string;
  id?: string;
}

/**
 * Hairline-free pill for one state: mono uppercase text with its marker. The decision is the brightest ink in
 * weight 600 on the raised surface with the filled square; every other state keeps its own muted hue with a hollow
 * ring. No state uses an amber or ochre hue.
 */
export function StatePill({ state, children, className, id }: StatePillProps) {
  return (
    <span id={id} className={cx("state-pill", `is-${state}`, className)}>
      <StateMark state={state} />
      {children}
    </span>
  );
}
