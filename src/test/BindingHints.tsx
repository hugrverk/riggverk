import { useKeymapEntries, useKeymapState, usePlatform } from "../keyboard/context";
import { formatKeys } from "../keyboard/keymap";
import { evaluateWhen, isVisibleHint, paneHintEntries, type RegisteredBinding } from "../keyboard/registry";
import { useShellMode } from "../shell/ShellState";
import { invokeBinding } from "../ui/BindingButton";

/**
 * Test-only probe of the keymap: one button per hinted binding that is on offer right now (the focused pane's
 * bindings plus the global ones), with the disabled reason as its title and `aria-disabled` while `when()` holds it.
 * The app has no such surface; its pages offer their own buttons. This lets a test ask "is `m` offered, and why is it
 * held" without knowing which page control carries the binding. A click runs the binding as its key does.
 * It also reports the shell's derived mode (NORMAL, INSERT, COMMAND, CONFIRM, HELP) as an `output`, so a test can
 * check that a confirm or review registered itself and released the keyboard again.
 */
export function BindingHints() {
  const platform = usePlatform();
  const mode = useShellMode();
  const { activePaneId, editing } = useKeymapState();
  const entries = useKeymapEntries();
  // Bindings that cannot fire while a text field has focus are not on offer there.
  const offered = (entry: RegisteredBinding) => isVisibleHint(entry) && (!editing || entry.binding.inEditable === true);
  const paneHints = activePaneId ? paneHintEntries(entries, activePaneId).filter(offered) : [];
  const globalHints = entries.filter(entry => entry.binding.scope === "global" && !entry.binding.paneId).filter(offered);
  return (
    <footer aria-label="Key hints">
      <output aria-label="Shell mode">{mode}</output>
      {[...paneHints, ...globalHints].map(({ binding }) => {
        const { disabledReason } = evaluateWhen(binding);
        return (
          <button
            key={binding.id}
            type="button"
            aria-disabled={disabledReason !== null || undefined}
            title={disabledReason ?? undefined}
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              if (disabledReason === null) invokeBinding(binding);
            }}
          >
            {formatKeys(binding.keys, platform).join(" ")} {binding.hint}
          </button>
        );
      })}
    </footer>
  );
}
