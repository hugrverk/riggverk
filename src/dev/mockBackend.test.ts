import { invoke } from "@tauri-apps/api/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AgentTargetMeta,
  InstallationStatus,
  LightRuntimeHealth,
  RulesConversionPreview,
  RulesDiffView,
  SetupPlan,
  WorkspaceDiagnostics,
} from "../types";

/**
 * The browser-only mock backend stands in for the Tauri commands when the app is opened with `?mock=<scenario>`,
 * and the visual QA of the light harnesses' rules rows depends on it. It installs itself on import.
 */
beforeAll(async () => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?mock=conflict");
  await import("./mockBackend");
});

const LIGHT_RULES = ["copilot_rules", "pi_rules", "kilo_rules"] as const;

describe("mock backend: the light harnesses' rules files", () => {
  it("lists a rules target per light harness, on by default, and counts them in the diagnostics", async () => {
    const targets = await invoke<AgentTargetMeta[]>("get_agent_targets");
    expect(targets.filter(target => LIGHT_RULES.includes(target.id as (typeof LIGHT_RULES)[number]))).toEqual([
      { id: "copilot_rules", label: "copilot rules", harness: "copilot", kind: "rules", target_rel: ".copilot/copilot-instructions.md", source_rel: "templates/sync/copilot-rules.md" },
      { id: "pi_rules", label: "pi rules", harness: "pi", kind: "rules", target_rel: ".pi/agent/AGENTS.md", source_rel: "templates/sync/pi-rules.md" },
      { id: "kilo_rules", label: "kilo rules", harness: "kilo", kind: "rules", target_rel: ".config/kilo/AGENTS.md", source_rel: "templates/sync/kilo-rules.md" },
    ]);
    const { settings } = await invoke<{ settings: { enabled_target_ids: string[]; enabled_harness_ids: string[] } }>("get_settings");
    for (const id of LIGHT_RULES) expect(settings.enabled_target_ids).toContain(id);
    expect(settings.enabled_harness_ids).not.toContain("pi");
    const diagnostics = await invoke<WorkspaceDiagnostics>("get_workspace_diagnostics");
    expect(diagnostics.total_rule_targets).toBe(6);
  });

  it("reports an absent, a masked and an outdated rules file in the conflict scenario", async () => {
    const status = await invoke<InstallationStatus>("get_installation_status", { surfaces: [...LIGHT_RULES] });
    const by = Object.fromEntries(status.surfaces.map(row => [row.surface, row]));
    expect(by.copilot_rules).toMatchObject({ state: "not_installed", rules: { layout: "absent" } });
    expect(by.pi_rules).toMatchObject({
      state: "conflict",
      rules: { conflict_reason: "masked_by_override" },
      detail: "an override file in the same folder masks this file, left as is",
    });
    expect(by.kilo_rules).toMatchObject({ state: "update_available" });
  });

  it("refuses to convert a masked file and says why", async () => {
    const preview = await invoke<RulesConversionPreview>("preview_rules_conversion", { surface: "pi_rules" });
    expect(preview.applicable).toBe(false);
    expect(preview.reason).toContain("masks");
    expect(preview.preview_token).toBeNull();
    const diff = await invoke<RulesDiffView>("preview_rules_diff", { surface: "pi_rules", mode: "update" });
    expect(diff.applicable).toBe(false);
  });

  it("plans a new Copilot file as a create at its own path", async () => {
    const plan = await invoke<SetupPlan>("preview_setup", { surfaces: ["copilot_rules"] });
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({ surface: "copilot_rules", kind: "create" });
    expect(plan.operations[0]!.summary).toContain("~/.copilot/copilot-instructions.md");
  });

  it("gives the health a rules row and the warnings the backend gives", async () => {
    const pi = await invoke<LightRuntimeHealth>("get_light_runtime_health", { harness: "pi" });
    expect(pi.rules).toMatchObject({ status: "diverged", path: "~/.pi/agent/AGENTS.md", conflict_reason: "masked_by_override" });
    expect(pi.status).toBe("diverged");
    expect(pi.warnings.some(warning => warning.includes("AGENTS.override.md"))).toBe(true);

    const kilo = await invoke<LightRuntimeHealth>("get_light_runtime_health", { harness: "kilo" });
    expect(kilo.rules).toMatchObject({ status: "stale", path: "~/.config/kilo/AGENTS.md" });
    expect(kilo.warnings.some(warning => warning.includes("~/.claude/CLAUDE.md"))).toBe(true);

    const copilot = await invoke<LightRuntimeHealth>("get_light_runtime_health", { harness: "copilot" });
    expect(copilot.rules).toMatchObject({ status: "missing", path: "~/.copilot/copilot-instructions.md" });
    // Claude's rules are managed in the mock, so the VS Code note shows.
    expect(copilot.warnings.some(warning => warning.includes("VS Code"))).toBe(true);
  });
});
