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
    critic_model: null,
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
    playwright_mcp_version: "0.0.83",
    config_precedence: { installed_not_strict: [], sibling_files: [], env_vars: [], system_managed_paths: [] },
    template_tui_path: "",
    installed_tui_path: "",
    tui_status: "synced",
    tui_diverged_keys: [],
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
    expect(rows.find(row => row.label === "agents")).toMatchObject({ value: "2/3 · missing: a.md", tone: "warn" });
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

  it("says when opencode.json is JSONC, which the app compares but does not rewrite", () => {
    const precedence = { installed_not_strict: ["comments", "trailing commas"], sibling_files: [], env_vars: [], system_managed_paths: [] };
    expect(row(rowsOf({ config_precedence: precedence }), "config")).toMatchObject({ value: "synced · has comments, trailing commas", tone: "ok", wrap: true });
    const diverged = row(rowsOf({ config_status: "diverged", config_diverged_keys: ["model"], config_precedence: precedence }), "config");
    expect(diverged).toMatchObject({ value: "diverged · model · has comments, trailing commas", tone: "warn" });
  });

  it("names what else changes OpenCode's config, and has no row when nothing does", () => {
    expect(rowsOf().map(item => item.label)).not.toContain("overrides");
    const overrides = row(
      rowsOf({
        config_precedence: {
          installed_not_strict: [],
          sibling_files: [
            { file: "config.json", managed_keys: [], invalid: true },
            { file: "opencode.jsonc", managed_keys: ["model", "agent.plan.permission"], invalid: false },
          ],
          env_vars: ["OPENCODE_CONFIG", "OPENCODE_PERMISSION"],
          system_managed_paths: ["/Library/Application Support/opencode"],
        },
      }),
      "overrides",
    );
    expect(overrides).toMatchObject({
      value: "config.json: not valid JSONC · opencode.jsonc: model, agent.plan.permission · env: OPENCODE_CONFIG, OPENCODE_PERMISSION · system managed: /Library/Application Support/opencode",
      tone: "warn",
      wrap: true,
    });
    const labels = rowsOf({ config_precedence: { installed_not_strict: [], sibling_files: [], env_vars: ["OPENCODE_CONFIG"], system_managed_paths: [] } }).map(item => item.label);
    expect(labels.indexOf("overrides")).toBe(labels.indexOf("config") + 1);
  });

  it("shows the rules status like the other harness pages", () => {
    expect(row(rowsOf(), "rules")).toMatchObject({ value: "synced", tone: "ok" });
    expect(row(rowsOf({ rules_status: "diverged" }), "rules")).toMatchObject({ value: "diverged", tone: "warn" });
    expect(row(rowsOf({ rules_status: "missing" }), "rules")).toMatchObject({ value: "missing", tone: "fail" });
    expect(row(rowsOf({ rules_status: "unknown" }), "rules")).toMatchObject({ value: "unknown", tone: "dim" });
  });

  it("shows the pinned Playwright MCP version with a status, as the Copilot, Pi and Kilo pages do", () => {
    expect(row(rowsOf(), "mcp playwright")).toMatchObject({ value: "synced · 0.0.83", tone: "ok" });
    // Other managed keys differing does not make the Playwright entry differ.
    expect(row(rowsOf({ config_status: "diverged", config_diverged_keys: ["model"] }), "mcp playwright")).toMatchObject({ value: "synced · 0.0.83", tone: "ok" });
    expect(row(rowsOf({ config_status: "diverged", config_diverged_keys: ["model", "mcp.playwright"] }), "mcp playwright")).toMatchObject({ value: "diverged · 0.0.83", tone: "warn" });
    // The entry is gone, or has no pinned version to show.
    expect(row(rowsOf({ config_status: "diverged", config_diverged_keys: ["mcp.playwright"], playwright_mcp_version: null }), "mcp playwright")).toMatchObject({ value: "diverged", tone: "warn" });
    expect(row(rowsOf({ playwright_mcp_version: null }), "mcp playwright")).toMatchObject({ value: "none", tone: "dim" });
    // Nothing to compare against: the version alone, with no status.
    expect(row(rowsOf({ config_status: "unknown" }), "mcp playwright")).toMatchObject({ value: "0.0.83", tone: "dim" });
  });

  it("names the managed tui.json keys that differ", () => {
    expect(row(rowsOf(), "tui")).toMatchObject({ value: "synced", tone: "ok", wrap: false });
    expect(row(rowsOf({ tui_status: "diverged", tui_diverged_keys: ["theme", "mouse"] }), "tui")).toMatchObject({ value: "diverged · theme, mouse", tone: "warn", wrap: true });
    // A file that cannot be compared (comments, invalid JSON) names no key; the install review gives the reason.
    expect(row(rowsOf({ tui_status: "diverged", tui_diverged_keys: [] }), "tui")).toMatchObject({ value: "diverged", tone: "warn", wrap: false });
    expect(row(rowsOf({ tui_status: "missing" }), "tui")).toMatchObject({ value: "missing", tone: "fail" });
  });

  it("shows names and statuses only, never what a check or a config value says", () => {
    const secret = "SECRET-MARKER";
    const rows = rowsOf({
      model: secret,
      small_model: secret,
      subagent_model: secret,
      template_config_path: secret,
      installed_config_path: secret,
      checks: [{ id: "configs_match", label: secret, status: "warn", detail: secret }],
      generated_snapshot_detail: secret,
      summary: secret,
      config_status: "diverged",
      config_diverged_keys: ["model", "agent.plan"],
      tui_status: "diverged",
      tui_diverged_keys: ["theme"],
    });
    expect(rows.map(item => item.label)).toEqual(expect.arrayContaining(["config", "tui"]));
    expect(JSON.stringify(rows)).not.toContain(secret);
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
    expect(agents).toMatchObject({ value: "3/6 · diverged: architect.md, scribe.md · missing: verifier.md", tone: "warn", wrap: true });
  });

  it("says the agents are synced with the count, like the Codex and Claude pages", () => {
    expect(row(rowsOf(), "agents")).toMatchObject({ value: "synced · 6/6", tone: "ok" });
    // The user's own agents are not part of the count and do not change the row.
    expect(row(rowsOf({ extra_installed_agent_count: 2 }), "agents")).toMatchObject({ value: "synced · 6/6", tone: "ok" });
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

  it("counts the enforced config keys the user keeps beside the config status", () => {
    const health = (configKept?: string[]) =>
      ({
        status: "synced",
        rules_status: "synced",
        agents_status: "synced",
        skills_status: "synced",
        config_status: "synced",
        config_kept: configKept,
        installed_bundled_agent_count: 6,
        bundled_agent_count: 6,
        skills_synced_count: 18,
        skills_expected_count: 18,
        approval_policy: null,
        sandbox_mode: null,
        next_action: "",
        summary: "",
        checks: [],
        warnings: [],
      }) as unknown as CodexRuntimeHealth;
    const config = (value?: string[]) => runtimeRowsFor({ harness: "codex", health: health(value) }).find(row => row.label === "config");
    expect(config(undefined)?.value).toBe("synced");
    expect(config([])?.value).toBe("synced");
    expect(config(["approvals_reviewer"])).toMatchObject({ value: "synced · you keep 1", tone: "ok" });
    expect(config(["approvals_reviewer", "sandbox_mode"])?.value).toBe("synced · you keep 2");
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
    mcp: { status: "synced", path: "~/.config/kilo/kilo.jsonc", playwright_version: "0.0.83", detail: "installed and current" },
    skills: { status: "synced", synced: 17, expected: 17, roots: ["~/.claude/skills", "~/.agents/skills"] },
    warnings: [],
    next_action: "No runtime action needed.",
    ...overrides,
  });
  const rulesHealth = (rules: Partial<LightRuntimeHealth["rules"]>) => health({ rules: { ...health().rules, ...rules } });
  const mcpHealth = (mcp: Partial<LightRuntimeHealth["mcp"]>) => health({ mcp: { ...health().mcp, ...mcp } });

  it("lists the CLI, the rules file, the Playwright entry and the skills, with the skill loads below the skills row", () => {
    const rows = runtimeRowsFor({ harness: "kilo", health: health() }, LOADS);
    expect(labelsOf(rows)).toEqual(["cli", "rules", "mcp playwright", "skills", "skill loads"]);
    expect(rows[0]).toEqual({ label: "cli", value: "7.8.12", tone: "ok" });
    expect(rows[1]).toEqual({ label: "rules", value: "synced", tone: "ok", wrap: false });
    expect(rows[2]).toEqual({ label: "mcp playwright", value: "synced · 0.0.83", tone: "ok", wrap: false });
    expect(rows[3]).toEqual({ label: "skills", value: "synced · 17/17", tone: "ok" });
  });

  it("says what is wrong with the Playwright entry in the mcp row", () => {
    const row = (mcp: Partial<LightRuntimeHealth["mcp"]>) => runtimeRowsFor({ harness: "kilo", health: mcpHealth(mcp) }).find(candidate => candidate.label === "mcp playwright");
    expect(row({ status: "missing", playwright_version: null, detail: "no file yet" })).toEqual({
      label: "mcp playwright",
      value: "missing · no file yet",
      tone: "fail",
      wrap: true,
    });
    expect(row({ status: "stale", detail: "update available for the playwright entry" })).toMatchObject({
      value: "stale · 0.0.83 · update available for the playwright entry",
      tone: "warn",
      wrap: true,
    });
    expect(row({ status: "diverged", playwright_version: null, detail: "an entry named playwright already exists and differs from the managed one; rename or remove it to let the app manage the entry" })).toMatchObject({
      value: "diverged · an entry named playwright already exists and differs from the managed one; rename or remove it to let the app manage the entry",
      tone: "warn",
    });
    expect(row({ status: "invalid", playwright_version: null, detail: "the file has comments; the app edits strict JSON only and writes nothing" })).toMatchObject({
      value: "invalid · the file has comments; the app edits strict JSON only and writes nothing",
      tone: "fail",
    });
    expect(row({ status: "off", playwright_version: null, detail: "switched off in Settings" })).toEqual({
      label: "mcp playwright",
      value: "off · target switched off in Settings",
      tone: "dim",
    });
    expect(row({ status: "unknown", playwright_version: null, detail: "the MCP file could not be checked" })).toMatchObject({
      value: "unknown · the MCP file could not be checked",
      tone: "dim",
    });
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
