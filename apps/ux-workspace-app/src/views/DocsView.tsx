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
  if (docs.length === 0) {
    return (
      <section className="terminal terminal-view">
        <div className="terminal-topline">
          <span className="terminal-title">DOCS</span>
          <span className="terminal-host">curated workspace docs</span>
        </div>
        <div className="doc-layout">
          <div className="doc-list doc-list-empty">
            {workspaceValid ? "No workspace docs found" : "No valid workspace selected. Create or choose a workspace in Settings."}
          </div>
        </div>
      </section>
    );
  }

  const groups = groupDocs(docs);

  return (
    <section className="terminal terminal-view">
      <div className="terminal-topline">
        <span className="terminal-title">DOCS</span>
        <span className="terminal-host">{docs.length} curated workspace docs</span>
      </div>
      <div className="doc-layout">
        <div className="doc-list">
          {groups.map((group) => (
            <div key={group.section}>
              <div className="doc-section-header">{group.section}</div>
              {group.docs.map((d) => (
                <div
                  key={d.id}
                  className={`doc-list-item ${activeDoc?.id === d.id ? "doc-list-item-active" : ""}`}
                  onClick={() => onSelectDoc(d.id)}
                >
                  <span className="cell-value">{d.title}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="doc-viewer">
          {activeDoc && (
            <>
              <div className="doc-viewer-header">
                <span className="cell-value">{activeDoc.path}</span>
                <button className="btn btn-sm" onClick={() => onOpenDoc(activeDoc.id)}>open</button>
              </div>
              <div className="doc-viewer-body"><Markdown content={activeDoc.content} /></div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
