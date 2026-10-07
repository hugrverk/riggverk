import type { KvItem } from "../ui/Kv";
import type { Tone } from "../ui/tone";
import type {
  ClaudeRuntimeHealth,
  CodexRuntimeHealth,
  CursorProfileHealth,
  OpenCodeRuntimeHealth,
} from "../types";
import { runtimeChipLabel, runtimeChipTone } from "./runtimeUi";

/** Runtime health of one harness, as loaded by the workspace health controller. */
export type HarnessRuntimeHealth =
  | { harness: "codex"; health: CodexRuntimeHealth | null }
  | { harness: "opencode"; health: OpenCodeRuntimeHealth | null }
  | { harness: "claude"; health: ClaudeRuntimeHealth | null }
  | { harness: "cursor"; health: CursorProfileHealth | null };

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

/** The backend's next step, only while the runtime is out of sync: "No runtime action needed." is noise. */
function nextRows(status: string, next: string | null | undefined): KvItem[] {
  return runtimeChipTone(status) === "ok" ? [] : textRow("next", next, { wrap: true });
}

function warningRows(warnings: readonly string[]): KvItem[] {
  return warnings.map((warning, index) => ({ label: index === 0 ? "warnings" : "", value: warning, tone: "warn" as const, wrap: true, id: `warning-${index}` }));
}

function codexRows(health: CodexRuntimeHealth): KvItem[] {
  return [
    statusRow("runtime", health.status),
    statusRow("rules", health.rules_status),
    { label: "agents", value: `${runtimeChipLabel(health.agents_status).toLowerCase()} · ${health.installed_bundled_agent_count}/${health.bundled_agent_count}`, tone: toneOf(health.agents_status) },
    { label: "skills", value: `${runtimeChipLabel(health.skills_status).toLowerCase()} · ${health.skills_synced_count}/${health.skills_expected_count}`, tone: toneOf(health.skills_status) },
    { label: "config", value: runtimeChipLabel(health.config_status).toLowerCase(), tone: toneOf(health.config_status) },
    ...textRow("approval", health.approval_policy),
    ...textRow("sandbox", health.sandbox_mode),
    ...nextRows(health.status, health.next_action),
    ...warningRows(health.warnings),
  ];
}

function opencodeRows(health: OpenCodeRuntimeHealth): KvItem[] {
  return [
    statusRow("runtime", health.status),
    ...textRow("default agent", health.default_agent),
    ...textRow("autoupdate", health.autoupdate),
    { label: "agents", value: `${health.installed_bundled_agent_count}/${health.bundled_agent_count} installed`, tone: health.agent_mismatches.length > 0 ? "warn" : "ok" },
    statusRow("tui", health.tui_status),
    ...nextRows(health.status, health.next_action),
    ...warningRows(health.warnings),
  ];
}

function cursorRows(health: CursorProfileHealth): KvItem[] {
  return [
    statusRow("runtime", health.status),
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

function claudeRows(health: ClaudeRuntimeHealth): KvItem[] {
  const synced = health.rules_synced && health.agents_synced && health.skills_synced;
  return [
    flagRow("runtime", synced),
    flagRow("rules", health.rules_synced),
    { label: "agents", value: `${health.agents_synced ? "synced" : "diverged"} · ${health.installed_agent_count}/${health.expected_agent_count}`, tone: health.agents_synced ? "ok" : "warn" },
    flagRow("skills", health.skills_synced),
    { label: "claude cli", value: health.claude_cli_available ? "available" : "not found", tone: health.claude_cli_available ? "ok" : "warn" },
  ];
}

/** `key  value` rows for the runtime section of a harness page. */
export function runtimeRowsFor({ harness, health }: HarnessRuntimeHealth): KvItem[] {
  if (!health) return [{ label: "runtime", value: "not loaded", tone: "dim" }];
  switch (harness) {
    case "codex": return codexRows(health);
    case "opencode": return opencodeRows(health);
    case "cursor": return cursorRows(health);
    case "claude": return claudeRows(health);
  }
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
