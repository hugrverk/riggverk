import { useKeymapContext, usePlatform } from "../keyboard/context";
import { ariaKeyShortcuts, formatKeys, parseKeys } from "../keyboard/keymap";
import { evaluateWhen, type Binding, type RegisteredBinding } from "../keyboard/registry";
import { ActionKey } from "./ActionKey";

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
