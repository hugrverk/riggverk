import { describe, expect, it, vi } from "vitest";
import type { InstallationOverview, OverviewEntry, OverviewId } from "../hooks/useInstallationOverview";
import type { InstallationState, InstallationStatus, SetupSurfaceId, SurfaceInstallationStatus } from "../types";
import {
  matrixModel,
  overviewTargets,
  previewDisabledFor,
  surfaceRowsFor,
  surfaceShortName,
  targetMeta,
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

describe("targetMeta", () => {
  const options = { workspaceValid: true, id: "claude" as const };

  it("describes the installation state in the list's right-hand cell", () => {
    expect(targetMeta(entry("claude", status("current")), options)).toEqual({ text: "current", tone: "ok" });
    expect(targetMeta(entry("claude", status("update_available", [], { update_count: 2 })), options)).toEqual({ text: "2 to update", tone: "warn" });
    expect(targetMeta(entry("claude", status("not_installed", [], { create_count: 3 })), options)).toEqual({ text: "not installed", tone: "warn" });
    expect(targetMeta(entry("claude", status("conflict", [], { conflict_count: 1 })), options)).toEqual({ text: "1 conflict", tone: "fail" });
    expect(targetMeta(entry("claude", status("update_available", [], { update_count: 2, conflict_count: 2 })), options)).toEqual({
      text: "2 to update · 2 conflicts",
      tone: "fail",
    });
  });

  it("says why there is no state yet", () => {
    expect(targetMeta(undefined, options).text).toBe("…");
    expect(targetMeta(entry("claude", null, { loading: true }), options).text).toBe("…");
    expect(targetMeta(entry("claude", null, { error: "hash failed" }), options)).toEqual({ text: "status failed", tone: "fail" });
    expect(targetMeta(undefined, { workspaceValid: false, id: "claude" })).toEqual({ text: "needs workspace", tone: "dim" });
    expect(targetMeta(undefined, { workspaceValid: false, id: "workspace" })).toEqual({ text: "setup needed", tone: "warn" });
  });
});

describe("surfaceRowsFor", () => {
  it("lists surfaces whose target toggle is off as off, without reading them from the status", () => {
    const claude = entry("claude", status("current", [surface("claude_rules", "current"), surface("claude_agents", "update_available"), surface("claude_skills", "conflict")]));
    const rows = surfaceRowsFor("claude", claude, SETTINGS);
    expect(rows.map(row => [row.name, row.state])).toEqual([
      ["rules", "current"],
      ["agents", "update_available"],
      ["skills", "conflict"],
    ]);

    const codex = entry("codex", status("current", [surface("codex_rules", "current"), surface("codex_skills", "update_available")]));
    const codexRows = surfaceRowsFor("codex", codex, SETTINGS);
    expect(codexRows.map(row => [row.surface, row.state])).toEqual([
      ["codex_config", "off"],
      ["codex_agents", "off"],
      ["codex_rules", "current"],
      ["codex_skills", "update_available"],
    ]);
    expect(codexRows[0]).toMatchObject({ targetId: "codex_config", display: { label: "off", glyph: "none" } });
  });

  it("shows a rules file the user manages as 'you manage', not as current", () => {
    const managed: SurfaceInstallationStatus = {
      ...surface("claude_rules", "current"),
      rules: { layout: "legacy", refinement_lines: 0, conflict_reason: "legacy_diverged", user_managed: true },
    };
    const rows = surfaceRowsFor("claude", entry("claude", status("current", [managed])), SETTINGS);
    expect(rows[0]).toMatchObject({ state: "user_managed", display: { label: "you manage", tone: "warn" } });
    const matrix = matrixModel({ entries: { claude: entry("claude", status("current", [managed])) } } as unknown as InstallationOverview, ["claude"], SETTINGS);
    expect(matrix[0]!.cells.find(cell => cell.column === "rules")).toMatchObject({ state: "user_managed" });
  });

  it("marks surfaces as unknown until the status arrives", () => {
    expect(surfaceRowsFor("workspace", undefined, null)).toEqual([
      expect.objectContaining({ surface: "workspace_bundle", state: "unknown" }),
    ]);
  });
});

describe("matrixModel", () => {
  it("puts every target against every surface kind with n/a, off and state cells", () => {
    const overview: InstallationOverview = {
      entries: {
        workspace: entry("workspace", status("current", [surface("workspace_bundle", "current")])),
        codex: entry("codex", status("update_available", [surface("codex_rules", "update_available"), surface("codex_skills", "current")])),
      },
      loading: false,
      refresh: vi.fn(async () => {}),
    };
    const rows = matrixModel(overview, ["workspace", "codex"], SETTINGS);
    const byColumn = (index: number) => Object.fromEntries(rows[index]!.cells.map(cell => [cell.column, cell.state]));
    expect(byColumn(0)).toEqual({ config: "na", agents: "na", rules: "na", skills: "na", mcp: "na", bundle: "current" });
    expect(byColumn(1)).toEqual({ config: "off", agents: "off", rules: "update_available", skills: "current", mcp: "na", bundle: "na" });
    const rulesCell = rows[1]!.cells.find(cell => cell.column === "rules")!;
    expect(rulesCell.display).toMatchObject({ glyph: "partial", label: "update", tone: "warn" });
  });

  it("orders targets as the workspace followed by the enabled harnesses in tab order", () => {
    expect(overviewTargets(["claude", "codex"])).toEqual(["workspace", "codex", "claude"]);
    expect(surfaceShortName("open_code_config")).toBe("config");
  });
});

describe("updateActionFor", () => {
  const idle = { workspaceValid: true, busyLabel: null, settingsSaving: false };

  it("labels the key after the state", () => {
    expect(updateActionFor("claude", entry("claude", status("update_available")), idle)).toEqual({ label: "update", disabled: false });
    expect(updateActionFor("claude", entry("claude", status("not_installed")), idle).label).toBe("install");
    expect(updateActionFor("claude", entry("claude", status("update_available", [], { conflict_count: 1 })), idle).label).toBe("update safe files");
    expect(updateActionFor("claude", entry("claude", status("conflict", [], { conflict_count: 1 })), idle)).toEqual({ label: "review conflicts", disabled: false });
  });

  it("names the reason it is off", () => {
    expect(updateActionFor("claude", entry("claude", status("current")), idle).disabled).toMatch(/already current/);
    expect(updateActionFor("claude", entry("claude", status("unavailable")), idle).disabled).toMatch(/unavailable/);
    expect(updateActionFor("claude", entry("claude", status("update_available")), { ...idle, busyLabel: "release-check" }).disabled).toBe("release-check is running");
    expect(updateActionFor("claude", entry("claude", status("update_available")), { ...idle, settingsSaving: true }).disabled).toBe("saving target changes");
    expect(updateActionFor("claude", undefined, { ...idle, workspaceValid: false }).disabled).toBe("no valid workspace installed");
    expect(updateActionFor("claude", entry("claude", null, { loading: true }), idle).disabled).toBe("checking status…");
  });

  it("lets the workspace itself be installed without a valid workspace", () => {
    expect(updateActionFor("workspace", undefined, { ...idle, workspaceValid: false })).toEqual({ label: "install", disabled: false });
    expect(previewDisabledFor("workspace", { workspaceValid: false, busyLabel: null })).toBe(false);
    expect(previewDisabledFor("claude", { workspaceValid: false, busyLabel: null })).toBe("no valid workspace installed");
    expect(previewDisabledFor("claude", { workspaceValid: true, busyLabel: "apply" })).toBe("apply is running");
  });
});
