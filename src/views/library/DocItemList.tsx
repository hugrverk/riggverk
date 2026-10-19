import { useMemo } from "react";
import type { DocsHealth, DocSummary } from "../../types";
import { LibraryList } from "./LibraryList";

export function filterDocsForSearch(docs: DocSummary[], query: string): DocSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs;
  return docs.filter(
    (d) =>
      d.title.toLowerCase().includes(q) ||
      d.path.toLowerCase().includes(q) ||
      d.section.toLowerCase().includes(q),
  );
}

/** Keeps documents of one section together, in first-seen section order, so each heading appears once. */
export function orderBySection(docs: DocSummary[]): DocSummary[] {
  const sections = new Map<string, DocSummary[]>();
  for (const doc of docs) {
    const existing = sections.get(doc.section) ?? [];
    existing.push(doc);
    sections.set(doc.section, existing);
  }
  return Array.from(sections.values()).flat();
}

interface DocItemListProps {
  docs: DocSummary[];
  docsHealth: DocsHealth | null;
  workspaceValid: boolean;
  activeKey: string | null;
  followCursor: boolean;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  onGoToWorkspaceRepair: () => void;
  search: string;
  onSearchChange: (query: string) => void;
  /** Enter hint: "edit" while the open doc is a personal doc, "read" for a bundled one. */
  activateHint: string;
}

export function DocItemList({
  docs,
  docsHealth,
  workspaceValid,
  activeKey,
  followCursor,
  onSelect,
  onActivate,
  onGoToWorkspaceRepair,
  search,
  onSearchChange,
  activateHint,
}: DocItemListProps) {
  const missingCount = docsHealth?.missing_count ?? 0;
  const showStaleBanner = workspaceValid && missingCount > 0;
  const items = useMemo(() => orderBySection(filterDocsForSearch(docs, search)), [docs, search]);

  const staleHint = `${missingCount} bundled doc${missingCount === 1 ? " is" : "s are"} missing from this workspace.`;

  return (
    <>
      {showStaleBanner && (
        <div className="lib-notice" role="status">
          <p className="c-warn">Bundled docs need update</p>
          <p className="c-dim">{staleHint}</p>
          <button type="button" className="btn btn-sm btn-primary" onClick={onGoToWorkspaceRepair}>
            open workspace update
          </button>
        </div>
      )}
      {!workspaceValid ? (
        <p className="c-dim" role="status">No valid workspace</p>
      ) : docs.length === 0 ? (
        <p className="c-dim" role="status">No docs found</p>
      ) : (
        <LibraryList<DocSummary>
          label="Workspace documents"
          items={items}
          getKey={doc => doc.id}
          getGroup={doc => doc.section}
          renderItem={doc => (
            <>
              <span className="nm">{doc.title}</span>
              {doc.source === "custom" && <span className="meta c-acc">context</span>}
            </>
          )}
          activeKey={activeKey}
          followCursor={followCursor}
          onSelect={onSelect}
          onActivate={onActivate}
          activateHint={activateHint}
          filter={{
            value: search,
            onChange: onSearchChange,
            label: "Filter documents",
            placeholder: "filter by path or title",
          }}
          empty="No documents match the current filter."
        />
      )}
    </>
  );
}
