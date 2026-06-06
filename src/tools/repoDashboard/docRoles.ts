import type { RepoDocFile } from "../../types";

/** Canonical documentation role inferred from path and content signals. */
export type DocRole =
  | "active-work"
  | "active-audit"
  | "current-state"
  | "limitations"
  | "roadmap"
  | "open-questions"
  | "reference"
  | "unknown";

const CANONICAL_PATH_ROLES: ReadonlyArray<{ pattern: RegExp; role: DocRole }> = [
  { pattern: /^docs\/START_HERE\.md$/i, role: "reference" },
  { pattern: /^docs\/BACKLOG\.md$/i, role: "active-work" },
  { pattern: /^docs\/audit\/ISSUES\.md$/i, role: "active-audit" },
  { pattern: /^docs\/CURRENT_STATE\.md$/i, role: "current-state" },
  { pattern: /^docs\/KNOWN_GAPS\.md$/i, role: "limitations" },
  { pattern: /^docs\/ROADMAP\.md$/i, role: "roadmap" },
  { pattern: /^docs\/audit\/OPEN_QUESTIONS\.md$/i, role: "open-questions" },
];

const ACTIVE_WORK_ROLES = new Set<DocRole>(["active-work", "active-audit"]);

export function normalizeDocPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function classifyDocRole(path: string, _content = ""): DocRole {
  const normalized = normalizeDocPath(path);
  for (const entry of CANONICAL_PATH_ROLES) {
    if (entry.pattern.test(normalized)) return entry.role;
  }
  if (/^docs\/product\/.+\.md$/i.test(normalized)) return "reference";
  if (/^docs\/.+\.md$/i.test(normalized)) return "reference";
  return "unknown";
}

/** True when the repository declares a Kretsverket-style active work queue. */
export function detectCanonicalWorkCanon(files: readonly RepoDocFile[]): boolean {
  const backlog = files.find(
    f =>
      f.found &&
      f.readable &&
      normalizeDocPath(f.path).toLowerCase() === "docs/backlog.md" &&
      f.content.trim().length > 0,
  );
  if (!backlog) return false;
  const lower = backlog.content.toLowerCase();
  if (/\bcanonical queue\b/.test(lower)) return true;
  if (/\bconcrete active work\b/.test(lower)) return true;
  const startHere = files.find(
    f =>
      f.found &&
      f.readable &&
      normalizeDocPath(f.path).toLowerCase() === "docs/start_here.md",
  );
  if (startHere) {
    const sh = startHere.content.toLowerCase();
    if (sh.includes("backlog.md") && /\bactive work\b/.test(sh)) return true;
  }
  return /\b##\s+(bugs|verify|enhancements)\b/i.test(backlog.content);
}

export function isActiveWorkDocRole(role: DocRole): boolean {
  return ACTIVE_WORK_ROLES.has(role);
}

export function docRoleLabel(role: DocRole, path = ""): string {
  if (normalizeDocPath(path).toLowerCase() === "docs/start_here.md") return "Guide";
  switch (role) {
    case "active-work":
      return "Active work";
    case "active-audit":
      return "Audit";
    case "current-state":
      return "Current state";
    case "limitations":
      return "Limitations";
    case "roadmap":
      return "Roadmap";
    case "open-questions":
      return "Open questions";
    case "reference":
      return "Reference";
    default:
      return "Reference";
  }
}

/** Sort key for canonical docs (lower = earlier). Non-canonical docs sort after. */
export function docRoleSortKey(path: string, role: DocRole): number {
  const normalized = normalizeDocPath(path).toLowerCase();
  const explicit: Record<string, number> = {
    "docs/start_here.md": 1,
    "docs/backlog.md": 2,
    "docs/current_state.md": 3,
    "docs/known_gaps.md": 4,
    "docs/roadmap.md": 5,
    "docs/audit/issues.md": 6,
    "docs/audit/open_questions.md": 7,
  };
  if (normalized in explicit) return explicit[normalized];
  if (role === "reference" && normalized.startsWith("docs/")) return 50;
  return 100;
}

export function compareDocsByRole(
  a: { path: string; role: DocRole },
  b: { path: string; role: DocRole },
): number {
  const order = docRoleSortKey(a.path, a.role) - docRoleSortKey(b.path, b.role);
  if (order !== 0) return order;
  return a.path.localeCompare(b.path);
}
