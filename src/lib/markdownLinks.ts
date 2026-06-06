export type MarkdownHrefKind = "external" | "anchor" | "blocked";

const UNSAFE_SCHEME = /^(javascript|data|file):/i;
const GENERIC_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Classify markdown link targets for safe rendering. */
export function classifyMarkdownHref(href: string): MarkdownHrefKind {
  const trimmed = href.trim();
  if (!trimmed) return "blocked";
  if (trimmed.startsWith("#")) return "anchor";
  if (UNSAFE_SCHEME.test(trimmed)) return "blocked";
  if (trimmed.startsWith("//")) return "blocked";
  if (/^\/\//.test(trimmed)) return "blocked";
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return "blocked";
  if (GENERIC_SCHEME.test(trimmed)) {
    return /^https?:/i.test(trimmed) ? "external" : "blocked";
  }
  return "blocked";
}

export function isSafeExternalMarkdownHref(href: string): boolean {
  return classifyMarkdownHref(href) === "external";
}
