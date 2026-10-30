import type { KvItem } from "../ui/Kv";
import type { Tone } from "../ui/tone";
import type {
  ClaudeRuntimeHealth,
  CodexRuntimeHealth,
  CursorProfileHealth,
  LightAgent,
  LightCliHealth,
  LightMcpHealth,
  LightRulesHealth,
  LightRuntimeHealth,
  OpenCodeCliHealth,
  OpenCodeRuntimeHealth,
} from "../types";
import { runtimeChipLabel, runtimeChipTone } from "./runtimeUi";

/** Runtime health of one harness, as loaded by the workspace health controller. */
export type HarnessRuntimeHealth =
  | { harness: "codex"; health: CodexRuntimeHealth | null }
  | { harness: "opencode"; health: OpenCodeRuntimeHealth | null }
  | { harness: "claude"; health: ClaudeRuntimeHealth | null }
  | { harness: "cursor"; health: CursorProfileHealth | null }
  | { harness: LightAgent; health: LightRuntimeHealth | null };

function toneOf(status: string): Tone {
  const tone = runtimeChipTone(status);
  return tone === "muted" ? "dim" : tone;
}

function statusRow(label: string, status: string): KvItem {
  return { label, value: runtimeChipLabel(status).toLowerCase(), tone: toneOf(status) };
}

function flagRow(label: string, synced: boolean): KvItem {
  return { label, value: synced ? "synced" : "diverged", tone: synced ? "ok" : "warn" };
}

function textRow(label: string, value: string | null | undefined, options: { wrap?: boolean; tone?: Tone } = {}): KvItem[] {
  return value ? [{ label, value, ...options }] : [];
}

/** A backend sentence ("Update OpenCode.") as a row value: lowercase start and no full stop, like every other value. */
function fragment(sentence: string): string {
  const text = sentence.trim().replace(/\.$/, "");
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The backend's next step, only while the runtime is out of sync: "No runtime action needed." is noise. */
function nextRows(status: string, next: string | null | undefined): KvItem[] {
  return runtimeChipTone(status) === "ok" ? [] : textRow("next", next && fragment(next), { wrap: true });
}

function warningRows(warnings: readonly string[]): KvItem[] {
  return warnings.map((warning, index) => ({ label: index === 0 ? "warnings" : "", value: warning, tone: "warn" as const, wrap: true, id: `warning-${index}` }));
}

/*
 * The overall verdict is the runtime group's heading (`runtimeVerdict`), so the rows below start with the parts.
 */

/** The config status, and how many enforced keys the user keeps ("synced · you keep 1"). */
function codexConfigRow(health: CodexRuntimeHealth): KvItem {
  const kept = health.config_kept?.length ?? 0;
  const status = runtimeChipLabel(health.config_status).toLowerCase();
  return { label: "config", value: kept > 0 ? `${status} · you keep ${kept}` : status, tone: toneOf(health.config_status) };
}

function codexRows(health: CodexRuntimeHealth): KvItem[] {
  // The AGENTS.override.md warning has its own alert on the Codex page; the warnings row would repeat it.
  const override = health.checks?.find(check => check.id === "rules_override" && check.status === "warn")?.detail;
  return [
    statusRow("rules", health.rules_status),
    { label: "agents", value: `${runtimeChipLabel(health.agents_status).toLowerCase()} · ${health.installed_bundled_agent_count}/${health.bundled_agent_count}`, tone: toneOf(health.agents_status) },
    { label: "skills", value: `${runtimeChipLabel(health.skills_status).toLowerCase()} · ${health.skills_synced_count}/${health.skills_expected_count}`, tone: toneOf(health.skills_status) },
    codexConfigRow(health),
    ...textRow("approval", health.approval_policy),
    ...textRow("sandbox", health.sandbox_mode),
    ...nextRows(health.status, health.next_action),
    ...warningRows(health.warnings.filter(warning => warning !== override)),
  ];
}

/** The CLI version, or why there is none. An unsupported major's full explanation is in the warnings. */
function opencodeCliRow(cli: OpenCodeCliHealth | null): KvItem[] {
  if (!cli) return [];
  switch (cli.status) {
    case "supported": return [{ label: "cli", value: cli.version ?? "found", tone: "ok" }];
    case "unsupported": return [{ label: "cli", value: `${cli.version ?? "unknown"} · unsupported`, tone: "warn" }];
    case "missing": return [{ label: "cli", value: cli.detail, tone: "warn", wrap: true }];
    default: return [{ label: "cli", value: "found · version unknown", tone: "dim" }];
  }
}

/** The agent files: `synced · 6/6`, or `installed/bundled` and the files that are not as bundled, grouped by their status: "missing: a.md". */
function opencodeAgentsRow(health: OpenCodeRuntimeHealth): KvItem {
  const filesByStatus = new Map<string, string[]>();
  for (const { status, filename } of health.agent_mismatches) filesByStatus.set(status, [...(filesByStatus.get(status) ?? []), filename]);
  const groups = [...filesByStatus].map(([status, files]) => `${status}: ${files.join(", ")}`);
  const count = `${health.installed_bundled_agent_count}/${health.bundled_agent_count}`;
  return groups.length > 0
    ? { label: "agents", value: [count, ...groups].join(" · "), tone: "warn", wrap: true }
    : { label: "agents", value: `synced · ${count}`, tone: "ok" };
}

/** A status, then the managed keys that differ from the bundled file (by name), then notes about the file. */
function statusKeysRow(label: string, status: string, keys: readonly string[], notes: readonly string[] = []): KvItem {
  const parts = [runtimeChipLabel(status).toLowerCase(), ...(keys.length > 0 ? [keys.join(", ")] : []), ...notes];
  return { label, value: parts.join(" · "), tone: toneOf(status), wrap: parts.length > 1 };
}

/** The config status and its differing keys, then what makes the file JSONC (the app does not rewrite it then). */
function opencodeConfigRow(health: OpenCodeRuntimeHealth): KvItem {
  const notStrict = health.config_precedence.installed_not_strict;
  return statusKeysRow("config", health.config_status, health.config_diverged_keys, notStrict.length > 0 ? [`has ${notStrict.join(", ")}`] : []);
}

/** What else changes the config OpenCode runs, by name only: sibling files and their managed keys, config variables, a system managed config. The warnings say what to do. */
function opencodeOverridesRow({ config_precedence: precedence }: OpenCodeRuntimeHealth): KvItem[] {
  const parts = [
    ...precedence.sibling_files.map(({ file, managed_keys, invalid }) => `${file}: ${invalid ? "not valid JSONC" : managed_keys.join(", ")}`),
    ...(precedence.env_vars.length > 0 ? [`env: ${precedence.env_vars.join(", ")}`] : []),
    ...(precedence.system_managed_paths.length > 0 ? [`system managed: ${precedence.system_managed_paths.join(", ")}`] : []),
  ];
  return parts.length > 0 ? [{ label: "overrides", value: parts.join(" · "), tone: "warn", wrap: true }] : [];
}

/**
 * The pinned `@playwright/mcp` version with a status, like the Copilot, Pi and Kilo pages: `synced · 0.0.83`. The
 * status is the managed `mcp.playwright` entry against the bundled one, so there is none while the file is not compared.
 */
function opencodePlaywrightRow(health: OpenCodeRuntimeHealth): KvItem {
  const label = "mcp playwright";
  const version = health.playwright_mcp_version;
  if (health.config_diverged_keys.includes("mcp.playwright")) return { label, value: version ? `diverged · ${version}` : "diverged", tone: "warn" };
  if (!version) return { label, value: "none", tone: "dim" };
  const compared = health.config_status === "synced" || health.config_status === "diverged";
  return compared ? { label, value: `synced · ${version}`, tone: "ok" } : { label, value: version, tone: "dim" };
}

function opencodeRows(health: OpenCodeRuntimeHealth): KvItem[] {
  return [
    ...opencodeCliRow(health.cli),
    ...textRow("default agent", health.default_agent),
    ...textRow("autoupdate", health.autoupdate),
    statusRow("rules", health.rules_status),
    opencodeAgentsRow(health),
    opencodeConfigRow(health),
    ...opencodeOverridesRow(health),
    opencodePlaywrightRow(health),
    statusKeysRow("tui", health.tui_status, health.tui_diverged_keys),
    ...nextRows(health.status, health.next_action),
    ...warningRows(health.warnings),
  ];
}

function cursorRows(health: CursorProfileHealth): KvItem[] {
  return [
    { label: "profile", value: health.profile_root },
    statusRow("workspace", health.workspace_resources_status),
    { label: "agents", value: `${health.global_agents_count}/${health.expected_global_agents_count}`, tone: toneOf(health.global_agents_status) },
    { label: "skills", value: `${health.global_skills_count}/${health.expected_global_skills_count}`, tone: toneOf(health.global_skills_status) },
    statusRow("mcp", health.mcp_status),
    { label: "user rules", value: health.user_rules_status },
    ...nextRows(health.status, health.next_action),
    ...warningRows(health.warnings),
  ];
}

/** The CLI version, or why there is none. Nothing but `--version` is ever run, so there is nothing else to show. */
function lightCliRow(cli: LightCliHealth): KvItem {
  switch (cli.status) {
    case "found": return { label: "cli", value: `${cli.version ?? "found"}${cli.source === "nvm" ? " · nvm" : ""}`, tone: "ok" };
    case "missing": return { label: "cli", value: cli.detail, tone: "dim", wrap: true };
    default: return { label: "cli", value: "found · version unknown", tone: "dim" };
  }
}

/** The rules file: its status, and what the backend says about it unless that adds nothing. */
function lightRulesRow(rules: LightRulesHealth): KvItem {
  if (rules.status === "off") return { label: "rules", value: "off · target switched off in Settings", tone: "dim" };
  // A harness that reads Claude Code's rules file instead of its own (Grok): where its rules come from, or that none do.
  if (rules.status === "shared") return { label: "rules", value: `shared · ${rules.detail}`, tone: "ok", wrap: true };
  if (rules.status === "none") return { label: "rules", value: `none · ${rules.detail}`, tone: "dim", wrap: true };
  const extra = rules.status === "missing" || rules.detail === "installed and current" || !rules.detail ? "" : ` · ${rules.detail}`;
  return { label: "rules", value: `${runtimeChipLabel(rules.status).toLowerCase()}${extra}`, tone: toneOf(rules.status), wrap: extra !== "" };
}

/** The Playwright entry in the MCP file: its status, the pinned version, and what the backend says unless that adds nothing. */
function lightMcpRow(mcp: LightMcpHealth): KvItem {
  if (mcp.status === "off") return { label: "mcp playwright", value: "off · target switched off in Settings", tone: "dim" };
  const version = mcp.status === "synced" || mcp.status === "stale" ? (mcp.playwright_version ?? "") : "";
  const extra = [version, mcp.status === "synced" || !mcp.detail ? "" : mcp.detail].filter(Boolean);
  const wrap = mcp.status !== "synced" && mcp.detail !== "";
  return {
    label: "mcp playwright",
    value: [runtimeChipLabel(mcp.status).toLowerCase(), ...extra].join(" · "),
    tone: toneOf(mcp.status),
    wrap,
  };
}

/** The CLI, the rules file, the Playwright MCP entry and the skills are managed for the light harnesses. */
function lightRows(health: LightRuntimeHealth): KvItem[] {
  const { skills } = health;
  return [
    lightCliRow(health.cli),
    lightRulesRow(health.rules),
    lightMcpRow(health.mcp),
    {
      label: "skills",
      value: `${runtimeChipLabel(skills.status).toLowerCase()} · ${skills.synced}/${skills.expected}`,
      tone: toneOf(skills.status),
    },
    ...nextRows(health.status, health.next_action),
    ...warningRows(health.warnings),
  ];
}

function claudeRows(health: ClaudeRuntimeHealth): KvItem[] {
  return [
    flagRow("rules", health.rules_synced),
    { label: "agents", value: `${health.agents_synced ? "synced" : "diverged"} · ${health.installed_agent_count}/${health.expected_agent_count}`, tone: health.agents_synced ? "ok" : "warn" },
    flagRow("skills", health.skills_synced),
    { label: "claude cli", value: health.claude_cli_available ? "available" : "not found", tone: health.claude_cli_available ? "ok" : "warn" },
  ];
}

function healthRows({ harness, health }: HarnessRuntimeHealth): KvItem[] {
  // Not loaded yet: the heading says so.
  if (!health) return [];
  switch (harness) {
    case "codex": return codexRows(health);
    case "opencode": return opencodeRows(health);
    case "cursor": return cursorRows(health);
    case "claude": return claudeRows(health);
    case "copilot":
    case "pi":
    case "kilo":
    case "antigravity": return lightRows(health);
    case "grok": return lightRows(health);
  }
}

/** The skill-load rows go below the skills row, or the agents row where there is none (OpenCode), else last. */
function withSkillLoadRows(rows: KvItem[], skillLoadRows: readonly KvItem[]): KvItem[] {
  if (skillLoadRows.length === 0) return rows;
  const after = ["skills", "agents"].map(label => rows.findIndex(row => row.label === label)).find(index => index >= 0);
  const at = after === undefined ? rows.length : after + 1;
  return [...rows.slice(0, at), ...skillLoadRows, ...rows.slice(at)];
}

/**
 * `key  value` rows for the runtime section of a harness page. `skillLoadRows` (which skill copies the harness
 * loads) come from the load view, not from the health, so they are shown even while the health is not loaded.
 */
export function runtimeRowsFor(runtime: HarnessRuntimeHealth, skillLoadRows: readonly KvItem[] = []): KvItem[] {
  return withSkillLoadRows(healthRows(runtime), skillLoadRows);
}

/** Short verdict for the runtime group heading: "synced", "diverged", "not loaded". */
export function runtimeVerdict(runtime: HarnessRuntimeHealth): { text: string; tone: Tone } {
  if (!runtime.health) return { text: "not loaded", tone: "dim" };
  if (runtime.harness === "claude") {
    const synced = runtime.health.rules_synced && runtime.health.agents_synced && runtime.health.skills_synced;
    return { text: synced ? "synced" : "diverged", tone: synced ? "ok" : "warn" };
  }
  const status = runtime.health.status;
  return { text: runtimeChipLabel(status).toLowerCase(), tone: toneOf(status) };
}
