import { describe, expect, it } from "vitest";
import type { RepoDashboardWorkItem } from "../../types";
import {
  composePrompt,
  type PromptRepoContextSection,
} from "./composer";
import { createPromptLoopContextSeed } from "./contextHandoff";

describe("Repo Dashboard handoff: no local paths leak into composed prompts", () => {
  const localRepoPath = "/Users/jane/secrets/repo-a";

  const item: RepoDashboardWorkItem = {
    workId: "RD-001",
    type: "todo",
    text: "Document Repo Dashboard full history",
    source: "docs",
    path: "docs/audit/ISSUES.md",
    line: 12,
    priority: "high",
    status: "open",
    needsPlan: false,
  };

  const repoContext: PromptRepoContextSection = {
    label: "Repo A",
    repo_slug: "owner/repo-a",
    current_branch: "main",
    default_branch: "main",
  };

  it("keeps the checkout path out of the seed while still resolving the saved repo entry", () => {
    const seed = createPromptLoopContextSeed(item, {
      repoPath: localRepoPath,
      savedEntries: [{ id: "repo-a", path: `${localRepoPath}/` }],
      seedNonce: 1,
    });

    expect(seed.repoEntryId).toBe("repo-a");
    expect(JSON.stringify(seed)).not.toContain("/Users/jane");
    expect(seed.taskContext).toContain("- Path: docs/audit/ISSUES.md");
  });

  it("composes a prompt from the seed without any host filesystem path", () => {
    const seed = createPromptLoopContextSeed(item, {
      repoPath: localRepoPath,
      savedEntries: [{ id: "repo-a", path: localRepoPath }],
      seedNonce: 1,
    });

    const out = composePrompt({
      basePrompt: "Do the bounded work.",
      repoContext,
      taskContext: seed.taskContext,
      selectedOptionIds: ["focused-check"],
    });

    expect(out).not.toContain("/Users/jane");
    expect(out).toContain("Repository: owner/repo-a");
    expect(out).toContain("- Path: docs/audit/ISSUES.md");
    expect(out).toContain("Verification: run the narrowest focused check");
  });

  it("returns only basePrompt when nothing is active", () => {
    const out = composePrompt({ basePrompt: "Plain prompt" });
    expect(out).toBe("Plain prompt");
  });
});
