import { useMemo } from "react";
import type { RepoDocFile, RepoDocsSource } from "../../types";
import { classifyDocRole, compareDocsByRole, docRoleLabel } from "./docRoles";
import { shouldIncludeDocInDashboardList } from "./docsParser";
import { docsSourceLabel, docsSourceWarning } from "./model";
import { MarkdownRenderer } from "./MarkdownRenderer";

export function docDisplayTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|markdown)$/i, "");
}

export function filterDocsForSearch(docs: RepoDocFile[], query: string): RepoDocFile[] {
  const q = query.trim().toLowerCase();
  const visible = docs.filter(shouldIncludeDocInDashboardList);
  const ordered = [...visible].sort((a, b) => {
    const roleA = classifyDocRole(a.path, a.content);
    const roleB = classifyDocRole(b.path, b.content);
    return compareDocsByRole({ path: a.path, role: roleA }, { path: b.path, role: roleB });
  });
  if (!q) return ordered;
  return ordered.filter(doc => {
    const title = docDisplayTitle(doc.path).toLowerCase();
    return doc.path.toLowerCase().includes(q) || title.includes(q);
  });
}

export function pickReadableDocPath(docs: RepoDocFile[], preferred: string | null): string | null {
  const readable = docs.filter(d => d.found && d.readable);
  if (preferred && readable.some(d => d.path === preferred)) {
    return preferred;
  }
  const startHere = readable.find(d => d.path.toLowerCase() === "docs/start_here.md");
  if (startHere) return startHere.path;
  const readme = readable.find(d => d.path === "README.md");
  if (readme) return readme.path;
  const sorted = [...readable].sort((a, b) => {
    const roleA = classifyDocRole(a.path, a.content);
    const roleB = classifyDocRole(b.path, b.content);
    return compareDocsByRole({ path: a.path, role: roleA }, { path: b.path, role: roleB });
  });
  return sorted[0]?.path ?? null;
}

function docListStatus(doc: RepoDocFile): string {
  if (!doc.found) return "missing";
  if (!doc.readable) return "unreadable";
  if (doc.truncated) return "truncated";
  return "readable";
}

export interface RepoDocsWorkspaceProps {
  docs: RepoDocFile[];
  docsSource: RepoDocsSource;
  docsRef: string;
  docsStale: boolean;
  parserWarnings: string[];
  repoWarnings: string[];
  ghMessage?: string | null;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}

export function RepoDocsWorkspace({
  docs,
  docsSource,
  docsRef,
  docsStale,
  parserWarnings,
  repoWarnings,
  ghMessage,
  selectedPath,
  onSelectPath,
  searchQuery,
  onSearchQueryChange,
}: RepoDocsWorkspaceProps) {
  const filteredDocs = useMemo(
    () => filterDocsForSearch(docs, searchQuery),
    [docs, searchQuery],
  );
  const selectedDoc = docs.find(d => d.path === selectedPath) ?? null;
  const readableCount = docs.filter(d => d.found && d.readable).length;
  const sourceWarning = docsSourceWarning(docsSource, docsStale);

  return (
    <div className="repo-dashboard-docs-workspace">
      <header className="repo-dashboard-page-head">
        <h2 className="font-mono repo-dashboard-page-title">Docs</h2>
        <p className="text-muted small repo-dashboard-page-desc">
          Searchable repository Markdown. {readableCount} readable document
          {readableCount === 1 ? "" : "s"} from {docsSourceLabel(docsSource).toLowerCase()}.
        </p>
      </header>

      <div className="repo-dashboard-docs-body">
        <aside className="repo-dashboard-docs-list-pane" aria-label="Document list">
          <label className="repo-dashboard-docs-search-wrap font-mono">
            <span className="visually-hidden">Filter documents</span>
            <input
              type="search"
              className="repo-dashboard-field repo-dashboard-docs-search"
              value={searchQuery}
              onChange={e => onSearchQueryChange(e.target.value)}
              placeholder="Filter by path or title"
              aria-label="Filter documents"
            />
          </label>
          {!filteredDocs.length ? (
            <p className="text-muted small" role="status">
              {docs.length
                ? "No documents match the current filter."
                : "No Markdown documents discovered in this repository."}
            </p>
          ) : (
            <ul
              className="repo-dashboard-docs-list"
              role="listbox"
              aria-label="Repository documents"
              aria-activedescendant={
                selectedPath ? `repo-doc-option-${selectedPath.replace(/[^\w-]+/g, "-")}` : undefined
              }
            >
              {filteredDocs.map(doc => {
                const status = docListStatus(doc);
                const selected = doc.path === selectedPath;
                const optionId = `repo-doc-option-${doc.path.replace(/[^\w-]+/g, "-")}`;
                const role = classifyDocRole(doc.path, doc.content);
                const roleLabel =
                  role !== "unknown"
                    ? docRoleLabel(role, doc.path)
                    : doc.path.toLowerCase().startsWith("docs/")
                      ? docRoleLabel("reference", doc.path)
                      : null;
                return (
                  <li key={doc.path} role="none">
                    <button
                      type="button"
                      id={optionId}
                      role="option"
                      aria-selected={selected}
                      className={`repo-dashboard-docs-list-item${selected ? " active" : ""}`}
                      onClick={() => onSelectPath(doc.path)}
                    >
                      <span className="font-mono repo-dashboard-docs-list-title">
                        {docDisplayTitle(doc.path)}
                      </span>
                      {roleLabel ? (
                        <span className="prompt-loops-pill repo-dashboard-docs-role-pill">
                          {roleLabel}
                        </span>
                      ) : null}
                      <span className="font-mono repo-dashboard-docs-list-path text-muted">
                        {doc.path}
                      </span>
                      {status !== "readable" ? (
                        <span className="prompt-loops-pill repo-dashboard-docs-list-status">
                          {status}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section
          className="repo-dashboard-docs-reader-pane"
          aria-label="Document reader"
        >
          {!selectedDoc ? (
            <p className="text-muted small" role="status">
              Select a readable document from the list.
            </p>
          ) : (
            <>
              <header className="repo-dashboard-docs-reader-head">
                <h3 className="font-mono repo-dashboard-docs-reader-title">
                  {docDisplayTitle(selectedDoc.path)}
                </h3>
                <p className="font-mono small text-muted repo-dashboard-docs-reader-path">
                  {selectedDoc.path}
                </p>
                {selectedDoc.found && selectedDoc.readable ? (
                  <p className="text-muted small repo-dashboard-docs-reader-role">
                    Role: {docRoleLabel(classifyDocRole(selectedDoc.path, selectedDoc.content), selectedDoc.path)}
                  </p>
                ) : null}
                {!selectedDoc.found ? (
                  <p className="text-muted small" role="status">
                    Document not found in the repository snapshot.
                  </p>
                ) : null}
                {selectedDoc.found && !selectedDoc.readable ? (
                  <p className="repo-dashboard-docs-reader-warning small" role="status">
                    Could not read this document
                    {selectedDoc.read_error ? `: ${selectedDoc.read_error}` : "."}
                  </p>
                ) : null}
                {selectedDoc.truncated ? (
                  <p className="repo-dashboard-docs-reader-warning small" role="status">
                    Content truncated at load limit — only the beginning is shown.
                  </p>
                ) : null}
              </header>
              {selectedDoc.readable && selectedDoc.content ? (
                <div
                  className="repo-dashboard-docs-reader-scroll"
                  role="region"
                  aria-label="Document content"
                  tabIndex={0}
                >
                  <MarkdownRenderer content={selectedDoc.content} />
                </div>
              ) : null}
            </>
          )}

          {(parserWarnings.length > 0 || repoWarnings.length > 0 || ghMessage || sourceWarning) && (
            <details className="repo-dashboard-docs-diagnostics font-mono">
              <summary>Diagnostics</summary>
              <div className="repo-dashboard-docs-diagnostic-block">
                <h4 className="repo-dashboard-docs-diagnostic-title">Documentation source</h4>
                <p className="text-muted small repo-dashboard-docs-source-meta">
                  {docsSourceLabel(docsSource)} · {docsRef}
                  {docsStale ? " · stale" : ""}
                </p>
                {sourceWarning ? (
                  <p className="repo-dashboard-docs-reader-warning small" role="status">
                    {sourceWarning}
                  </p>
                ) : null}
              </div>
              {parserWarnings.length > 0 ? (
                <div className="repo-dashboard-docs-diagnostic-block">
                  <h4 className="repo-dashboard-docs-diagnostic-title">Parser warnings</h4>
                  <pre className="repo-dashboard-code">{parserWarnings.join("\n")}</pre>
                </div>
              ) : null}
              {repoWarnings.length > 0 ? (
                <div className="repo-dashboard-docs-diagnostic-block">
                  <h4 className="repo-dashboard-docs-diagnostic-title">Repository warnings</h4>
                  <pre className="repo-dashboard-code">{repoWarnings.join("\n")}</pre>
                </div>
              ) : null}
              {ghMessage ? (
                <p className="text-muted small repo-dashboard-gh-note">{ghMessage}</p>
              ) : null}
            </details>
          )}
        </section>
      </div>
    </div>
  );
}
