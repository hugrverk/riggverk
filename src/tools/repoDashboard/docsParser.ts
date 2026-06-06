import type {
  RepoDashboardWorkClassification,
  RepoDashboardWorkItem,
  RepoDashboardWorkStatus,
  RepoDashboardWorkType,
  RepoDocFile,
  RepoGhIssue,
} from "../../types";
import {
  classifyDocRole,
  detectCanonicalWorkCanon,
  isActiveWorkDocRole,
  normalizeDocPath,
  type DocRole,
} from "./docRoles";

export type WorkItemConfidence = "high" | "medium" | "low";

export interface DocParseResult {
  items: RepoDashboardWorkItem[];
  warnings: string[];
}

const OPTIONAL_DOC_PATHS = new Set([
  "docs/FEATURES.md",
  "docs/TODO.md",
]);

const SKIP_SECTION =
  /\b(non-goals?|risk notes?|goals?:|acceptance criteria|how to use|what it does|intended behavior|recently completed|reference only|when to run|queue rules|classification)\b/i;

const GENERIC_ACTIONABLE_SECTION =
  /\b(active queue|todo|open questions?|work queue|planned|partial|validation)\b/i;

// --- Markdown table helpers ---

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

export function normalizeMarkdownLinkText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cellValue(cells: string[], idx: number): string {
  if (idx < 0) return "";
  return normalizeMarkdownLinkText(cells[idx] ?? "");
}

// --- Status and classification ---

function mapAuditClassification(raw: string): RepoDashboardWorkClassification {
  const low = raw.trim().toLowerCase();
  if (low === "bug") return "bug";
  if (low === "verify") return "verify";
  if (low === "enhancement") return "enhancement";
  return "other";
}

function mapAuditStatus(raw: string): RepoDashboardWorkStatus | null {
  const low = raw.trim().toLowerCase();
  if (/\b(resolved|completed|closed|done)\b/.test(low) && !/\bpartial/.test(low)) {
    return null;
  }
  if (/\bpartially resolved\b/.test(low) || /\bin progress\b/.test(low)) return "started";
  if (/\bverify-only\b/.test(low) || low === "open") return "open";
  if (/\bopen\b/.test(low)) return "open";
  return "open";
}

function mapIssueLabels(labels: string[]): RepoDashboardWorkClassification {
  const joined = labels.join(" ").toLowerCase();
  if (/\bbug\b/.test(joined)) return "bug";
  if (/\b(verify|needs-repro|investigation)\b/.test(joined)) return "verify";
  if (/\b(enhancement|feature|improvement)\b/.test(joined)) return "enhancement";
  return "other";
}

function legacyTypeFromClassification(c: RepoDashboardWorkClassification): RepoDashboardWorkType {
  switch (c) {
    case "bug":
      return "fix";
    case "verify":
      return "fix";
    case "enhancement":
      return "todo";
    default:
      return "note";
  }
}

function needsPlan(text: string, status: RepoDashboardWorkStatus): boolean {
  if (status === "done") return false;
  return /\b(unclear|oklar|tbd|needs plan|needs planning|planering|beslut|decision|fråga|question|blocked|blocker)\b/i.test(
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

function backlogSectionKind(section: string): RepoDashboardWorkClassification | null {
  const low = section.toLowerCase();
  if (/\bbugs\b/.test(low)) return "bug";
  if (/\bverify\b/.test(low)) return "verify";
  if (/\benhancements?\b/.test(low)) return "enhancement";
  return null;
}

function isBacklogOverviewSection(section: string): boolean {
  return /\b(now\s*\/\s*next\s*\/\s*later|horizon|focus)\b/i.test(section);
}

function isEmptyStateProse(line: string): boolean {
  return /\bno confirmed open bugs\b/i.test(line);
}

// --- Canonical BACKLOG parser ---

function parseCanonicalBacklog(file: RepoDocFile, out: RepoDashboardWorkItem[]): void {
  const lines = file.content.split("\n");
  let section = "";
  let headers: string[] | null = null;
  let sectionKind: RepoDashboardWorkClassification | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) {
      section = heading[2].trim();
      headers = null;
      sectionKind = backlogSectionKind(section);
      continue;
    }

    if (isEmptyStateProse(line)) continue;
    if (isBacklogOverviewSection(section)) continue;
    if (SKIP_SECTION.test(section)) {
      headers = null;
      continue;
    }
    if (!sectionKind) {
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
      continue;
    }

    if (cells.every(c => !c || /^—+$/.test(c))) continue;

    const idIdx = findColumnIndex(headers, ["id"]);
    const priorityIdx = findColumnIndex(headers, ["priority"]);
    const areaIdx = findColumnIndex(headers, ["area"]);
    const evidenceIdx = findColumnIndex(headers, [
      "evidence",
      "evidence / question",
      "evidence or question",
      "evidence or problem",
      "bounded outcome",
    ]);
    const ownerIdx = findColumnIndex(headers, ["owner files", "owner files / docs", "owner"]);
    const nextIdx = findColumnIndex(headers, ["next action", "next slice"]);
    const verifyIdx = findColumnIndex(headers, ["verification"]);

    const workId = cellValue(cells, idIdx);
    if (!workId) continue;

    const area = cellValue(cells, areaIdx);
    const evidence = cellValue(cells, evidenceIdx);
    const title = evidence || workId;
    const priority = cellValue(cells, priorityIdx);
    const ownerFiles = cellValue(cells, ownerIdx);
    const nextAction = cellValue(cells, nextIdx);
    const verification = cellValue(cells, verifyIdx);

    out.push({
      source: "docs",
      path: file.path,
      line: index + 1,
      text: title,
      type: legacyTypeFromClassification(sectionKind),
      status: "open",
      needsPlan: needsPlan(`${section} ${title}`, "open"),
      section,
      confidence: "high",
      workId,
      classification: sectionKind,
      priority: priority || undefined,
      area: area || undefined,
      nextAction: nextAction || undefined,
      verification: verification || undefined,
      ownerFiles: ownerFiles || undefined,
      docRole: "active-work",
      canonicalSource: "backlog",
    });
  }
}

// --- Canonical audit ISSUES parser ---

function parseAuditIssues(file: RepoDocFile, out: RepoDashboardWorkItem[]): void {
  const lines = file.content.split("\n");
  let headers: string[] | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!isPipeTableRow(line)) {
      headers = null;
      continue;
    }
    if (isTableSeparator(line)) continue;

    const cells = splitTableRow(line);
    if (!headers) {
      headers = cells;
      const idIdx = findColumnIndex(headers, ["id"]);
      if (idIdx < 0) {
        headers = null;
      }
      continue;
    }

    if (cells.every(c => !c || /^—+$/.test(c))) continue;

    const idIdx = findColumnIndex(headers, ["id"]);
    const severityIdx = findColumnIndex(headers, ["severity"]);
    const statusIdx = findColumnIndex(headers, ["status"]);
    const classIdx = findColumnIndex(headers, ["classification"]);
    const titleIdx = findColumnIndex(headers, ["title"]);
    const filesIdx = findColumnIndex(headers, ["primary files", "owner files"]);
    const nextIdx = findColumnIndex(headers, ["next slice", "next action"]);

    const rawId = cellValue(cells, idIdx);
    const workId = rawId.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
    if (!workId) continue;

    const statusRaw = cellValue(cells, statusIdx);
    const status = mapAuditStatus(statusRaw);
    if (!status) continue;

    const classification = mapAuditClassification(cellValue(cells, classIdx));
    const title = cellValue(cells, titleIdx) || workId;
    const priority = cellValue(cells, severityIdx);
    const ownerFiles = cellValue(cells, filesIdx);
    const nextAction = cellValue(cells, nextIdx);

    out.push({
      source: "docs",
      path: file.path,
      line: index + 1,
      text: title,
      type: legacyTypeFromClassification(classification),
      status,
      needsPlan: needsPlan(`${title} ${statusRaw}`, status),
      section: "Audit Issues",
      confidence: "high",
      workId,
      classification,
      priority: priority || undefined,
      ownerFiles: ownerFiles || undefined,
      nextAction: nextAction || undefined,
      docRole: "active-audit",
      canonicalSource: "audit",
    });
  }
}

// --- Generic fallback parsers ---

function isActionableTable(headers: string[]): boolean {
  if (findColumnIndex(headers, ["status", "state", "resolution"]) >= 0) return true;
  const h = headers.join(" ").toLowerCase();
  if (findColumnIndex(headers, ["gap", "id"]) >= 0 && h.includes("notes")) return true;
  return false;
}

function pushGenericItem(
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
  out.push({
    source: "docs",
    path: file.path,
    line: opts.line,
    text,
    type: opts.type ?? "note",
    status: opts.status,
    needsPlan: needsPlan(`${opts.section} ${text}`, opts.status),
    section: opts.section.trim() || undefined,
    confidence: opts.confidence,
  });
}

function parseGenericMarkdownTables(file: RepoDocFile, out: RepoDashboardWorkItem[]): void {
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

    const title = titleIdx >= 0 ? cells[titleIdx] ?? "" : cells[0] ?? "";
    const statusCell = statusIdx >= 0 ? cells[statusIdx] ?? "" : "";
    const id = cells.find(c => /^[A-Z]{2,}-\d+$/i.test(c)) ?? "";
    const text = [id, title, statusCell].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
    if (!text || text.length < 3) continue;

    const status = statusFromTableCell(statusCell, text);
    pushGenericItem(out, file, {
      line: index + 1,
      text,
      section,
      status,
      confidence: "high",
    });
  }
}

function shouldSkipGenericBullet(section: string, text: string, path: string): boolean {
  if (SKIP_SECTION.test(section)) return true;
  const low = text.toLowerCase();
  if (low.length < 4) return true;
  if (/^(see |for |refer to |maintain |keep )/.test(low)) return true;
  if (/^https?:\/\//.test(low)) return true;
  if (/readme\.md$/i.test(path) && /\[.+?\]\([^)]+\)/.test(text.trim())) return true;
  if (!GENERIC_ACTIONABLE_SECTION.test(section) && !GENERIC_ACTIONABLE_SECTION.test(path)) {
    if (!path.includes("TODO") && !path.includes("todo")) return true;
  }
  return false;
}

function parseGenericBullets(file: RepoDocFile, out: RepoDashboardWorkItem[]): void {
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
    if (shouldSkipGenericBullet(section, text, file.path)) return;

    const context = `${section} ${text} ${file.path}`.toLowerCase();
    pushGenericItem(out, file, {
      line: index + 1,
      text,
      section,
      status: statusFromMarker(marker, context),
      confidence: GENERIC_ACTIONABLE_SECTION.test(section) ? "medium" : "low",
    });
  });
}

function parseFileCanonical(
  file: RepoDocFile,
  role: DocRole,
  out: RepoDashboardWorkItem[],
): void {
  const path = normalizeDocPath(file.path);
  if (role === "active-work") {
    parseCanonicalBacklog(file, out);
    return;
  }
  if (role === "active-audit") {
    parseAuditIssues(file, out);
    return;
  }
  if (isActiveWorkDocRole(role)) return;
  if (role === "limitations" || role === "roadmap" || role === "current-state" || role === "open-questions") {
    return;
  }
  if (role === "reference" && /product\/features\.md$/i.test(path)) {
    return;
  }
}

function parseFileGeneric(file: RepoDocFile, out: RepoDashboardWorkItem[]): void {
  parseGenericMarkdownTables(file, out);
  parseGenericBullets(file, out);
}

export function parseDocWorkItems(files: RepoDocFile[]): RepoDashboardWorkItem[] {
  return parseDocWorkItemsDetailed(files).items;
}

export function parseDocWorkItemsDetailed(files: RepoDocFile[]): DocParseResult {
  const out: RepoDashboardWorkItem[] = [];
  const warnings: string[] = [];
  const canonical = detectCanonicalWorkCanon(files);

  for (const file of files) {
    if (!file.found || !file.readable || !file.content) continue;
    if (file.truncated) {
      warnings.push(`${file.path}: content truncated at load limit`);
    }
    if (file.read_error) {
      warnings.push(`${file.path}: ${file.read_error}`);
    }

    const role = classifyDocRole(file.path, file.content);
    const path = normalizeDocPath(file.path);

    if (canonical) {
      if (isActiveWorkDocRole(role)) {
        parseFileCanonical(file, role, out);
      } else if (role !== "reference" && role !== "unknown") {
        // Intentionally excluded from Work — no warning needed for known non-work roles.
      } else if (/todo\.md$/i.test(path)) {
        parseFileGeneric(file, out);
      } else if (GENERIC_ACTIONABLE_SECTION.test(file.content) && /todo/i.test(path)) {
        parseFileGeneric(file, out);
      }
    } else {
      parseFileGeneric(file, out);
    }
  }

  if (canonical) {
    const hasBacklog = files.some(
      f => f.found && normalizeDocPath(f.path).toLowerCase() === "docs/backlog.md",
    );
    if (hasBacklog) {
      const backlogItems = out.filter(i => i.canonicalSource === "backlog");
      if (!backlogItems.length) {
        warnings.push(
          "docs/BACKLOG.md: canonical active-work source detected but no queue rows were parsed",
        );
      }
    }
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
    const classification = mapIssueLabels(issue.labels);
    return {
      source: "issue",
      path: `issue #${issue.number}`,
      text: `#${issue.number} ${issue.title}`,
      type: legacyTypeFromClassification(classification),
      status,
      needsPlan: needsPlan(context, status),
      confidence: "high",
      workId: `#${issue.number}`,
      classification,
      canonicalSource: "github",
    };
  });
}

function workItemDedupKey(item: RepoDashboardWorkItem): string {
  if (item.workId && item.canonicalSource) {
    return `${item.canonicalSource}|${item.workId}`;
  }
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
  const openIssues = issues.filter(i => i.state.toLowerCase() !== "closed");
  const seen = new Set<string>();
  const merged = [...docResult.items, ...parseIssueWorkItems(openIssues)];
  const items = merged.filter(item => {
    if (item.status === "done") return false;
    const key = workItemDedupKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { items, parserWarnings: docResult.warnings };
}

