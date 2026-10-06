import { useEffect, useMemo, useRef, useState } from "react";
import { focusPaneById } from "../../keyboard/focus";
import type { RepoDocFile, RepoDocsSource } from "../../types";
import { Pane } from "../../ui/Pane";
import { PaneList } from "../../ui/PaneList";
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

/** Moving the list cursor selects after this pause so holding j/k does not re-render the document on every row. */
const DOC_SELECT_DEBOUNCE_MS = 120;

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
  const sourceWarning = docsSourceWarning(docsSource, docsStale);

  // The list cursor leads; the selection (what the reader shows) follows it after a short pause.
  const [cursorPath, setCursorPath] = useState<string | null>(selectedPath);
  const selectTimer = useRef<number | null>(null);
  const cancelPendingSelect = () => {
    if (selectTimer.current !== null) {
      window.clearTimeout(selectTimer.current);
      selectTimer.current = null;
    }
  };
  useEffect(() => {
    setCursorPath(selectedPath);
  }, [selectedPath]);
  useEffect(() => cancelPendingSelect, []);

  const onCursorChange = (path: string) => {
    // A cursor whose row was filtered away is repaired by the list; that is not the reader's cue to switch documents.
    const userMove = filteredDocs.some(doc => doc.path === cursorPath);
    setCursorPath(path);
    cancelPendingSelect();
    if (!userMove || path === selectedPath) return;
    selectTimer.current = window.setTimeout(() => {
      selectTimer.current = null;
      onSelectPath(path);
    }, DOC_SELECT_DEBOUNCE_MS);
  };

  const openDoc = (doc: RepoDocFile) => {
    cancelPendingSelect();
    onSelectPath(doc.path);
    focusPaneById("docs-reader");
  };

  return (
    <div className="repo-dashboard-docs-workspace">
      <div className="repo-dashboard-docs-body">
        <Pane
          id="docs-list"
          index={2}
          title="docs"
          meta={`· ${filteredDocs.length}`}
          label="Document list"
          className="repo-dashboard-docs-list-pane"
          bodyClassName="repo-dashboard-docs-list-body"
          defaultFocus
        >
          <PaneList
            label="Repository documents"
            items={filteredDocs}
            getKey={doc => doc.path}
            cursorKey={cursorPath}
            onCursorChange={onCursorChange}
            selectedKeys={selectedPath ? [selectedPath] : []}
            onActivate={openDoc}
            activateHint="read"
            filter={{
              value: searchQuery,
              onChange: onSearchQueryChange,
              label: "Filter documents",
              placeholder: "filter by path or title",
            }}
            empty={
              docs.length
                ? "No documents match the current filter."
                : "No Markdown documents discovered in this repository."
            }
            renderItem={doc => {
              const status = docListStatus(doc);
              const role = classifyDocRole(doc.path, doc.content);
              const roleLabel =
                role !== "unknown"
                  ? docRoleLabel(role, doc.path)
                  : doc.path.toLowerCase().startsWith("docs/")
                    ? docRoleLabel("reference", doc.path)
                    : null;
              return (
                <>
                  <span className="nm" title={doc.path}>
                    <span className="repo-dashboard-docs-list-title">{docDisplayTitle(doc.path)}</span>{" "}
                    <span className="c-dim repo-dashboard-docs-list-path">{doc.path}</span>
                  </span>
                  <span className="meta">
                    {roleLabel}
                    {roleLabel && status !== "readable" ? " · " : null}
                    {status !== "readable" ? <span className="c-warn">{status}</span> : null}
                  </span>
                </>
              );
            }}
          />
        </Pane>

        <Pane
          id="docs-reader"
          index={3}
          title={selectedDoc ? docDisplayTitle(selectedDoc.path) : "reader"}
          meta={selectedDoc ? `· ${selectedDoc.path}` : undefined}
          label="Document reader"
          className="repo-dashboard-docs-reader-pane"
          bodyClassName="repo-dashboard-docs-reader-body"
        >
          {!selectedDoc ? (
            <p className="text-muted small" role="status">
              Select a readable document from the list.
            </p>
          ) : (
            <>
              <header className="repo-dashboard-docs-reader-head">
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
                  data-pane-primary=""
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
        </Pane>
      </div>
    </div>
  );
}
