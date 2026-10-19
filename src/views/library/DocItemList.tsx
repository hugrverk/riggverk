import { useMemo } from "react";
import type { DocSummary } from "../../types";
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
  activeKey: string | null;
  followCursor: boolean;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  search: string;
  onSearchChange: (query: string) => void;
  /** Enter hint: "edit" while the open doc is a personal doc, "read" for a bundled one. */
  activateHint: string;
}

export function DocItemList({
  docs,
  activeKey,
  followCursor,
  onSelect,
  onActivate,
  search,
  onSearchChange,
  activateHint,
}: DocItemListProps) {
  const items = useMemo(() => orderBySection(filterDocsForSearch(docs, search)), [docs, search]);

  if (docs.length === 0) return <p className="c-dim" role="status">No docs found</p>;
  return (
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
  );
}
