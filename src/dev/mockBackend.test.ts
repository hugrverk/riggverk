import { invoke } from "@tauri-apps/api/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AgentTargetMeta,
  FileDiffView,
  InstallationStatus,
  LightRuntimeHealth,
  RulesConversionPreview,
  RulesDiffView,
  SetupPlan,
  SetupResult,
  TakeBundledPreview,
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

describe("mock backend: the light harnesses' Playwright MCP entries", () => {
  it("lists an MCP target per light harness, on by default except Kilo's", async () => {
    const targets = await invoke<AgentTargetMeta[]>("get_agent_targets");
    expect(targets.filter(target => target.kind === "mcp")).toEqual([
      { id: "copilot_mcp", label: "copilot mcp", harness: "copilot", kind: "mcp", target_rel: ".copilot/mcp-config.json", source_rel: "templates/mcp/copilot.playwright.json" },
      { id: "pi_mcp", label: "pi mcp", harness: "pi", kind: "mcp", target_rel: ".pi/agent/mcp.json", source_rel: "templates/mcp/pi.playwright.json" },
      { id: "kilo_mcp", label: "kilo mcp", harness: "kilo", kind: "mcp", target_rel: ".config/kilo/kilo.jsonc", source_rel: "templates/mcp/kilo.playwright.json" },
    ]);
    const { settings } = await invoke<{ settings: { enabled_target_ids: string[] } }>("get_settings");
    expect(settings.enabled_target_ids).toContain("copilot_mcp");
    expect(settings.enabled_target_ids).toContain("pi_mcp");
    expect(settings.enabled_target_ids).not.toContain("kilo_mcp");
  });

  it("reports a file the app does not edit, with its reason, in the conflict scenario", async () => {
    const status = await invoke<InstallationStatus>("get_installation_status", { surfaces: ["copilot_mcp", "pi_mcp", "kilo_mcp"] });
    const by = Object.fromEntries(status.surfaces.map(row => [row.surface, row]));
    expect(by.copilot_mcp).toMatchObject({ state: "not_installed" });
    expect(by.pi_mcp).toMatchObject({ state: "conflict", detail: "the file has comments; the app edits strict JSON only and writes nothing" });
    expect(by.kilo_mcp).toMatchObject({ state: "update_available" });
  });

  it("gives the health an MCP row, the Pi exposure note and a verdict that follows it", async () => {
    const pi = await invoke<LightRuntimeHealth>("get_light_runtime_health", { harness: "pi" });
    expect(pi.mcp).toMatchObject({ status: "invalid", path: "~/.pi/agent/mcp.json", playwright_version: null });
    expect(pi.warnings.some(warning => warning.includes("exposure"))).toBe(true);

    const copilot = await invoke<LightRuntimeHealth>("get_light_runtime_health", { harness: "copilot" });
    expect(copilot.mcp).toMatchObject({ status: "missing", path: "~/.copilot/mcp-config.json", detail: "not installed" });
    expect(copilot.warnings.some(warning => warning.includes("exposure"))).toBe(false);

    const kilo = await invoke<LightRuntimeHealth>("get_light_runtime_health", { harness: "kilo" });
    expect(kilo.mcp).toMatchObject({ status: "off", path: "~/.config/kilo/kilo.jsonc" });
  });
});

describe("mock backend: skill and agent files in conflict or kept", () => {
  const statusOf = async (surface: "skills" | "claude_agents") =>
    (await invoke<InstallationStatus>("get_installation_status", { surfaces: [surface] })).surfaces[0]!;

  it("reports units in conflict first and a kept one with a bundled update waiting", async () => {
    const skills = await statusOf("skills");
    expect(skills.files).toMatchObject({ conflicts: 5, kept: 1, kept_updates: 1 });
    expect(skills.files!.units.map(unit => [unit.key, unit.state])).toEqual([
      ["skill:claude:tdd", "conflict"],
      ["skill:agents:security-audit", "conflict"],
      ["skill:claude:diagnose", "kept"],
    ]);
    const agents = await statusOf("claude_agents");
    expect(agents.files!.units.map(unit => unit.key)).toEqual(["agent:verifier", "agent:sentinel"]);
  });

  it("diffs a unit, withholding what it must not show, and refuses a unit that is not listed", async () => {
    const diff = await invoke<FileDiffView>("preview_file_diff", { surface: "skills", unit: "skill:agents:security-audit" });
    expect(diff.files.map(file => [file.rel, file.kind])).toEqual([
      ["HUNTING.md", "text"],
      ["CLIENT-SIDE.md", "identical_text"],
      ["assets/report.bin", "binary"],
      ["scripts/deploy.sh", "withheld"],
    ]);
    await expect(invoke("preview_file_diff", { surface: "skills", unit: "skill:claude:nope" })).rejects.toThrow("no conflicting or kept files");
  });

  it("keeps and hands back a unit like the backend does, and the surface follows", async () => {
    await invoke("set_files_kept", { surface: "claude_agents", units: ["agent:verifier"], kept: true });
    expect((await statusOf("claude_agents")).files).toMatchObject({ conflicts: 0, kept: 2 });
    expect((await invoke<InstallationStatus>("get_installation_status", { surfaces: ["claude_agents"] })).counts.kept_count).toBe(2);
    await invoke("set_files_kept", { surface: "claude_agents", units: ["agent:verifier"], kept: false });
    expect((await statusOf("claude_agents")).files).toMatchObject({ conflicts: 1, kept: 1 });
    await expect(invoke("set_files_kept", { surface: "claude_agents", units: ["agent:nope"], kept: true })).rejects.toThrow("no conflicting or kept files");
    await expect(invoke("set_files_kept", { surface: "claude_agents", units: [], kept: true })).rejects.toThrow("at least one");
  });

  it("takes the bundled version of a unit only with the preview's own proof, and the rollback brings the conflict back", async () => {
    const preview = await invoke<TakeBundledPreview>("preview_take_bundled", { surface: "claude_agents", units: ["agent:sentinel"] });
    expect(preview.units).toHaveLength(1);
    expect(preview.units[0]!.files[0]).toMatchObject({ rel: "sentinel.md", state: "kept", backup_name: expect.stringContaining("artifacts/") });
    expect(preview.units[0]!.diff.files[0]!.kind).toBe("text");
    await expect(invoke("preview_take_bundled", { surface: "claude_agents", units: ["agent:nope"] })).rejects.toThrow("no conflicting or kept files");

    // Proof from nowhere, or for another preview, changes nothing.
    await expect(
      invoke("apply_take_bundled", { surface: "claude_agents", units: ["agent:sentinel"], planFingerprint: "0".repeat(64), previewToken: preview.preview_token }),
    ).rejects.toThrow("mismatch");
    expect((await statusOf("claude_agents")).files!.units.map(unit => unit.key)).toContain("agent:sentinel");

    const result = await invoke<SetupResult>("apply_take_bundled", {
      surface: "claude_agents",
      units: ["agent:sentinel"],
      planFingerprint: preview.plan_fingerprint,
      previewToken: preview.preview_token,
    });
    expect(result).toMatchObject({ success: true, applied: ["~/.claude/agents/sentinel.md"] });
    expect((await statusOf("claude_agents")).files!.units.map(unit => unit.key)).toEqual(["agent:verifier"]);
    // A token is used once.
    await expect(
      invoke("apply_take_bundled", { surface: "claude_agents", units: ["agent:sentinel"], planFingerprint: preview.plan_fingerprint, previewToken: preview.preview_token }),
    ).rejects.toThrow("mismatch");

    const rolled = await invoke<SetupResult>("rollback_setup_transaction", { transactionId: result.transaction_id, dryRun: false });
    expect(rolled.success).toBe(true);
    // The file is back, but not the choice to keep it.
    expect((await statusOf("claude_agents")).files!.units.map(unit => [unit.key, unit.state])).toEqual([
      ["agent:verifier", "conflict"],
      ["agent:sentinel", "conflict"],
    ]);
  });
});
