import type { RepoDashboardWorkItem } from "../src/types";
import {
  createPromptLoopContextSeed,
  formatRepoDashboardWorkItemContext,
  isPromptContextEligibleWorkItem,
} from "../src/tools/promptLoops/contextHandoff";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const legacyEligible: RepoDashboardWorkItem = {
  source: "docs",
  path: "docs/ROADMAP.md",
  line: 42,
  text: "Add symbol editor center-cross grid.",
  type: "feature",
  status: "open",
  needsPlan: false,
};

const canonicalVerify: RepoDashboardWorkItem = {
  source: "docs",
  path: "docs/BACKLOG.md",
  line: 30,
  text: "Trackpad pinch may jitter on target hardware.",
  type: "fix",
  status: "open",
  needsPlan: false,
  workId: "KV-V-001",
  classification: "verify",
  priority: "Medium",
  area: "Viewport / grid",
  nextAction: "Reproduce on target hardware.",
  verification: "Manual pinch sweep",
  canonicalSource: "backlog",
};

const issueEligible: RepoDashboardWorkItem = {
  source: "issue",
  path: "issue #12",
  text: "#12 Fix regression",
  type: "fix",
  status: "open",
  needsPlan: false,
  classification: "bug",
  canonicalSource: "github",
  workId: "#12",
};

const ineligibleGap: RepoDashboardWorkItem = {
  ...legacyEligible,
  type: "gap",
};

assert(isPromptContextEligibleWorkItem(legacyEligible), "legacy docs feature");
assert(isPromptContextEligibleWorkItem(canonicalVerify), "canonical verify");
assert(isPromptContextEligibleWorkItem(issueEligible), "open github issue");
assert(!isPromptContextEligibleWorkItem(ineligibleGap), "gap type");

const formatted = formatRepoDashboardWorkItemContext(canonicalVerify);
assert(formatted.includes("Selected Repo Dashboard item:"), "header");
assert(formatted.includes("- ID: KV-V-001"), "work id");
assert(formatted.includes("- Classification: verify"), "classification");
assert(formatted.includes("- Next action:"), "next action");
assert(formatted.includes("- Verification:"), "verification");
assert(
  formatted.includes(
    "Treat this as starting context only. Inspect repository reality, repo-local docs, scripts, and current code before deciding implementation.",
  ),
  "disclaimer",
);

const noLine = formatRepoDashboardWorkItemContext({ ...canonicalVerify, line: undefined });
assert(!noLine.includes("- Line:"), "omit line when missing");

const seed = createPromptLoopContextSeed(canonicalVerify, {
  repoPath: "/Users/demo/agent-workspace",
  savedEntries: [
    {
      id: "agent-workspace",
      path: "/Users/demo/agent-workspace/",
    },
  ],
  seedNonce: 1,
});
assert(seed.taskContext === formatted, "seed task context");
assert(seed.repoEntryId === "agent-workspace", "repo entry match");
assert(seed.id.endsWith("|1"), "stable seed id");

const unmatched = createPromptLoopContextSeed(canonicalVerify, {
  repoPath: "/other/path",
  savedEntries: [{ id: "x", path: "/nope" }],
  seedNonce: 2,
});
assert(unmatched.repoEntryId === undefined, "no repo entry when path unmatched");

const stableA = createPromptLoopContextSeed(canonicalVerify, { seedNonce: 99 });
const stableB = createPromptLoopContextSeed(canonicalVerify, { seedNonce: 99 });
assert(
  stableA.id.split("|").slice(0, -1).join("|") === stableB.id.split("|").slice(0, -1).join("|"),
  "stable seed key",
);

console.log("OK: prompt context handoff checks passed");
