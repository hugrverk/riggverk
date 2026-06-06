import { SafeMarkdown } from "../../components/SafeMarkdown";

export function MarkdownRenderer({ content }: { content: string }) {
  return <SafeMarkdown content={content} className="repo-dashboard-markdown" />;
}
