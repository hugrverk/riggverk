import type { ReactNode } from "react";
import { useKeymapContext, usePlatform } from "../keyboard/context";
import { ariaKeyShortcuts, formatKeys, parseKeys } from "../keyboard/keymap";
import { evaluateWhen, type Binding, type RegisteredBinding } from "../keyboard/registry";
import { ActionKey } from "./ActionKey";
import { TButton, type TButtonProps } from "./TButton";

/** Runs a binding from a click: the handler receives a synthetic keydown for its first key. False when it declined. */
export function invokeBinding(binding: Binding): boolean {
  const chord = parseKeys(binding.keys)[0];
  const key = chord ? chord[chord.length - 1]!.key : "";
  return binding.run(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })) !== false;
}

/**
 * The clickable form of a binding that has a `hint`. Hidden while `when()` is false, rendered
 * aria-disabled with the reason as tooltip while `when()` returns a string. A click that ran the binding is
 * announced to the keymap like a key press, so the status bar echoes it the same way.
 */
export function BindingActionKey({ entry }: { entry: RegisteredBinding }) {
  const platform = usePlatform();
  const keymap = useKeymapContext()?.keymap;
  const { binding } = entry;
  const { active, disabledReason } = evaluateWhen(binding);
  if (!binding.hint || (!active && disabledReason === null)) return null;
  return (
    <ActionKey
      keys={formatKeys(binding.keys, platform)}
      shortcut={ariaKeyShortcuts(binding.keys, platform)}
      disabled={disabledReason ?? false}
      onClick={() => {
        const chord = parseKeys(binding.keys)[0];
        if (invokeBinding(binding) && chord) {
          keymap?.emitRun({ binding, chord, source: "click", editable: false, repeat: false });
        }
      }}
    >
      {binding.hint}
    </ActionKey>
  );
}

/**
 * The bracket-button form of a binding its owner holds (a confirm line's `y apply`): the same visibility and
 * disabled rules as `BindingActionKey`, and a click runs the binding exactly as its key does, never a second code path.
 */
export function BindingButton({
  binding,
  variant,
  label,
}: {
  binding: Binding;
  variant?: TButtonProps["variant"];
  /** The text after the key cap; defaults to the binding's hint. */
  label?: ReactNode;
}) {
  const platform = usePlatform();
  const keymap = useKeymapContext()?.keymap;
  const { active, disabledReason } = evaluateWhen(binding);
  if (!binding.hint || (!active && disabledReason === null)) return null;
  return (
    <TButton
      keys={formatKeys(binding.keys, platform)}
      shortcut={ariaKeyShortcuts(binding.keys, platform)}
      variant={variant}
      disabled={disabledReason ?? false}
      onClick={() => {
        // Echoed like its key, the same as a status-bar hint.
        const chord = parseKeys(binding.keys)[0];
        if (invokeBinding(binding) && chord) {
          keymap?.emitRun({ binding, chord, source: "click", editable: false, repeat: false });
        }
      }}
    >
      {label ?? binding.hint}
    </TButton>
  );
}
