import type { ActionResult } from "../../components/TerminalOutput";
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

  if (!activeDoc) return null;

  return (
    <div className="lib-docs-pane">
      <header className="lib-docs-header">
        <div className="lib-docs-header-main">
          <h1 className="lib-docs-title">{activeDoc.title}</h1>
          <p className="lib-docs-pathline">
            <span className="lib-docs-section">{activeDoc.section}</span>
            <span className="lib-docs-path-sep" aria-hidden="true">·</span>
            <span className="lib-docs-path">{activeDoc.path}</span>
            {activeDoc.source === "custom" && (
              <span className="lib-docs-context-tag">context</span>
            )}
          </p>
        </div>
        <div className="lib-docs-header-actions">
          {docDirty && (
            <span className="lib-docs-modified" aria-label="Unsaved changes">
              modified
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm lib-docs-open-btn"
            onClick={() => onOpenDoc(activeDoc.id)}
          >
            open
          </button>
        </div>
      </header>

      <div className="lib-docs-mode-tabs" role="group" aria-label="Doc view mode">
        <button
          type="button"
          className={`btn btn-sm lib-docs-mode-tab${docMode === "preview" ? " btn-active" : ""}`}
          onClick={() => onSetDocMode("preview")}
          aria-pressed={docMode === "preview"}
        >
          preview
        </button>
        <button
          type="button"
          className={`btn btn-sm lib-docs-mode-tab${docMode === "edit" ? " btn-active" : ""}`}
          onClick={() => onSetDocMode("edit")}
          aria-pressed={docMode === "edit"}
        >
          edit
        </button>
      </div>

      <div className="lib-docs-content">
        {docMode === "preview" ? (
          <div className="lib-docs-preview-scroll">
            <SafeMarkdown content={activeDoc.content} className="lib-docs-markdown markdown-body" />
          </div>
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
    </div>
  );
}
