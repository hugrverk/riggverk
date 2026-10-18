import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import {
  installationStatus,
  installScreenOf,
  overviewOf,
  settingsOf,
  skillLoadsOf,
  STATUS_DATA,
  surfaceStatus,
} from "../test/pageFixtures";
import { LIGHT_AGENTS, type EffectiveSkillLoads, type LightAgent, type LightRuntimeHealth } from "../types";
import { LightHarnessView } from "./LightHarnessView";
import type { HarnessViewProps } from "./pageTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  cleanup();
});

const LABELS: Record<LightAgent, string> = { copilot: "Copilot", pi: "Pi", kilo: "Kilo" };

function health(overrides: Partial<LightRuntimeHealth> = {}): LightRuntimeHealth {
  return {
    harness: "pi",
    status: "synced",
    cli: { status: "found", version: "1.3.0", source: "path", detail: "Pi 1.3.0" },
    skills: { status: "synced", synced: 17, expected: 17, roots: ["~/.agents/skills"] },
    warnings: [],
    next_action: "No runtime action needed.",
    ...overrides,
  };
}

function props(harness: LightAgent, overrides: Partial<HarnessViewProps> = {}): HarnessViewProps {
  return {
    appSettings: settingsOf({ enabled_harness_ids: [harness] }),
    agentTargets: [],
    settingsSaveStatus: "saved",
    onToggleTarget: vi.fn(),
    skillLoads: skillLoadsOf(),
    overview: overviewOf({
      [harness]: installationStatus("update_available", [surfaceStatus("skills", "update_available")], { update_count: 1 }),
    }),
    install: installScreenOf(),
    backupRoot: "/tmp/backups",
    rollbackTransactionId: null,
    onRollback: vi.fn(),
    onRefresh: vi.fn(),
    runWorkspaceTask: vi.fn(async () => null) as unknown as HarnessViewProps["runWorkspaceTask"],
    refreshAfterApply: vi.fn(),
    onApplied: vi.fn(),
    wsLog: null,
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    status: STATUS_DATA,
    workspaceValid: true,
    gitAvailable: true,
    onClearOutput: vi.fn(),
    ...overrides,
  };
}

function renderLight(harness: LightAgent, runtimeHealth: LightRuntimeHealth | null, overrides: Partial<HarnessViewProps> = {}) {
  const merged = props(harness, overrides);
  return { props: merged, ...renderInFrame(<LightHarnessView {...merged} harness={harness} runtimeHealth={runtimeHealth} />) };
}

function detail(label: string) {
  return screen.getByRole("region", { name: `${label} detail` });
}

function facts(root: HTMLElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const dt of root.querySelectorAll("dt")) result[dt.textContent!] = dt.nextElementSibling!.textContent!;
  return result;
}

describe("LightHarnessView", () => {
  it.each(LIGHT_AGENTS)("renders the %s page with the skills surface as its only row, and no target toggle", harness => {
    renderLight(harness, null);
    const label = LABELS[harness];
    const rows = within(screen.getByRole("listbox", { name: `${label} surfaces` })).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("skills");
    expect(rows[0]!.textContent).not.toContain("[x]");
    expect(rows[0]!.textContent).not.toContain("[ ]");
    expect(screen.getByRole("region", { name: label })).toBeTruthy();
  });

  it("shows the CLI version and the skills of a synced harness, with no rules and no MCP row", () => {
    renderLight("pi", health());
    const pi = detail("Pi");
    expect(pi.textContent).toContain("runtime · synced");
    expect(facts(pi)).toMatchObject({ cli: "1.3.0", skills: "synced · 17/17" });
    expect(facts(pi)).not.toHaveProperty("rules");
    expect(facts(pi)).not.toHaveProperty("mcp");
    // Nothing to do while synced.
    expect(facts(pi)).not.toHaveProperty("next");
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
    expect(copilot.textContent).toContain("runtime · partial");
    expect(facts(copilot)).toMatchObject({ skills: "partial · 10/17", next: "run Install or Update on the Copilot page" });
    cleanup();

    renderLight("pi", health({
      status: "unserved",
      skills: { status: "unserved", synced: 0, expected: 17, roots: [] },
      warnings: ["No skills are installed for Pi: it reads ~/.agents/skills, and a customised CODEX_HOME keeps Codex out of that folder."],
      next_action: "Disable Codex or unset CODEX_HOME to install skills for Pi.",
    }));
    const pi = detail("Pi");
    expect(pi.textContent).toContain("runtime · unserved");
    expect(facts(pi).skills).toBe("unserved · 0/17");
    expect(facts(pi).warnings).toContain("CODEX_HOME");
    expect(facts(pi).next).toContain("unset CODEX_HOME");
  });

  it("says the runtime is not loaded before the health arrives", () => {
    renderLight("kilo", null);
    expect(detail("Kilo").textContent).toContain("runtime · not loaded");
  });

  it("names the folders the harness reads when the cursor is on the skills row", () => {
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
    expect(facts(detail("Kilo")).reads).toBe("~/.kilo/skills (missing), ~/.agents/skills, ~/.claude/skills");
  });

  it("opens the install review for this harness with u and a read-only preview with p", () => {
    const { props: shown } = renderLight("pi", health());
    const surfaces = screen.getByRole("listbox", { name: "Pi surfaces" });
    surfaces.focus();
    fireEvent.keyDown(surfaces, { key: "u" });
    expect(shown.install.open).toHaveBeenLastCalledWith("pi");
    fireEvent.keyDown(surfaces, { key: "p" });
    expect(shown.install.open).toHaveBeenLastCalledWith("pi", { readOnly: true });
  });

  it("offers nothing without a valid workspace", () => {
    renderLight("pi", health(), { workspaceValid: false });
    expect(detail("Pi").textContent).toContain("runtime · no valid workspace");
    expect(detail("Pi").textContent).toContain("No valid workspace installed");
  });
});
