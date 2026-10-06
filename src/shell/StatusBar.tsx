import type { ReactNode } from "react";
import { useKeymapEntries, useKeymapState } from "../keyboard/context";
import { isVisibleHint, paneHintEntries, type RegisteredBinding } from "../keyboard/registry";
import { BindingActionKey } from "../ui/BindingActionKey";
import { Kbd } from "../ui/Kbd";
import { useShellMode, useShellState } from "./ShellState";

export interface StatusBarProps {
  /** Current view, shown as the first context segment. */
  viewLabel: string;
  /** Right-aligned text (backups, runtime availability, ...). */
  right?: ReactNode;
}

/**
 * Bottom bar: derived mode (NORMAL / INSERT / COMMAND / CONFIRM / HELP), context, the pending chord, and
 * hints for the focused pane plus the global actions. Hinted bindings render as clickable ActionKeys; the
 * positional hints (tab numbers, pane and row movement) are plain text because they are not single actions.
 */
export function StatusBar({ viewLabel, right }: StatusBarProps) {
  const mode = useShellMode();
  const { statusContext, notice } = useShellState();
  const { pendingChord, activePaneId, inList } = useKeymapState();
  const entries = useKeymapEntries();

  const typing = mode === "INSERT";
  // Bindings that cannot fire while a text field has focus are not offered as hints there.
  const offered = (entry: RegisteredBinding) => isVisibleHint(entry) && (!typing || entry.binding.inEditable === true);
  const paneHints = activePaneId ? paneHintEntries(entries, activePaneId).filter(offered) : [];
  const globalHints = entries.filter(entry => entry.binding.scope === "global" && !entry.binding.paneId).filter(offered);
  const context = statusContext ? `${viewLabel} › ${statusContext}` : viewLabel;

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className="mode" data-mode={mode.toLowerCase()}>
        {mode}
      </span>
      <span className="ctx" role="status">
        {notice ?? context}
      </span>
      {pendingChord.length > 0 && (
        <span className="chord" aria-label="Pending keys">
          {pendingChord.join(" ")}
        </span>
      )}
      <div className="hints">
        {mode === "NORMAL" && (
          <>
            <span>
              <Kbd>1</Kbd>–<Kbd>9</Kbd> tab
            </span>
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
            {globalHints.map(entry => (
              <BindingActionKey key={entry.binding.id} entry={entry} />
            ))}
          </>
        )}
      </div>
      <span className="rt">{right}</span>
    </footer>
  );
}
