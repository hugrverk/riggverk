import { formatChord, type Platform } from "./keymap";
import type { BindingRun } from "./registry";

/** What the status bar shows for a handled key: key-cap tokens and the binding's hint. */
export interface EchoKey {
  keys: string[];
  label: string;
}

/** Their effect is the mode badge (COMMAND, HELP); echoing them as well would say it twice. */
const SILENT_IDS = new Set(["shell.command", "shell.help"]);

/** Cursor and section movement: a stream of these is not an action worth echoing. Hint clicks are still echoed. */
const MOVEMENT_KEYS = new Set([
  "j", "k", "h", "l", "g", "G", "[", "]", "<", ">", "Tab",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
]);

/**
 * The echo for a binding that ran, or null. Only bindings with a hint echo (those are the named actions: `u update`,
 * `y apply`), never while a text field has focus or a key auto-repeats, and key presses of movement keys do not.
 * Digit tab switches and Escape carry no hint, so they stay silent without a rule of their own.
 */
export function echoOf(run: BindingRun, platform: Platform): EchoKey | null {
  const { binding, chord } = run;
  if (!binding.hint || SILENT_IDS.has(binding.id) || run.editable || run.repeat) return null;
  if (run.source === "key" && chord.some(step => MOVEMENT_KEYS.has(step.key))) return null;
  return { keys: formatChord(chord, platform), label: binding.hint };
}
