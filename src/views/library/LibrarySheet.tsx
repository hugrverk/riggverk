import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { usePlatform } from "../../keyboard/context";
import { formatKeys } from "../../keyboard/keymap";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import type { InstallAgent } from "../../types";
import { Kv } from "../../ui/Kv";
import { TButton } from "../../ui/TButton";
import { DocContent } from "./DocContent";
import type { LibraryEntry } from "./entry";
import { RulesEditor, type RulesMode } from "./RulesEditor";

interface LibrarySheetProps {
  /** Shown in the header while the item loads. */
  title: string;
  entry: LibraryEntry | null;
  /** Why the item could not be read; shown while there is no entry. */
  loadError?: string | null;
  sheetRef: RefObject<HTMLDivElement | null>;
  rulesMode: RulesMode;
  onRulesMode: (mode: RulesMode) => void;
  onRequestClose: () => void;
  /** Present only when the app can make a personal copy of a bundled skill. */
  onCopySkill?: (name: string) => void;
  onOpenHarness?: (harness: InstallAgent) => void;
}

const TAG_LABEL = { yours: "yours", riggverk: "riggverk", pack: "pack" } as const;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function ReadOnlyBody({ entry, onCopySkill }: { entry: LibraryEntry; onCopySkill?: (name: string) => void }) {
  const isJson = entry.preview === "json";
  const formatted = useMemo(() => (isJson ? formatJson(entry.draft) : ""), [isJson, entry.draft]);
  return (
    <>
      {entry.readOnlyReason && <p className="lib-ro">{entry.readOnlyReason}</p>}
      {entry.copySkill && onCopySkill && (
        <div className="lib-copy-row">
          <TButton keys={[]} onClick={() => onCopySkill(entry.copySkill!)}>Edit as my copy</TButton>
          <span className="lib-dim">
            Creates your own skill in a pack; the {entry.copySkill.startsWith("pack:imported/") ? "imported" : "bundled"} one stays active.
          </span>
        </div>
      )}
      {entry.meta.length > 0 && (
        <div className="lib-meta" role="region" aria-label={entry.metaTitle ?? "Metadata"}>
          {entry.metaTitle && <p className="lib-label">{entry.metaTitle}</p>}
          <Kv items={entry.meta} />
        </div>
      )}
      {isJson ? <pre className="lib-pre">{formatted}</pre> : <DocContent content={entry.draft} />}
    </>
  );
}

function SheetFooter({ entry }: { entry: LibraryEntry }) {
  const platform = usePlatform();
  const failed = entry.saveResult && !entry.saveResult.success ? redactTerminalOutput(entry.saveResult.stderr) || "save failed" : null;
  const saveDisabled = entry.saving ? "saving…" : entry.dirty ? false : "no changes to save";
  return (
    <footer className="lib-sheet-foot">
      <div className="lib-foot-left">
        {entry.dirty ? <span className="lib-flag">Unsaved changes</span> : <span className="lib-dim">Saved</span>}
        {entry.rules && <span className="lib-dim">Backed up before saving</span>}
        {entry.footNote && <span className="lib-dim">{entry.footNote}</span>}
        {failed && (
          <span className="lib-fail" role="alert">
            {failed}
          </span>
        )}
      </div>
      <div className="lib-foot-right">
        <TButton keys={[]} onClick={entry.onReset} disabled={entry.dirty ? false : "no unsaved changes"}>
          Discard
        </TButton>
        <TButton
          keys={formatKeys("Mod+s", platform)}
          shortcut="Control+S Meta+S"
          variant="primary"
          onClick={() => void entry.onSave()}
          disabled={saveDisabled}
        >
          Save
        </TButton>
      </div>
    </footer>
  );
}

/**
 * The item open over the Library: a modal sheet that drops from the top of the content, under the toolbar. Its owner
 * guards closing (backdrop, Close, Escape) against unsaved changes and keeps the content behind it inert; this
 * sheet moves focus in, keeps Tab inside it and renders the item: the rendered text of a read-only item, the
 * textarea and footer of an editable one, the modes of a rules file.
 */
export function LibrarySheet({
  title,
  entry,
  loadError = null,
  sheetRef,
  rulesMode,
  onRulesMode,
  onRequestClose,
  onCopySkill,
  onOpenHarness,
}: LibrarySheetProps) {
  const headingId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const editable = entry !== null && !entry.readOnly;

  // Focus moves in: an editable item's textarea took it already (autoFocus); otherwise the scrolling body, so the
  // arrow keys read the item; until it loads, the sheet itself.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || sheet.contains(document.activeElement)) return;
    (bodyRef.current ?? sheet).focus();
  }, [entry?.id, sheetRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const stops = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.closest("[hidden]") === null);
    if (stops.length === 0) {
      event.preventDefault();
      return;
    }
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === sheet)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div className="lib-sheet-back" aria-hidden="true" onClick={onRequestClose} />
      <div
        ref={sheetRef}
        className="lib-sheet"
        role="dialog"
        aria-modal="true"
        data-keyscope="overlay"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="lib-sheet-head">
          <div className="lib-sheet-title">
            <h2 id={headingId}>{entry?.title ?? title}</h2>
            {entry?.path && <span className="lib-path">{entry.path}</span>}
          </div>
          {entry && <span className={`lib-tag${entry.tag === "yours" ? " is-yours" : ""}`}>{TAG_LABEL[entry.tag]}</span>}
          {entry?.onOpen && (
            <button type="button" className="lib-quiet" onClick={entry.onOpen}>
              Open in editor
            </button>
          )}
          <button type="button" className="lib-quiet" onClick={onRequestClose}>
            Close
          </button>
        </header>
        <div className="lib-sheet-body" ref={bodyRef} tabIndex={editable ? undefined : 0} role={editable ? undefined : "region"} aria-label={editable ? undefined : "Content"}>
          {entry === null ? (
            loadError ? (
              <p className="lib-fail" role="alert">{redactTerminalOutput(loadError)}</p>
            ) : (
              <p className="lib-dim" role="status">Loading…</p>
            )
          ) : entry.rules ? (
            <RulesEditor entry={entry as LibraryEntry & { rules: NonNullable<LibraryEntry["rules"]> }} mode={rulesMode} onMode={onRulesMode} onOpenHarness={onOpenHarness} />
          ) : entry.readOnly ? (
            <ReadOnlyBody entry={entry} onCopySkill={onCopySkill} />
          ) : (
            <textarea
              key={entry.id}
              className="lib-textarea"
              value={entry.draft}
              onChange={event => entry.onChange(event.target.value)}
              spellCheck={false}
              aria-label={entry.editorLabel}
              autoFocus
            />
          )}
        </div>
        {editable && entry && <SheetFooter entry={entry} />}
      </div>
    </>
  );
}
