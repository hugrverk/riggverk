import { cleanup, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithShell } from "../../test/renderWithShell";
import { DocumentPane } from "./DocumentPane";
import type { LibraryEntry } from "./entry";

afterEach(cleanup);

function entry(overrides: Partial<LibraryEntry>): LibraryEntry {
  return {
    source: "skills",
    id: "pack:old-pack/old-skill",
    listKey: "pack:old-pack/old-skill",
    title: "old-skill",
    path: "",
    copyPath: "",
    editorLabel: "Edit skill",
    saved: "",
    draft: "pack missing",
    dirty: false,
    saving: false,
    saveResult: null,
    saveMessage: "",
    readOnly: true,
    readOnlyReason: "from a skill pack",
    note: null,
    preview: "markdown",
    metaTitle: null,
    meta: [],
    onChange: () => {},
    onSave: () => {},
    onReset: () => {},
    onOpen: null,
    ...overrides,
  };
}

function titleText(): string {
  return screen.getByRole("region", { name: "Document" }).querySelector(".pane-title")!.textContent!.replace(/\s+/g, " ").trim();
}

function renderPane(item: LibraryEntry) {
  renderWithShell(<DocumentPane entry={item} emptyHint="" editing={false} textareaRef={createRef()} onClose={() => {}} />);
}

describe("DocumentPane title", () => {
  it("drops the path segment of an item that has none", () => {
    renderPane(entry({}));
    expect(titleText()).toBe("old-skill · read-only");
  });

  it("joins the path, the modified flag and read-only with one separator each", () => {
    renderPane(entry({ path: "skills/tdd/SKILL.md", dirty: true }));
    expect(titleText()).toBe("old-skill · skills/tdd/SKILL.md · modified · read-only");
  });
});
