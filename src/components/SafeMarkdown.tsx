import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { classifyMarkdownHref } from "../lib/markdownLinks";
import { CopyableBlock } from "./CopyableBlock";

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
    <span className="markdown-link-blocked" title="Link blocked for safety" {...props}>
      {children}
    </span>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownAnchor,
  code: ({ className, children, ...props }) => {
    const text = String(children).replace(/\n$/, "");
    const isBlock = Boolean(className) || text.includes("\n");
    if (!isBlock) {
      return (
        <code className="markdown-inline-code" {...props}>
          {children}
        </code>
      );
    }
    return (
      <CopyableBlock text={text}>
        <pre className="markdown-code">
          <code {...props}>{text}</code>
        </pre>
      </CopyableBlock>
    );
  },
};

export function SafeMarkdown({
  content,
  className = "markdown-body",
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
