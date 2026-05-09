import { useMemo } from "react";

export function Markdown({ content }: { content: string }) {
  const els = useMemo(() => parseMarkdown(content), [content]);
  return <div className="markdown-body">{els}</div>;
}

function parseMarkdown(content: string): React.JSX.Element[] {
  const lines = content.split("\n");
  const els: React.JSX.Element[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) { buf.push(lines[i]); i++; }
      i++;
      els.push(<pre className="markdown-code" key={els.length}>{buf.join("\n")}</pre>);
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#{1,6})/)![1].length;
      const text = line.replace(/^#{1,6}\s+/, "").trim();
      const cls = `markdown-h markdown-h${level}`;
      const children = renderInline(text);
      if (level === 1) els.push(<h1 className={cls} key={els.length}>{children}</h1>);
      else if (level === 2) els.push(<h2 className={cls} key={els.length}>{children}</h2>);
      else if (level === 3) els.push(<h3 className={cls} key={els.length}>{children}</h3>);
      else if (level === 4) els.push(<h4 className={cls} key={els.length}>{children}</h4>);
      else if (level === 5) els.push(<h5 className={cls} key={els.length}>{children}</h5>);
      else els.push(<h6 className={cls} key={els.length}>{children}</h6>);
      i++;
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      els.push(<hr className="markdown-rule" key={els.length} />);
      i++;
      continue;
    }

    if (line.trim() === "") { i++; continue; }

    if (/^[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*+]\s+/, "")); i++; }
      els.push(<ul className="markdown-list" key={els.length}>{items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ul>);
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      els.push(<ol className="markdown-list" key={els.length}>{items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ol>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|[-*+]\s|\d+\.\s|[-*_]{3,})/.test(lines[i])) { para.push(lines[i]); i++; }
    els.push(<p className="markdown-p" key={els.length}>{renderInline(para.join(" "))}</p>);
  }

  return els;
}

function renderInline(text: string): (string | React.JSX.Element)[] {
  const parts: (string | React.JSX.Element)[] = [];
  const regex = /`([^`]+)`/g;
  let last = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<code className="markdown-inline-code" key={parts.length}>{match[1]}</code>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
