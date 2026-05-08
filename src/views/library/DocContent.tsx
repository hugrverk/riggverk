import type { ActionResult } from "../../components/TerminalOutput";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import type { DocumentContent } from "../../types";
import { Markdown } from "../../components/Markdown";

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
    <>
      <div className="lib-editor-meta-strip">
        <div className="lib-editor-meta-left">
          <span className="lib-editor-meta-title">{activeDoc.title}</span>
          <span className="lib-editor-meta-path">
            {activeDoc.section} &middot; {activeDoc.path}
            {activeDoc.source === "custom" && (
              <span className="docs-source-tag">context</span>
            )}
          </span>
        </div>
        <div className="lib-editor-meta-right">
          {docDirty && <span className="editor-dirty" aria-label="Unsaved changes">modified</span>}
          <button className="btn btn-sm" onClick={() => onOpenDoc(activeDoc.id)}>open</button>
        </div>
      </div>
      <div className="editor-mode-tabs" role="tablist" aria-label="Doc view mode">
        <button className={`btn btn-sm ${docMode === "preview" ? "btn-active" : ""}`} onClick={() => onSetDocMode("preview")} role="tab" aria-selected={docMode === "preview"}>preview</button>
        <button className={`btn btn-sm ${docMode === "edit" ? "btn-active" : ""}`} onClick={() => onSetDocMode("edit")} role="tab" aria-selected={docMode === "edit"}>edit</button>
      </div>
      <div className="lib-editor-body">
        {docMode === "preview" ? (
          <div className="lib-preview-body"><Markdown content={activeDoc.content} /></div>
        ) : (
          <textarea
            className="editor-textarea"
            value={docDraft}
            onChange={(e) => onChangeDocDraft(e.target.value)}
            spellCheck={false}
            aria-label="Edit document"
          />
        )}
      </div>
      {docMode === "edit" && (
        <div className="editor-save-row">
          <button className="btn btn-primary btn-sm" onClick={onSaveDoc} disabled={docSaving || !docDirty}>
            {docSaving ? "saving..." : "save"}
          </button>
          <button className="btn btn-sm" onClick={onResetDoc} disabled={docSaving || !docDirty}>reset</button>
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
        <div className="docs-create-form">
          <label className="docs-create-label">
            <span>Title</span>
            <input className="docs-create-input" type="text" placeholder="My Context Notes" value={createDocTitle} onChange={(e) => onSetCreateDocTitle(e.target.value)} aria-label="New doc title" />
          </label>
          <label className="docs-create-label">
            <span>Slug</span>
            <input className="docs-create-input" type="text" placeholder="my-context-notes" value={createDocSlug} onChange={(e) => onSetCreateDocSlug(e.target.value)} aria-label="New doc slug" />
          </label>
          <div className="docs-create-actions">
            <button className="btn btn-primary btn-sm" onClick={onCreateDoc} disabled={createDocCreating || !createDocTitle.trim() || !createDocSlug.trim()}>
              {createDocCreating ? "creating..." : "create"}
            </button>
            <button className="btn btn-sm" onClick={() => { onSetShowCreateDoc(false); }}>cancel</button>
            <span className="docs-create-hint">docs/context/</span>
          </div>
          {createDocError && <div className="docs-create-error">{createDocError}</div>}
        </div>
      )}
    </>
  );
}
