import type { ReactNode } from "react";
import { useKeymapContext, usePlatform } from "../keyboard/context";
import { ariaKeyShortcuts, formatKeys, parseKeys } from "../keyboard/keymap";
import { evaluateWhen, type Binding } from "../keyboard/registry";
import { ApplyButton } from "./ApplyButton";
import { TButton, type TButtonProps } from "./TButton";

/** Runs a binding from a click: the handler receives a synthetic keydown for its first key. False when it declined. */
export function invokeBinding(binding: Binding): boolean {
  const chord = parseKeys(binding.keys)[0];
  const key = chord ? chord[chord.length - 1]!.key : "";
  return binding.run(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })) !== false;
}

/**
 * The button form of a binding its owner holds (a review's `y apply`): hidden while `when()` is false, rendered
 * aria-disabled with the reason as tooltip while `when()` returns a string. A click runs the binding exactly as its
 * key does, never a second code path. `apply` renders an `ApplyButton` (primary, Enter never activates it) for the
 * binding that writes.
 */
export function BindingButton({
  binding,
  variant,
  label,
  apply = false,
}: {
  binding: Binding;
  variant?: TButtonProps["variant"];
  /** The text after the key cap; defaults to the binding's hint. */
  label?: ReactNode;
  /** The binding applies a reviewed plan: render an `ApplyButton`. */
  apply?: boolean;
}) {
  const platform = usePlatform();
  const keymap = useKeymapContext()?.keymap;
  const { active, disabledReason } = evaluateWhen(binding);
  if (!binding.hint || (!active && disabledReason === null)) return null;
  const props = {
    keys: formatKeys(binding.keys, platform),
    shortcut: ariaKeyShortcuts(binding.keys, platform),
    disabled: disabledReason ?? false,
    onClick: () => {
      // Announced to the keymap like a key press.
      const chord = parseKeys(binding.keys)[0];
      if (invokeBinding(binding) && chord) {
        keymap?.emitRun({ binding, chord, source: "click", editable: false, repeat: false });
      }
    },
  };
  if (apply) return <ApplyButton {...props}>{label ?? binding.hint}</ApplyButton>;
  return (
    <TButton {...props} variant={variant}>
      {label ?? binding.hint}
    </TButton>
  );
}
