import type { DiscoveredLocalGitRepo, RepoDashboardEntry } from "../types";
import { normalizeRepoPathForCompare } from "../tools/repoDashboard/model";

export function repoEntryIdFromPath(path: string): string {
  const base = path.replace(/\/+$/, "").split("/").pop() || "repo";
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "repo";
}

export function repoEntryLabelFromPath(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || "Repository";
}

export function savedRepoPathsSet(entries: RepoDashboardEntry[]): Set<string> {
  return new Set(entries.map(e => normalizeRepoPathForCompare(e.path)));
}

export function isRepoPathAlreadySaved(
  path: string,
  entries: RepoDashboardEntry[],
): boolean {
  const key = normalizeRepoPathForCompare(path);
  return entries.some(e => normalizeRepoPathForCompare(e.path) === key);
}

export function discoveredToDashboardEntry(
  discovered: DiscoveredLocalGitRepo,
): RepoDashboardEntry {
  return {
    id: repoEntryIdFromPath(discovered.path),
    label: discovered.label.trim() || repoEntryLabelFromPath(discovered.path),
    path: discovered.path,
    default_branch: discovered.default_branch?.trim() || null,
  };
}

/** Merge imports into saved entries without duplicating normalized paths or ids. */
export function mergeImportedRepoEntries(
  existing: RepoDashboardEntry[],
  imports: RepoDashboardEntry[],
): RepoDashboardEntry[] {
  const entries = [...existing];
  const seenPaths = savedRepoPathsSet(entries);
  const seenIds = new Set(entries.map(e => e.id));

  for (const entry of imports) {
    const pathKey = normalizeRepoPathForCompare(entry.path);
    if (seenPaths.has(pathKey)) continue;

    let id = entry.id;
    if (seenIds.has(id)) {
      let suffix = 2;
      while (seenIds.has(`${entry.id}-${suffix}`)) suffix += 1;
      id = `${entry.id}-${suffix}`;
    }

    const next = { ...entry, id };
    entries.push(next);
    seenPaths.add(pathKey);
    seenIds.add(id);
  }

  return entries;
}
