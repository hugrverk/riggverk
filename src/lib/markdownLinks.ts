export type MarkdownHrefKind = "external" | "anchor" | "blocked";

/** Classify markdown link targets for safe rendering: only http(s) and in-page anchors are allowed. */
export function classifyMarkdownHref(href: string): MarkdownHrefKind {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) return "anchor";
  return /^https?:/i.test(trimmed) ? "external" : "blocked";
}

export function isSafeExternalMarkdownHref(href: string): boolean {
  return classifyMarkdownHref(href) === "external";
}
