import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoDocFile, RepoGhIssue } from "../src/types";
import {
  classifyDocRole,
  detectCanonicalWorkCanon,
} from "../src/tools/repoDashboard/docRoles";
import {
  isOptionalDocPath,
  mergeWorkItemsDetailed,
  parseDocWorkItems,
  parseDocWorkItemsDetailed,
} from "../src/tools/repoDashboard/docsParser";
import {
  createPromptLoopContextSeed,
  formatRepoDashboardWorkItemContext,
  isPromptContextEligibleWorkItem,
} from "../src/tools/promptLoops/contextHandoff";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(here, "../src/tools/repoDashboard/fixtures", name), "utf8");

function doc(path: string, content: string, overrides: Partial<RepoDocFile> = {}): RepoDocFile {
  return {
    path,
    found: true,
    readable: true,
    truncated: false,
    content,
    ...overrides,
  };
}

// Generic TODO fallback
{
  const todoDoc = doc(
    "docs/TODO.md",
    ["## Section", "- [ ] First task", "- [x] Done task", "1. Numbered gap item"].join("\n"),
  );
  const items = parseDocWorkItems([todoDoc]);
  assert.ok(items.length >= 2, "generic TODO bullets parsed");
  assert.ok(items.some(i => i.text === "First task" && i.status === "open"));
  assert.ok(items.some(i => i.text === "Done task" && i.status === "done"));
}

// Document role classification
assert.equal(classifyDocRole("docs/BACKLOG.md"), "active-work");
assert.equal(classifyDocRole("docs/audit/ISSUES.md"), "active-audit");
assert.equal(classifyDocRole("docs/CURRENT_STATE.md"), "current-state");
assert.equal(classifyDocRole("docs/KNOWN_GAPS.md"), "limitations");
assert.equal(classifyDocRole("docs/ROADMAP.md"), "roadmap");
assert.equal(classifyDocRole("docs/audit/OPEN_QUESTIONS.md"), "open-questions");
assert.equal(classifyDocRole("docs/product/FEATURES.md"), "reference");

const canonFiles: RepoDocFile[] = [
  doc("docs/START_HERE.md", fixture("krets-start-here.md")),
  doc("docs/BACKLOG.md", fixture("krets-backlog.md")),
  doc("docs/audit/ISSUES.md", fixture("krets-audit-issues.md")),
  doc("docs/KNOWN_GAPS.md", fixture("krets-known-gaps.md")),
  doc("docs/ROADMAP.md", fixture("krets-roadmap.md")),
  doc("docs/CURRENT_STATE.md", fixture("krets-current-state.md")),
  doc("docs/audit/OPEN_QUESTIONS.md", fixture("krets-open-questions.md")),
  doc("docs/product/FEATURES.md", fixture("krets-features-snippet.md")),
];

assert.ok(detectCanonicalWorkCanon(canonFiles), "canonical work queue detected");

const canonItems = parseDocWorkItems(canonFiles);
const verifyItems = canonItems.filter(i => i.classification === "verify" && i.canonicalSource === "backlog");
const enhancementItems = canonItems.filter(
  i => i.classification === "enhancement" && i.canonicalSource === "backlog",
);
const bugItems = canonItems.filter(i => i.classification === "bug" && i.canonicalSource === "backlog");
const auditItems = canonItems.filter(i => i.canonicalSource === "audit");

assert.equal(verifyItems.length, 3, "BACKLOG Verify rows parsed");
assert.equal(enhancementItems.length, 4, "BACKLOG Enhancement rows parsed");
assert.equal(bugItems.length, 0, "no open BACKLOG Bugs rows");
assert.equal(auditItems.length, 2, "active audit rows parsed; resolved excluded");
assert.ok(auditItems.some(i => i.workId === "ELCAD-AUD-014" && i.status === "started"));
assert.ok(auditItems.some(i => i.workId === "KRETS-AUD-032" && i.status === "open"));
assert.ok(!auditItems.some(i => i.workId === "KRETS-AUD-099"), "resolved audit row excluded");
assert.ok(auditItems.some(i => i.classification === "verify"));
assert.ok(auditItems.some(i => i.classification === "enhancement"));

assert.equal(
  canonItems.filter(i => i.path.includes("KNOWN_GAPS")).length,
  0,
  "KNOWN_GAPS produces zero Work items",
);
assert.equal(
  canonItems.filter(i => i.path.includes("ROADMAP")).length,
  0,
  "ROADMAP produces zero Work items",
);
assert.equal(
  canonItems.filter(i => i.path.includes("CURRENT_STATE")).length,
  0,
  "CURRENT_STATE produces zero Work items",
);
assert.equal(
  canonItems.filter(i => i.path.includes("FEATURES")).length,
  0,
  "product FEATURES produces zero Work items",
);
assert.equal(
  canonItems.filter(i => i.path.includes("OPEN_QUESTIONS")).length,
  0,
  "OPEN_QUESTIONS produces zero Work items",
);
assert.ok(
  !canonItems.some(i => i.status === "done" && i.source === "docs"),
  "completed implementation descriptions do not become Done Work items",
);
assert.ok(
  !canonItems.some(i => i.text.includes("NOW") && i.text.includes("NEXT")),
  "NOW/NEXT overview rows are not individual work items",
);

// GitHub label mapping and open-only merge
{
  const issues: RepoGhIssue[] = [
    { number: 1, title: "Bug fix", state: "OPEN", labels: ["bug"] },
    { number: 2, title: "Investigate", state: "OPEN", labels: ["needs-repro"] },
    { number: 3, title: "Feature idea", state: "OPEN", labels: ["enhancement"] },
    { number: 4, title: "Closed", state: "closed", labels: ["bug"] },
  ];
  const merged = mergeWorkItemsDetailed(canonFiles, issues);
  const ghItems = merged.items.filter(i => i.source === "issue");
  assert.equal(ghItems.length, 3, "closed GitHub issues excluded");
  assert.ok(ghItems.some(i => i.classification === "bug"));
  assert.ok(ghItems.some(i => i.classification === "verify"));
  assert.ok(ghItems.some(i => i.classification === "enhancement"));
}

// Prompt Loops eligibility and formatted context
{
  const sample = verifyItems[0];
  assert.ok(isPromptContextEligibleWorkItem(sample), "canonical verify item eligible");
  assert.ok(isPromptContextEligibleWorkItem(enhancementItems[0]), "canonical enhancement eligible");
  const ctx = formatRepoDashboardWorkItemContext(sample);
  assert.ok(ctx.includes("KV-V-001"), "context includes work ID");
  assert.ok(ctx.includes("verify"), "context includes classification");
  assert.ok(ctx.includes("Next action"), "context includes next action field");
  const seed = createPromptLoopContextSeed(sample, { seedNonce: 1 });
  assert.ok(seed.taskContext.includes("KV-V-001"));
  assert.equal(createPromptLoopContextSeed(sample, { seedNonce: 1 }).id.split("|").slice(0, -1).join("|"), seed.id.split("|").slice(0, -1).join("|"));
}

assert.equal(isOptionalDocPath("docs/TODO.md"), true);
assert.equal(isOptionalDocPath("docs/BACKLOG.md"), false);

const emptyDoc: RepoDocFile = {
  path: "missing.md",
  found: false,
  readable: false,
  truncated: false,
  content: "",
};
assert.deepEqual(parseDocWorkItemsDetailed([emptyDoc]).items, []);

const truncatedDoc = doc("docs/BACKLOG.md", "- [ ] still parsed", { truncated: true });
const truncated = parseDocWorkItemsDetailed([truncatedDoc]);
assert.ok(truncated.warnings.some(w => w.includes("truncated")));

const unreadableDoc: RepoDocFile = {
  path: "docs/ROADMAP.md",
  found: true,
  readable: false,
  truncated: false,
  content: "",
  read_error: "read docs/ROADMAP.md: permission denied",
};
assert.deepEqual(parseDocWorkItemsDetailed([unreadableDoc]).items, []);

console.log("Repo Dashboard docs parser checks passed");
