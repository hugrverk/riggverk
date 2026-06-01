import type {
  RepoDashboardWorkItem,
  RepoDashboardWorkStatus,
  RepoDashboardWorkType,
  RepoDocFile,
  RepoGhIssue,
} from "../../types";

export type WorkItemConfidence = "high" | "medium" | "low";

export interface DocParseResult {
  items: RepoDashboardWorkItem[];
  warnings: string[];
}

const ACTIONABLE_SECTION =
  /\b(active queue|backlog|gap|gaps|todo|open questions?|limitations?|missing validation|candidate tasks|work queue|planned|partial|validation)\b/i;

const SKIP_SECTION =
  /\b(non-goals?|risk notes?|goals?:|acceptance criteria|how to use|what it does|intended behavior|recently completed|reference only|when to run)\b/i;

const OPTIONAL_DOC_PATHS = new Set([
  "docs/FEATURES.md",
  "docs/TODO.md",
]);

function classify(text: string, path: string, section: string): RepoDashboardWorkType {
  const s = `${text} ${section} ${path}`.toLowerCase();
  if (path.includes("KNOWN_GAPS") || path.includes("known-gaps") || /\bgap\b/.test(s)) return "gap";
  if (path.includes("BACKLOG") || path.includes("backlog") || /\bbl-\d+/i.test(text)) return "todo";
  if (path.includes("ROADMAP") || path.includes("roadmap") || /\bphase\b/.test(s)) return "roadmap";
  if (path.includes("VALIDATION") || path.includes("validation") || /\baudit\b/.test(s)) return "fix";
  if (path.includes("FEATURES") || path.includes("features") || /\bfeature\b/.test(s)) return "feature";
  if (/\btodo\b/.test(s)) return "todo";
  if (/\bbug\b/.test(s) || /\bfix\b/.test(s)) return "fix";
  return "note";
}

function needsPlan(text: string, status: RepoDashboardWorkStatus): boolean {
  if (status === "done") return false;
  return /\b(unclear|oklar|tbd|needs plan|needs planning|planering|beslut|decision|fråga|question|blocked|blocker|verify-only)\b/i.test(
    text,
  );
}

function statusFromMarker(marker: string, text: string): RepoDashboardWorkStatus {
  const low = text.toLowerCase();
  if (marker.includes("x") || /\b(done|complete|completed|klart|klar|resolved|archived)\b/.test(low)) {
    return "done";
  }
  if (marker.includes("~") || marker.includes(">") || /\b(started|påbörjad|wip|in progress)\b/.test(low)) {
    return "started";
  }
  return "open";
}

function statusFromTableCell(statusRaw: string, rowText: string): RepoDashboardWorkStatus {
  const status = statusRaw.trim().toLowerCase();
  if (!status) return statusFromMarker("", rowText);
  if (
    /\b(done|completed|klart|klar|resolved|archived|implemented)\b/.test(status) &&
    !/\b(partial|partially|open|planned|blocked|verify)\b/.test(status)
  ) {
    return "done";
  }
  if (/\bpartial/.test(status) || /\b(started|wip|in progress|verify-only)\b/.test(status)) {
    return "started";
  }
  if (/\b(open|planned|blocked|backlog|future|gap|missing)\b/.test(status)) {
    return "open";
  }
  return statusFromMarker("", `${status} ${rowText}`);
}

function statusFromFeatureLine(line: string): RepoDashboardWorkStatus | null {
  const m = line.match(/^Status:\s*(.+)$/i);
  if (!m) return null;
  return statusFromTableCell(m[1], m[1]);
}

function isPipeTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.includes("|");
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(c => c.trim());
}

function findColumnIndex(headers: string[], names: string[]): number {
  const lower = headers.map(h => h.toLowerCase());
  for (const name of names) {
    const idx = lower.findIndex(h => h === name || h.includes(name));
    if (idx >= 0) return idx;
  }
  return -1;
}

function tableRowToText(cells: string[], titleIdx: number, statusIdx: number): string {
  const title = titleIdx >= 0 ? cells[titleIdx] ?? "" : cells[0] ?? "";
  const status = statusIdx >= 0 ? cells[statusIdx] ?? "" : "";
  const id = cells.find(c => /^[A-Z]{2,}-\d+$/i.test(c)) ?? "";
  const parts = [id, title, status].filter(Boolean);
  return parts.join(" · ").replace(/\s+/g, " ").trim();
}

function bulletPathsAllowed(path: string): boolean {
  const p = path.toLowerCase();
  if (/keyboard_shortcuts|limitations|workflows|glossary|architecture|domain_model|decisions|current_state|validation\.md|roadmap\.md/i.test(p)) {
    return false;
  }
  if (p.includes("docs/product/") && !p.includes("limitations")) return false;
  return (
    p.includes("backlog") ||
    p.includes("known_gaps") ||
    p.includes("todo") ||
    p.includes("open_questions") ||
    p.includes("issues.md") ||
    p.includes("readme")
  );
}

function shouldSkipBullet(section: string, text: string, path: string): boolean {
  if (!bulletPathsAllowed(path)) return true;
  if (SKIP_SECTION.test(section)) return true;
  const low = text.toLowerCase();
  if (low.length < 4) return true;
  if (/^(see |for |refer to |maintain |keep )/.test(low)) return true;
  if (/^https?:\/\//.test(low)) return true;
  if (!ACTIONABLE_SECTION.test(section) && !ACTIONABLE_SECTION.test(path)) {
    if (!path.includes("TODO") && !path.includes("todo")) return true;
  }
  return false;
}

function isActionableTable(headers: string[]): boolean {
  if (findColumnIndex(headers, ["status", "state", "resolution"]) >= 0) return true;
  const h = headers.join(" ").toLowerCase();
  if (findColumnIndex(headers, ["gap", "id"]) >= 0 && h.includes("notes")) return true;
  return false;
}

function pushItem(
  out: RepoDashboardWorkItem[],
  file: RepoDocFile,
  opts: {
    line: number;
    text: string;
    section: string;
    type?: RepoDashboardWorkType;
    status: RepoDashboardWorkStatus;
    confidence: WorkItemConfidence;
  },
): void {
  const text = opts.text.replace(/\s+/g, " ").trim();
  if (!text || text.length < 3) return;
  const section = opts.section.trim();
  const type = opts.type ?? classify(text, file.path, section);
  const status = opts.status;
  out.push({
    source: "docs",
    path: file.path,
    line: opts.line,
    text,
    type,
    status,
    needsPlan: needsPlan(`${section} ${text}`, status),
    section: section || undefined,
    confidence: opts.confidence,
  });
}

function parseMarkdownTables(file: RepoDocFile, out: RepoDashboardWorkItem[]): void {
  const lines = file.content.split("\n");
  let headers: string[] | null = null;
  let titleIdx = -1;
  let statusIdx = -1;
  let section = "";

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) {
      section = heading[2].trim();
      headers = null;
      continue;
    }
    if (SKIP_SECTION.test(section)) {
      headers = null;
      continue;
    }
    if (!isPipeTableRow(line)) {
      headers = null;
      continue;
    }
    if (isTableSeparator(line)) continue;

    const cells = splitTableRow(line);
    if (!headers) {
      headers = cells;
      if (!isActionableTable(headers)) {
        headers = null;
        continue;
      }
      titleIdx = findColumnIndex(headers, ["gap", "id", "title", "area", "feature"]);
      statusIdx = findColumnIndex(headers, ["status", "state", "resolution"]);
      if (titleIdx < 0) titleIdx = 0;
      continue;
    }

    if (cells.every(c => !c || /^—+$/.test(c))) continue;

    const text = tableRowToText(cells, titleIdx, statusIdx);
    if (!text || text.length < 3) continue;

    const statusCell = statusIdx >= 0 ? cells[statusIdx] ?? "" : "";
    const status = statusFromTableCell(statusCell, text);
    pushItem(out, file, {
      line: index + 1,
      text,
      section,
      status,
      confidence: "high",
    });
  }
}

function parseFeatureStatusBlocks(file: RepoDocFile, out: RepoDashboardWorkItem[]): void {
  if (!/product\/features\.md$/i.test(file.path) && !/docs\/features\.md$/i.test(file.path)) return;
  const lines = file.content.split("\n");
  let section = "";
  let featureTitle = "";
  let pendingStatus: RepoDashboardWorkStatus | null = null;
  let statusLine = 0;

  const flush = () => {
    if (!featureTitle || !pendingStatus) return;
    pushItem(out, file, {
      line: statusLine,
      text: `${featureTitle} — ${pendingStatus === "done" ? "Implemented" : pendingStatus === "started" ? "Partial" : "Planned"}`,
      section,
      type: "feature",
      status: pendingStatus,
      confidence: "medium",
    });
    pendingStatus = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      flush();
      featureTitle = h2[1].trim();
      section = featureTitle;
      pendingStatus = null;
      continue;
    }
    const st = statusFromFeatureLine(line);
    if (st && featureTitle) {
      pendingStatus = st;
      statusLine = index + 1;
    }
  }
  flush();
}

function parseBullets(file: RepoDocFile, out: RepoDashboardWorkItem[]): void {
  let section = "";
  file.content.split("\n").forEach((line, index) => {
    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) {
      section = heading[2].trim();
      return;
    }

    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(\[[ xX~!>-]\]\s*)?(.+)/);
    if (!bullet) return;

    const marker = (bullet[1] ?? "").toLowerCase();
    const text = bullet[2].trim().replace(/\s+/g, " ");
    if (shouldSkipBullet(section, text, file.path)) return;

    const context = `${section} ${text} ${file.path}`.toLowerCase();
    pushItem(out, file, {
      line: index + 1,
      text,
      section,
      status: statusFromMarker(marker, context),
      confidence: ACTIONABLE_SECTION.test(section) ? "medium" : "low",
    });
  });
}

export function parseDocWorkItems(files: RepoDocFile[]): RepoDashboardWorkItem[] {
  return parseDocWorkItemsDetailed(files).items;
}

export function parseDocWorkItemsDetailed(files: RepoDocFile[]): DocParseResult {
  const out: RepoDashboardWorkItem[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    if (!file.found || !file.content) continue;
    if (file.error) {
      warnings.push(`${file.path}: ${file.error}`);
    }
    parseMarkdownTables(file, out);
    parseFeatureStatusBlocks(file, out);
    parseBullets(file, out);
  }

  return { items: dedupeDocItems(out), warnings };
}

function dedupeDocItems(items: RepoDashboardWorkItem[]): RepoDashboardWorkItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = workItemDedupKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isOptionalDocPath(path: string): boolean {
  return OPTIONAL_DOC_PATHS.has(path);
}

export function parseIssueWorkItems(issues: RepoGhIssue[]): RepoDashboardWorkItem[] {
  return issues.map(issue => {
    const labels = issue.labels.join(" ");
    const context = `${issue.title} ${labels}`.toLowerCase();
    const status: RepoDashboardWorkStatus = issue.state.toLowerCase() === "closed" ? "done" : "open";
    return {
      source: "issue",
      path: `issue #${issue.number}`,
      text: `#${issue.number} ${issue.title}`,
      type: classify(context, "github", ""),
      status,
      needsPlan: needsPlan(context, status),
      confidence: "high",
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

export function mergeWorkItemsDetailed(
  docs: RepoDocFile[],
  issues: RepoGhIssue[],
): { items: RepoDashboardWorkItem[]; parserWarnings: string[] } {
  const docResult = parseDocWorkItemsDetailed(docs);
  const seen = new Set<string>();
  const merged = [...docResult.items, ...parseIssueWorkItems(issues)];
  const items = merged.filter(item => {
    const key = workItemDedupKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { items, parserWarnings: docResult.warnings };
}
