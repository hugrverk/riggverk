import assert from "node:assert/strict";
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

const FIXTURE_START_HERE = `# Start Here

Navigation entrypoint for contributors and coding agents.

## Status model

| Question | Canonical owner |
| --- | --- |
| What concrete work is active? | [BACKLOG.md](BACKLOG.md) |
| What exists now? | [CURRENT_STATE.md](CURRENT_STATE.md) |
`;

const FIXTURE_BACKLOG = `# Backlog

Canonical queue for **concrete active work**.

## NOW / NEXT / LATER

| Horizon | Focus |
| --- | --- |
| **NOW** | Close verification items. |
| **NEXT** | Improve bounded editing. |

## Bugs

No confirmed open bugs are currently documented.

## Verify

| ID | Priority | Area | Evidence / question | Owner files | Next action | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| PROJECT-V-001 | Medium | Module A | Suspected jitter on target hardware. | \`moduleA.ts\` | Reproduce before changing code. | Manual sweep |
| PROJECT-V-002 | Medium | Build | Native smoke still needs coverage. | \`src/\` | Run focused smoke. | \`npm test\` |
| PROJECT-V-003 | Low | Export | Automated export coverage is incomplete. | \`export.ts\` | Exercise edge cases. | Unit tests |

## Enhancements

| ID | Priority | Area | Bounded outcome | Owner files / docs | Verification |
| --- | --- | --- | --- | --- | --- |
| PROJECT-E-001 | Medium | Accessibility | Extend keyboard editing. | \`nav.tsx\` | Focused keyboard tests |
| PROJECT-E-002 | High | Core | Add explicit snapping. | \`snap.ts\` | Unit and browser smoke |
| PROJECT-E-003 | Medium | Pipeline | Improve deterministic quality. | \`src/pipeline/\` | Vitest fixtures |
| PROJECT-E-004 | Low | Validation | Add targeted visual regression. | \`tests/\` | Bounded screenshots |

## Queue rules

1. Do not add completed work or batch ledgers.
`;

const FIXTURE_AUDIT_ISSUES = `# Audit Issues

Active audit findings with concrete evidence.

| ID | Severity | Status | Classification | Title | Primary files | Next slice |
| --- | --- | --- | --- | --- | --- | --- |
| PROJECT-AUD-014 | Medium | Partially resolved | Enhancement | Targeted visual regression | \`playwright.config.ts\` | Add stable fixtures |
| PROJECT-AUD-032 | Medium | Verify-only | Verify | Hardware-specific behavior | \`moduleA.ts\` | Reproduce through PROJECT-V-001 |
| PROJECT-AUD-099 | Low | Resolved | Bug | Legacy resolved finding | \`old.ts\` | Closed |
`;

const FIXTURE_KNOWN_GAPS = `# Known Gaps

Current limitations. This file is not an active work queue.

| Area | Current boundary |
| --- | --- |
| Model | No inferred netlist. |
`;

const FIXTURE_ROADMAP = `# Roadmap

Future direction only — not active work.

## Phase 2

Planned improvements for a later release.
`;

const FIXTURE_CURRENT_STATE = `# Current State

Implemented behavior as of today. Not an active work queue.
`;

const FIXTURE_OPEN_QUESTIONS = `# Open Questions

Undecided topics. Not active work.
`;

const FIXTURE_FEATURES = `# Features

Reference product documentation. Not active work.
`;

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
  doc("docs/START_HERE.md", FIXTURE_START_HERE),
  doc("docs/BACKLOG.md", FIXTURE_BACKLOG),
  doc("docs/audit/ISSUES.md", FIXTURE_AUDIT_ISSUES),
  doc("docs/KNOWN_GAPS.md", FIXTURE_KNOWN_GAPS),
  doc("docs/ROADMAP.md", FIXTURE_ROADMAP),
  doc("docs/CURRENT_STATE.md", FIXTURE_CURRENT_STATE),
  doc("docs/audit/OPEN_QUESTIONS.md", FIXTURE_OPEN_QUESTIONS),
  doc("docs/product/FEATURES.md", FIXTURE_FEATURES),
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
assert.ok(auditItems.some(i => i.workId === "PROJECT-AUD-014" && i.status === "started"));
assert.ok(auditItems.some(i => i.workId === "PROJECT-AUD-032" && i.status === "open"));
assert.ok(!auditItems.some(i => i.workId === "PROJECT-AUD-099"), "resolved audit row excluded");
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

// Prompt Builder eligibility and formatted context
{
  const sample = verifyItems[0];
  assert.ok(isPromptContextEligibleWorkItem(sample), "canonical verify item eligible");
  assert.ok(isPromptContextEligibleWorkItem(enhancementItems[0]), "canonical enhancement eligible");
  const ctx = formatRepoDashboardWorkItemContext(sample);
  assert.ok(ctx.includes("PROJECT-V-001"), "context includes work ID");
  assert.ok(ctx.includes("verify"), "context includes classification");
  assert.ok(ctx.includes("Next action"), "context includes next action field");
  const seed = createPromptLoopContextSeed(sample, { seedNonce: 1 });
  assert.ok(seed.taskContext.includes("PROJECT-V-001"));
  assert.equal(createPromptLoopContextSeed(sample, { seedNonce: 1 }).id.split("|").slice(0, -1).join("|"), seed.id.split("|").slice(0, -1).join("|"));
}

assert.equal(isOptionalDocPath("docs/TODO.md"), true);
assert.equal(isOptionalDocPath("docs/FEATURES.md"), true);
assert.equal(isOptionalDocPath("docs/VALIDATION.md"), true);
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
