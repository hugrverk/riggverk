import { normalizeRepoPathForCompare } from "../repoDashboard/model";
import type { RepoDashboardEntry, RepoDashboardWorkItem } from "../../types";

/** Session-only seed for Repo Dashboard → Prompt Loops context handoff. */
export interface PromptLoopContextSeed {
  id: string;
  taskContext: string;
  repoEntryId?: string;
}

const ELIGIBLE_TYPES = new Set(["feature", "roadmap", "todo"]);

export function isPromptContextEligibleWorkItem(item: RepoDashboardWorkItem): boolean {
  return item.source === "docs" && ELIGIBLE_TYPES.has(item.type);
}

export function formatRepoDashboardWorkItemContext(item: RepoDashboardWorkItem): string {
  const lines = [
    "Selected Repo Dashboard item:",
    `- Type: ${item.type}`,
    `- Source: ${item.source}`,
    `- Path: ${item.path}`,
  ];
  if (item.line != null) {
    lines.push(`- Line: ${item.line}`);
  }
  lines.push(`- Status: ${item.status}`);
  lines.push(`- Text: ${item.text}`);
  lines.push("");
  lines.push(
    "Treat this as starting context only. Inspect repository reality, repo-local docs, scripts, and current code before deciding implementation.",
  );
  return lines.join("\n");
}

export function findRepoEntryIdForPath(
  repoPath: string,
  entries: readonly RepoDashboardEntry[],
): string | undefined {
  const key = normalizeRepoPathForCompare(repoPath);
  return entries.find(e => normalizeRepoPathForCompare(e.path) === key)?.id;
}

function stableSeedKey(item: RepoDashboardWorkItem): string {
  return [item.source, item.path, String(item.line ?? ""), item.type, item.status, item.text].join(
    "|",
  );
}

export function createPromptLoopContextSeed(
  item: RepoDashboardWorkItem,
  options: {
    repoPath?: string;
    savedEntries?: readonly RepoDashboardEntry[];
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
