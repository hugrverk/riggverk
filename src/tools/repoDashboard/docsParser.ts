import type {
  RepoDashboardWorkItem,
  RepoDashboardWorkStatus,
  RepoDashboardWorkType,
  RepoDocFile,
  RepoGhIssue,
} from "../../types";

function classify(text: string): RepoDashboardWorkType {
  const s = text.toLowerCase();
  if (s.includes("gap")) return "gap";
  if (s.includes("feature") || s.includes("feat")) return "feature";
  if (s.includes("roadmap")) return "roadmap";
  if (s.includes("todo")) return "todo";
  if (s.includes("bug") || s.includes("fix")) return "fix";
  return "note";
}

function needsPlan(text: string): boolean {
  return /\b(unclear|oklar|tbd|todo|needs plan|needs planning|planering|beslut|decision|fråga|question|blocked|blocker)\b/i.test(
    text,
  );
}

function statusFromMarker(marker: string, text: string): RepoDashboardWorkStatus {
  const low = text.toLowerCase();
  if (marker.includes("x") || /\b(done|complete|completed|klart|klar)\b/.test(low)) return "done";
  if (marker.includes("~") || marker.includes(">") || /\b(started|påbörjad|wip|in progress)\b/.test(low)) {
    return "started";
  }
  return "open";
}

export function parseDocWorkItems(files: RepoDocFile[]): RepoDashboardWorkItem[] {
  const out: RepoDashboardWorkItem[] = [];

  for (const file of files) {
    if (!file.found || !file.content) continue;
    let section = "";
    file.content.split("\n").forEach((line, index) => {
      const heading = line.match(/^(#{1,4})\s+(.+)/);
      if (heading) section = heading[2].trim();

      const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(\[[ xX~!>-]\]\s*)?(.+)/);
      if (!bullet) return;

      const marker = (bullet[1] ?? "").toLowerCase();
      const text = bullet[2].trim().replace(/\s+/g, " ");
      if (!text) return;

      const context = `${section} ${text} ${file.path}`.toLowerCase();
      out.push({
        source: "docs",
        path: file.path,
        line: index + 1,
        text,
        type: classify(context),
        status: statusFromMarker(marker, context),
        needsPlan: needsPlan(context),
      });
    });
  }

  return out;
}

export function parseIssueWorkItems(issues: RepoGhIssue[]): RepoDashboardWorkItem[] {
  return issues.map(issue => {
    const labels = issue.labels.join(" ");
    const context = `${issue.title} ${labels}`.toLowerCase();
    return {
      source: "issue",
      path: `issue #${issue.number}`,
      text: `#${issue.number} ${issue.title}`,
      type: classify(context),
      status: issue.state === "closed" ? "done" : "open",
      needsPlan: needsPlan(context),
    };
  });
}

function workItemDedupKey(item: RepoDashboardWorkItem): string {
  return `${item.source}|${item.path}|${item.line ?? 0}|${item.text}`;
}

export function mergeWorkItems(
  docs: RepoDocFile[],
  issues: RepoGhIssue[],
): RepoDashboardWorkItem[] {
  const seen = new Set<string>();
  const merged = [...parseDocWorkItems(docs), ...parseIssueWorkItems(issues)];
  return merged.filter(item => {
    const key = workItemDedupKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
