import { useState } from "react";
import { Markdown } from "../components/Markdown";
import type { ActionResult } from "../components/TerminalOutput";
import type { DocumentContent, DocSummary } from "../types";

interface DocGroup {
  section: string;
  docs: DocSummary[];
}

function groupDocs(docs: DocSummary[]): DocGroup[] {
  const groups: DocGroup[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    if (!seen.has(d.section)) {
      seen.add(d.section);
      groups.push({ section: d.section, docs: [] });
    }
    groups[groups.length - 1].docs.push(d);
  }
  return groups;
}

interface DocsViewProps {
  docs: DocSummary[];
  activeDoc: DocumentContent | null;
  workspaceValid: boolean;
  onSelectDoc: (id: string) => void;
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

export function DocsView({
  docs,
  activeDoc,
  workspaceValid,
  onSelectDoc,
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
}: DocsViewProps) {
  const [search, setSearch] = useState("");

  if (docs.length === 0) {
    return (
      <section className="terminal terminal-view">
        <div className="terminal-topline">
          <span className="terminal-title">DOCS</span>
          <span className="terminal-host">curated + context workspace docs</span>
        </div>
        <div className="docs-command-strip">
          <span className="docs-summary">0 docs</span>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => onSetShowCreateDoc(!showCreateDoc)}
            disabled={!workspaceValid}
            aria-label="New context doc"
          >
            + new
          </button>
        </div>
        {showCreateDoc && (
          <div className="docs-create-form">
            <label className="docs-create-label">
              <span>Title</span>
              <input
                className="docs-create-input"
                type="text"
                placeholder="My Context Notes"
                value={createDocTitle}
                onChange={e => onSetCreateDocTitle(e.target.value)}
                aria-label="New doc title"
              />
            </label>
            <label className="docs-create-label">
              <span>Slug</span>
              <input
                className="docs-create-input"
                type="text"
                placeholder="my-context-notes"
                value={createDocSlug}
                onChange={e => onSetCreateDocSlug(e.target.value)}
                aria-label="New doc slug"
              />
            </label>
            <div className="docs-create-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={onCreateDoc}
                disabled={createDocCreating || !createDocTitle.trim() || !createDocSlug.trim()}
              >
                {createDocCreating ? "creating..." : "create"}
              </button>
              <button className="btn btn-sm" onClick={() => { onSetShowCreateDoc(false); }}>cancel</button>
              <span className="docs-create-hint">docs/context/</span>
            </div>
            {createDocError && (
              <div className="docs-create-error">{createDocError}</div>
            )}
          </div>
        )}
        <div className="docs-cockpit">
          <div className="docs-nav">
            <div className="docs-nav-empty">
              {workspaceValid ? "No workspace docs found" : "No valid workspace selected. Create or choose a workspace in Workspace."}
            </div>
          </div>
          <div className="docs-preview" />
        </div>
      </section>
    );
  }

  const q = search.toLowerCase().trim();
  const filtered = q
    ? docs.filter(d =>
        d.title.toLowerCase().includes(q) ||
        d.id.toLowerCase().includes(q) ||
        d.path.toLowerCase().includes(q) ||
        d.section.toLowerCase().includes(q)
      )
    : docs;

  const groups = groupDocs(filtered);
  const activeSection = activeDoc ? activeDoc.section : null;
  const customCount = docs.filter(d => d.source === "custom").length;

  return (
    <section className="terminal terminal-view">
      <div className="terminal-topline">
        <span className="terminal-title">DOCS</span>
        <span className="terminal-host">curated + context workspace docs</span>
      </div>

      <div className="docs-command-strip">
        <input
          className="docs-search"
          type="text"
          placeholder="search title, id, path, section..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search docs"
        />
        {search && (
          <button className="btn btn-sm" onClick={() => setSearch("")}>x</button>
        )}
        <span className="docs-summary">
          {filtered.length}/{docs.length} docs
          {activeSection ? ` \u00b7 ${activeSection}` : " \u00b7 all sections"}
          {customCount > 0 ? ` \u00b7 ${customCount} context` : ""}
        </span>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => onSetShowCreateDoc(!showCreateDoc)}
          disabled={!workspaceValid}
          aria-label="New context doc"
        >
          + new
        </button>
      </div>

      {showCreateDoc && (
        <div className="docs-create-form">
          <label className="docs-create-label">
            <span>Title</span>
            <input
              className="docs-create-input"
              type="text"
              placeholder="My Context Notes"
              value={createDocTitle}
              onChange={e => onSetCreateDocTitle(e.target.value)}
              aria-label="New doc title"
            />
          </label>
          <label className="docs-create-label">
            <span>Slug</span>
            <input
              className="docs-create-input"
              type="text"
              placeholder="my-context-notes"
              value={createDocSlug}
              onChange={e => onSetCreateDocSlug(e.target.value)}
              aria-label="New doc slug"
            />
          </label>
          <div className="docs-create-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={onCreateDoc}
              disabled={createDocCreating || !createDocTitle.trim() || !createDocSlug.trim()}
            >
              {createDocCreating ? "creating..." : "create"}
            </button>
            <button className="btn btn-sm" onClick={() => { onSetShowCreateDoc(false); }}>cancel</button>
            <span className="docs-create-hint">docs/context/</span>
          </div>
          {createDocError && (
            <div className="docs-create-error">{createDocError}</div>
          )}
        </div>
      )}

      <div className="docs-cockpit">
        <div className="docs-nav">
          {groups.length === 0 ? (
            <div className="docs-nav-empty">No docs match the current search</div>
          ) : (
            groups.map((group) => (
              <div key={group.section}>
                <div className="docs-section-title">{group.section}</div>
                {group.docs.map((d) => (
                  <button
                    key={d.id}
                    className={`docs-row-button ${activeDoc?.id === d.id ? "docs-row-active" : ""}`}
                    onClick={() => onSelectDoc(d.id)}
                    aria-current={activeDoc?.id === d.id ? "true" : undefined}
                  >
                    <span className="docs-row-title">{d.title}</span>
                    {d.source === "custom" && <span className="docs-row-source">context</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="docs-editor">
          {activeDoc ? (
            <>
              <div className="docs-editor-header">
                <div className="docs-editor-header-left">
                  <span className="docs-preview-title">{activeDoc.title}</span>
                  <span className="docs-preview-meta">
                    {activeDoc.section} &middot; {activeDoc.path}
                    {activeDoc.source === "custom" && (
                      <span className="docs-source-tag">context</span>
                    )}
                  </span>
                </div>
                <div className="docs-editor-header-right">
                  {docDirty && (
                    <span className="docs-dirty-indicator" aria-label="Unsaved changes">modified</span>
                  )}
                  <button className="btn btn-sm" onClick={() => onOpenDoc(activeDoc.id)}>open</button>
                </div>
              </div>

              <div className="docs-mode-tabs" role="tablist" aria-label="Doc view mode">
                <button
                  className={`btn btn-sm ${docMode === "preview" ? "btn-active" : ""}`}
                  onClick={() => onSetDocMode("preview")}
                  role="tab"
                  aria-selected={docMode === "preview"}
                >
                  preview
                </button>
                <button
                  className={`btn btn-sm ${docMode === "edit" ? "btn-active" : ""}`}
                  onClick={() => onSetDocMode("edit")}
                  role="tab"
                  aria-selected={docMode === "edit"}
                >
                  edit
                </button>
              </div>

              <div className="docs-editor-body">
                {docMode === "preview" ? (
                  <div className="docs-preview-body"><Markdown content={activeDoc.content} /></div>
                ) : (
                  <textarea
                    className="docs-textarea"
                    value={docDraft}
                    onChange={e => onChangeDocDraft(e.target.value)}
                    spellCheck={false}
                    aria-label="Edit document"
                  />
                )}
              </div>

              {docMode === "edit" && (
                <div className="docs-save-row">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={onSaveDoc}
                    disabled={docSaving || !docDirty}
                  >
                    {docSaving ? "saving..." : "save"}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={onResetDoc}
                    disabled={docSaving || !docDirty}
                  >
                    reset
                  </button>
                  {docSaveResult && (
                    <span className={`docs-save-status ${docSaveResult.success ? "docs-save-ok" : "docs-save-fail"}`}>
                      {docSaveResult.success
                        ? docSaveResult.stdout
                        : docSaveResult.stderr || "save failed"}
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="docs-preview-empty">Select a doc to preview</div>
          )}
        </div>
      </div>
    </section>
  );
}
