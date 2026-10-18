import { describe, expect, it } from "vitest";
import type {
  ClaudeRuntimeHealth,
  CodexRuntimeHealth,
  CursorProfileHealth,
  LightRuntimeHealth,
  OpenCodeRuntimeHealth,
} from "../types";
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

function opencodeHealth(overrides: Partial<OpenCodeRuntimeHealth> = {}): OpenCodeRuntimeHealth {
  return {
    status: "synced",
    template_config_path: "",
    installed_config_path: "",
    checks: [],
    default_agent: "architect",
    model: null,
    small_model: null,
    subagent_model: null,
    autoupdate: "notify",
    snapshot: true,
    bundled_agent_count: 6,
    installed_bundled_agent_count: 6,
    extra_installed_agent_count: 0,
    agent_mismatches: [],
    warnings: [],
    cli: { status: "supported", version: "1.19.3", major: 1, detail: "OpenCode 1.19.3" },
    config_status: "synced",
    config_diverged_keys: [],
    rules_status: "synced",
    playwright_mcp_version: "0.0.48",
    template_tui_path: "",
    installed_tui_path: "",
    tui_status: "synced",
    generated_snapshot_base_path: "",
    generated_snapshot_policy_path: "",
    generated_snapshot_path: "",
    generated_snapshot_status: "current",
    generated_snapshot_detail: "",
    summary: "",
    next_action: "",
    ...overrides,
  };
}

const rowsOf = (overrides: Partial<OpenCodeRuntimeHealth> = {}) =>
  runtimeRowsFor({ harness: "opencode", health: opencodeHealth(overrides) });
const row = (rows: ReturnType<typeof rowsOf>, label: string) => rows.find(item => item.label === label);

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
    const health = opencodeHealth({
      status: "stale",
      default_agent: "build",
      autoupdate: null,
      bundled_agent_count: 3,
      installed_bundled_agent_count: 2,
      agent_mismatches: [{ filename: "a.md", status: "missing", detail: "" }],
      warnings: ["first warning", "second warning"],
      next_action: "Update OpenCode.",
    });
    const rows = runtimeRowsFor({ harness: "opencode", health });
    expect(rows.find(row => row.label === "runtime")).toBeUndefined();
    expect(runtimeVerdict({ harness: "opencode", health })).toEqual({ text: "stale", tone: "warn" });
    expect(rows.find(row => row.label === "agents")).toMatchObject({ value: "2/3 installed · missing: a.md", tone: "warn" });
    expect(rows.find(row => row.label === "autoupdate")).toBeUndefined();
    expect(rows.filter(row => row.id?.startsWith("warning-")).map(row => [row.tone, row.value])).toEqual([["warn", "first warning"], ["warn", "second warning"]]);
    // The backend's sentence reads like the other values: no capital, no full stop.
    expect(rows.find(row => row.label === "next")?.value).toBe("update OpenCode");
  });

  it("shows the next step only while the runtime is out of sync, and never a summary", () => {
    const opencode = (status: string, nextAction: string) =>
      opencodeHealth({ status, default_agent: null, autoupdate: null, summary: "OpenCode summary", next_action: nextAction });
    const labels = (status: string, nextAction: string) =>
      runtimeRowsFor({ harness: "opencode", health: opencode(status, nextAction) }).map(row => row.label);

    expect(labels("synced", "No runtime action needed.")).not.toContain("next");
    expect(labels("synced", "No runtime action needed.")).not.toContain("summary");
    const stale = runtimeRowsFor({ harness: "opencode", health: opencode("stale", "Regenerate opencode.json before sync.") });
    expect(stale.find(row => row.label === "next")?.value).toBe("regenerate opencode.json before sync");
    expect(stale.map(row => row.label)).not.toContain("summary");
  });

  it("shows the OpenCode CLI version, or why there is none", () => {
    expect(row(rowsOf(), "cli")).toMatchObject({ value: "1.19.3", tone: "ok" });
    expect(rowsOf({ cli: null }).map(item => item.label)).not.toContain("cli");

    const two = row(rowsOf({ cli: { status: "unsupported", version: "2.0.32", major: 2, detail: "long explanation" } }), "cli");
    expect(two).toMatchObject({ value: "2.0.32 · unsupported", tone: "warn" });

    const detail = "not found; install OpenCode 1.x with npm i -g opencode-ai or brew install anomalyco/tap/opencode";
    const missing = row(rowsOf({ cli: { status: "missing", version: null, major: null, detail } }), "cli");
    expect(missing).toMatchObject({ value: detail, tone: "warn", wrap: true });
    expect(String(missing?.value)).toContain("opencode-ai");
    expect(String(missing?.value)).toContain("anomalyco/tap/opencode");

    expect(row(rowsOf({ cli: { status: "unknown", version: null, major: null, detail: "" } }), "cli")).toMatchObject({ value: "found · version unknown", tone: "dim" });
  });

  it("shows the unsupported-version warning from the backend like any other warning", () => {
    const warning = "OpenCode 2.0.32 is installed, but Riggverk supports OpenCode 1.x";
    const rows = rowsOf({ warnings: [warning], cli: { status: "unsupported", version: "2.0.32", major: 2, detail: warning } });
    expect(rows.filter(item => item.id?.startsWith("warning-")).map(item => [item.tone, item.value])).toEqual([["warn", warning]]);
  });

  it("names the managed config keys that differ", () => {
    expect(row(rowsOf(), "config")).toMatchObject({ value: "synced", tone: "ok", wrap: false });
    const diverged = row(rowsOf({ config_status: "diverged", config_diverged_keys: ["model", "mcp.playwright"] }), "config");
    expect(diverged).toMatchObject({ value: "diverged · model, mcp.playwright", tone: "warn", wrap: true });
    expect(row(rowsOf({ config_status: "missing" }), "config")).toMatchObject({ value: "missing", tone: "fail" });
    expect(row(rowsOf({ config_status: "invalid" }), "config")).toMatchObject({ value: "invalid", tone: "fail" });
  });

  it("shows the rules status and the pinned Playwright MCP version", () => {
    expect(row(rowsOf(), "rules")).toMatchObject({ value: "synced", tone: "ok" });
    expect(row(rowsOf({ rules_status: "diverged" }), "rules")).toMatchObject({ value: "diverged", tone: "warn" });
    expect(row(rowsOf({ rules_status: "unknown" }), "rules")).toMatchObject({ value: "unknown", tone: "dim" });

    expect(row(rowsOf(), "mcp playwright")).toMatchObject({ value: "0.0.48", tone: "ok" });
    expect(row(rowsOf({ config_status: "diverged", config_diverged_keys: ["mcp.playwright"] }), "mcp playwright")).toMatchObject({ value: "0.0.48", tone: "warn" });
    expect(row(rowsOf({ playwright_mcp_version: null }), "mcp playwright")).toMatchObject({ value: "none", tone: "dim" });
  });

  it("lists the agent files that are not as bundled, by status, instead of a count", () => {
    const agents = row(
      rowsOf({
        bundled_agent_count: 6,
        installed_bundled_agent_count: 3,
        agent_mismatches: [
          { filename: "architect.md", status: "diverged", detail: "" },
          { filename: "scribe.md", status: "diverged", detail: "" },
          { filename: "verifier.md", status: "missing", detail: "" },
        ],
      }),
      "agents",
    );
    expect(agents).toMatchObject({ value: "3/6 installed · diverged: architect.md, scribe.md · missing: verifier.md", tone: "warn", wrap: true });
    expect(row(rowsOf(), "agents")).toMatchObject({ value: "6/6 installed", tone: "ok", wrap: false });
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

describe("skill load rows among the runtime rows", () => {
  const LOADS = [{ label: "skill loads", value: "3 skills, 1 copy each", tone: "ok" as const }];
  const labelsOf = (rows: ReturnType<typeof runtimeRowsFor>) => rows.map(row => row.label);

  it("go below the skills row, where the harness has one", () => {
    expect(labelsOf(runtimeRowsFor({ harness: "claude", health: CLAUDE }, LOADS))).toEqual(["rules", "agents", "skills", "skill loads", "claude cli"]);
  });

  it("go below the agents row where it has none (OpenCode)", () => {
    const labels = labelsOf(runtimeRowsFor({ harness: "opencode", health: opencodeHealth() }, LOADS));
    expect(labels.indexOf("skill loads")).toBe(labels.indexOf("agents") + 1);
    expect(labels).not.toContain("skills");
  });

  it("show while the health is not loaded, and change nothing without them", () => {
    expect(runtimeRowsFor({ harness: "codex", health: null }, LOADS)).toEqual(LOADS);
    expect(runtimeRowsFor({ harness: "claude", health: CLAUDE })).toEqual(runtimeRowsFor({ harness: "claude", health: CLAUDE }, []));
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

describe("light harness runtime rows", () => {
  const LOADS = [{ label: "skill loads", value: "3 skills, 1 copy each", tone: "ok" as const }];
  const labelsOf = (rows: ReturnType<typeof runtimeRowsFor>) => rows.map(row => row.label);
  const health =(overrides: Partial<LightRuntimeHealth> = {}): LightRuntimeHealth => ({
    harness: "kilo",
    status: "synced",
    cli: { status: "found", version: "7.8.12", source: "path", detail: "Kilo 7.8.12" },
    rules: { status: "synced", path: "~/.config/kilo/AGENTS.md", refinement_lines: 0, user_managed: false, conflict_reason: null, detail: "installed and current" },
    skills: { status: "synced", synced: 17, expected: 17, roots: ["~/.claude/skills", "~/.agents/skills"] },
    warnings: [],
    next_action: "No runtime action needed.",
    ...overrides,
  });
  const rulesHealth = (rules: Partial<LightRuntimeHealth["rules"]>) => health({ rules: { ...health().rules, ...rules } });

  it("lists the CLI, the rules file and the skills, with the skill loads below the skills row", () => {
    const rows = runtimeRowsFor({ harness: "kilo", health: health() }, LOADS);
    expect(labelsOf(rows)).toEqual(["cli", "rules", "skills", "skill loads"]);
    expect(rows[0]).toEqual({ label: "cli", value: "7.8.12", tone: "ok" });
    expect(rows[1]).toEqual({ label: "rules", value: "synced", tone: "ok", wrap: false });
    expect(rows[2]).toEqual({ label: "skills", value: "synced · 17/17", tone: "ok" });
  });

  it("says what is wrong with the rules file in the rules row", () => {
    const row = (rules: Partial<LightRuntimeHealth["rules"]>) => runtimeRowsFor({ harness: "kilo", health: rulesHealth(rules) }).find(candidate => candidate.label === "rules");
    expect(row({ status: "missing", detail: "1 to install" })).toMatchObject({ value: "missing", tone: "fail" });
    expect(row({ status: "stale", detail: "base update available; refinements: 5 lines preserved" })).toMatchObject({
      value: "stale · base update available; refinements: 5 lines preserved",
      tone: "warn",
      wrap: true,
    });
    expect(row({ status: "diverged", conflict_reason: "masked_by_override", detail: "an override file in the same folder masks this file, left as is" })).toMatchObject({
      value: "diverged · an override file in the same folder masks this file, left as is",
      tone: "warn",
    });
    expect(row({ status: "off", detail: "switched off in Settings" })).toEqual({ label: "rules", value: "off · target switched off in Settings", tone: "dim" });
    expect(row({ status: "unknown", detail: "the rules file could not be checked" })).toMatchObject({ value: "unknown · the rules file could not be checked", tone: "dim" });
  });

  it("takes the verdict from the overall status, which the backend moves to the rules once the skills are fine", () => {
    expect(runtimeVerdict({ harness: "kilo", health: health({ status: "stale" }) })).toEqual({ text: "stale", tone: "warn" });
    expect(runtimeVerdict({ harness: "kilo", health: health({ status: "diverged" }) })).toEqual({ text: "diverged", tone: "warn" });
  });

  it("takes its verdict from the skills status, and calls a harness with no folder unserved", () => {
    expect(runtimeVerdict({ harness: "pi", health: health({ harness: "pi" }) })).toEqual({ text: "synced", tone: "ok" });
    expect(runtimeVerdict({ harness: "pi", health: health({ harness: "pi", status: "partial" }) })).toEqual({ text: "partial", tone: "warn" });
    expect(runtimeVerdict({ harness: "pi", health: health({ harness: "pi", status: "unserved" }) })).toEqual({ text: "unserved", tone: "warn" });
    expect(runtimeVerdict({ harness: "pi", health: null })).toEqual({ text: "not loaded", tone: "dim" });
  });

  it("keeps the next step out of a synced harness's way, and shows it with the warnings otherwise", () => {
    const synced = runtimeRowsFor({ harness: "copilot", health: health({ harness: "copilot" }) });
    expect(synced.some(row => row.label === "next")).toBe(false);
    const missing = runtimeRowsFor({
      harness: "copilot",
      health: health({
        harness: "copilot",
        status: "missing",
        skills: { status: "missing", synced: 0, expected: 17, roots: ["~/.agents/skills"] },
        warnings: ["COPILOT_HOME is set"],
        next_action: "Run Install or Update on the Copilot page.",
      }),
    });
    expect(missing.find(row => row.label === "next")?.value).toBe("run Install or Update on the Copilot page");
    expect(missing.find(row => row.label === "warnings")?.value).toBe("COPILOT_HOME is set");
    expect(missing.find(row => row.label === "skills")).toMatchObject({ value: "missing · 0/17", tone: "fail" });
  });
});
