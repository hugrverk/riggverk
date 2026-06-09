import type { OpenCodeRuntimeHealth } from "../types";
import { runtimeChipTone } from "./runtimeUi";

export type RuntimeChipTone = "ok" | "warn" | "fail" | "muted";

function findCheck(health: OpenCodeRuntimeHealth, id: string) {
  return health.checks.find(c => c.id === id);
}

function checkFailed(health: OpenCodeRuntimeHealth, id: string): boolean {
  return findCheck(health, id)?.status === "fail";
}

function checkWarned(health: OpenCodeRuntimeHealth, id: string): boolean {
  return findCheck(health, id)?.status === "warn";
}

export function configCheckTone(health: OpenCodeRuntimeHealth, id: string): RuntimeChipTone {
  const check = findCheck(health, id);
  if (!check) return "muted";
  if (check.status === "pass") return "ok";
  if (check.status === "warn") return "warn";
  return "fail";
}

/** Maps a health check to a runtime status id for labels/chips. */
export function configCheckStatusLabel(health: OpenCodeRuntimeHealth, id: string): string {
  if (id === "configs_match") {
    if (checkFailed(health, "installed_config_valid") || checkFailed(health, "template_config_valid")) {
      return "invalid";
    }
    if (checkFailed(health, "installed_config_exists") || checkFailed(health, "template_config_exists")) {
      return "missing";
    }
  }

  const check = findCheck(health, id);
  if (!check) {
    return "unknown";
  }
  if (check.status === "pass") return "synced";
  if (check.status === "warn") return "diverged";

  if (id === "configs_match" || id === "tui_configs_match") {
    if (checkFailed(health, "installed_config_valid") || checkFailed(health, "template_config_valid")) {
      return "invalid";
    }
    if (checkFailed(health, "installed_config_exists") || checkFailed(health, "template_config_exists")) {
      return "missing";
    }
    if (id === "tui_configs_match") {
      if (checkFailed(health, "installed_tui_config_exists") || checkFailed(health, "template_tui_config_exists")) {
        return "missing";
      }
    }
    return "diverged";
  }

  if (check.status === "fail") {
    if (id.includes("valid")) return "invalid";
    if (id.includes("exists")) return "missing";
  }
  return "invalid";
}

export function opencodeAgentsStatus(health: OpenCodeRuntimeHealth): string {
  if (health.bundled_agent_count === 0) return "invalid";
  if (findCheck(health, "legacy_scout")?.status === "warn") return "diverged";
  if (health.installed_bundled_agent_count < health.bundled_agent_count) return "missing";
  if (health.agent_mismatches.length > 0) return "diverged";
  return "synced";
}

export function opencodeAgentsTone(health: OpenCodeRuntimeHealth): RuntimeChipTone {
  return runtimeChipTone(opencodeAgentsStatus(health));
}

function checkDetailIncludes(health: OpenCodeRuntimeHealth, id: string, needle: string): boolean {
  return findCheck(health, id)?.detail.includes(needle) ?? false;
}

export function opencodeConfigStatus(health: OpenCodeRuntimeHealth): string {
  const configInvalid =
    checkFailed(health, "template_config_valid")
    || checkFailed(health, "installed_config_valid");
  const tuiInvalid =
    checkDetailIncludes(health, "template_tui_config_exists", "invalid JSON")
    || checkDetailIncludes(health, "installed_tui_config_exists", "invalid JSON");

  if (configInvalid || tuiInvalid) return "invalid";

  if (
    checkFailed(health, "template_config_exists")
    || checkFailed(health, "installed_config_exists")
    || checkFailed(health, "template_tui_config_exists")
    || checkFailed(health, "installed_tui_config_exists")
  ) {
    return "missing";
  }

  if (health.generated_snapshot_status === "stale") return "stale";

  if (checkWarned(health, "configs_match") || health.tui_status === "diverged" || checkWarned(health, "tui_configs_match")) {
    return "diverged";
  }

  if (health.generated_snapshot_status === "missing") return "missing";

  return "synced";
}

export function opencodeConfigTone(health: OpenCodeRuntimeHealth): RuntimeChipTone {
  const status = opencodeConfigStatus(health);
  if (status === "stale") return "warn";
  return runtimeChipTone(status);
}

export function opencodeConfigIssues(health: OpenCodeRuntimeHealth): string[] {
  const issues: string[] = [];
  if (checkFailed(health, "installed_config_exists")) issues.push("installed config missing");
  else if (checkFailed(health, "installed_config_valid")) issues.push("installed config invalid");
  else if (checkWarned(health, "configs_match")) issues.push("config differs");

  if (checkFailed(health, "installed_tui_config_exists")) issues.push("installed TUI missing");
  else if (checkDetailIncludes(health, "installed_tui_config_exists", "invalid JSON")) {
    issues.push("installed TUI invalid");
  } else if (health.tui_status === "diverged" || checkWarned(health, "tui_configs_match")) {
    issues.push("TUI differs");
  }

  if (health.generated_snapshot_status === "stale") issues.push("snapshot stale");
  else if (health.generated_snapshot_status === "missing") issues.push("snapshot missing");

  return issues;
}

export function opencodeAgentsIssues(health: OpenCodeRuntimeHealth): string[] {
  const issues: string[] = [];
  const missing = health.agent_mismatches.filter(m => m.status === "missing").length;
  const diverged = health.agent_mismatches.filter(m => m.status === "diverged").length;
  if (health.bundled_agent_count > 0 && health.installed_bundled_agent_count < health.bundled_agent_count) {
    const gap = health.bundled_agent_count - health.installed_bundled_agent_count;
    issues.push(`${gap} bundled agent(s) missing`);
  }
  if (missing > 0) issues.push(`${missing} agent(s) missing`);
  if (diverged > 0) issues.push(`${diverged} agent(s) diverged`);
  if (findCheck(health, "legacy_scout")?.status === "warn") {
    issues.push("legacy scout.md present");
  }
  if (health.extra_installed_agent_count > 0) {
    issues.push(`${health.extra_installed_agent_count} extra installed`);
  }
  return issues;
}

export function opencodeAgentsNextAction(health: OpenCodeRuntimeHealth): string | undefined {
  const issues = opencodeAgentsIssues(health);
  if (issues.length === 0) return undefined;
  if (health.agent_mismatches.length > 0) {
    return `${health.agent_mismatches.length} agent(s) diverged or missing — sync agents or diff first.`;
  }
  if (health.installed_bundled_agent_count < health.bundled_agent_count) {
    return "Some bundled agents are missing — sync agents.";
  }
  return undefined;
}

export function opencodeConfigNextAction(health: OpenCodeRuntimeHealth): string | undefined {
  const issues = opencodeConfigIssues(health);
  if (issues.length === 0) return undefined;
  if (health.generated_snapshot_status === "stale") {
    return health.generated_snapshot_detail || "Regenerate opencode.json before sync.";
  }
  return `${issues.join("; ")} — diff or sync config.`;
}

/** @internal Exported for release-check unit script. */
export function runOpencodeRuntimeUiSelfTests(): void {
  const baseHealth = (): OpenCodeRuntimeHealth => ({
    status: "diverged",
    template_config_path: "",
    installed_config_path: "",
    checks: [
      { id: "configs_match", label: "", status: "pass", detail: "" },
      { id: "template_config_exists", label: "", status: "pass", detail: "" },
      { id: "installed_config_exists", label: "", status: "pass", detail: "" },
      { id: "template_config_valid", label: "", status: "pass", detail: "" },
      { id: "installed_config_valid", label: "", status: "pass", detail: "" },
      { id: "template_tui_config_exists", label: "", status: "pass", detail: "" },
      { id: "installed_tui_config_exists", label: "", status: "pass", detail: "" },
      { id: "tui_configs_match", label: "", status: "pass", detail: "" },
    ],
    default_agent: null,
    model: null,
    small_model: null,
    autoupdate: null,
    snapshot: null,
    qwen_context: null,
    qwen_output: null,
    bundled_agent_count: 6,
    installed_bundled_agent_count: 6,
    extra_installed_agent_count: 0,
    agent_mismatches: [],
    warnings: [],
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
  });

  const assertEq = (actual: string, expected: string, label: string) => {
    if (actual !== expected) {
      throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
  };

  const syncedAgents = baseHealth();
  assertEq(opencodeAgentsStatus(syncedAgents), "synced", "agents synced when 6/6");
  assertEq(opencodeAgentsStatus({ ...syncedAgents, status: "diverged" }), "synced", "agents ignore global status");

  const divergedConfig = {
    ...syncedAgents,
    status: "diverged",
    checks: syncedAgents.checks.map(c =>
      c.id === "configs_match" ? { ...c, status: "warn" } : c,
    ),
  };
  assertEq(opencodeAgentsStatus(divergedConfig), "synced", "agents synced when config diverged");
  assertEq(opencodeConfigStatus(divergedConfig), "diverged", "config diverged when configs_match warn");
  assertEq(configCheckStatusLabel(divergedConfig, "configs_match"), "diverged", "configs_match warn label");
  assertEq(configCheckStatusLabel(divergedConfig, "configs_match"), "diverged", "not unknown");

  const passLabel = baseHealth();
  assertEq(configCheckStatusLabel(passLabel, "configs_match"), "synced", "configs_match pass");

  const stale = { ...syncedAgents, generated_snapshot_status: "stale" };
  assertEq(opencodeConfigStatus(stale), "stale", "config stale snapshot");

  const missingInstalled = {
    ...syncedAgents,
    checks: syncedAgents.checks
      .filter(c => c.id !== "configs_match")
      .map(c => c.id === "installed_config_exists" ? { ...c, status: "fail" } : c),
  };
  assertEq(configCheckStatusLabel(missingInstalled, "configs_match"), "missing", "configs_match when installed missing");

  const agentGap = { ...syncedAgents, installed_bundled_agent_count: 4 };
  assertEq(opencodeAgentsStatus(agentGap), "missing", "agents missing count");
}
