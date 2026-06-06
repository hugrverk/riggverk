import { describe, expect, it } from "vitest";
import type { RepoDashboardEntry, RepoDashboardWorkItem } from "../../types";
import {
  createPromptLoopContextSeed,
  findRepoEntryIdForPath,
  formatRepoDashboardWorkItemContext,
  isPromptContextEligibleWorkItem,
} from "./contextHandoff";

const baseItem: RepoDashboardWorkItem = {
  source: "docs",
  path: "docs/audit/ISSUES.md",
  line: 12,
  text: "Document Repo Dashboard full history guarantee",
  type: "feature",
  status: "open",
  needsPlan: true,
  workId: "RD-001",
  classification: "enhancement",
  priority: "P1",
  area: "repo-dashboard",
  nextAction: "Add bounded git log pagination",
  verification: "Run release-check + docs drift",
  ownerFiles: "src-tauri/src/commands/repo_dashboard.rs",
  canonicalSource: "audit",
};

describe("isPromptContextEligibleWorkItem", () => {
  it("accepts canonical classification that is not done", () => {
    expect(isPromptContextEligibleWorkItem({ ...baseItem, classification: "enhancement", status: "open" })).toBe(true);
    expect(isPromptContextEligibleWorkItem({ ...baseItem, classification: "bug", status: "started" })).toBe(true);
    expect(isPromptContextEligibleWorkItem({ ...baseItem, classification: "verify", status: "open" })).toBe(true);
  });

  it("rejects canonical classification that is done", () => {
    expect(isPromptContextEligibleWorkItem({ ...baseItem, classification: "enhancement", status: "done" })).toBe(false);
  });

  it("accepts docs-backed legacy eligible types when not done", () => {
    expect(isPromptContextEligibleWorkItem({ ...baseItem, type: "feature", status: "open" })).toBe(true);
    expect(isPromptContextEligibleWorkItem({ ...baseItem, type: "roadmap", status: "started" })).toBe(true);
    expect(isPromptContextEligibleWorkItem({ ...baseItem, type: "todo", status: "open" })).toBe(true);
  });

  it("rejects docs-backed legacy ineligible types", () => {
    const noClassification = { ...baseItem };
    delete (noClassification as { classification?: string }).classification;
    expect(isPromptContextEligibleWorkItem({ ...noClassification, type: "gap" })).toBe(false);
    expect(isPromptContextEligibleWorkItem({ ...noClassification, type: "fix" })).toBe(false);
    expect(isPromptContextEligibleWorkItem({ ...noClassification, type: "note" })).toBe(false);
  });

  it("rejects done items even when canonical classification is present", () => {
    expect(isPromptContextEligibleWorkItem({ ...baseItem, source: "issue", classification: "bug", status: "done" })).toBe(false);
  });

  it("rejects done legacy items", () => {
    expect(isPromptContextEligibleWorkItem({ ...baseItem, type: "feature", status: "done" })).toBe(false);
  });
});

describe("formatRepoDashboardWorkItemContext", () => {
  it("emits a deterministic context block with safe metadata only", () => {
    const text = formatRepoDashboardWorkItemContext(baseItem);
    expect(text).toContain("Selected Repo Dashboard item:");
    expect(text).toContain("ID: RD-001");
    expect(text).toContain("Classification: enhancement");
    expect(text).toContain("Priority: P1");
    expect(text).toContain("Area: repo-dashboard");
    expect(text).toContain("Status: open");
    expect(text).toContain("Source: audit");
    expect(text).toContain("Path: docs/audit/ISSUES.md");
    expect(text).toContain("Line: 12");
    expect(text).toContain("Summary: Document Repo Dashboard full history guarantee");
    expect(text).toContain("Next action: Add bounded git log pagination");
    expect(text).toContain("Verification: Run release-check + docs drift");
    expect(text).toContain("Owner files: src-tauri/src/commands/repo_dashboard.rs");
    expect(text).not.toMatch(/Type:/);
    expect(text).toContain("starting context only");
  });

  it("falls back to type when no classification is present", () => {
    const item: RepoDashboardWorkItem = { ...baseItem };
    delete (item as { classification?: string }).classification;
    const text = formatRepoDashboardWorkItemContext(item);
    expect(text).toContain("Type: feature");
  });
});

describe("createPromptLoopContextSeed", () => {
  const entries: RepoDashboardEntry[] = [
    { id: "repo-a", label: "Repo A", path: "/Users/test/repo-a" },
    { id: "repo-b", label: "Repo B", path: "/Users/test/repo-b" },
  ];

  it("selects a matching saved repository when one exists", () => {
    const seed = createPromptLoopContextSeed(baseItem, {
      repoPath: "/Users/test/repo-a",
      savedEntries: entries,
      seedNonce: 42,
    });
    expect(seed.taskContext).toContain("Selected Repo Dashboard item:");
    expect(seed.repoEntryId).toBe("repo-a");
    expect(seed.id.endsWith("|42")).toBe(true);
  });

  it("leaves repoEntryId unset when no matching saved repository", () => {
    const seed = createPromptLoopContextSeed(baseItem, {
      repoPath: "/Users/test/missing",
      savedEntries: entries,
      seedNonce: 7,
    });
    expect(seed.repoEntryId).toBeUndefined();
    expect(seed.id.endsWith("|7")).toBe(true);
  });

  it("leaves repoEntryId unset when repoPath is empty", () => {
    const seed = createPromptLoopContextSeed(baseItem, {
      savedEntries: entries,
      seedNonce: 1,
    });
    expect(seed.repoEntryId).toBeUndefined();
  });
});

describe("findRepoEntryIdForPath", () => {
  it("matches by trimmed and slash-stripped path", () => {
    const entries = [
      { id: "a", path: "/Users/test/repo-a/" },
      { id: "b", path: "/Users/test/repo-b" },
    ];
    expect(findRepoEntryIdForPath("/Users/test/repo-a", entries)).toBe("a");
    expect(findRepoEntryIdForPath("/Users/test/repo-a/", entries)).toBe("a");
    expect(findRepoEntryIdForPath("/Users/test/repo-b", entries)).toBe("b");
    expect(findRepoEntryIdForPath("/Users/test/other", entries)).toBeUndefined();
  });
});
