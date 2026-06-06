import { describe, expect, it } from "vitest";
import {
  composePrompt,
  type PromptRepoContextSection,
} from "./composer";

describe("composePrompt: no local paths leak into composed output", () => {
  const localRepoPath = "/Users/jane/secrets/repo-a";

  it("does not include the host filesystem path when task context comes from handoff", () => {
    const repoContext: PromptRepoContextSection = {
      label: "Repo A",
      repo_slug: "owner/repo-a",
      current_branch: "main",
      default_branch: "main",
    };
    const taskContext = [
      "Selected Repo Dashboard item:",
      "- ID: RD-001",
      `- Path: docs/audit/ISSUES.md`,
      "- Line: 12",
      "- Summary: Document Repo Dashboard full history",
    ].join("\n");

    const out = composePrompt({
      basePrompt: "Do the bounded work.",
      repoContext,
      taskContext,
      selectedOptionIds: ["focused-check"],
    });

    expect(out).not.toContain(localRepoPath);
    expect(out).not.toContain("/Users/jane");
    expect(out).toContain("Repository: owner/repo-a");
    expect(out).toContain("Path: docs/audit/ISSUES.md");
    expect(out).toContain("Hard constraint: docs only".length === 0 ? "" : "");
    expect(out).toContain("Verification: run the narrowest focused check");
  });

  it("returns only basePrompt when nothing is active", () => {
    const out = composePrompt({ basePrompt: "Plain prompt" });
    expect(out).toBe("Plain prompt");
  });
});
