import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocContent } from "./DocContent";
import type { DocumentContent } from "../../types";

const sampleDoc: DocumentContent = {
  id: "doc-1",
  title: "Operator checklist",
  section: "Context",
  path: "docs/context/operator-checklist.md",
  source: "custom",
  content: "# Heading\n\nParagraph with [safe link](https://example.com).\n\n| A | B |\n|---|---|\n| 1 | 2 |",
};

function renderDoc(overrides: Partial<Parameters<typeof DocContent>[0]> = {}) {
  const onOpenDoc = vi.fn();
  const onSetDocMode = vi.fn();
  const onChangeDocDraft = vi.fn();
  const onSaveDoc = vi.fn();
  const onResetDoc = vi.fn();
  const onSetShowCreateDoc = vi.fn();
  const onSetCreateDocTitle = vi.fn();
  const onSetCreateDocSlug = vi.fn();
  const onCreateDoc = vi.fn();

  render(
    <DocContent
      activeDoc={sampleDoc}
      onOpenDoc={onOpenDoc}
      docDraft={sampleDoc.content}
      docDirty={false}
      docSaving={false}
      docSaveResult={null}
      docMode="preview"
      onSetDocMode={onSetDocMode}
      onChangeDocDraft={onChangeDocDraft}
      onSaveDoc={onSaveDoc}
      onResetDoc={onResetDoc}
      showCreateDoc={false}
      createDocTitle=""
      createDocSlug=""
      createDocError={null}
      createDocCreating={false}
      onSetShowCreateDoc={onSetShowCreateDoc}
      onSetCreateDocTitle={onSetCreateDocTitle}
      onSetCreateDocSlug={onSetCreateDocSlug}
      onCreateDoc={onCreateDoc}
      {...overrides}
    />,
  );

  return {
    onOpenDoc,
    onSetDocMode,
    onChangeDocDraft,
    onSaveDoc,
    onResetDoc,
    onSetShowCreateDoc,
    onCreateDoc,
  };
}

describe("DocContent", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders title and path without section subcategory", () => {
    renderDoc();
    expect(screen.getByRole("heading", { name: "Operator checklist" })).not.toBeNull();
    expect(screen.getByText("docs/context/operator-checklist.md")).not.toBeNull();
    expect(screen.queryByText("Context")).toBeNull();
    expect(screen.queryByText("Context · context")).toBeNull();
  });

  it("exposes Preview and Edit as icon buttons in a group", () => {
    const { onSetDocMode } = renderDoc({ docMode: "preview" });
    const group = screen.getByRole("group", { name: "Doc view mode" });
    const preview = screen.getByRole("button", { name: "Preview" });
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(group.contains(preview)).toBe(true);
    expect(group.contains(edit)).toBe(true);
    expect(preview.getAttribute("aria-pressed")).toBe("true");
    expect(edit.getAttribute("aria-pressed")).toBe("false");
    expect(preview.className).toContain("lib-docs-icon-btn-active");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();

    fireEvent.click(edit);
    expect(onSetDocMode).toHaveBeenCalledWith("edit");
  });

  it("calls onSetDocMode with preview when Preview is clicked from edit mode", () => {
    const { onSetDocMode } = renderDoc({ docMode: "edit" });
    const preview = screen.getByRole("button", { name: "Preview" });
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("aria-pressed")).toBe("true");
    expect(preview.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(preview);
    expect(onSetDocMode).toHaveBeenCalledWith("preview");
  });

  it("shows modified state, copy path, and open action", () => {
    const { onOpenDoc } = renderDoc({ docDirty: true });
    expect(screen.getByLabelText("Unsaved changes")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy path" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenDoc).toHaveBeenCalledWith("doc-1");
  });

  it("renders scoped library docs markdown with tables and links", () => {
    const { container } = render(
      <DocContent
        activeDoc={sampleDoc}
        onOpenDoc={vi.fn()}
        docDraft={sampleDoc.content}
        docDirty={false}
        docSaving={false}
        docSaveResult={null}
        docMode="preview"
        onSetDocMode={vi.fn()}
        onChangeDocDraft={vi.fn()}
        onSaveDoc={vi.fn()}
        onResetDoc={vi.fn()}
        showCreateDoc={false}
        createDocTitle=""
        createDocSlug=""
        createDocError={null}
        createDocCreating={false}
        onSetShowCreateDoc={vi.fn()}
        onSetCreateDocTitle={vi.fn()}
        onSetCreateDocSlug={vi.fn()}
        onCreateDoc={vi.fn()}
      />,
    );
    expect(container.querySelector(".lib-docs-markdown")).not.toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("a[href='https://example.com']")).not.toBeNull();
  });

  it("renders create-document form controls", () => {
    renderDoc({ showCreateDoc: true, createDocTitle: "Notes", createDocSlug: "notes" });
    expect(screen.getByLabelText("New doc title")).not.toBeNull();
    expect(screen.getByLabelText("New doc slug")).not.toBeNull();
    expect(screen.getByRole("button", { name: "create" })).not.toBeNull();
  });
});
