import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Children, isValidElement } from "react";
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

function extractCodeText(children: React.ReactNode): string {
  const child = Children.only(children);
  if (isValidElement<{ children?: React.ReactNode }>(child)) {
    return String(child.props.children ?? "").replace(/\n$/, "");
  }
  return String(children).replace(/\n$/, "");
}

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownAnchor,
  pre: ({ children, ...props }) => {
    const text = extractCodeText(children);
    return (
      <CopyableBlock text={text}>
        <pre className="markdown-code" {...props}>
          {children}
        </pre>
      </CopyableBlock>
    );
  },
  code: ({ className, children, ...props }) => {
    const text = String(children);
    const isBlock = Boolean(className) || text.includes("\n");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="markdown-inline-code" {...props}>
        {children}
      </code>
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
