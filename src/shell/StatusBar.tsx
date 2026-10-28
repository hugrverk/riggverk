import { useKeymapEntries, useKeymapState } from "../keyboard/context";
import { isVisibleHint, paneHintEntries, type RegisteredBinding } from "../keyboard/registry";
import { BindingActionKey } from "../ui/BindingActionKey";
import { Kbd } from "../ui/Kbd";
import { useShellMode, useShellState } from "./ShellState";

/** Hints that stay visible however narrow the bar gets: how to reach everything else. */
const ALWAYS_VISIBLE_HINT_IDS = new Set(["shell.command", "shell.help"]);

export interface StatusBarProps {
  /** Current view, shown as the first context segment. */
  viewLabel: string;
}

/**
 * Slim bottom bar that stays until every action has a button (S9 removes it): the view and its context, the
 * pending chord, and hints for the focused pane plus the global actions. Hinted bindings render as clickable
 * ActionKeys; the positional hints (pane and row movement) are plain text because they are not single actions.
 * Notices live in the `Toast`, the digit hints in the sidebar. The derived mode (NORMAL / INSERT / COMMAND /
 * CONFIRM / HELP) is kept for assistive technology and tests but not drawn. When the bar is too narrow the hints
 * drop from the end, a whole hint at a time; `:` command and `?` help sit in their own group and always stay.
 */
export function StatusBar({ viewLabel }: StatusBarProps) {
  const mode = useShellMode();
  const { statusContext } = useShellState();
  const { pendingChord, activePaneId, inList } = useKeymapState();
  const entries = useKeymapEntries();

  const typing = mode === "INSERT";
  // Bindings that cannot fire while a text field has focus are not offered as hints there.
  const offered = (entry: RegisteredBinding) => isVisibleHint(entry) && (!typing || entry.binding.inEditable === true);
  const paneHints = activePaneId ? paneHintEntries(entries, activePaneId).filter(offered) : [];
  const globalHints = entries.filter(entry => entry.binding.scope === "global" && !entry.binding.paneId).filter(offered);
  const alwaysHints = globalHints.filter(entry => ALWAYS_VISIBLE_HINT_IDS.has(entry.binding.id));
  const otherGlobalHints = globalHints.filter(entry => !ALWAYS_VISIBLE_HINT_IDS.has(entry.binding.id));
  const view = viewLabel.toLowerCase();
  const context = statusContext ? `${view} › ${statusContext}` : view;

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className="mode visually-hidden" data-mode={mode.toLowerCase()}>
        {mode}
      </span>
      <span className="ctx">{context}</span>
      {pendingChord.length > 0 && (
        <span className="chord" aria-label="Pending keys">
          {pendingChord.join(" ")}
        </span>
      )}
      <div className="hints">
        {mode === "NORMAL" && (
          <>
            <span>
              <Kbd>h</Kbd>
              <Kbd>l</Kbd> pane
            </span>
            {inList && (
              <span>
                <Kbd>j</Kbd>
                <Kbd>k</Kbd> move
              </span>
            )}
          </>
        )}
        {mode === "INSERT" && (
          <span>
            <Kbd>esc</Kbd> leave field
          </span>
        )}
        {mode === "COMMAND" && (
          <>
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> select
            </span>
            <span>
              <Kbd>tab</Kbd> complete
            </span>
            <span>
              <Kbd>↵</Kbd> run
            </span>
            <span>
              <Kbd>esc</Kbd> close
            </span>
          </>
        )}
        {mode === "HELP" && (
          <span>
            <Kbd>esc</Kbd> close
          </span>
        )}
        {mode !== "COMMAND" && mode !== "HELP" && (
          <>
            {paneHints.map(entry => (
              <BindingActionKey key={entry.binding.id} entry={entry} />
            ))}
            {otherGlobalHints.map(entry => (
              <BindingActionKey key={entry.binding.id} entry={entry} />
            ))}
          </>
        )}
      </div>
      {mode !== "COMMAND" && mode !== "HELP" && alwaysHints.length > 0 && (
        <div className="hints-keep">
          {alwaysHints.map(entry => (
            <BindingActionKey key={entry.binding.id} entry={entry} />
          ))}
        </div>
      )}
    </footer>
  );
}
