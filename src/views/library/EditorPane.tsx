import type { ReactNode, RefObject } from "react";
import { CopyButton } from "../../components/CopyButton";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import { ActionKey } from "../../ui/ActionKey";
import { Pane } from "../../ui/Pane";
import type { LibraryEntry } from "./entry";

interface EditorPaneProps {
  entry: LibraryEntry | null;
  /** Shown instead of the editor while no item is open. */
  emptyHint: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Rendered above the textarea (the new-doc form). */
  top?: ReactNode;
  onClose: () => void | Promise<void>;
}

function saveStatus(entry: LibraryEntry): { text: string; ok: boolean } | null {
  if (entry.saving) return { text: "saving...", ok: true };
  const result = entry.saveResult;
  if (result) {
    return result.success
      ? { text: redactTerminalOutput(result.stdout), ok: true }
      : { text: redactTerminalOutput(result.stderr) || "save failed", ok: false };
  }
  if (entry.saveMessage) return { text: entry.saveMessage, ok: true };
  return null;
}

/**
 * Pane [2]: the working copy as a plain textarea. The pane itself is the NORMAL-mode target (`l` from the
 * list lands on it without typing anything); Enter or `i` moves into the textarea (INSERT) and Escape returns
 * to the list.
 */
export function EditorPane({ entry, emptyHint, textareaRef, top, onClose }: EditorPaneProps) {
  const status = entry ? saveStatus(entry) : null;
  return (
    <Pane
      id="editor"
      label="Editor"
      title={entry ? entry.title : "editor"}
      meta={
        entry ? (
          <>
            · {entry.path}
            {entry.dirty && (
              <>
                {" · "}
                <span className="c-warn" title="Unsaved changes">modified</span>
              </>
            )}
            {entry.readOnly && (
              <>
                {" · "}
                <span className="c-dim">read-only</span>
              </>
            )}
          </>
        ) : undefined
      }
      bodyClassName="lib-fill"
      footer={
        entry ? (
          <>
            {/* `:q` and `:reset` are command-line commands, not key bindings, so the status bar cannot offer them. */}
            <ActionKey keys={[":q"]} onClick={() => void onClose()}>close</ActionKey>
            {!entry.readOnly && (
              <ActionKey keys={[":reset"]} onClick={entry.onReset} disabled={entry.dirty ? false : "no unsaved changes"}>
                discard
              </ActionKey>
            )}
            {entry.copyPath && (
              <CopyButton
                className="lib-copy-path"
                getText={() => entry.copyPath}
                copyLabel="Copy path"
                copiedLabel="Path copied"
              />
            )}
            {entry.readOnly && entry.readOnlyReason && <span className="c-dim">{entry.readOnlyReason}</span>}
            {!entry.readOnly && entry.note && <span className="c-dim">{entry.note}</span>}
            {status && (
              <span className={status.ok ? "c-ok" : "c-fail"} role="status">
                {status.text}
              </span>
            )}
          </>
        ) : undefined
      }
    >
      <div className="lib-editor" data-pane-primary="" tabIndex={-1}>
        {top}
        {entry ? (
          <textarea
            key={entry.id}
            ref={textareaRef}
            className="lib-textarea"
            value={entry.draft}
            readOnly={entry.readOnly}
            onChange={(e) => entry.onChange(e.target.value)}
            spellCheck={false}
            aria-label={entry.editorLabel}
          />
        ) : (
          <p className="c-dim" role="status">
            <span aria-hidden="true">$ </span>
            {emptyHint}
          </p>
        )}
      </div>
    </Pane>
  );
}
