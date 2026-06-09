import type { CodexRuntimeHealth } from "../types";
import { runtimeChipTone } from "./runtimeUi";

export type RuntimeChipTone = "ok" | "warn" | "fail" | "muted";

export function codexRulesStatus(health: CodexRuntimeHealth): string {
  return health.rules_status;
}

export function codexAgentsStatus(health: CodexRuntimeHealth): string {
  if (health.bundled_agent_count === 0) return "invalid";
  if (health.installed_bundled_agent_count < health.bundled_agent_count) return "missing";
  if (health.agent_mismatches.length > 0) return "diverged";
  return "synced";
}

export function codexConfigStatus(health: CodexRuntimeHealth): string {
  if (health.config_status === "invalid") return "invalid";
  if (health.config_status === "missing") return "missing";
  if (health.config_status === "diverged") return "diverged";
  return "synced";
}

export function codexSkillsStatus(health: CodexRuntimeHealth): string {
  return health.skills_status;
}

export function codexOverallTone(health: CodexRuntimeHealth): RuntimeChipTone {
  return runtimeChipTone(health.status);
}

export function codexSurfaceTone(status: string): RuntimeChipTone {
  if (status === "synced") return "ok";
  if (status === "missing" || status === "invalid") return "fail";
  return "warn";
}

export function codexAgentsNextAction(health: CodexRuntimeHealth): string | undefined {
  if (health.agent_mismatches.length === 0) return undefined;
  return `${health.agent_mismatches.length} native agent(s) diverged or missing — sync agents or diff first.`;
}

export function codexConfigNextAction(health: CodexRuntimeHealth): string | undefined {
  if (health.config_status === "synced") return undefined;
  if (health.config_status === "missing") return "Installed config missing — sync config to create managed defaults.";
  return "Managed config sections differ — diff or sync config.";
}
