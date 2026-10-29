/** Personal docs (`docs/context/<slug>.md`) are the user's own text: the only docs the Library edits. */
export function isPersonalDoc(doc: { source: string }): boolean {
  return doc.source === "custom";
}

/**
 * Personal docs and the refinements below the managed block of a rules file are the only Library items with a
 * draft: every other source is read-only. A draft belongs to its open item, not to the topic on show (a search
 * result can open an item of any topic), so unsaved edits count wherever the Library is looking.
 */
export function isLibraryDirty(docDirty: boolean, rulesDirty: boolean): boolean {
  return docDirty || rulesDirty;
}
