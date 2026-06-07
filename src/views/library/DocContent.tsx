import { CopyButton } from "../../components/CopyButton";
import type { ActionResult } from "../../components/TerminalOutput";
import { displayPath } from "../../lib/displayPath";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import type { DocumentContent } from "../../types";
import { SafeMarkdown } from "../../components/SafeMarkdown";

interface DocContentProps {
  activeDoc: DocumentContent | null;
  onOpenDoc: (id: string) => void;
  docDraft: string;
  docDirty: boolean;
  docSaving: boolean;
  docSaveResult: ActionResult | null;
  docMode: "preview" | "edit";
  onSetDocMode: (mode: "preview" | "edit") => void;
  onChangeDocDraft: (value: string) => void;
  onSaveDoc: () => void;
  onResetDoc: () => void;
  showCreateDoc: boolean;
  createDocTitle: string;
  createDocSlug: string;
  createDocError: string | null;
  createDocCreating: boolean;
  onSetShowCreateDoc: (show: boolean) => void;
  onSetCreateDocTitle: (value: string) => void;
  onSetCreateDocSlug: (value: string) => void;
  onCreateDoc: () => void;
}

function PreviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function DocContent(props: DocContentProps) {
  const {
    activeDoc,
    onOpenDoc,
    docDraft,
    docDirty,
    docSaving,
    docSaveResult,
    docMode,
    onSetDocMode,
    onChangeDocDraft,
    onSaveDoc,
    onResetDoc,
    showCreateDoc,
    createDocTitle,
    createDocSlug,
    createDocError,
    createDocCreating,
    onSetShowCreateDoc,
    onSetCreateDocTitle,
    onSetCreateDocSlug,
    onCreateDoc,
  } = props;

  return (
    <section className="lib-docs-reader-pane" aria-label="Document reader">
      {!activeDoc ? (
        <p className="text-muted small" role="status">
          Select a document from the list.
        </p>
      ) : (
        <>
          <header className="lib-docs-reader-head">
            <div className="lib-docs-reader-head-main">
              <h3 className="lib-docs-reader-title">{activeDoc.title}</h3>
              <p
                className="lib-docs-reader-path font-mono text-muted"
                title={displayPath(activeDoc.path)}
              >
                {displayPath(activeDoc.path)}
              </p>
            </div>
            <div className="lib-docs-reader-actions">
              {docDirty && (
                <span className="lib-docs-modified-dot" aria-label="Unsaved changes" title="Unsaved changes" />
              )}
              <div className="lib-docs-icon-group" role="group" aria-label="Doc view mode">
                <button
                  type="button"
                  className={`lib-docs-icon-btn${docMode === "preview" ? " lib-docs-icon-btn-active" : ""}`}
                  onClick={() => onSetDocMode("preview")}
                  aria-pressed={docMode === "preview"}
                  aria-label="Preview"
                  title="Preview"
                >
                  <PreviewIcon />
                </button>
                <button
                  type="button"
                  className={`lib-docs-icon-btn${docMode === "edit" ? " lib-docs-icon-btn-active" : ""}`}
                  onClick={() => onSetDocMode("edit")}
                  aria-pressed={docMode === "edit"}
                  aria-label="Edit"
                  title="Edit"
                >
                  <EditIcon />
                </button>
              </div>
              <CopyButton
                className="lib-docs-icon-btn"
                getText={() => displayPath(activeDoc.path)}
                copyLabel="Copy path"
                copiedLabel="Path copied"
              />
              <button
                type="button"
                className="lib-docs-icon-btn"
                onClick={() => onOpenDoc(activeDoc.id)}
                aria-label="Open"
                title="Open"
              >
                <OpenIcon />
              </button>
            </div>
          </header>

          <div
            className="lib-docs-reader-scroll"
            role="region"
            aria-label="Document content"
            tabIndex={0}
          >
            {docMode === "preview" ? (
              <SafeMarkdown content={activeDoc.content} className="lib-docs-markdown markdown-body" />
            ) : (
              <textarea
                className="lib-docs-editor editor-textarea"
                value={docDraft}
                onChange={(e) => onChangeDocDraft(e.target.value)}
                spellCheck={false}
                aria-label="Edit document"
              />
            )}
          </div>

          {docMode === "edit" && (
            <div className="lib-docs-save-row editor-save-row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onSaveDoc}
                disabled={docSaving || !docDirty}
              >
                {docSaving ? "saving..." : "save"}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={onResetDoc}
                disabled={docSaving || !docDirty}
              >
                reset
              </button>
              {docSaveResult && (
                <span className={`editor-save-status ${docSaveResult.success ? "editor-save-ok" : "editor-save-fail"}`}>
                  {docSaveResult.success
                    ? redactTerminalOutput(docSaveResult.stdout)
                    : redactTerminalOutput(docSaveResult.stderr) || "save failed"}
                </span>
              )}
            </div>
          )}
        </>
      )}

      {showCreateDoc && (
        <form
          className="lib-docs-create-form docs-create-form"
          onSubmit={(e) => {
            e.preventDefault();
            onCreateDoc();
          }}
        >
          <label className="lib-docs-create-label docs-create-label">
            <span>Title</span>
            <input
              className="docs-create-input"
              type="text"
              placeholder="My Context Notes"
              value={createDocTitle}
              onChange={(e) => onSetCreateDocTitle(e.target.value)}
              aria-label="New doc title"
            />
          </label>
          <label className="lib-docs-create-label docs-create-label">
            <span>Slug</span>
            <input
              className="docs-create-input"
              type="text"
              placeholder="my-context-notes"
              value={createDocSlug}
              onChange={(e) => onSetCreateDocSlug(e.target.value)}
              aria-label="New doc slug"
            />
          </label>
          <div className="lib-docs-create-actions docs-create-actions">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={createDocCreating || !createDocTitle.trim() || !createDocSlug.trim()}
            >
              {createDocCreating ? "creating..." : "create"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onSetShowCreateDoc(false)}
            >
              cancel
            </button>
            <span className="docs-create-hint">docs/context/</span>
          </div>
          {createDocError && <div className="docs-create-error">{createDocError}</div>}
        </form>
      )}
    </section>
  );
}
