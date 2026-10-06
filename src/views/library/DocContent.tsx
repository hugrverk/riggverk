import { useMemo } from "react";
import { SafeMarkdown } from "../../components/SafeMarkdown";
import { stripFrontmatter } from "./frontmatter";

/**
 * The Library's scoped reading surface (`.lib-docs-markdown`): rendered markdown of the working copy, safe
 * links and copyable code blocks included. YAML front matter is left out; the editor shows it verbatim and the
 * metadata block summarises it.
 */
export function DocContent({ content }: { content: string }) {
  const markdown = useMemo(() => stripFrontmatter(content), [content]);
  return <SafeMarkdown content={markdown} className="markdown-body lib-docs-markdown" />;
}
