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

function codexRows(health: CodexRuntimeHealth): KvItem[] {
  // The AGENTS.override.md warning has its own alert on the Codex page; the warnings row would repeat it.
  const override = health.checks?.find(check => check.id === "rules_override" && check.status === "warn")?.detail;
  return [
    statusRow("rules", health.rules_status),
    { label: "agents", value: `${runtimeChipLabel(health.agents_status).toLowerCase()} · ${health.installed_bundled_agent_count}/${health.bundled_agent_count}`, tone: toneOf(health.agents_status) },
    { label: "skills", value: `${runtimeChipLabel(health.skills_status).toLowerCase()} · ${health.skills_synced_count}/${health.skills_expected_count}`, tone: toneOf(health.skills_status) },
    { label: "config", value: runtimeChipLabel(health.config_status).toLowerCase(), tone: toneOf(health.config_status) },
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

/** `installed/bundled`, then the files that are not as bundled, grouped by their status: "missing: a.md". */
function opencodeAgentsRow(health: OpenCodeRuntimeHealth): KvItem {
  const filesByStatus = new Map<string, string[]>();
  for (const { status, filename } of health.agent_mismatches) filesByStatus.set(status, [...(filesByStatus.get(status) ?? []), filename]);
  const groups = [...filesByStatus].map(([status, files]) => `${status}: ${files.join(", ")}`);
  return {
    label: "agents",
    value: [`${health.installed_bundled_agent_count}/${health.bundled_agent_count} installed`, ...groups].join(" · "),
    tone: groups.length > 0 ? "warn" : "ok",
    wrap: groups.length > 0,
  };
}

/** The status, then the managed keys that differ from the bundled config. */
function opencodeConfigRow(health: OpenCodeRuntimeHealth): KvItem {
  const keys = health.config_diverged_keys;
  const status = runtimeChipLabel(health.config_status).toLowerCase();
  return { label: "config", value: keys.length > 0 ? `${status} · ${keys.join(", ")}` : status, tone: toneOf(health.config_status), wrap: keys.length > 0 };
}

function opencodeRows(health: OpenCodeRuntimeHealth): KvItem[] {
  const playwright = health.playwright_mcp_version;
  return [
    ...opencodeCliRow(health.cli),
    ...textRow("default agent", health.default_agent),
    ...textRow("autoupdate", health.autoupdate),
    statusRow("rules", health.rules_status),
    opencodeAgentsRow(health),
    opencodeConfigRow(health),
    playwright
      ? { label: "mcp playwright", value: playwright, tone: health.config_diverged_keys.includes("mcp.playwright") ? "warn" as const : "ok" as const }
      : { label: "mcp playwright", value: "none", tone: "dim" as const },
    statusRow("tui", health.tui_status),
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
    case "kilo": return lightRows(health);
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
