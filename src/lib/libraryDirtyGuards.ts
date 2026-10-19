import type { LibrarySourceType } from "../views/LibraryView";

/** Personal docs (`docs/context/<slug>.md`) are the user's own text: the only docs the Library edits. */
export function isPersonalDoc(doc: { source: string }): boolean {
  return doc.source === "custom";
}

/**
 * Personal docs and the refinements below the managed block of a rules file are the only Library items with a
 * draft: every other source is read-only.
 */
export function isLibrarySourceTypeDirty(sourceType: LibrarySourceType, docDirty: boolean, rulesDirty: boolean): boolean {
  return (sourceType === "docs" && docDirty) || (sourceType === "rules" && rulesDirty);
}
