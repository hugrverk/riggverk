import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { classifyMarkdownHref } from "./markdownLinks";

function MarkdownAnchor({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (!href) {
    return <span {...props}>{children}</span>;
  }
  const kind = classifyMarkdownHref(href);
  if (kind === "external") {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  }
  if (kind === "anchor") {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }
  return (
    <span className="repo-dashboard-md-link-blocked" title="Link blocked for safety" {...props}>
      {children}
    </span>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownAnchor,
};

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="repo-dashboard-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
