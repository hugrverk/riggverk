const FRONTMATTER = /^---[ \t]*\r?\n((?:[^\n]*\r?\n)*?)---[ \t]*(?:\r?\n|$)/;
const YAML_KEY = /^[A-Za-z0-9_-]+[ \t]*:/m;

/**
 * Drops leading YAML front matter before rendering. Skills and agents carry their metadata there; the editor
 * shows it verbatim and the metadata block summarises it, while rendered as markdown it would turn into a
 * rule and a heading. Only a block that opens with a `key:` line counts, so a document that merely starts
 * with a horizontal rule is left alone.
 */
export function stripFrontmatter(content: string): string {
  const match = FRONTMATTER.exec(content);
  if (!match || !YAML_KEY.test(match[1] ?? "")) return content;
  return content.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
}
