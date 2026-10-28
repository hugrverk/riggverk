import { useMemo, type ReactNode, type RefObject } from "react";
import { CopyableBlock } from "../../components/CopyableBlock";
import { CopyButton } from "../../components/CopyButton";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import { TButton } from "../../ui/TButton";
import { Kv } from "../../ui/Kv";
import { Pane } from "../../ui/Pane";
import { DocContent } from "./DocContent";
import type { LibraryEntry } from "./entry";

interface DocumentPaneProps {
  entry: LibraryEntry | null;
  /** Shown instead of the document while no item is open. */
  emptyHint: string;
  /** True while the pane shows the source textarea instead of the rendered document (editable items only). */
  editing: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Rendered above the document (the new-doc form). */
  top?: ReactNode;
  onClose: () => void | Promise<void>;
}

function saveStatus(entry: LibraryEntry): { text: string; ok: boolean } | null {
  if (entry.saving) return { text: "saving…", ok: true };
  const result = entry.saveResult;
  if (result) {
    return result.success
      ? { text: redactTerminalOutput(result.stdout), ok: true }
      : { text: redactTerminalOutput(result.stderr) || "save failed", ok: false };
  }
  if (entry.saveMessage) return { text: entry.saveMessage, ok: true };
  return null;
}

function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

/**
 * The working copy rendered (markdown, or pretty-printed JSON for configs) under the item's metadata, and under
 * the read-only text that precedes it in the same file when there is one (a rules file's managed block).
 */
function DocumentView({ entry }: { entry: LibraryEntry }) {
  const isJson = entry.preview === "json";
  const formatted = useMemo(() => (isJson ? formatJson(entry.draft) : ""), [isJson, entry.draft]);
  return (
    <>
      {entry.meta.length > 0 && (
        <div className="lib-meta" role="region" aria-label={entry.metaTitle ?? "Metadata"}>
          {entry.metaTitle && <p className="group">{entry.metaTitle}</p>}
          <Kv items={entry.meta} />
        </div>
      )}
      {entry.before && (
        <div className="lib-before" role="region" aria-label={entry.beforeLabel ?? "Read-only"}>
          {entry.beforeLabel && <p className="group">{entry.beforeLabel}</p>}
          <DocContent content={entry.before} />
        </div>
      )}
      {isJson ? (
        <CopyableBlock text={formatted} className="copyable-block-terminal copyable-block-fill">
          <pre className="configs-code">{formatted}</pre>
        </CopyableBlock>
      ) : (
        <DocContent content={entry.draft} />
      )}
    </>
  );
}

/**
 * The open item, one pane. It shows the working copy rendered, so unsaved edits are visible; the rendered body
 * is the pane's NORMAL-mode focus target (`l` from the list lands on it and scrolls it). Editable items switch
 * the same pane to a plain textarea (INSERT) while `editing`; read-only items never do.
 */
export function DocumentPane({ entry, emptyHint, editing, textareaRef, top, onClose }: DocumentPaneProps) {
  const status = entry ? saveStatus(entry) : null;
  const showTextarea = entry !== null && editing;
  return (
    <Pane
      id="editor"
      label="Document"
      className="pane-flat lib-doc"
      title={entry ? entry.title : "document"}
      meta={
        entry ? (
          <>
            · {entry.path}
            {entry.dirty && (
              <>
                {" · "}
                <span className="lib-flag" title="Unsaved changes">modified</span>
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
      scrollable={!showTextarea}
      bodyClassName={showTextarea ? "lib-fill" : undefined}
      footer={
        entry ? (
          <>
            {/* `:q` and `:reset` are command-line commands, not key bindings, so these buttons are their only mouse path. */}
            <TButton keys={[":q"]} onClick={() => void onClose()}>close</TButton>
            {!entry.readOnly && (
              <TButton keys={[":reset"]} onClick={entry.onReset} disabled={entry.dirty ? false : "no unsaved changes"}>
                discard
              </TButton>
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
            {entry.note && <span className="c-dim">{entry.note}</span>}
            {status && (
              <span className={status.ok ? "c-ok" : "c-fail"} role="status">
                {status.text}
              </span>
            )}
          </>
        ) : undefined
      }
    >
      {showTextarea ? (
        <div className="lib-editor" data-pane-primary="" tabIndex={-1}>
          {top}
          <textarea
            key={entry.id}
            ref={textareaRef}
            className="lib-textarea"
            value={entry.draft}
            onChange={(e) => entry.onChange(e.target.value)}
            spellCheck={false}
            aria-label={entry.editorLabel}
          />
        </div>
      ) : (
        <>
          {top}
          {entry ? (
            <DocumentView entry={entry} />
          ) : (
            <p className="c-dim" role="status">
              <span aria-hidden="true">$ </span>
              {emptyHint}
            </p>
          )}
        </>
      )}
    </Pane>
  );
}
