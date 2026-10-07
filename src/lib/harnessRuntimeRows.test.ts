import { describe, expect, it } from "vitest";
import type { ClaudeRuntimeHealth, CodexRuntimeHealth, CursorProfileHealth, OpenCodeRuntimeHealth } from "../types";
import { runtimeRowsFor, runtimeVerdict } from "./harnessRuntimeRows";

const CLAUDE: ClaudeRuntimeHealth = {
  rules_synced: true,
  agents_synced: false,
  skills_synced: true,
  expected_agent_count: 6,
  installed_agent_count: 5,
  claude_cli_available: false,
  summary: "Claude CLI not found",
};

describe("runtimeRowsFor", () => {
  it("has no rows while the health is not loaded; the verdict heading says so", () => {
    expect(runtimeRowsFor({ harness: "codex", health: null })).toEqual([]);
    expect(runtimeVerdict({ harness: "codex", health: null })).toEqual({ text: "not loaded", tone: "dim" });
  });

  it("turns the Claude sync flags into rows and a verdict, which is not repeated as a row", () => {
    const rows = runtimeRowsFor({ harness: "claude", health: CLAUDE });
    expect(rows.map(row => [row.label, row.value, row.tone])).toEqual([
      ["rules", "synced", "ok"],
      ["agents", "diverged · 5/6", "warn"],
      ["skills", "synced", "ok"],
      ["claude cli", "not found", "warn"],
    ]);
    expect(runtimeVerdict({ harness: "claude", health: CLAUDE })).toEqual({ text: "diverged", tone: "warn" });
    expect(runtimeVerdict({ harness: "claude", health: { ...CLAUDE, agents_synced: true } })).toEqual({ text: "synced", tone: "ok" });
  });

  it("lists OpenCode warnings one row each and tones the status", () => {
    const health = {
      status: "stale",
      tui_status: "synced",
      default_agent: "build",
      autoupdate: null,
      bundled_agent_count: 3,
      installed_bundled_agent_count: 2,
      agent_mismatches: [{ filename: "a.md", status: "missing", detail: "" }],
      warnings: ["first warning", "second warning"],
      summary: "",
      next_action: "Update OpenCode.",
    } as unknown as OpenCodeRuntimeHealth;
    const rows = runtimeRowsFor({ harness: "opencode", health });
    expect(rows.find(row => row.label === "runtime")).toBeUndefined();
    expect(runtimeVerdict({ harness: "opencode", health })).toEqual({ text: "stale", tone: "warn" });
    expect(rows.find(row => row.label === "agents")).toMatchObject({ value: "2/3 installed", tone: "warn" });
    expect(rows.find(row => row.label === "autoupdate")).toBeUndefined();
    expect(rows.filter(row => row.tone === "warn" && row.wrap).map(row => row.value)).toEqual(["first warning", "second warning"]);
    // The backend's sentence reads like the other values: no capital, no full stop.
    expect(rows.find(row => row.label === "next")?.value).toBe("update OpenCode");
  });

  it("shows the next step only while the runtime is out of sync, and never a summary", () => {
    const opencode = (status: string, nextAction: string) =>
      ({
        status,
        tui_status: "synced",
        default_agent: null,
        autoupdate: null,
        bundled_agent_count: 3,
        installed_bundled_agent_count: 3,
        agent_mismatches: [],
        warnings: [],
        summary: "OpenCode summary",
        next_action: nextAction,
      }) as unknown as OpenCodeRuntimeHealth;
    const labels = (status: string, nextAction: string) =>
      runtimeRowsFor({ harness: "opencode", health: opencode(status, nextAction) }).map(row => row.label);

    expect(labels("synced", "No runtime action needed.")).not.toContain("next");
    expect(labels("synced", "No runtime action needed.")).not.toContain("summary");
    const stale = runtimeRowsFor({ harness: "opencode", health: opencode("stale", "Regenerate opencode.json before sync.") });
    expect(stale.find(row => row.label === "next")?.value).toBe("regenerate opencode.json before sync");
    expect(stale.map(row => row.label)).not.toContain("summary");
  });

  it("shows the Cursor profile counts against what is expected", () => {
    const health = {
      status: "partial",
      profile_root: "/Users/me/.cursor",
      workspace_resources_status: "current",
      global_agents_status: "partial",
      global_agents_count: 3,
      expected_global_agents_count: 6,
      global_skills_status: "synced",
      global_skills_count: 18,
      expected_global_skills_count: 18,
      mcp_status: "missing",
      user_rules_status: "manual",
      warnings: [],
      next_action: "Install Cursor surfaces.",
    } as unknown as CursorProfileHealth;
    const rows = runtimeRowsFor({ harness: "cursor", health });
    expect(rows.find(row => row.label === "agents")).toMatchObject({ value: "3/6", tone: "warn" });
    expect(rows.find(row => row.label === "skills")).toMatchObject({ value: "18/18", tone: "ok" });
    expect(rows.find(row => row.label === "mcp")).toMatchObject({ value: "missing", tone: "fail" });
    expect(runtimeVerdict({ harness: "cursor", health })).toEqual({ text: "partial", tone: "warn" });
  });
});

describe("codex runtime rows", () => {
  it("leaves out the AGENTS.override.md warning, which the page shows as an alert", () => {
    const detail = "AGENTS.override.md replaces AGENTS.md for Codex";
    const health = {
      status: "partial",
      rules_status: "synced",
      agents_status: "synced",
      skills_status: "synced",
      config_status: "synced",
      installed_bundled_agent_count: 6,
      bundled_agent_count: 6,
      skills_synced_count: 18,
      skills_expected_count: 18,
      approval_policy: null,
      sandbox_mode: null,
      next_action: "",
      summary: "",
      checks: [{ id: "rules_override", label: "AGENTS.override.md", status: "warn", detail }],
      warnings: [detail, "another warning"],
    } as unknown as CodexRuntimeHealth;
    const warnings = runtimeRowsFor({ harness: "codex", health }).filter(row => row.id?.startsWith("warning-"));
    expect(warnings.map(row => [row.label, row.value])).toEqual([["warnings", "another warning"]]);
  });
});
