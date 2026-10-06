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

/** First free id for `baseId`: `baseId`, then `baseId-2`, `baseId-3`, ... */
function uniqueRepoEntryId(baseId: string, takenIds: ReadonlySet<string>): string {
  if (!takenIds.has(baseId)) return baseId;
  let suffix = 2;
  while (takenIds.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

/**
 * Add or update the saved entry for `path`. Entries match on normalized path only:
 * ids are basename slugs and collide for different checkouts of the same folder name.
 */
export function upsertRepoEntry(
  existing: RepoDashboardEntry[],
  path: string,
  defaultBranch: string | null,
): { entries: RepoDashboardEntry[]; id: string } {
  const entries = [...existing];
  const pathKey = normalizeRepoPathForCompare(path);
  const index = entries.findIndex(e => normalizeRepoPathForCompare(e.path) === pathKey);
  if (index >= 0) {
    const current = entries[index];
    entries[index] = { ...current, path, default_branch: defaultBranch };
    return { entries, id: current.id };
  }
  const id = uniqueRepoEntryId(repoEntryIdFromPath(path), new Set(entries.map(e => e.id)));
  entries.push({ id, label: repoEntryLabelFromPath(path), path, default_branch: defaultBranch });
  return { entries, id };
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

    const id = uniqueRepoEntryId(entry.id, seenIds);
    entries.push({ ...entry, id });
    seenPaths.add(pathKey);
    seenIds.add(id);
  }

  return entries;
}
