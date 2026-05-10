const TITLE_CASE_OVERRIDES: Record<string, string> = {
  "bmw": "BMW",
  "bmw-m": "BMW M",
  "clickhouse": "ClickHouse",
  "x.ai": "X.ai",
  "spacex": "SpaceX",
};

function titleCaseSegment(segment: string): string {
  if (!segment) return segment;
  return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
}

export function designMdDisplayTitle(slug: string): string {
  const cleanSlug = slug.trim();
  const override = TITLE_CASE_OVERRIDES[cleanSlug.toLowerCase()];
  if (override) return override;

  return cleanSlug
    .split(/[-_]/)
    .filter(Boolean)
    .map(titleCaseSegment)
    .join(" ");
}

export function designMdHasInspiredTitle(title: string): boolean {
  return /\binspired\b/i.test(title);
}

export function designMdSearchText(entry: {
  slug: string;
  title: string;
  description: string;
}): string {
  return [
    entry.slug,
    entry.title,
    designMdDisplayTitle(entry.slug),
    entry.description,
  ].join(" ").toLowerCase();
}
