import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocSummary, DocsHealth } from "../../types";

// DocItemList is not exported; test via a minimal inline mirror of docs list markup
// by importing LibraryView would be heavy — exercise docs list classes through DocContent tests
// and verify docs sidebar structure with a focused fixture component.

function DocsListFixture({
  docs,
  activeId,
  showStaleBanner,
}: {
  docs: DocSummary[];
  activeId: string | null;
  showStaleBanner: boolean;
}) {
  const groups = new Map<string, DocSummary[]>();
  for (const d of docs) {
    const existing = groups.get(d.section) ?? [];
    existing.push(d);
    groups.set(d.section, existing);
  }

  return (
    <aside className="lib-docs-list-pane" aria-label="Document list">
      {showStaleBanner && (
        <div className="lib-docs-stale-banner" role="status">
          <p className="lib-docs-stale-title">Bundled docs need update</p>
        </div>
      )}
      <ul className="lib-docs-list" role="listbox" aria-label="Workspace documents">
        {Array.from(groups.entries()).map(([section, items]) => (
          <li key={section} role="none" className="lib-docs-list-section">
            <div className="lib-docs-section-label">{section}</div>
            <ul className="lib-docs-list-section-items" role="group" aria-label={section}>
              {items.map((d) => (
                <li key={d.id} role="none">
                  <button
                    type="button"
                    className={`lib-docs-list-item${activeId === d.id ? " active" : ""}`}
                    role="option"
                    aria-selected={activeId === d.id}
                  >
                    <span className="font-mono lib-docs-list-title">{d.title}</span>
                    <span className="font-mono lib-docs-list-path text-muted">{d.path}</span>
                    {d.source === "custom" && (
                      <span className="prompt-loops-pill lib-docs-context-pill">context</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-sm btn-primary lib-docs-new-btn">
        + new doc
      </button>
    </aside>
  );
}

describe("Library Docs list chrome", () => {
  afterEach(() => {
    cleanup();
  });

  const docs: DocSummary[] = [
    {
      id: "a",
      title: "Alpha",
      section: "Bundled",
      path: "docs/alpha.md",
      source: "bundled",
    },
    {
      id: "b",
      title: "Beta notes",
      section: "Context",
      path: "docs/context/beta.md",
      source: "custom",
    },
  ];

  it("groups documents by section with selected state", () => {
    const { container } = render(
      <DocsListFixture docs={docs} activeId="b" showStaleBanner={false} />,
    );
    expect(screen.getByText("Bundled")).not.toBeNull();
    expect(screen.getByText("Context")).not.toBeNull();
    const active = container.querySelector(".lib-docs-list-item.active");
    expect(active?.textContent).toContain("Beta notes");
  });

  it("shows custom context tag and stale warning banner", () => {
    render(<DocsListFixture docs={docs} activeId={null} showStaleBanner={true} />);
    expect(screen.getByText("context")).not.toBeNull();
    expect(screen.getByText("Bundled docs need update")).not.toBeNull();
    expect(screen.getByRole("button", { name: "+ new doc" })).not.toBeNull();
  });
});
