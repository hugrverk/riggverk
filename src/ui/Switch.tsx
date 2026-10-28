import { cx } from "./tone";

export interface SwitchProps {
  checked: boolean;
  /** The value the switch asks for. */
  onChange: (next: boolean) => void;
  /** Accessible name: what the switch turns on ("Let Riggverk manage codex rules"). */
  label: string;
  /** true or a reason string: rendered aria-disabled, never calls onChange. The reason becomes the tooltip. */
  disabled?: boolean | string;
  className?: string;
  id?: string;
}

/**
 * A real `<button role="switch">`: Space and Enter toggle it natively, `aria-checked` carries the state (the knob is
 * decoration, drawn by `.switch` in `_harness.scss`). A disabled switch stays focusable, with its reason as the tooltip.
 */
export function Switch({ checked, onChange, label, disabled = false, className, id }: SwitchProps) {
  const isDisabled = disabled !== false;
  return (
    <button
      id={id}
      type="button"
      role="switch"
      className={cx("switch", className)}
      aria-checked={checked}
      aria-label={label}
      aria-disabled={isDisabled || undefined}
      title={typeof disabled === "string" ? disabled : undefined}
      onClick={() => {
        if (!isDisabled) onChange(!checked);
      }}
    />
  );
}
