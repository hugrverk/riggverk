import type { RepoDashboardWorkItem } from "../src/types";
import {
  createPromptLoopContextSeed,
  formatRepoDashboardWorkItemContext,
  isPromptContextEligibleWorkItem,
} from "../src/tools/promptLoops/contextHandoff";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const eligible: RepoDashboardWorkItem = {
  source: "docs",
  path: "docs/ROADMAP.md",
  line: 42,
  text: "Add symbol editor center-cross grid.",
  type: "feature",
  status: "open",
  needsPlan: false,
};

const ineligibleIssue: RepoDashboardWorkItem = {
  ...eligible,
  source: "issue",
  type: "feature",
};

const ineligibleGap: RepoDashboardWorkItem = {
  ...eligible,
  type: "gap",
};

assert(isPromptContextEligibleWorkItem(eligible), "eligible docs feature");
assert(!isPromptContextEligibleWorkItem(ineligibleIssue), "issue source");
assert(!isPromptContextEligibleWorkItem(ineligibleGap), "gap type");

const formatted = formatRepoDashboardWorkItemContext(eligible);
assert(formatted.includes("Selected Repo Dashboard item:"), "header");
assert(formatted.includes("- Type: feature"), "type");
assert(formatted.includes("- Line: 42"), "line");
assert(formatted.includes("- Text: Add symbol editor center-cross grid."), "text");
assert(formatted.includes("Treat this as starting context only."), "disclaimer");

const noLine = formatRepoDashboardWorkItemContext({ ...eligible, line: undefined });
assert(!noLine.includes("- Line:"), "omit line when missing");

const seed = createPromptLoopContextSeed(eligible, {
  repoPath: "/Users/demo/agent-workspace",
  savedEntries: [
    {
      id: "agent-workspace",
      label: "agent-workspace",
      path: "/Users/demo/agent-workspace/",
      default_branch: "main",
    },
  ],
  seedNonce: 1,
});
assert(seed.taskContext === formatted, "seed task context");
assert(seed.repoEntryId === "agent-workspace", "repo entry match");
assert(seed.id.endsWith("|1"), "stable seed id");

const unmatched = createPromptLoopContextSeed(eligible, {
  repoPath: "/other/path",
  savedEntries: [{ id: "x", label: "x", path: "/nope" }],
  seedNonce: 2,
});
assert(unmatched.repoEntryId === undefined, "no repo entry when path unmatched");

console.log("OK: prompt context handoff checks passed");
