import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import {
  installationStatus,
  installScreenOf,
  overviewOf,
  settingsOf,
  skillLoadsOf,
  surfaceStatus,
} from "../test/pageFixtures";
import {
  LIGHT_AGENTS,
  type AgentTargetMeta,
  type EffectiveSkillLoads,
  type LightAgent,
  type LightRuntimeHealth,
  type RulesStatus,
  type SetupSurfaceId,
} from "../types";
import { DEFAULT_ENABLED_TARGET_IDS } from "../lib/harnessInstallation";
import { LightHarnessView } from "./LightHarnessView";
import type { HarnessViewProps } from "./pageTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  cleanup();
});

const LABELS: Record<LightAgent, string> = { copilot: "Copilot", pi: "Pi", kilo: "Kilo", antigravity: "Antigravity", grok: "Grok" };

const LIGHT_TARGETS: AgentTargetMeta[] = [
  { id: "copilot_rules", label: "copilot rules", harness: "copilot", kind: "rules", target_rel: ".copilot/copilot-instructions.md", source_rel: "templates/sync/copilot-rules.md" },
  { id: "copilot_mcp", label: "copilot mcp", harness: "copilot", kind: "mcp", target_rel: ".copilot/mcp-config.json", source_rel: "templates/mcp/copilot.playwright.json" },
  { id: "pi_rules", label: "pi rules", harness: "pi", kind: "rules", target_rel: ".pi/agent/AGENTS.md", source_rel: "templates/sync/pi-rules.md" },
  { id: "pi_mcp", label: "pi mcp", harness: "pi", kind: "mcp", target_rel: ".pi/agent/mcp.json", source_rel: "templates/mcp/pi.playwright.json" },
  { id: "kilo_rules", label: "kilo rules", harness: "kilo", kind: "rules", target_rel: ".config/kilo/AGENTS.md", source_rel: "templates/sync/kilo-rules.md" },
  { id: "kilo_mcp", label: "kilo mcp", harness: "kilo", kind: "mcp", target_rel: ".config/kilo/kilo.jsonc", source_rel: "templates/mcp/kilo.playwright.json" },
  { id: "antigravity_rules", label: "antigravity rules", harness: "antigravity", kind: "rules", target_rel: ".gemini/AGENTS.md", source_rel: "templates/sync/antigravity-rules.md" },
  { id: "antigravity_mcp", label: "antigravity mcp", harness: "antigravity", kind: "mcp", target_rel: ".gemini/config/mcp_config.json", source_rel: "templates/mcp/antigravity.playwright.json" },
  { id: "grok_mcp", label: "grok mcp", harness: "grok", kind: "mcp", target_rel: ".grok/config.toml", source_rel: "templates/mcp/grok.playwright.json" },
];

const rulesSurface = (harness: LightAgent) => `${harness}_rules` as SetupSurfaceId;
const mcpSurface = (harness: LightAgent) => `${harness}_mcp` as SetupSurfaceId;
const absentRules: RulesStatus = { layout: "absent", refinement_lines: 0, user_managed: false };

function health(overrides: Partial<LightRuntimeHealth> = {}): LightRuntimeHealth {
  return {
    harness: "pi",
    status: "synced",
    cli: { status: "found", version: "1.3.0", source: "path", detail: "Pi 1.3.0" },
    rules: { status: "synced", path: "~/.pi/agent/AGENTS.md", refinement_lines: 0, user_managed: false, conflict_reason: null, detail: "installed and current" },
    mcp: { status: "synced", path: "~/.pi/agent/mcp.json", playwright_version: "0.0.83", detail: "installed and current" },
    skills: { status: "synced", synced: 17, expected: 17, roots: ["~/.agents/skills"] },
    warnings: [],
    next_action: "No runtime action needed.",
    ...overrides,
  };
}

function props(harness: LightAgent, overrides: Partial<HarnessViewProps> = {}): HarnessViewProps {
  return {
    appSettings: settingsOf({ enabled_harness_ids: [harness] }),
    agentTargets: LIGHT_TARGETS,
    settingsSaveStatus: "saved",
    onToggleTarget: vi.fn(),
    skillLoads: skillLoadsOf(),
    overview: overviewOf({
      [harness]: installationStatus(
        "update_available",
        [
          { ...surfaceStatus(rulesSurface(harness), "not_installed", "not installed"), rules: absentRules },
          surfaceStatus("skills", "update_available"),
          surfaceStatus(mcpSurface(harness), "not_installed", "no file yet"),
        ],
        { create_count: 2, update_count: 1 },
      ),
    }),
    install: installScreenOf(),
    backupRoot: "/tmp/backups",
    rollbackTransactionId: null,
    onRefresh: vi.fn(),
    runWorkspaceTask: vi.fn(async () => null) as unknown as HarnessViewProps["runWorkspaceTask"],
    refreshAfterApply: vi.fn(),
    onApplied: vi.fn(),
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    dataFolderOk: true,
    ...overrides,
  };
}

function renderLight(harness: LightAgent, runtimeHealth: LightRuntimeHealth | null, overrides: Partial<HarnessViewProps> = {}) {
  const merged = props(harness, overrides);
  return { props: merged, ...renderInFrame(<LightHarnessView {...merged} harness={harness} runtimeHealth={runtimeHealth} />) };
}

/** The page of a harness: the keys work with focus anywhere in it. */
function detail(label: string) {
  return screen.getByRole("region", { name: label });
}

/** The runtime verdict, the bold line of the runtime cell. */
function verdictOf(root: HTMLElement): string {
  return within(root).getByRole("region", { name: "Runtime" }).querySelector(".hp-ch b")!.textContent!;
}

function cell(root: HTMLElement, surface: string) {
  return root.querySelector<HTMLElement>(`[data-surface="${surface}"]`)!;
}

function facts(root: HTMLElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const dt of root.querySelectorAll("dt")) result[dt.textContent!] = dt.nextElementSibling!.textContent!;
  return result;
}

describe("LightHarnessView", () => {
  it.each(LIGHT_AGENTS.filter(harness => harness !== "grok"))("renders the %s page with a rules cell and an MCP cell that have a target switch and a skills cell that has none", harness => {
    renderLight(harness, null);
    const label = LABELS[harness];
    const page = screen.getByRole("region", { name: label });
    const cells = Array.from(page.querySelectorAll<HTMLElement>("[data-surface]"));
    expect(cells).toHaveLength(3);
    const rulesTarget = LIGHT_TARGETS.find(target => target.id === `${harness}_rules`)!;
    const mcpTarget = LIGHT_TARGETS.find(target => target.id === `${harness}_mcp`)!;
    expect(cells[0]!.querySelector(".hp-lbl")!.textContent).toBe(`Rules · ${rulesTarget.target_rel}`);
    expect(within(cells[0]!).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(cells[1]!.querySelector(".hp-lbl")!.textContent).toBe("Skills");
    expect(within(cells[1]!).queryByRole("switch")).toBeNull();
    expect(cells[2]!.querySelector(".hp-lbl")!.textContent).toBe(`MCP · ${mcpTarget.target_rel}`);
    // Kilo's MCP entry edits its main config file, and Antigravity's is opt-in too: their targets start off.
    const mcpOff = harness === "kilo" || harness === "antigravity";
    expect(within(cells[2]!).getByRole("switch").getAttribute("aria-checked")).toBe(mcpOff ? "false" : "true");
    expect(within(page).getByRole("heading", { name: label })).toBeTruthy();
  });

  it("renders the Grok page with a skills cell and an MCP cell that starts off, and says where its rules come from", () => {
    const grokHealth = (rules: LightRuntimeHealth["rules"]) =>
      health({
        harness: "grok",
        cli: { status: "found", version: "0.4.2", source: "path", detail: "Grok 0.4.2" },
        rules,
        mcp: { status: "off", path: "~/.grok/config.toml", playwright_version: null, detail: "switched off in Settings" },
        skills: { status: "synced", synced: 17, expected: 17, roots: ["~/.claude/skills", "~/.agents/skills"] },
      });
    const overview = overviewOf({
      grok: installationStatus("current", [surfaceStatus("skills", "current"), surfaceStatus("grok_mcp", "not_installed", "no file yet")]),
    });
    const shared = {
      status: "shared",
      path: "~/.claude/CLAUDE.md",
      refinement_lines: 0,
      user_managed: false,
      conflict_reason: null,
      detail: "Grok reads the managed block in ~/.claude/CLAUDE.md, installed for Claude Code",
    };
    renderLight("grok", grokHealth(shared), { overview });
    const page = detail("Grok");
    const cells = Array.from(page.querySelectorAll<HTMLElement>("[data-surface]"));
    expect(cells.map(item => item.dataset.surface)).toEqual(["skills", "grok_mcp"]);
    expect(cells[1]!.querySelector(".hp-lbl")!.textContent).toBe("MCP · .grok/config.toml");
    expect(within(cells[1]!).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(facts(page).rules).toBe(`shared · ${shared.detail}`);
    expect(verdictOf(page)).toBe("synced");
    cleanup();

    const none = { ...shared, status: "none", detail: "No rules are installed for Grok: it reads ~/.claude/CLAUDE.md, which gets the managed block only while Claude Code and its rules are on" };
    renderLight("grok", grokHealth(none), { overview });
    expect(facts(detail("Grok")).rules).toBe(`none · ${none.detail}`);
  });

  it("shows the CLI version, the rules file, the Playwright entry and the skills of a synced harness", () => {
    renderLight("pi", health());
    const pi = detail("Pi");
    expect(verdictOf(pi)).toBe("synced");
    expect(facts(pi)).toMatchObject({ cli: "1.3.0", rules: "synced", "mcp playwright": "synced · 0.0.83", skills: "synced · 17/17" });
    // Nothing to do while synced.
    expect(facts(pi)).not.toHaveProperty("next");
  });

  it("puts a missing, invalid or switched-off Playwright entry into the runtime rows and the verdict", () => {
    renderLight("copilot", health({
      harness: "copilot",
      status: "invalid",
      mcp: { status: "invalid", path: "~/.copilot/mcp-config.json", playwright_version: null, detail: "the file has comments; the app edits strict JSON only and writes nothing" },
      next_action: "Resolve the MCP file conflict on the Copilot page.",
    }));
    const copilot = detail("Copilot");
    expect(verdictOf(copilot)).toBe("invalid");
    expect(facts(copilot)["mcp playwright"]).toBe("invalid · the file has comments; the app edits strict JSON only and writes nothing");
    expect(facts(copilot).next).toBe("resolve the MCP file conflict on the Copilot page");
    cleanup();

    renderLight("pi", health({
      status: "missing",
      mcp: { status: "missing", path: "~/.pi/agent/mcp.json", playwright_version: null, detail: "no file yet" },
      warnings: ["Pi does not declare the tools of this server to the model until the entry sets exposure (for example \"direct\"); by default they are callable from codemode scripts only."],
      next_action: "Run Install or Update on the Pi page.",
    }));
    const pi = detail("Pi");
    expect(facts(pi)["mcp playwright"]).toBe("missing · no file yet");
    expect(facts(pi).warnings).toContain("exposure");
    cleanup();

    renderLight("kilo", health({
      harness: "kilo",
      mcp: { status: "off", path: "~/.config/kilo/kilo.jsonc", playwright_version: null, detail: "switched off in Settings" },
    }));
    expect(facts(detail("Kilo"))["mcp playwright"]).toBe("off · target switched off in Settings");
  });

  it("shows the file of the MCP row and what happens to it, and why a file the app does not edit is left alone", () => {
    renderLight("kilo", health({ harness: "kilo" }), {
      overview: overviewOf({
        kilo: installationStatus(
          "conflict",
          [
            surfaceStatus("kilo_rules", "current"),
            surfaceStatus("skills", "current"),
            surfaceStatus("kilo_mcp", "conflict", "the file has comments; the app edits strict JSON only and writes nothing"),
          ],
          { conflict_count: 1 },
        ),
      }),
      appSettings: settingsOf({
        enabled_harness_ids: ["kilo"],
        enabled_target_ids: [...DEFAULT_ENABLED_TARGET_IDS, "kilo_mcp"],
      }),
    });
    const mcp = cell(detail("Kilo"), "kilo_mcp");
    // A file the app does not edit is a thing to fix by hand: the cell says why, in the backend's words.
    expect(mcp.querySelector(".hp-lbl")!.textContent).toBe("MCP · .config/kilo/kilo.jsonc");
    expect(mcp.getAttribute("data-state")).toBe("fix");
    expect(mcp.querySelector(".state-pill")!.textContent).toBe("Fix by hand");
    expect(mcp.querySelector(".hp-ch b")!.textContent).toBe("the file has comments; the app edits strict JSON only and writes nothing");
    expect(within(mcp).getByRole("switch", { name: "Let Riggverk manage kilo mcp" }).getAttribute("aria-checked")).toBe("true");
  });

  it("puts a stale, conflicting or switched-off rules file into the runtime rows and the verdict", () => {
    renderLight("kilo", health({
      harness: "kilo",
      status: "stale",
      rules: { status: "stale", path: "~/.config/kilo/AGENTS.md", refinement_lines: 5, user_managed: false, conflict_reason: null, detail: "base update available; refinements: 5 lines preserved" },
      next_action: "Run Install or Update on the Kilo page.",
    }));
    const kilo = detail("Kilo");
    expect(verdictOf(kilo)).toBe("stale");
    expect(facts(kilo)).toMatchObject({ rules: "stale · base update available; refinements: 5 lines preserved", next: "run Install or Update on the Kilo page" });
    cleanup();

    renderLight("pi", health({
      status: "diverged",
      rules: { status: "diverged", path: "~/.pi/agent/AGENTS.md", refinement_lines: 0, user_managed: false, conflict_reason: "masked_by_override", detail: "an override file in the same folder masks this file, left as is" },
      warnings: ["AGENTS.override.md in ~/.pi/agent replaces AGENTS.md, so Pi never reads the managed block. Remove or rename it."],
      next_action: "Resolve the rules file conflict on the Pi page.",
    }));
    const pi = detail("Pi");
    expect(verdictOf(pi)).toBe("diverged");
    expect(facts(pi).rules).toContain("masks this file");
    expect(facts(pi).warnings).toContain("AGENTS.override.md");
    cleanup();

    renderLight("copilot", health({
      harness: "copilot",
      rules: { status: "off", path: "~/.copilot/copilot-instructions.md", refinement_lines: 0, user_managed: false, conflict_reason: null, detail: "switched off in Settings" },
    }));
    expect(facts(detail("Copilot")).rules).toBe("off · target switched off in Settings");
  });

  it("shows why a masked or hidden rules file is left alone, and offers no conversion for it", () => {
    const masked: RulesStatus = { layout: "block", refinement_lines: 0, user_managed: false, conflict_reason: "masked_by_override" };
    renderLight("pi", health(), {
      overview: overviewOf({
        pi: installationStatus("conflict", [{ ...surfaceStatus("pi_rules", "conflict", "masked"), rules: masked }, surfaceStatus("skills", "current")], { conflict_count: 1 }),
      }),
    });
    const pi = detail("Pi");
    expect(facts(pi)).toMatchObject({ why: "another file in the folder masks this one, so the harness never reads it" });
    // The sentence above the facts says what to do: nothing in the app can sort it out.
    expect(pi.textContent).toContain("Another file in the folder decides what Pi reads, so Riggverk writes nothing here.");
    expect(pi.textContent).toContain("Remove or rename that file");
    cleanup();

    const peer: RulesStatus = { layout: "absent", refinement_lines: 0, user_managed: false, conflict_reason: "peer_context_file" };
    renderLight("pi", health(), {
      overview: overviewOf({
        pi: installationStatus("conflict", [{ ...surfaceStatus("pi_rules", "conflict", "hidden"), rules: peer }, surfaceStatus("skills", "current")], { conflict_count: 1 }),
      }),
    });
    expect(facts(detail("Pi")).why).toBe("the harness reads another context file in the folder, which a new file would hide");
  });

  it("says where a CLI was found when only nvm has it, and why it is missing otherwise", () => {
    renderLight("kilo", health({
      harness: "kilo",
      cli: { status: "found", version: "7.8.12", source: "nvm", detail: "Kilo 7.8.12 (found in nvm v24.14.0, not on PATH)" },
    }));
    expect(facts(detail("Kilo")).cli).toBe("7.8.12 · nvm");
    cleanup();

    renderLight("pi", health({ cli: { status: "missing", version: null, source: null, detail: "pi is not on PATH; start it from a shell where pi runs" } }));
    expect(facts(detail("Pi")).cli).toBe("pi is not on PATH; start it from a shell where pi runs");
    cleanup();

    renderLight("copilot", health({ harness: "copilot", cli: { status: "unknown", version: null, source: "path", detail: "found, but copilot --version gave no version" } }));
    expect(facts(detail("Copilot")).cli).toBe("found · version unknown");
  });

  it("offers the next step while skills are missing, and warns when the harness is unserved", () => {
    renderLight("copilot", health({
      harness: "copilot",
      status: "partial",
      skills: { status: "partial", synced: 10, expected: 17, roots: ["~/.agents/skills"] },
      next_action: "Run Install or Update on the Copilot page.",
    }));
    const copilot = detail("Copilot");
    expect(verdictOf(copilot)).toBe("partial");
    expect(facts(copilot)).toMatchObject({ skills: "partial · 10/17", next: "run Install or Update on the Copilot page" });
    cleanup();

    renderLight("pi", health({
      status: "unserved",
      skills: { status: "unserved", synced: 0, expected: 17, roots: [] },
      warnings: ["No skills are installed for Pi: it reads ~/.agents/skills, and a customized CODEX_HOME keeps Codex out of that folder."],
      next_action: "Disable Codex or unset CODEX_HOME to install skills for Pi.",
    }));
    const pi = detail("Pi");
    expect(verdictOf(pi)).toBe("unserved");
    expect(facts(pi).skills).toBe("unserved · 0/17");
    expect(facts(pi).warnings).toContain("CODEX_HOME");
    expect(facts(pi).next).toContain("unset CODEX_HOME");
  });

  it("says the runtime is not loaded before the health arrives", () => {
    renderLight("kilo", null);
    expect(verdictOf(detail("Kilo"))).toBe("not loaded");
  });

  it("names the folders the harness reads in the skills cell", () => {
    const skillLoads = skillLoadsOf({
      harnesses: [{
        harness: "kilo",
        folders: [
          { folder: "kilo", path: "~/.kilo/skills", exists: false },
          { folder: "agents", path: "~/.agents/skills", exists: true },
          { folder: "claude", path: "~/.claude/skills", exists: true },
        ],
        skills: [],
      }],
      foreign_duplicates: [],
    } satisfies EffectiveSkillLoads);
    renderLight("kilo", health({ harness: "kilo" }), { skillLoads });
    expect(facts(cell(detail("Kilo"), "skills")).reads).toBe("~/.kilo/skills (missing), ~/.agents/skills, ~/.claude/skills");
  });

  it("names Antigravity's two own folders, the App's and the CLI's, in the skills cell", () => {
    const skillLoads = skillLoadsOf({
      harnesses: [{
        harness: "antigravity",
        folders: [
          { folder: "antigravity_app", path: "~/.gemini/config/skills", exists: true },
          { folder: "antigravity_cli", path: "~/.gemini/antigravity-cli/skills", exists: false },
        ],
        skills: [],
      }],
      foreign_duplicates: [],
    } satisfies EffectiveSkillLoads);
    renderLight("antigravity", health({
      harness: "antigravity",
      cli: { status: "found", version: "1.2.0", source: "path", detail: "Antigravity 1.2.0" },
      skills: { status: "partial", synced: 17, expected: 34, roots: ["~/.gemini/config/skills", "~/.gemini/antigravity-cli/skills"] },
    }), { skillLoads });
    const antigravity = detail("Antigravity");
    expect(facts(cell(antigravity, "skills")).reads).toBe("~/.gemini/config/skills, ~/.gemini/antigravity-cli/skills (missing)");
    expect(facts(antigravity).cli).toBe("1.2.0");
  });

  it("opens the install review for this harness with u and a read-only preview with p", () => {
    const { props: shown } = renderLight("pi", health());
    const surfaces = screen.getByRole("region", { name: "Pi" });
    surfaces.focus();
    fireEvent.keyDown(surfaces, { key: "u" });
    expect(shown.install.open).toHaveBeenLastCalledWith("pi");
    fireEvent.keyDown(surfaces, { key: "p" });
    expect(shown.install.open).toHaveBeenLastCalledWith("pi", { readOnly: true });
  });

  it("offers nothing without a valid workspace", () => {
    renderLight("pi", health(), { dataFolderOk: false });
    expect(verdictOf(detail("Pi"))).toBe("workspace folder unusable");
    expect(detail("Pi").textContent).toContain("The workspace folder is unusable");
  });
});
