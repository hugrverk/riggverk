import type { InstallAgent, SetupHistoryEntry } from "../types";
import { HARNESS_LABELS, HARNESS_SURFACES } from "./harnessInstallation";
import { surfaceTitle } from "./installPlan";
import { listText } from "./overviewModel";
import { plural } from "./plural";

export interface ReceiptLine {
  label: string;
  value: string;
}

/** Unix nanoseconds as a decimal string, in milliseconds; null when it is not a plain number. */
export function nanosToMillis(nanos: string | null): number | null {
  if (!nanos || !/^\d+$/.test(nanos)) return null;
  // Dropping six digits is a floor to the millisecond and stays exact where a float of the full value would not.
  const millis = nanos.length > 6 ? Number(nanos.slice(0, -6)) : 0;
  return Number.isFinite(millis) ? millis : null;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "15:39" for today, "Oct 21, 15:39" for another day; null when the entry carries no usable time. */
export function updateTimeText(entry: Pick<SetupHistoryEntry, "created_at" | "finished_at">, now: Date = new Date()): string | null {
  const millis = nanosToMillis(entry.finished_at) ?? nanosToMillis(entry.created_at);
  if (millis === null) return null;
  const date = new Date(millis);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay(date, now)) return time;
  return `${date.toLocaleDateString("en-GB", { month: "short", day: "numeric" })}, ${time}`;
}

/** "Codex", "Claude and Codex"; null when the update touched no agent's own files (the shared skills, the workspace). */
export function updateAgentsText(entry: Pick<SetupHistoryEntry, "harnesses">): string | null {
  const names = entry.harnesses.map(harness => HARNESS_LABELS[harness]);
  return names.length === 0 ? null : listText(names);
}

/** What an undo did to the run's changes: the files it had created were removed, the others restored from the backup. */
function undoneLines(restored: SetupHistoryEntry["changes"]): ReceiptLine[] {
  const created = restored.filter(change => change.kind === "create").length;
  const fromBackup = restored.length - created;
  const lines: ReceiptLine[] = [];
  if (created > 0) lines.push({ label: "Removed", value: `${plural(created, "file")} it had created` });
  if (fromBackup > 0) lines.push({ label: "Restored", value: `${plural(fromBackup, "file")} from the backup` });
  return lines;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * The receipt of one history entry, only from what the manifest recorded: the files it changed and restored, what the
 * plan found current ("Checked") and left for the user, and how many files were backed up. A run from before receipts
 * were recorded has no Checked / Left for you lines; nothing is guessed for it.
 */
export function receiptLines(entry: SetupHistoryEntry, backupCount: number | null = null): ReceiptLine[] {
  const lines: ReceiptLine[] = [];
  const changed = entry.changes.filter(change => change.applied && !change.restored);
  const restored = entry.changes.filter(change => change.restored);
  if (changed.length > 0) {
    const surfaces = unique(changed.map(change => change.surface)).map(surfaceTitle).join(", ");
    lines.push({ label: "Changed", value: `${surfaces} · ${plural(changed.length, "file")}` });
  }
  lines.push(...undoneLines(restored));
  if (entry.receipt) {
    if (entry.receipt.synced.length > 0) {
      lines.push({ label: "Checked", value: `${unique(entry.receipt.synced).map(surfaceTitle).join(", ")} · current` });
    }
    if (entry.receipt.left_for_you.length > 0) {
      lines.push({
        label: "Left for you",
        value: entry.receipt.left_for_you
          .map(item => `${surfaceTitle(item.surface)} · ${item.reason === "conflict" ? "you edited it" : "needs a manual step"}`)
          .join("; "),
      });
    }
  }
  if (entry.backup_files > 0) {
    const kept = backupCount !== null && backupCount > 0 ? ` · kept with ${plural(backupCount, "backup")}` : "";
    lines.push({ label: "Backup", value: `${plural(entry.backup_files, "file")}${kept}` });
  }
  if (lines.length === 0) lines.push({ label: "Changed", value: "no files" });
  return lines;
}

/**
 * The entry the "Last update" cell is about: the newest update that ran (a run that failed before writing is not one).
 * It may already be undone; the cell then says so and offers no Undo.
 */
export function lastUpdateEntry(history: readonly SetupHistoryEntry[]): SetupHistoryEntry | null {
  return history.find(entry => entry.status !== "failed") ?? null;
}

/** What the History page names a run: the agents (or, for shared files only, the surfaces) it touched. */
function runSubject(entry: SetupHistoryEntry): string {
  const agents = updateAgentsText(entry);
  if (agents) return agents;
  const surfaces = unique(entry.surfaces).map(surfaceTitle);
  return surfaces.length > 0 ? listText(surfaces) : "files";
}

/**
 * "Updated Codex", "Installed Codex", "Removed files" or, for a run that stopped, "Update of Codex". Only the recorded
 * changes decide the verb: a run whose applied changes were all removals says "Removed", all creations "Installed";
 * everything else says "Updated".
 */
export function runTitle(entry: SetupHistoryEntry): string {
  const subject = runSubject(entry);
  if (entry.status === "failed") return `Update of ${subject}`;
  const applied = entry.changes.filter(change => change.applied);
  const all = (kind: string) => applied.length > 0 && applied.every(change => change.kind === kind);
  const verb = all("remove") ? "Removed" : all("create") ? "Installed" : "Updated";
  return `${verb} ${subject}`;
}

/** "Today 15:39 · 2 files" or "Oct 21, 15:39": when it ran, and how many files it wrote when it wrote any. */
export function runMetaText(entry: SetupHistoryEntry, now: Date = new Date()): string {
  const time = updateTimeText(entry, now);
  const millis = nanosToMillis(entry.finished_at) ?? nanosToMillis(entry.created_at);
  const when = time === null ? null : millis !== null && sameDay(new Date(millis), now) ? `Today ${time}` : time;
  const written = entry.changes.filter(change => change.applied).length;
  return [when, written > 0 ? plural(written, "file") : null].filter(Boolean).join(" · ") || "Time not recorded";
}

/** The pill of a run: Done, Undone (quiet outline) or Failed. */
export function runPill(entry: SetupHistoryEntry): { state: "ok" | "tip" | "fix"; text: string } {
  if (entry.status === "rolled_back") return { state: "tip", text: "Undone" };
  if (entry.status === "failed") return { state: "fix", text: "Failed" };
  return { state: "ok", text: "Done" };
}

/**
 * The receipt of one history entry for one agent: the lines of `receiptLines` narrowed to the surfaces that belong to
 * the agent (the shared `skills` surface included, since every agent reads skills). `part` is false when the update
 * did not touch the agent: it names no surface of the agent's own and does not list the agent. The Backup line is
 * left out because the backup is counted for the whole run, not per agent.
 */
export function agentReceipt(entry: SetupHistoryEntry, harness: InstallAgent): { part: boolean; lines: ReceiptLine[] } {
  const own = new Set(HARNESS_SURFACES[harness]);
  const ownOnly = (surface: SetupHistoryEntry["surfaces"][number]) => own.has(surface) && surface !== "skills";
  const changed = entry.changes.filter(change => own.has(change.surface) && change.applied && !change.restored);
  const restored = entry.changes.filter(change => own.has(change.surface) && change.restored);
  const synced = unique((entry.receipt?.synced ?? []).filter(surface => own.has(surface)));
  const left = (entry.receipt?.left_for_you ?? []).filter(item => own.has(item.surface));
  const part =
    entry.harnesses.includes(harness) ||
    entry.changes.some(change => ownOnly(change.surface)) ||
    (entry.receipt?.synced ?? []).some(ownOnly) ||
    (entry.receipt?.left_for_you ?? []).some(item => ownOnly(item.surface));
  if (!part) return { part: false, lines: [] };
  const lines: ReceiptLine[] = [];
  if (changed.length > 0) {
    lines.push({ label: "Changed", value: `${unique(changed.map(change => change.surface)).map(surfaceTitle).join(", ")} · ${plural(changed.length, "file")}` });
  }
  lines.push(...undoneLines(restored));
  if (synced.length > 0) lines.push({ label: "Checked", value: `${synced.map(surfaceTitle).join(", ")} · current` });
  if (left.length > 0) {
    lines.push({
      label: "Left for you",
      value: left.map(item => `${surfaceTitle(item.surface)} · ${item.reason === "conflict" ? "you edited it" : "needs a manual step"}`).join("; "),
    });
  }
  if (lines.length === 0) lines.push({ label: "Changed", value: "no files" });
  return { part: true, lines };
}
