import { endingsOnlyNote, unifiedLineDiff } from "../../lib/lineDiff";
import type { RulesFileContent } from "../../types";

/**
 * The rules file as it will read once `draft` is saved: the text above the refinements (the user's text above
 * BEGIN and the managed block, which the backend returns as `before`) followed by the draft, byte for byte.
 */
export function effectiveRulesText(file: Pick<RulesFileContent, "before">, draft: string): string {
  return file.before + draft;
}

/** The refinements on disk against the draft, as unified-diff lines for `DiffView`; "" when they are equal. */
export function refinementsDiff(file: Pick<RulesFileContent, "refinements">, draft: string): string {
  return unifiedLineDiff(file.refinements, draft);
}

/** What to say instead of a diff when the draft differs from the disk only in its line endings or final newline; null otherwise. */
export function refinementsEndingsNote(file: Pick<RulesFileContent, "refinements">, draft: string): string | null {
  return endingsOnlyNote(file.refinements, draft);
}

const HEADING = /^##[ \t]+(.+?)[ \t]*$/;

function headingsOf(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const title = HEADING.exec(line.replace(/\r$/, ""))?.[1];
    if (title !== undefined && !found.includes(title)) found.push(title);
  }
  return found;
}

/** The `## Heading` sections of the draft that the managed block above it has too, in draft order. */
export function sharedHeadings(before: string, draft: string): string[] {
  const base = new Set(headingsOf(before));
  return headingsOf(draft).filter(title => base.has(title));
}

/** The line under the textarea for those headings: the agent reads both sections, the later one last. */
export function overrideHint(headings: readonly string[]): string | null {
  if (headings.length === 0) return null;
  const names = headings.map(name => `“${name}”`).join(", ");
  return `${names} ${headings.length > 1 ? "are also sections" : "is also a section"} in the managed base. The agent reads both; yours comes later in the file.`;
}
