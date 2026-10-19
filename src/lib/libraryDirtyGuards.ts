import type { LibrarySourceType } from "../views/LibraryView";

/** Personal docs (`docs/context/<slug>.md`) are the user's own text: the only Library items it edits. */
export function isPersonalDoc(doc: { source: string }): boolean {
  return doc.source === "custom";
}

/** Personal docs are the only Library items with a draft: every other source is read-only. */
export function isLibrarySourceTypeDirty(sourceType: LibrarySourceType, docDirty: boolean): boolean {
  return sourceType === "docs" && docDirty;
}
