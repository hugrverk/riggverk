import { describe, expect, it } from "vitest";
import { buildInstallReview, type InstallFlowRequest } from "../hooks/useInstallFlow";
import type { PlannedOperation, SetupPlan, SetupResult, SetupSurfaceId } from "../types";
import {
  applyOutputLineTone,
  buildPlanGroups,
  countPlanRows,
  describePlanCounts,
  formatApplyOutput,
  installRequestFor,
  planRows,
  scopeForTarget,
  surfaceTitle,
} from "./installPlan";

function op(surface: SetupSurfaceId, kind: PlannedOperation["kind"], extra: Partial<PlannedOperation> = {}): PlannedOperation {
  return { surface, kind, summary: `${kind} ${surface}`, ...extra };
}

function plan(operations: PlannedOperation[], synced: SetupSurfaceId[] = []): SetupPlan {
  return {
    operations,
    synced,
    conflicts: operations.filter(o => o.kind === "conflict"),
    manual_steps: operations.filter(o => o.kind === "manual"),
    summary: "",
    has_pending_changes: true,
    is_blocked: false,
    plan_fingerprint: "fingerprint-0123456789",
    preview_token: "token-secret",
  };
}

function review(operations: PlannedOperation[], surfaces: SetupSurfaceId[], synced: SetupSurfaceId[] = []) {
  const request: InstallFlowRequest = { label: "update claude", surfaces };
  return buildInstallReview(request, plan(operations, synced));
}

const MIXED = review(
  [
    op("claude_rules", "update", { summary: "Update ~/.claude/CLAUDE.md" }),
    op("claude_agents", "update", { details: ["+ create agents/sentinel.md", "~ update agents/verifier.md"] }),
    op("skills", "update", {
      details: [
        "+ create skills/handoff/SKILL.md",
        "~ update skills/frontend-design/SKILL.md",
        "− remove skills/zoom-in/SKILL.md (no longer bundled, backed up)",
      ],
    }),
    op("cursor_mcp", "conflict", { summary: "mcp.json differs", conflict_description: "mcp.json was modified locally since install" }),
  ],
  ["claude_rules", "claude_agents", "skills", "cursor_mcp"],
);

describe("buildPlanGroups", () => {
  it("groups rows by surface in request order and parses detail lines into + ~ − rows", () => {
    const groups = buildPlanGroups(MIXED);
    expect(groups.map(group => group.title)).toEqual(["claude rules", "claude agents", "skills", "cursor mcp"]);
    const skills = groups[2]!.rows;
    expect(skills.map(row => [row.kind, row.glyph, row.label, row.file])).toEqual([
      ["create", "add", "create", "skills/handoff/SKILL.md"],
      ["update", "change", "update", "skills/frontend-design/SKILL.md"],
      ["remove", "remove", "remove", "skills/zoom-in/SKILL.md"],
    ]);
    expect(skills[2]!.note).toBe("no longer bundled, backed up");
  });

  it("reads the skills surface's lines per folder, an edited copy that stays being a conflict row", () => {
    const skills = review(
      [
        op("skills", "update", {
          details: [
            "+ ~/.agents/skills (25 skills, 46 files)",
            "- $CODEX_HOME/skills (25 skills, owned copies)",
            "! ~/.cursor/skills/tdd (edited, kept; Codex reads both copies)",
          ],
        }),
      ],
      ["skills"],
    );
    const group = buildPlanGroups(skills)[0]!;
    expect(group.title).toBe("skills");
    expect(group.rows.map(row => [row.kind, row.file, row.note, row.safe, row.conflict])).toEqual([
      ["create", "~/.agents/skills", "25 skills, 46 files", true, false],
      ["remove", "$CODEX_HOME/skills", "25 skills, owned copies", true, false],
      ["conflict", "~/.cursor/skills/tdd", "edited, kept; Codex reads both copies", false, true],
    ]);
    expect(describePlanCounts(countPlanRows([group]))).toBe("apply 2 safe changes, skip 1 conflict");
  });

  it("reads a skill the user keeps (=) as a manual row, and points a skill in conflict at the page that resolves it", () => {
    const skills = review(
      [
        op("skills", "update", {
          details: [
            "~ ~/.claude/skills (3 skills, 5 files)",
            "! ~/.agents/skills/tdd (edited, kept)",
            "= ~/.claude/skills/diagnose (you manage; bundled update available)",
          ],
        }),
      ],
      ["skills"],
    );
    const rows = buildPlanGroups(skills)[0]!.rows;
    expect(rows.map(row => [row.kind, row.label, row.file, row.note, row.safe, row.conflict])).toEqual([
      ["update", "update", "~/.claude/skills", "3 skills, 5 files", true, false],
      ["conflict", "conflict", "~/.agents/skills/tdd", "edited, kept", false, true],
      ["manual", "manual", "~/.claude/skills/diagnose", "you manage; bundled update available", false, false],
    ]);
    expect(rows[1]!.detail).toContain("resolve from a harness page: d diff · m keep mine");
    // Only a file in conflict is pointed at the resolve keys; a kept one is already resolved.
    expect(rows[0]!.detail.join(" ")).not.toContain("resolve from");
    expect(rows[2]!.detail.join(" ")).not.toContain("resolve from");
    expect(describePlanCounts(countPlanRows([buildPlanGroups(skills)[0]!]))).toBe("apply 1 safe change, skip 1 conflict, 1 manual step left to you");
  });

  it("points an agent in conflict at its harness page, and leaves every other conflict without a pointer", () => {
    const groups = buildPlanGroups(
      review(
        [
          op("claude_agents", "conflict", { conflict_description: "agents were edited" }),
          op("claude_rules", "conflict", { conflict_description: "rules were edited" }),
          op("cursor_mcp", "conflict", { conflict_description: "mcp.json was edited" }),
        ],
        ["claude_agents", "claude_rules", "cursor_mcp"],
      ),
    );
    const detail = (index: number) => groups[index]!.rows[0]!.detail;
    expect(detail(0)).toContain("resolve from the Claude page: d diff · m keep mine");
    expect(detail(1).join(" ")).not.toContain("resolve from");
    expect(detail(2).join(" ")).not.toContain("resolve from");
  });

  it("shows an operation without detail lines as one row labelled with the surface", () => {
    const rules = buildPlanGroups(MIXED)[0]!.rows;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ kind: "update", file: "claude rules", note: "Update ~/.claude/CLAUDE.md", safe: true });
  });

  it("marks conflicts with their description and keeps them out of the safe rows", () => {
    const conflict = planRows(buildPlanGroups(MIXED)).find(row => row.conflict)!;
    expect(conflict).toMatchObject({ kind: "conflict", glyph: "conflict", label: "conflict", safe: false });
    expect(conflict.note).toBe("mcp.json was modified locally since install");
    expect(conflict.detail).toContain("mcp.json differs");
  });

  it("gives every row of a review a unique id", () => {
    const ids = planRows(buildPlanGroups(MIXED)).map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a header for surfaces that are already in sync", () => {
    const groups = buildPlanGroups(review([op("claude_rules", "update")], ["claude_rules", "claude_agents"], ["claude_agents"]));
    expect(groups.map(group => [group.surface, group.unchanged, group.rows.length])).toEqual([
      ["claude_rules", false, 1],
      ["claude_agents", true, 0],
    ]);
  });

  it("lists manual steps with a warning glyph and the step as the reason", () => {
    const groups = buildPlanGroups(review([op("cursor_mcp", "manual", { manual_step: "Enable the Playwright MCP in Cursor" })], ["cursor_mcp"]));
    expect(groups[0]!.rows[0]).toMatchObject({ kind: "manual", glyph: "conflict", label: "manual", note: "Enable the Playwright MCP in Cursor", safe: false });
  });
});

describe("plan counts", () => {
  it("counts rows by kind and describes what apply would do", () => {
    const counts = countPlanRows(buildPlanGroups(MIXED));
    expect(counts).toMatchObject({ create: 2, update: 3, remove: 1, conflict: 1, manual: 0 });
    expect(describePlanCounts(counts)).toBe("apply 6 safe changes, skip 1 conflict");
  });

  it("says when nothing is safe to apply", () => {
    const onlyConflict = review([op("cursor_mcp", "conflict")], ["cursor_mcp"]);
    expect(describePlanCounts(countPlanRows(buildPlanGroups(onlyConflict)))).toBe("nothing safe to apply, 1 conflict");
    expect(describePlanCounts(countPlanRows([]))).toBe("nothing to apply");
  });

  it("singularises one change and mentions manual steps", () => {
    const one = review([op("claude_rules", "update"), op("cursor_mcp", "manual")], ["claude_rules", "cursor_mcp"]);
    expect(describePlanCounts(countPlanRows(buildPlanGroups(one)))).toBe("apply 1 safe change, 1 manual step left to you");
  });
});

describe("installRequestFor", () => {
  const settings = {
    enabled_harness_ids: ["codex", "claude"] as ("codex" | "claude")[],
    enabled_target_ids: ["claude_rules", "claude_agents", "codex_rules"],
  };

  it("never requests a surface whose target toggle is off", () => {
    const request = installRequestFor("codex", settings);
    expect(request.surfaces).toEqual(["codex_rules", "skills"]);
    expect(request.surfaces).not.toContain("codex_config");
    expect(request.surfaces).not.toContain("codex_agents");
    expect(request.label).toBe("update codex");
    expect(request.readOnly).toBe(false);
  });

  it("covers the workspace bundle alone, or the workspace plus every enabled harness", () => {
    expect(installRequestFor("workspace", settings).surfaces).toEqual(["workspace_bundle"]);
    const all = installRequestFor("all", settings).surfaces;
    expect(all[0]).toBe("workspace_bundle");
    expect(all).toContain("skills");
    expect(all).not.toContain("cursor_agents");
    expect(all).not.toContain("codex_config");
  });

  it("marks previews read-only", () => {
    expect(installRequestFor("claude", settings, { readOnly: true })).toMatchObject({ label: "preview claude", readOnly: true });
  });

  it("anchors the review to the page of its target", () => {
    expect(scopeForTarget("claude")).toBe("claude");
    expect(scopeForTarget("workspace")).toBe("start");
    expect(scopeForTarget("all")).toBe("start");
  });
});

describe("formatApplyOutput", () => {
  const reviewed = review([op("claude_rules", "update"), op("claude_agents", "update")], ["claude_rules", "claude_agents"]);

  function result(overrides: Partial<SetupResult> = {}): SetupResult {
    return {
      success: true,
      transaction_id: "1710000000000",
      applied: ["ClaudeRules", "ClaudeAgents"],
      failed: [],
      rolled_back: [],
      manual_steps: [],
      message: "Successfully applied 2 artifact(s)",
      ...overrides,
    };
  }

  it("lists the applied surfaces, the counts and the transaction", () => {
    const { stdout, stderr } = formatApplyOutput(reviewed, result());
    const lines = stdout.split("\n");
    expect(lines[0]).toBe("plan fingerpr · 2 surfaces · fingerprint verified");
    expect(lines).toContain("applied      claude rules");
    expect(lines).toContain("applied      claude agents");
    expect(lines).toContain("applied 2 · failed 0 · rolled back 0");
    expect(lines.at(-1)).toBe("transaction 1710000000000 recorded · rollback available");
    expect(stderr).toBe("");
  });

  it("never prints the preview token", () => {
    expect(formatApplyOutput(reviewed, result()).stdout).not.toContain("token-secret");
  });

  it("reports a rolled-back or failed run per surface and puts the failures on stderr", () => {
    const rolledBack = formatApplyOutput(reviewed, result({ success: false, applied: [], failed: ["write failed"], rolled_back: ["ClaudeRules"] }));
    expect(rolledBack.stdout).toContain("rolled back  claude rules");
    expect(rolledBack.stdout).toContain("applied 0 · failed 1 · rolled back 1");
    expect(rolledBack.stdout).toContain("transaction 1710000000000 recorded");
    expect(rolledBack.stdout).not.toContain("rollback available");
    expect(rolledBack.stderr).toBe("write failed");

    const failed = formatApplyOutput(reviewed, result({ success: false, applied: [], failed: [], message: "Backup failed" }));
    expect(failed.stdout).toContain("failed       claude rules");
    expect(failed.stderr).toBe("Backup failed");
  });

  it("tones the lines it writes", () => {
    expect(applyOutputLineTone("applied      claude rules")).toBe("ok");
    expect(applyOutputLineTone("failed       claude rules")).toBe("fail");
    expect(applyOutputLineTone("rolled back  claude rules")).toBe("warn");
    expect(applyOutputLineTone("transaction 17 recorded")).toBe("dim");
    expect(applyOutputLineTone("applied 2 · failed 0")).toBeNull();
  });

  it("titles a surface without the vendor prefix quirks", () => {
    expect(surfaceTitle("open_code_agents")).toBe("opencode agents");
    expect(surfaceTitle("skills")).toBe("skills");
    expect(surfaceTitle("workspace_bundle")).toBe("workspace bundle");
  });
});
