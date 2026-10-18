import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENABLED_HARNESS_IDS,
  DEFAULT_ENABLED_TARGET_IDS,
  disabledSurfacesForHarness,
  enabledSetupSurfaces,
  enabledSurfacesForHarness,
  harnessForSurface,
  harnessForView,
  harnessSurfaceStates,
  HARNESS_LABELS,
  HARNESS_NAV_ORDER,
  HARNESS_SURFACES,
  isLightAgent,
  isSurfaceEnabled,
  surfacesNeedingApply,
  TARGET_SURFACES,
  targetIdForSurface,
  type SetupTargetId,
} from "./harnessInstallation";
import {
  CENTRAL_AGENTS,
  INSTALL_AGENTS,
  LIGHT_AGENTS,
  type AppSettings,
  type SetupPlan,
  type SetupSurfaceId,
} from "../types";

type EnabledSettings = Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids">;

/** Backend defaults: the four central harnesses, every target except codex_config. */
function defaults(overrides: Partial<EnabledSettings> = {}): EnabledSettings {
  return {
    enabled_target_ids: [...DEFAULT_ENABLED_TARGET_IDS],
    enabled_harness_ids: [...DEFAULT_ENABLED_HARNESS_IDS],
    ...overrides,
  };
}

const ALL_SURFACES: SetupSurfaceId[] = [
  ...new Set<SetupSurfaceId>(["workspace_bundle", ...INSTALL_AGENTS.flatMap((harness) => HARNESS_SURFACES[harness])]),
];

describe("harnessInstallation", () => {
  it("maps each harness to setup surfaces", () => {
    expect(HARNESS_SURFACES.codex).toContain("skills");
    expect(HARNESS_SURFACES.opencode).toContain("open_code_rules");
    expect(HARNESS_SURFACES.claude).toContain("claude_agents");
    expect(HARNESS_SURFACES.cursor).toContain("cursor_mcp");
  });

  it("lists the one skills surface on every harness page, and it belongs to none of them", () => {
    for (const harness of INSTALL_AGENTS) {
      expect(HARNESS_SURFACES[harness].filter((surface) => surface === "skills")).toHaveLength(1);
    }
    expect(harnessForSurface("skills")).toBeNull();
    expect(harnessForSurface("workspace_bundle")).toBeNull();
    expect(harnessForSurface("codex_rules")).toBe("codex");
  });

  it("includes remove surfaces when planning updates", () => {
    const plan: SetupPlan = {
      operations: [
        { surface: "skills", kind: "remove", summary: "stale" },
        { surface: "codex_rules", kind: "no_change", summary: "synced" },
      ],
      synced: [],
      conflicts: [],
      manual_steps: [],
      summary: "1 pending",
      has_pending_changes: true,
      is_blocked: false,
    };
    expect(surfacesNeedingApply(plan)).toEqual(["skills"]);
  });
});

describe("target to surface mapping", () => {
  it("mirrors the backend target table", () => {
    expect(TARGET_SURFACES).toEqual({
      codex_rules: ["codex_rules"],
      codex_agents: ["codex_agents"],
      codex_config: ["codex_config"],
      opencode_rules: ["open_code_rules"],
      opencode_agents: ["open_code_agents"],
      opencode_config: ["open_code_config"],
      claude_rules: ["claude_rules"],
      claude_agents: ["claude_agents"],
      cursor_setup: ["cursor_agents", "cursor_mcp"],
    });
  });

  it("gates a surface by exactly one target and never gates skills or the workspace bundle", () => {
    const gated = Object.values(TARGET_SURFACES).flat();
    expect(new Set(gated).size).toBe(gated.length);
    expect(targetIdForSurface("cursor_mcp")).toBe("cursor_setup");
    expect(targetIdForSurface("open_code_config")).toBe("opencode_config");
    for (const ungated of ["skills", "workspace_bundle"] as const) {
      expect(targetIdForSurface(ungated)).toBeNull();
    }
  });

  it("keeps each target's surfaces inside its own harness", () => {
    for (const [targetId, surfaces] of Object.entries(TARGET_SURFACES)) {
      const harnesses = new Set(surfaces.map(harnessForSurface));
      expect(harnesses.size, targetId).toBe(1);
      expect(targetId.startsWith(`${[...harnesses][0]}_`), targetId).toBe(true);
    }
    expect(harnessForSurface("workspace_bundle")).toBeNull();
  });

  it("defaults every target on except codex_config", () => {
    expect(DEFAULT_ENABLED_TARGET_IDS).not.toContain("codex_config");
    const expected = (Object.keys(TARGET_SURFACES) as SetupTargetId[]).filter((id) => id !== "codex_config");
    expect([...DEFAULT_ENABLED_TARGET_IDS].sort()).toEqual(expected.sort());
  });
});

describe("target-filtered surfaces", () => {
  it("leaves codex_config out of a default Codex install but keeps its other surfaces", () => {
    expect(enabledSurfacesForHarness("codex", defaults())).toEqual(["codex_agents", "codex_rules", "skills"]);
    expect(disabledSurfacesForHarness("codex", defaults())).toEqual(["codex_config"]);
  });

  it("adds codex_config back, in harness order, once the user enables it", () => {
    const settings = defaults({ enabled_target_ids: [...DEFAULT_ENABLED_TARGET_IDS, "codex_config"] });
    expect(enabledSurfacesForHarness("codex", settings)).toEqual(HARNESS_SURFACES.codex);
    expect(disabledSurfacesForHarness("codex", settings)).toEqual([]);
  });

  it("keeps skills surfaces when every target of a harness is off", () => {
    const settings = defaults({ enabled_target_ids: [] });
    expect(enabledSurfacesForHarness("claude", settings)).toEqual(["skills"]);
    expect(enabledSurfacesForHarness("opencode", settings)).toEqual(["skills"]);
    expect(enabledSurfacesForHarness("cursor", settings)).toEqual(["skills"]);
  });

  it("treats the cursor_setup toggle as gating both cursor_agents and cursor_mcp", () => {
    const off = defaults({ enabled_target_ids: DEFAULT_ENABLED_TARGET_IDS.filter((id) => id !== "cursor_setup") });
    expect(enabledSurfacesForHarness("cursor", off)).toEqual(["skills"]);
    expect(disabledSurfacesForHarness("cursor", off)).toEqual(["cursor_agents", "cursor_mcp"]);
  });

  it("returns nothing for a disabled harness, even for ungated skills", () => {
    const settings = defaults({ enabled_harness_ids: ["opencode", "claude", "cursor"] });
    expect(enabledSurfacesForHarness("codex", settings)).toEqual([]);
    expect(disabledSurfacesForHarness("codex", settings)).toEqual(HARNESS_SURFACES.codex);
    expect(isSurfaceEnabled(settings, "codex_rules")).toBe(false);
    // The skills surface is global: it is on whichever harnesses are, but a disabled harness's page offers nothing.
    expect(isSurfaceEnabled(settings, "skills")).toBe(true);
    expect(harnessSurfaceStates("codex", settings).every((state) => !state.enabled)).toBe(true);
  });

  it("enables the workspace bundle independently of any harness or target", () => {
    expect(isSurfaceEnabled(defaults({ enabled_harness_ids: [], enabled_target_ids: [] }), "workspace_bundle")).toBe(true);
  });

  it("builds the all-surfaces request from workspace plus enabled harnesses", () => {
    const surfaces = enabledSetupSurfaces(defaults());
    expect(surfaces).toEqual(ALL_SURFACES.filter((surface) => surface !== "codex_config"));
    expect(surfaces[0]).toBe("workspace_bundle");

    const claudeOnly = defaults({ enabled_harness_ids: ["claude"] });
    expect(enabledSetupSurfaces(claudeOnly)).toEqual(["workspace_bundle", "claude_rules", "claude_agents", "skills"]);
    // Skills are requested once, however many harnesses list them, and not at all when none is enabled.
    expect(enabledSetupSurfaces(defaults()).filter((surface) => surface === "skills")).toHaveLength(1);
    expect(enabledSetupSurfaces(defaults({ enabled_harness_ids: [] }))).toEqual(["workspace_bundle"]);
  });

  it("reports per-surface state with the gating target for the UI", () => {
    expect(harnessSurfaceStates("codex", defaults())).toEqual([
      { surface: "codex_config", enabled: false, targetId: "codex_config" },
      { surface: "codex_agents", enabled: true, targetId: "codex_agents" },
      { surface: "codex_rules", enabled: true, targetId: "codex_rules" },
      { surface: "skills", enabled: true, targetId: null },
    ]);
  });

  it("never returns a surface the backend would skip", () => {
    // Backend rule: harness enabled AND (ungated OR target enabled).
    const settings = defaults({ enabled_target_ids: ["claude_rules"], enabled_harness_ids: ["claude", "cursor"] });
    expect(enabledSetupSurfaces(settings)).toEqual([
      "workspace_bundle",
      "claude_rules",
      "skills",
    ]);
  });
});

describe("the light tier (Copilot, Pi, Kilo)", () => {
  it("is off by default: the defaults are the four central harnesses, as the backend's HarnessId::DEFAULT_ON", () => {
    expect([...DEFAULT_ENABLED_HARNESS_IDS]).toEqual(["codex", "opencode", "claude", "cursor"]);
    expect([...DEFAULT_ENABLED_HARNESS_IDS]).toEqual([...CENTRAL_AGENTS]);
    expect([...INSTALL_AGENTS]).toEqual([...CENTRAL_AGENTS, ...LIGHT_AGENTS]);
    expect([...LIGHT_AGENTS]).toEqual(["copilot", "pi", "kilo"]);
  });

  it("follows Claude in the tab order, so the first five tabs keep their numbers", () => {
    expect(HARNESS_NAV_ORDER).toEqual(["codex", "opencode", "cursor", "claude", "copilot", "pi", "kilo"]);
    expect([...HARNESS_NAV_ORDER].sort()).toEqual([...INSTALL_AGENTS].sort());
    expect(HARNESS_LABELS.copilot).toBe("Copilot");
    expect(Object.keys(HARNESS_LABELS).sort()).toEqual([...INSTALL_AGENTS].sort());
  });

  it("knows a light harness page and a light agent, and nothing else", () => {
    for (const harness of LIGHT_AGENTS) {
      expect(harnessForView(harness)).toBe(harness);
      expect(isLightAgent(harness)).toBe(true);
    }
    for (const harness of CENTRAL_AGENTS) expect(isLightAgent(harness)).toBe(false);
    for (const other of ["start", "library", "settings", "copilots", ""]) expect(harnessForView(other)).toBeNull();
  });

  it("offers the shared skills surface and nothing else, gated by no target", () => {
    for (const harness of LIGHT_AGENTS) {
      expect(HARNESS_SURFACES[harness]).toEqual(["skills"]);
      const on = defaults({ enabled_harness_ids: [harness] });
      expect(enabledSurfacesForHarness(harness, on)).toEqual(["skills"]);
      expect(harnessSurfaceStates(harness, on)).toEqual([{ surface: "skills", enabled: true, targetId: null }]);
      expect(enabledSurfacesForHarness(harness, defaults())).toEqual([]);
    }
  });

  it("adds no surface to an update-all request beyond the ones the harnesses already list", () => {
    const withLight = defaults({ enabled_harness_ids: [...INSTALL_AGENTS] });
    expect(enabledSetupSurfaces(withLight)).toEqual(enabledSetupSurfaces(defaults()));
    expect(enabledSetupSurfaces(defaults({ enabled_harness_ids: ["pi"] }))).toEqual(["workspace_bundle", "skills"]);
  });
});
