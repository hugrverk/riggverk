import type { RepoDashboardWorkItem } from "../../types";

/** Session-only seed for Repo Dashboard -> Prompt Builder context handoff. */
export interface PromptLoopContextSeed {
  id: string;
  taskContext: string;
  repoEntryId?: string;
}

const CANONICAL_CLASSIFICATIONS = new Set(["bug", "verify", "enhancement"]);

export function isPromptContextEligibleWorkItem(item: RepoDashboardWorkItem): boolean {
  if (item.classification && CANONICAL_CLASSIFICATIONS.has(item.classification)) {
    return item.status !== "done";
  }
  if (item.source === "issue") return item.status !== "done";
  const legacyEligible = new Set(["feature", "roadmap", "todo"]);
  return item.source === "docs" && legacyEligible.has(item.type) && item.status !== "done";
}

export function formatRepoDashboardWorkItemContext(item: RepoDashboardWorkItem): string {
  const lines = ["Selected Repo Dashboard item:"];
  if (item.workId) lines.push(`- ID: ${item.workId}`);
  if (item.classification) lines.push(`- Classification: ${item.classification}`);
  if (item.priority) lines.push(`- Priority: ${item.priority}`);
  if (item.area) lines.push(`- Area: ${item.area}`);
  lines.push(`- Status: ${item.status}`);
  lines.push(`- Source: ${item.canonicalSource ?? item.source}`);
  lines.push(`- Path: ${item.path}`);
  if (item.line != null) lines.push(`- Line: ${item.line}`);
  lines.push(`- Summary: ${item.text}`);
  if (item.nextAction) lines.push(`- Next action: ${item.nextAction}`);
  if (item.verification) lines.push(`- Verification: ${item.verification}`);
  if (item.ownerFiles) lines.push(`- Owner files: ${item.ownerFiles}`);
  if (!item.classification) {
    lines.push(`- Type: ${item.type}`);
  }
  lines.push("");
  lines.push(
    "Treat this as starting context only. Inspect repository reality, repo-local docs, scripts, and current code before deciding implementation.",
  );
  return lines.join("\n");
}

export function findRepoEntryIdForPath(
  repoPath: string,
  entries: readonly { id: string; path: string }[],
): string | undefined {
  const key = repoPath.trim().replace(/\/+$/, "");
  return entries.find(e => e.path.trim().replace(/\/+$/, "") === key)?.id;
}

function stableSeedKey(item: RepoDashboardWorkItem): string {
  return [
    item.source,
    item.path,
    String(item.line ?? ""),
    item.workId ?? "",
    item.classification ?? item.type,
    item.status,
    item.text,
  ].join("|");
}

export function createPromptLoopContextSeed(
  item: RepoDashboardWorkItem,
  options: {
    repoPath?: string;
    savedEntries?: readonly { id: string; path: string }[];
    seedNonce?: number;
  },
): PromptLoopContextSeed {
  const taskContext = formatRepoDashboardWorkItemContext(item);
  const repoEntryId =
    options.repoPath?.trim() && options.savedEntries?.length
      ? findRepoEntryIdForPath(options.repoPath, options.savedEntries)
      : undefined;
  const nonce = options.seedNonce ?? Date.now();
  return {
    id: `${stableSeedKey(item)}|${nonce}`,
    taskContext,
    ...(repoEntryId ? { repoEntryId } : {}),
  };
}
