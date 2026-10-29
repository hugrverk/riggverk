import { describe, expect, it } from "vitest";
import type { OverviewEntry, OverviewId } from "../hooks/useInstallationOverview";
import type { AgentTargetMeta, InstallationState, InstallationStatus, SetupSurfaceId, SurfaceInstallationStatus } from "../types";
import {
  harnessRowsFor,
  previewDisabledFor,
  surfaceRowsFor,
  surfaceShortName,
  updateActionFor,
} from "./installationView";

function surface(id: SetupSurfaceId, state: InstallationState): SurfaceInstallationStatus {
  return { surface: id, label: id, state, detail: `${state} detail` };
}

function status(
  state: InstallationState,
  surfaces: SurfaceInstallationStatus[] = [],
  counts: Partial<InstallationStatus["counts"]> = {},
): InstallationStatus {
  return {
    state,
    summary: state,
    counts: { create_count: 0, update_count: 0, remove_count: 0, conflict_count: 0, ...counts },
    surfaces,
  };
}

function entry(id: OverviewId, value: InstallationStatus | null, extra: Partial<OverviewEntry> = {}): OverviewEntry {
  return { id, status: value, loading: false, error: null, ...extra };
}

const SETTINGS = {
  enabled_harness_ids: ["codex", "claude"] as ("codex" | "claude")[],
  // codex_config is off by default; codex_agents is off here too.
  enabled_target_ids: ["codex_rules", "claude_rules", "claude_agents"],
};

describe("surfaceRowsFor", () => {
  it("lists surfaces whose target toggle is off as off, without reading them from the status", () => {
    const claude = entry("claude", status("current", [surface("claude_rules", "current"), surface("claude_agents", "update_available"), surface("skills", "conflict")]));
    const rows = surfaceRowsFor("claude", claude, SETTINGS);
    expect(rows.map(row => [row.name, row.state])).toEqual([
      ["rules", "current"],
      ["agents", "update_available"],
      ["config", "off"],
      ["skills", "conflict"],
    ]);
    // claude_config says what stays as it is while it is off; the other targets just name the toggle.
    expect(rows[2]).toMatchObject({
      targetId: "claude_config",
      detail: "off · Claude Code keeps its default commit and PR attribution",
    });
    expect(surfaceRowsFor("codex", undefined, SETTINGS)[0]).toMatchObject({ detail: "target codex_config is off" });

    const codex = entry("codex", status("current", [surface("codex_rules", "current"), surface("skills", "update_available")]));
    const codexRows = surfaceRowsFor("codex", codex, SETTINGS);
    expect(codexRows.map(row => [row.surface, row.state])).toEqual([
      ["codex_config", "off"],
      ["codex_agents", "off"],
      ["codex_rules", "current"],
      ["skills", "update_available"],
    ]);
    expect(codexRows[0]).toMatchObject({ targetId: "codex_config", display: { label: "off", tone: "dim" } });
  });

  it("shows a rules file the user manages as 'you manage', not as current", () => {
    const managed: SurfaceInstallationStatus = {
      ...surface("claude_rules", "current"),
      rules: { layout: "legacy", refinement_lines: 0, conflict_reason: "legacy_diverged", user_managed: true },
    };
    const rows = surfaceRowsFor("claude", entry("claude", status("current", [managed])), SETTINGS);
    expect(rows[0]).toMatchObject({ state: "user_managed", display: { label: "you manage", tone: "warn" } });
  });

  it("shows skill or agent files the user keeps as 'you manage' on a surface that is otherwise current", () => {
    const files = { conflicts: 0, kept: 2, kept_updates: 1, units: [], more: 0 };
    const keeps: SurfaceInstallationStatus = { ...surface("skills", "current"), files };
    const rows = surfaceRowsFor("claude", entry("claude", status("current", [keeps])), SETTINGS);
    expect(rows.find(row => row.surface === "skills")).toMatchObject({ state: "user_managed", display: { label: "you manage", tone: "warn" } });
    // Anything but current keeps its own state: an update or a conflict is not hidden by files the user keeps.
    const updating: SurfaceInstallationStatus = { ...surface("skills", "update_available"), files };
    expect(surfaceRowsFor("claude", entry("claude", status("update_available", [updating])), SETTINGS).find(row => row.surface === "skills")!.state).toBe("update_available");
  });

  it("marks surfaces as unknown until the status arrives", () => {
    expect(surfaceRowsFor("workspace", undefined, null)).toEqual([
      expect.objectContaining({ surface: "workspace_bundle", state: "unknown" }),
    ]);
  });

  it("names the workspace surface after the old copies it removes; the matrix column stays bundle", () => {
    const workspace = entry("workspace", status("current", [surface("workspace_bundle", "current")]));
    expect(surfaceRowsFor("workspace", workspace, null)[0]).toMatchObject({ name: "old copies", state: "current" });
    expect(surfaceShortName("workspace_bundle")).toBe("bundle");
  });
});

describe("harnessRowsFor", () => {
  const TARGETS: AgentTargetMeta[] = [
    { id: "codex_agents", label: "codex agents", harness: "codex", kind: "agents", target_rel: ".codex/agents", source_rel: "templates/codex/agents" },
    { id: "codex_rules", label: "codex rules", harness: "codex", kind: "rules", target_rel: ".codex/AGENTS.md", source_rel: "templates/sync/codex-rules.md" },
    { id: "cursor_setup", label: "cursor global agents", harness: "cursor", kind: "agents", target_rel: ".cursor/agents", source_rel: "templates/cursor/agents" },
  ];

  it("gives every surface a row with the toggle of its target, codex agents included", () => {
    const codex = entry("codex", status("update_available", [surface("codex_rules", "update_available"), surface("skills", "current")]));
    const rows = harnessRowsFor("codex", codex, { ...SETTINGS, enabled_target_ids: ["codex_rules", "codex_agents"] }, TARGETS);
    expect(rows.map(row => [row.name, row.targetId, row.targetEnabled, row.state])).toEqual([
      ["config", "codex_config", false, "off"],
      ["agents", "codex_agents", true, "unknown"],
      ["rules", "codex_rules", true, "update_available"],
      ["skills", null, null, "current"],
    ]);
    // A target the backend did not list still gets its toggle; it just has no path or metadata.
    expect(rows[0]).toMatchObject({ target: null, path: "", detail: "" });
    expect(rows[1]).toMatchObject({ target: TARGETS[0], path: ".codex/agents" });
    expect(rows[2]).toMatchObject({ path: ".codex/AGENTS.md", detail: "update_available detail", display: { label: "update", tone: "warn" } });
    expect(rows[3]).toMatchObject({ target: null, path: "", detail: "current detail" });
  });

  it("lists the other surfaces a toggle gates, and gives the path to the first only", () => {
    const rows = harnessRowsFor("cursor", undefined, { enabled_harness_ids: ["cursor"], enabled_target_ids: ["cursor_setup"] }, TARGETS);
    expect(rows.map(row => [row.surface, row.targetId, row.alsoSurfaces, row.path])).toEqual([
      ["cursor_agents", "cursor_setup", ["cursor_mcp"], ".cursor/agents"],
      ["skills", null, [], ""],
      ["cursor_mcp", "cursor_setup", ["cursor_agents"], ""],
    ]);
  });

  it("keeps the off state of a toggled-off target and drops the backend detail", () => {
    const claude = entry("claude", status("current", [surface("claude_agents", "current")]));
    const rows = harnessRowsFor("claude", claude, { enabled_harness_ids: ["claude"], enabled_target_ids: ["claude_rules"] }, []);
    expect(rows.find(row => row.surface === "claude_agents")).toMatchObject({ state: "off", targetEnabled: false, detail: "", display: { label: "off" } });
  });
});

describe("surfaceShortName", () => {
  it("names the kind of a surface", () => {
    expect(surfaceShortName("open_code_config")).toBe("config");
    expect(surfaceShortName("claude_rules")).toBe("rules");
  });
});

describe("updateActionFor", () => {
  const idle = { dataFolderOk: true, busyLabel: null, settingsSaving: false };

  it("labels the key after the state", () => {
    expect(updateActionFor("claude", entry("claude", status("update_available")), idle)).toEqual({ label: "update", disabled: false });
    expect(updateActionFor("claude", entry("claude", status("not_installed")), idle).label).toBe("install");
    expect(updateActionFor("claude", entry("claude", status("update_available", [], { conflict_count: 1 })), idle).label).toBe("update safe files");
    expect(updateActionFor("claude", entry("claude", status("conflict", [], { conflict_count: 1 })), idle)).toEqual({ label: "review conflicts", disabled: false });
  });

  it("names the reason it is off", () => {
    expect(updateActionFor("claude", entry("claude", status("current")), idle).disabled).toMatch(/already current/);
    expect(updateActionFor("claude", entry("claude", status("unavailable")), idle).disabled).toMatch(/unavailable/);
    expect(updateActionFor("claude", entry("claude", status("update_available")), { ...idle, busyLabel: "uninstall" }).disabled).toBe("uninstall is running");
    expect(updateActionFor("claude", entry("claude", status("update_available")), { ...idle, settingsSaving: true }).disabled).toBe("saving target changes");
    expect(updateActionFor("claude", undefined, { ...idle, dataFolderOk: false }).disabled).toBe("workspace folder unusable");
    expect(updateActionFor("claude", entry("claude", null, { loading: true }), idle).disabled).toBe("checking status…");
  });

  it("lets the workspace itself be installed without a valid workspace", () => {
    expect(updateActionFor("workspace", undefined, { ...idle, dataFolderOk: false })).toEqual({ label: "install", disabled: false });
    expect(previewDisabledFor("workspace", { dataFolderOk: false, busyLabel: null })).toBe(false);
    expect(previewDisabledFor("claude", { dataFolderOk: false, busyLabel: null })).toBe("workspace folder unusable");
    expect(previewDisabledFor("claude", { dataFolderOk: true, busyLabel: "apply" })).toBe("apply is running");
  });
});
