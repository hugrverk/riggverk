import { describe, expect, it } from "vitest";
import { buildInstallReview, type InstallFlowRequest } from "../hooks/useInstallFlow";
import type { PlannedOperation, SetupPlan, SetupResult, SetupSurfaceId } from "../types";
import {
  applyOutputLineTone,
  backupSentence,
  buildAgentPlan,
  buildPlanGroups,
  countPlanRows,
  describePlanCounts,
  formatApplyOutput,
  installRequestFor,
  installReviewLabel,
  planFileCount,
  planRowAgent,
  planRows,
  scopeForTarget,
  summaryTiles,
  surfaceTitle,
  writeChip,
  writeCounts,
  writeLine,
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
    expect(skills.map(row => [row.kind, row.label, row.file])).toEqual([
      ["create", "create", "skills/handoff/SKILL.md"],
      ["update", "update", "skills/frontend-design/SKILL.md"],
      ["remove", "remove", "skills/zoom-in/SKILL.md"],
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

  it("reads a pack skill's own line, with the keys it acts on without asking, as a row of that skill", () => {
    const skills = review(
      [
        op("skills", "update", {
          details: [
            "+ ~/.claude/skills (3 skills, 5 files)",
            "+ ~/.claude/skills/deploy (pack team; allowed-tools: Bash(git *) [grants tool access without asking])",
          ],
        }),
      ],
      ["skills"],
    );
    const rows = buildPlanGroups(skills)[0]!.rows;
    expect(rows.map(row => [row.kind, row.file, row.note])).toEqual([
      ["create", "~/.claude/skills", "3 skills, 5 files"],
      ["create", "~/.claude/skills/deploy", "pack team; allowed-tools: Bash(git *) [grants tool access without asking]"],
    ]);
  });

  it("reads the OpenCode config's per-key lines as one row per key, a shape in the note kept whole", () => {
    const opencode = review(
      [
        op("open_code_config", "update", {
          details: [
            "~ opencode.json lsp (now your settings with 1 entry: elixir-ls; becomes true)",
            "~ opencode.json snapshot (not set now; becomes true)",
            "~ opencode.json mcp.playwright (your entry is replaced by Riggverk's)",
            "~ tui.json theme (now \"gruvbox\"; becomes \"system\")",
            "+ ~/.config/playwright-mcp/config.json (new file)",
          ],
        }),
      ],
      ["open_code_config"],
    );
    const rows = buildPlanGroups(opencode)[0]!.rows;
    expect(rows.map(row => [row.kind, row.file, row.note, planRowAgent(row)])).toEqual([
      ["update", "opencode.json lsp", "now your settings with 1 entry: elixir-ls; becomes true", "opencode"],
      ["update", "opencode.json snapshot", "not set now; becomes true", "opencode"],
      ["update", "opencode.json mcp.playwright", "your entry is replaced by Riggverk's", "opencode"],
      ["update", "tui.json theme", "now \"gruvbox\"; becomes \"system\"", "opencode"],
      ["create", "~/.config/playwright-mcp/config.json", "new file", "opencode"],
    ]);
    // Several keys of one file are one file to write and to back up.
    expect(planFileCount(rows)).toBe(3);
    expect(backupSentence(rows)).toBe("2 existing files are backed up before anything is written");
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
    expect(rows[1]!.detail).toContain("resolve from a harness page: d diff · b take bundled · m keep mine");
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
    expect(detail(0)).toContain("resolve from the Claude page: d diff · b take bundled · m keep mine");
    expect(detail(1).join(" ")).not.toContain("resolve from");
    expect(detail(2).join(" ")).not.toContain("resolve from");
  });

  it("shows an operation without detail lines as one row labelled with the surface", () => {
    const rules = buildPlanGroups(MIXED)[0]!.rows;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ kind: "update", file: "claude rules", note: "Update ~/.claude/CLAUDE.md", safe: true });
    // Its details never just repeat the note: with nothing else to add they also say what the change does to Undo.
    expect(rules[0]!.detail).toEqual(["Update ~/.claude/CLAUDE.md", "The current file is backed up first; Undo puts it back."]);
  });

  it("marks conflicts with their description and keeps them out of the safe rows", () => {
    const conflict = planRows(buildPlanGroups(MIXED)).find(row => row.conflict)!;
    expect(conflict).toMatchObject({ kind: "conflict", label: "conflict", safe: false });
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

  it("lists manual steps with the step as the reason", () => {
    const groups = buildPlanGroups(review([op("cursor_mcp", "manual", { manual_step: "Enable the Playwright MCP in Cursor" })], ["cursor_mcp"]));
    expect(groups[0]!.rows[0]).toMatchObject({ kind: "manual", label: "manual", note: "Enable the Playwright MCP in Cursor", safe: false });
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

describe("installReviewLabel", () => {
  it("says install when the plan only creates", () => {
    const created = countPlanRows(buildPlanGroups(review([op("codex_rules", "create"), op("skills", "create")], ["codex_rules", "skills"])));
    expect(installReviewLabel("update codex", created)).toBe("install codex");
    expect(installReviewLabel("preview codex", created)).toBe("preview codex");
  });

  it("keeps update when anything is updated or removed", () => {
    expect(installReviewLabel("update claude", countPlanRows(buildPlanGroups(MIXED)))).toBe("update claude");
    const mixed = countPlanRows(buildPlanGroups(review([op("codex_rules", "create"), op("skills", "update")], ["codex_rules", "skills"])));
    expect(installReviewLabel("update codex", mixed)).toBe("update codex");
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

/** The default mock scenario's plan: shared and per-agent skill folders, two agents' surfaces and a kept edit. */
const UPDATE_ALL = review(
  [
    op("workspace_bundle", "no_change"),
    op("codex_agents", "no_change"),
    op("skills", "update", {
      details: [
        "+ ~/.agents/skills (17 skills, 17 files)",
        "~ ~/.claude/skills (17 skills, 17 files)",
        "- $CODEX_HOME/skills (17 skills, owned copies)",
        "! ~/.cursor/skills/tdd (edited, kept)",
      ],
    }),
    op("open_code_config", "update", { summary: "Update ~/.config/opencode/opencode.json" }),
    op("open_code_rules", "update", { summary: "Update ~/.config/opencode/AGENTS.md" }),
    op("claude_rules", "update", { summary: "Update ~/.claude/CLAUDE.md" }),
    op("claude_agents", "update", { details: ["+ create agents/sentinel.md", "~ update agents/verifier.md"] }),
    op("cursor_agents", "no_change"),
  ],
  ["workspace_bundle", "codex_agents", "skills", "open_code_config", "open_code_rules", "claude_rules", "claude_agents", "cursor_agents"],
  ["workspace_bundle", "codex_agents", "cursor_agents"],
);

describe("the plan per agent", () => {
  it("gives each row the agent it writes to, the skills surface by the folder its row names", () => {
    const agentOf = (surface: SetupSurfaceId, file: string) => planRowAgent({ surface, file });
    expect(agentOf("claude_rules", "claude rules")).toBe("claude");
    expect(agentOf("open_code_config", "opencode config")).toBe("opencode");
    expect(agentOf("skills", "~/.claude/skills")).toBe("claude");
    expect(agentOf("skills", "~/.claude/skills/deploy")).toBe("claude");
    expect(agentOf("skills", "$CODEX_HOME/skills")).toBe("codex");
    expect(agentOf("skills", "~/.config/opencode/skills")).toBe("opencode");
    expect(agentOf("skills", "$XDG_CONFIG_HOME/opencode/skills")).toBe("opencode");
    expect(agentOf("skills", "~/.cursor/skills/tdd")).toBe("cursor");
    expect(agentOf("skills", "~/.gemini/config/skills")).toBe("antigravity");
    // The folder every agent reads, a skills row without a folder and the workspace bundle are shared.
    expect(agentOf("skills", "~/.agents/skills")).toBe("shared");
    expect(agentOf("skills", "skills/handoff/SKILL.md")).toBe("shared");
    expect(agentOf("workspace_bundle", "workspace bundle")).toBe("shared");
  });

  it("groups the rows by agent, shared first, then the agents with the most to write, and pins the conflicts", () => {
    const plan = buildAgentPlan(buildPlanGroups(UPDATE_ALL));
    expect(plan.groups.map(group => [group.label, group.rows.map(row => row.file), group.unchanged])).toEqual([
      ["Shared", ["~/.agents/skills"], ["workspace bundle"]],
      ["Claude", ["~/.claude/skills", "claude rules", "agents/sentinel.md", "agents/verifier.md"], []],
      ["OpenCode", ["opencode config", "opencode rules"], []],
      ["Codex", ["$CODEX_HOME/skills"], ["agents"]],
      ["Cursor", [], ["agents"]],
    ]);
    expect(plan.conflicts.map(row => row.file)).toEqual(["~/.cursor/skills/tdd"]);
    // The conflict is listed once, at the top; its agent names it as skipped.
    expect(plan.groups.find(group => group.agent === "cursor")!.skipped.map(row => row.file)).toEqual(["~/.cursor/skills/tdd"]);
    // j/k walk the rows in the order the table shows them.
    expect(plan.rows.map(row => row.file)).toEqual([
      "~/.cursor/skills/tdd",
      "~/.agents/skills",
      "~/.claude/skills",
      "claude rules",
      "agents/sentinel.md",
      "agents/verifier.md",
      "opencode config",
      "opencode rules",
      "$CODEX_HOME/skills",
    ]);
  });

  it("writes a chip per agent in the plan's own signs, the filled square for what it keeps", () => {
    const chipOf = (create: number, update: number, remove: number, conflict = 0) =>
      writeChip({ create, update, remove, conflict, manual: 0 });
    expect(chipOf(0, 0, 1)).toBe("− 1 remove");
    expect(chipOf(0, 2, 0)).toBe("~ 2 update");
    expect(chipOf(1, 3, 0)).toBe("+ 1 · ~ 3");
    expect(chipOf(0, 0, 0, 1)).toBe("■ 1 kept");
    expect(chipOf(0, 2, 0, 1)).toBe("~ 2 · ■ 1");
    expect(chipOf(0, 0, 0)).toBeNull();
    const claude = buildAgentPlan(buildPlanGroups(UPDATE_ALL)).groups.find(group => group.agent === "claude")!;
    expect(writeLine(writeCounts(claude.rows))).toBe("1 create · 3 update");
    expect(writeLine({ create: 0, update: 0, remove: 0, conflict: 1, manual: 0 })).toBe("1 kept, skipped");
    expect(writeLine({ create: 0, update: 0, remove: 0, conflict: 0, manual: 0 })).toBe("nothing to write");
  });

  it("sums the plan up for the band: a tile per kind, the files and what is backed up", () => {
    const groups = buildPlanGroups(UPDATE_ALL);
    const counts = countPlanRows(groups);
    expect(summaryTiles(counts).map(tile => [tile.kind, tile.n, tile.sub])).toEqual([
      ["create", 2, "new files"],
      ["update", 5, "backed up first"],
      ["remove", 1, "backed up first"],
      ["conflict", 1, "skipped, yours"],
      ["unchanged", 3, "already in sync"],
    ]);
    // A row that names its files counts them; any other row is one file.
    expect(planFileCount(planRows(groups))).toBe(17 + 17 + 1 + 1 + 1 + 1 + 1 + 1);
    // The backed-up files are counted like the file total: the one ~/.claude/skills update row is 17 files.
    expect(backupSentence(planRows(groups))).toBe(`${17 + 1 + 1 + 1 + 1 + 1} existing files are backed up before anything is written`);
    expect(backupSentence(planRows(buildPlanGroups(review([op("claude_rules", "create")], ["claude_rules"]))))).toBe(
      "Nothing that exists is overwritten; Undo removes what is created",
    );
    expect(summaryTiles({ ...counts, manual: 1 }).map(tile => tile.kind)).toContain("manual");
  });
});
