import { useState } from "react";
import { Markdown } from "../components/Markdown";
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
}

export function DocsView({ docs, activeDoc, workspaceValid, onSelectDoc, onOpenDoc }: DocsViewProps) {
  const [search, setSearch] = useState("");

  if (docs.length === 0) {
    return (
      <section className="terminal terminal-view">
        <div className="terminal-topline">
          <span className="terminal-title">DOCS</span>
          <span className="terminal-host">curated workspace docs</span>
        </div>
        <div className="docs-cockpit">
          <div className="docs-command-strip">
            <span className="docs-summary">0 docs</span>
          </div>
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

  return (
    <section className="terminal terminal-view">
      <div className="terminal-topline">
        <span className="terminal-title">DOCS</span>
        <span className="terminal-host">curated workspace docs</span>
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
        </span>
      </div>

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
                    {d.title}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="docs-preview">
          {activeDoc ? (
            <>
              <div className="docs-preview-header">
                <div className="docs-preview-header-left">
                  <span className="docs-preview-title">{activeDoc.title}</span>
                  <span className="docs-preview-meta">{activeDoc.section} &middot; {activeDoc.path}</span>
                </div>
                <button className="btn btn-sm" onClick={() => onOpenDoc(activeDoc.id)}>open</button>
              </div>
              <div className="docs-preview-body"><Markdown content={activeDoc.content} /></div>
            </>
          ) : (
            <div className="docs-preview-empty">Select a doc to preview</div>
          )}
        </div>
      </div>
    </section>
  );
}
