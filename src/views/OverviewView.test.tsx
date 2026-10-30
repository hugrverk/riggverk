import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInFrame } from "../test/renderWithShell";
import {
  CLEAN_CODEX,
  flowOf,
  INVALID_DIAGNOSTICS,
  installationStatus,
  installScreenOf,
  op,
  overviewOf,
  RISKY_CLAUDE,
  settingsOf,
  surfaceStatus,
  VALID_DIAGNOSTICS,
} from "../test/pageFixtures";
import type { AgentTargetMeta, ApplyProgress, CodexRuntimeHealth, FilesStatus, InstallAgent, PackLibrary, SecurityPosture, SetupHistoryEntry } from "../types";
import { OverviewView, type OverviewViewProps } from "./OverviewView";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

let postures: Partial<Record<InstallAgent, SecurityPosture>> = {};
let history: SetupHistoryEntry[] = [];
/** What the flow map's source reads answer; null leaves them failing, as without a workspace. */
let sources: { skills: number; agents: number; rules: Array<{ surface: string; refinement_lines: number }>; packs: PackLibrary | null } | null = null;

const PACKS: PackLibrary = {
  folder: "~/packs",
  packs: [
    { name: "mine", state: "ok", reason: "", forgettable: false },
    { name: "old-pack", state: "missing", reason: "the pack folder is gone", forgettable: true },
  ],
  skills: [
    { id: "pack:mine/a", name: "a", description: "", pack: "mine", state: "active", reason: "", path: "" },
    { id: "pack:mine/b", name: "b", description: "", pack: "mine", state: "active", reason: "", path: "" },
    { id: "pack:old-pack/x", name: "x", description: "", pack: "old-pack", state: "missing", reason: "pack missing", path: "" },
  ],
  ignored: [],
};

const TARGETS: AgentTargetMeta[] = [
  { id: "codex_rules", label: "codex rules", harness: "codex", kind: "rules", target_rel: ".codex/AGENTS.md", source_rel: "" },
  { id: "claude_rules", label: "claude rules", harness: "claude", kind: "rules", target_rel: ".claude/CLAUDE.md", source_rel: "" },
  { id: "claude_agents", label: "claude agents", harness: "claude", kind: "agents", target_rel: ".claude/agents", source_rel: "" },
  { id: "opencode_rules", label: "opencode rules", harness: "opencode", kind: "rules", target_rel: ".config/opencode/AGENTS.md", source_rel: "" },
  { id: "cursor_setup", label: "cursor", harness: "cursor", kind: "agents", target_rel: ".cursor/agents", source_rel: "" },
];

beforeEach(() => {
  postures = {};
  history = [];
  sources = null;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: { harness?: InstallAgent }) => {
    if (command === "get_security_posture") {
      const posture = postures[args!.harness!];
      if (posture) return posture;
    }
    if (command === "list_setup_history") return history;
    if (sources && command === "list_skills") return Array.from({ length: sources.skills }, (_, index) => ({ id: `s${index}` }));
    if (sources && command === "list_agent_metadata") {
      return { agents: Array.from({ length: sources.agents }, (_, index) => ({ id: `a${index}`, exists: true })), warnings: [] };
    }
    if (sources && command === "list_rules_files") return sources.rules;
    if (sources?.packs && command === "list_pack_skills") return sources.packs;
    throw new Error(`unexpected invoke ${command}`);
  });
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(() => {
  cleanup();
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

const ALL: InstallAgent[] = ["codex", "opencode", "claude", "cursor"];

const RULES_CONFLICT = {
  layout: "legacy" as const,
  refinement_lines: 0,
  conflict_reason: "legacy_diverged" as const,
  user_managed: false,
};

const OVERVIEW = overviewOf({
  workspace: installationStatus("current", [surfaceStatus("workspace_bundle", "current", "none")]),
  codex: installationStatus("current", [surfaceStatus("codex_rules", "current"), surfaceStatus("skills", "current")]),
  opencode: installationStatus("update_available", [surfaceStatus("open_code_config", "update_available", "2 to update")], { update_count: 2 }),
  claude: installationStatus(
    "conflict",
    [
      { ...surfaceStatus("claude_rules", "conflict", "rules detail"), rules: RULES_CONFLICT },
      surfaceStatus("claude_agents", "current"),
      surfaceStatus("skills", "current"),
    ],
    { conflict_count: 1 },
  ),
  cursor: installationStatus("update_available", [surfaceStatus("cursor_agents", "update_available")], { update_count: 1 }),
});

function props(overrides: Partial<OverviewViewProps> = {}): OverviewViewProps {
  return {
    workspaceDiagnostics: VALID_DIAGNOSTICS,
    appSettings: settingsOf({ enabled_harness_ids: ALL, enabled_target_ids: ["codex_rules", "claude_rules", "claude_agents", "opencode_config", "cursor_setup"] }),
    enabledHarnessIds: ALL,
    onNavigate: vi.fn(),
    overview: OVERVIEW,
    install: installScreenOf(),
    backupRoot: "/tmp/backups",
    rollbackTransactionId: null,
    onRefresh: vi.fn(),
    onUninstall: vi.fn(),
    uninstallRecoveryTransactionId: null,
    onUninstallRollback: vi.fn(async () => false),
    uninstallPreviewRequested: false,
    onUninstallPreviewHandled: vi.fn(),
    onOpenFolder: vi.fn(),
    backupCount: 2,
    onOpenBackupsFolder: vi.fn(),
    onUndo: vi.fn(),
    wsLogCompletedAt: null,
    wsRunning: null,
    wsProgress: null,
    dataFolderOk: true,
    ...overrides,
  };
}

function renderOverview(overrides: Partial<OverviewViewProps> = {}) {
  const merged = props(overrides);
  return { props: merged, ...renderInFrame(<OverviewView {...merged} />) };
}

function page() {
  return screen.getByRole("region", { name: "Overview" });
}

/** The flow map's SVG. */
function map() {
  return within(page()).getByRole("group", { name: "What flows from each source to each agent" }) as unknown as SVGSVGElement;
}

/** A node of the map, by the agent's or source's name. */
function node(name: string) {
  return within(map() as unknown as HTMLElement).getByRole("button", { name: new RegExp(`^${name},`) });
}

function inspector() {
  return screen.getByRole("complementary", { name: "Details" });
}

/** A key hint of the focused page: hints live as a key hint, not in the page. */
function hint(name: RegExp) {
  return within(screen.getByLabelText("Key hints")).getByRole("button", { name });
}

function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(page(), { key, ...init });
}

describe("Overview header", () => {
  it("answers in a short sentence and counts only the states that are not zero", () => {
    renderOverview();
    expect(screen.getByRole("heading", { name: "Your setup works." })).toBeTruthy();
    const counts = screen.getByRole("list", { name: "Counts by state" });
    const lines = within(counts).getAllByRole("listitem").map(item => item.textContent);
    expect(lines).toEqual(expect.arrayContaining(["4 up to date", "2 updates ready", "1 needs your decision"]));
    // Fix by hand, yours and similar are zero here: they are not shown, dimmed or otherwise.
    expect(lines.join(" ")).not.toMatch(/fix by hand|yours/);
    expect(lines.join(" ")).not.toMatch(/\b0 /);
  });

  it("says when the status was read and that nothing was written", () => {
    renderOverview({ checkedAt: new Date(2026, 9, 28, 15, 42) });
    expect(within(screen.getByRole("list", { name: "Counts by state" })).getByText("Checked 15:42, nothing written")).toBeTruthy();
  });

  it("says everything is set up when nothing waits for a decision, a fix or an update", () => {
    const current = installationStatus("current", [surfaceStatus("codex_rules", "current"), surfaceStatus("skills", "current")]);
    renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, codex: current }), enabledHarnessIds: ["codex"] });
    expect(screen.getByRole("heading", { name: "Everything is set up." })).toBeTruthy();
  });

  it("says nothing is set up yet on a fresh profile", () => {
    const fresh = installationStatus("not_installed", [surfaceStatus("codex_rules", "not_installed"), surfaceStatus("skills", "not_installed")]);
    renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, codex: fresh }), enabledHarnessIds: ["codex"] });
    expect(screen.getByRole("heading", { name: "Nothing is set up yet." })).toBeTruthy();
  });

  it("names an unusable folder and counts it as the one thing to fix", () => {
    renderOverview({ workspaceDiagnostics: INVALID_DIAGNOSTICS, dataFolderOk: false, overview: overviewOf({}) });
    expect(screen.getByRole("heading", { name: "Riggverk can't use its folder." })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Counts by state" })).getByText(/to fix by hand/)).toBeTruthy();
  });
});

describe("Overview agents that are off", () => {
  it("lists the agents that are off and leads to Settings", () => {
    const { props: p } = renderOverview({ enabledHarnessIds: ["codex", "claude"] });
    const more = screen.getByRole("region", { name: "Agents that are off" });
    expect(more.textContent).toContain("OpenCode, Cursor, Copilot, Pi, Kilo and Antigravity are off.");
    fireEvent.click(within(more).getByRole("button", { name: "Add agents…" }));
    expect(p.onNavigate).toHaveBeenCalledWith("settings");
  });

  it("shows no such row when every agent is on", () => {
    renderOverview({ enabledHarnessIds: ["codex", "opencode", "cursor", "claude", "copilot", "pi", "kilo", "antigravity"] });
    expect(screen.queryByRole("region", { name: "Agents that are off" })).toBeNull();
  });
});

describe("Overview worth a look", () => {
  it("lists risky findings per agent, links to the agent and counts them", async () => {
    postures = { claude: RISKY_CLAUDE, codex: CLEAN_CODEX };
    const { props: p } = renderOverview();
    const look = await screen.findByRole("region", { name: "Worth a look · 1" });
    expect(look.textContent).toContain("starts in bypassPermissions mode: no permission prompts");
    fireEvent.click(within(look).getByRole("button", { name: /Claude/ }));
    expect(p.onNavigate).toHaveBeenCalledWith("claude");
  });

  it("is not there when nothing is risky, and a posture that cannot be read does not break the page", async () => {
    postures = { codex: CLEAN_CODEX };
    renderOverview();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_security_posture", { harness: "codex" }));
    expect(screen.queryByRole("region", { name: /Worth a look/ })).toBeNull();
  });
});

describe("Overview flow map", () => {
  it("has one node per agent with its state in the name, and the dimmed ones for agents that are off", () => {
    renderOverview();
    expect(within(map() as unknown as HTMLElement).getByRole("button", { name: "Claude, 1 to decide" })).toBeTruthy();
    expect(within(map() as unknown as HTMLElement).getByRole("button", { name: "Codex, Up to date" })).toBeTruthy();
    expect(within(map() as unknown as HTMLElement).getByRole("button", { name: "OpenCode, Update ready" })).toBeTruthy();
    expect(within(map() as unknown as HTMLElement).getByRole("button", { name: "Copilot, off in Settings" })).toBeTruthy();
  });

  it("draws the decision as a filled square and every other state as a ring", () => {
    renderOverview();
    expect(node("Claude").querySelector(".flow-square")).not.toBeNull();
    expect(node("Claude").querySelector(".flow-ring")).toBeNull();
    expect(node("Codex").querySelector(".flow-ring")).not.toBeNull();
    expect(node("Codex").querySelector(".flow-square")).toBeNull();
  });

  it("puts a monochrome icon before every agent name, the state as a badge on its corner, not a ring beside the name", () => {
    renderOverview();
    for (const name of ["Claude", "Codex", "OpenCode", "Copilot", "Pi", "Kilo"]) {
      const agent = node(name);
      expect(agent.querySelectorAll("svg.agent-glyph"), name).toHaveLength(1);
      // The badge sits on the icon's bottom-right corner: inside the icon's box, right and below its centre.
      const glyph = agent.querySelector("svg.agent-glyph")!;
      const badge = agent.querySelector(".flow-ring, .flow-square")!;
      const iconX = Number(glyph.getAttribute("x"));
      const iconY = Number(glyph.getAttribute("y"));
      const cx = Number(badge.getAttribute("cx") ?? Number(badge.getAttribute("x")) + Number(badge.getAttribute("width")) / 2);
      const cy = Number(badge.getAttribute("cy") ?? Number(badge.getAttribute("y")) + Number(badge.getAttribute("height")) / 2);
      expect(cx, `${name} badge x`).toBeGreaterThan(iconX + 8);
      expect(cx, `${name} badge x`).toBeLessThanOrEqual(iconX + 16 + 1);
      expect(cy, `${name} badge y`).toBeGreaterThan(iconY + 8);
      expect(cy, `${name} badge y`).toBeLessThanOrEqual(iconY + 16 + 1);
      // The name starts clear of the icon and its badge.
      const nameX = Number(agent.querySelector(".flow-name")!.getAttribute("x"));
      expect(nameX).toBeGreaterThanOrEqual(iconX + 16 + 4);
    }
    // Every agent, Codex and Kilo too, has a path-drawn glyph and no text.
    expect(node("Codex").querySelector("svg.agent-glyph path")).not.toBeNull();
    expect(node("Codex").querySelector("svg.agent-glyph text")).toBeNull();
  });

  it("keeps the state in the accessible name of each node, with a dashed badge for the agents that are off", () => {
    renderOverview();
    expect(node("Pi").getAttribute("aria-label")).toBe("Pi, off in Settings");
    expect(node("Pi").classList.contains("is-dim")).toBe(true);
    expect(node("Pi").querySelector(".flow-ring")).not.toBeNull();
    expect(node("Claude").getAttribute("aria-label")).toBe("Claude, 1 to decide");
    // The icons are decorative inside a node that already has a name.
    expect(node("Claude").querySelector("svg.agent-glyph")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the icon with the state in the inspector header of an agent", () => {
    renderOverview();
    fireEvent.click(node("Claude"));
    const header = inspector().querySelector(".flow-h")!;
    expect(header.querySelector(".agent-icon svg.agent-glyph")).not.toBeNull();
    expect(header.querySelector(".agent-badge.is-decide")).not.toBeNull();
    expect(header.textContent).toBe("Claude");
    fireEvent.click(node("Pi"));
    expect(inspector().querySelector(".flow-h .agent-badge.is-off")).not.toBeNull();
  });

  it("has a source for the base and for each pack, with a held pack named as such", async () => {
    sources = { skills: 24, agents: 6, rules: [], packs: PACKS };
    renderOverview();
    expect(await within(map() as unknown as HTMLElement).findByRole("button", { name: "Riggverk base, base, 30 items" })).toBeTruthy();
    expect(within(map() as unknown as HTMLElement).getByRole("button", { name: "mine, skill pack, 2 items" })).toBeTruthy();
    expect(within(map() as unknown as HTMLElement).getByRole("button", { name: "old-pack, skill pack, 1 item, held" })).toBeTruthy();
  });

  it("selects with Enter and a click, and a second click clears it", () => {
    renderOverview();
    fireEvent.keyDown(node("Codex"), { key: "Enter" });
    expect(within(inspector()).getByRole("heading", { name: "Codex" })).toBeTruthy();
    expect(node("Codex").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(node("Codex"));
    expect(within(inspector()).getByRole("heading", { name: "Overview" })).toBeTruthy();
  });

  it("puts the count on a curve while a node is pointed at, and takes it away again", () => {
    renderOverview();
    expect(map().querySelectorAll(".flow-cnt")).toHaveLength(0);
    fireEvent.mouseEnter(node("Claude"));
    expect(map().querySelectorAll(".flow-cnt").length).toBeGreaterThan(0);
    expect(map().classList.contains("has-hl")).toBe(true);
    fireEvent.mouseLeave(node("Claude"));
    expect(map().querySelectorAll(".flow-cnt")).toHaveLength(0);
  });

  it("selects a curve and shows what flows on it", async () => {
    sources = { skills: 24, agents: 6, rules: [], packs: PACKS };
    renderOverview();
    await within(map() as unknown as HTMLElement).findByRole("button", { name: /^mine, skill pack/ });
    const curve = map().querySelector('.flow-hit[aria-hidden="true"]')!;
    expect(curve).not.toBeNull();
    const hits = [...map().querySelectorAll(".flow-hit")];
    // The first curve belongs to the base and the first agent that is on: Codex.
    fireEvent.click(hits[0]!);
    expect(within(inspector()).getByRole("heading", { name: "Riggverk base → Codex" })).toBeTruthy();
    expect(within(inspector()).getByRole("list", { name: "Items on this curve" })).toBeTruthy();
  });
});

describe("Overview inspector", () => {
  it("shows the verdict pill and the hint when nothing is selected", () => {
    renderOverview();
    expect(within(inspector()).getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(within(inspector()).getByText("1 to decide")).toBeTruthy();
    expect(inspector().textContent).toContain("Esc clears the selection");
    expect(inspector().getAttribute("aria-live")).toBe("polite");
  });

  it("offers a decision with a button that opens the agent's page, and no square anywhere else", () => {
    const { props: p } = renderOverview();
    const decision = within(inspector()).getByText("Claude · Rules").closest(".flow-dec") as HTMLElement;
    expect(within(decision).getByText("Your file differs from every shipped version")).toBeTruthy();
    fireEvent.click(within(decision).getByRole("button", { name: "Open Claude" }));
    expect(p.onNavigate).toHaveBeenCalledWith("claude");
    expect(decision.querySelector(".state-mark.is-decide")).not.toBeNull();
  });

  it("lists what has to be fixed by hand, with the reason and a button to the agent's page", () => {
    const malformed = installationStatus(
      "conflict",
      [{ ...surfaceStatus("claude_rules", "conflict"), rules: { ...RULES_CONFLICT, conflict_reason: "malformed_markers" as const, malformed_reason: "missing_end" as const } }, surfaceStatus("claude_agents", "current")],
      { conflict_count: 1 },
    );
    const { props: p } = renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, claude: malformed }), enabledHarnessIds: ["claude"] });
    expect(within(inspector()).getByText("1 to fix")).toBeTruthy();
    const fix = within(inspector()).getByText(/^Claude · Rules to fix by hand/).closest(".flow-fix") as HTMLElement;
    expect(fix.textContent).toContain("Rules:");
    expect(fix.textContent).toMatch(/markers/i);
    expect(fix.querySelector(".state-mark.is-fix")).not.toBeNull();
    fireEvent.click(within(fix).getByRole("button", { name: "Open Claude" }));
    expect(p.onNavigate).toHaveBeenCalledWith("claude");
  });

  it("shows Install everything on a fresh profile, which does what Update all does", () => {
    const fresh = installationStatus("not_installed", [surfaceStatus("codex_rules", "not_installed"), surfaceStatus("skills", "not_installed")]);
    const { props: p } = renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, codex: fresh }), enabledHarnessIds: ["codex"] });
    expect(within(inspector()).getByText("Ready to install")).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Install everything" }));
    expect(p.install.open).toHaveBeenCalledWith("all", { scope: "start" });
  });

  it("does not offer Install everything once something is installed", () => {
    renderOverview();
    expect(within(inspector()).queryByRole("button", { name: "Install everything" })).toBeNull();
  });

  it("opens the Settings page for an agent that is off", () => {
    const { props: p } = renderOverview();
    fireEvent.click(node("Pi"));
    expect(within(inspector()).getByText("Off in Settings. Nothing flows to it.")).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Open Settings" }));
    expect(p.onNavigate).toHaveBeenCalledWith("settings");
  });

  it("shows an agent's rows with their state in words, and opens its page", () => {
    const { props: p } = renderOverview();
    fireEvent.click(node("Claude"));
    const rows = within(within(inspector()).getByRole("list", { name: "Claude surfaces" })).getAllByRole("listitem").map(row => row.textContent);
    expect(rows).toEqual(["Rulesneeds decision", "Agentsup to date", "Skillsup to date", "Settingsnot managed"]);
    expect(within(inspector()).getByText("Your file differs from every shipped version", { exact: false })).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Open Claude" }));
    expect(p.onNavigate).toHaveBeenCalledWith("claude");
  });

  it("counts skills and agents in an agent's rows where the Overview read them, and names who feeds it", async () => {
    sources = { skills: 24, agents: 6, rules: [], packs: PACKS };
    renderOverview();
    await within(map() as unknown as HTMLElement).findByRole("button", { name: /^mine, skill pack/ });
    fireEvent.click(node("Claude"));
    const rows = within(within(inspector()).getByRole("list", { name: "Claude surfaces" })).getAllByRole("listitem").map(row => row.textContent);
    expect(rows).toEqual(["Rulesneeds decision", "Agents6 agents · up to date", "Skills26 skills · up to date", "Settingsnot managed"]);
    expect(within(inspector()).getByText("Riggverk base and mine")).toBeTruthy();
  });

  it("adds the runtime sentence and the Codex override warning to the agent they belong to", () => {
    const health = {
      checks: [{ id: "rules_override", label: "AGENTS.override.md replaces AGENTS.md", status: "warn", detail: "the Riggverk base block is not loaded until it is removed or emptied" }],
    } as unknown as CodexRuntimeHealth;
    renderOverview({ runtimeHealth: { codex: { harness: "codex", health } } });
    fireEvent.click(node("Codex"));
    expect(within(inspector()).getByRole("alert").textContent).toContain("AGENTS.override.md replaces AGENTS.md");
    fireEvent.click(node("Claude"));
    expect(within(inspector()).queryByRole("alert")).toBeNull();
  });

  it("tells a rules file the user manages as yours, not as current", () => {
    const managed = installationStatus("current", [{ ...surfaceStatus("claude_rules", "current"), rules: { ...RULES_CONFLICT, user_managed: true } }]);
    renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, claude: managed }), enabledHarnessIds: ["claude"] });
    fireEvent.click(node("Claude"));
    expect(within(inspector()).getByText("You manage this file; base updates are waiting", { exact: false })).toBeTruthy();
    expect(within(inspector()).getByText("Yours")).toBeTruthy();
  });

  it("tells skill files in conflict as a decision on the agent that shows them", () => {
    const files: FilesStatus = {
      conflicts: 1,
      kept: 0,
      kept_updates: 0,
      units: [
        {
          key: "skill:claude:tdd",
          kind: "skill",
          name: "tdd",
          folder: "~/.claude/skills",
          wanted: true,
          state: "conflict",
          reason: "edited",
          bundle_changed: false,
          read_by: ["Claude"],
          files: [{ rel: "SKILL.md", state: "conflict", reason: "edited", bundle_changed: false }],
          more_files: 0,
        },
      ],
      more: 0,
    };
    const status = installationStatus("conflict", [{ ...surfaceStatus("skills", "conflict"), files }], { conflict_count: 1 });
    renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, claude: status }), enabledHarnessIds: ["claude"] });
    expect(node("Claude").querySelector(".flow-square")).not.toBeNull();
    expect(within(inspector()).getByText("1 file you edited")).toBeTruthy();
  });

  it("shows a source: what it holds, what it reaches, and the way to the Library", async () => {
    sources = { skills: 24, agents: 6, rules: [{ surface: "claude_rules", refinement_lines: 14 }], packs: PACKS };
    const { props: p } = renderOverview();
    fireEvent.click(await within(map() as unknown as HTMLElement).findByRole("button", { name: /^Riggverk base/ }));
    expect(within(inspector()).getByRole("heading", { name: "Riggverk base" })).toBeTruthy();
    const items = within(within(inspector()).getByRole("list", { name: "Riggverk base contents" })).getAllByRole("listitem").map(row => row.textContent);
    expect(items).toEqual(["Skills24 skills", "Agents6 agents", "Rules1 rules file"]);
    expect(within(inspector()).getByText("Codex, OpenCode, Cursor and Claude")).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Open in Library" }));
    expect(p.onNavigate).toHaveBeenCalledWith("library");
    fireEvent.click(within(map() as unknown as HTMLElement).getByRole("button", { name: /^Your refinements/ }));
    expect(within(inspector()).getByText("Claude")).toBeTruthy();
    expect(within(inspector()).getByText("14 lines")).toBeTruthy();
  });

  it("names a held pack and why", async () => {
    sources = { skills: 24, agents: 6, rules: [], packs: PACKS };
    renderOverview();
    fireEvent.click(await within(map() as unknown as HTMLElement).findByRole("button", { name: /^old-pack/ }));
    expect(within(inspector()).getByText("Held")).toBeTruthy();
    expect(within(inspector()).getByText("the pack folder is gone")).toBeTruthy();
  });

  it("clears the selection with Escape, and Escape is not taken while nothing is selected", () => {
    renderOverview();
    press("Escape");
    expect(within(inspector()).getByRole("heading", { name: "Overview" })).toBeTruthy();
    fireEvent.click(node("Codex"));
    expect(within(inspector()).getByRole("heading", { name: "Codex" })).toBeTruthy();
    press("Escape");
    expect(within(inspector()).getByRole("heading", { name: "Overview" })).toBeTruthy();
  });

  it("is not a tab trap: nodes are tab stops and the page itself is not", () => {
    renderOverview();
    expect(node("Claude").getAttribute("tabindex")).toBe("0");
    expect(page().getAttribute("tabindex")).toBe("-1");
  });
});

describe("Overview last update", () => {
  function entry(overrides: Partial<SetupHistoryEntry> = {}): SetupHistoryEntry {
    return {
      transaction_id: "1792663200000000000",
      created_at: "1792663200000000000",
      finished_at: "1792663202000000000",
      status: "applied",
      surfaces: ["codex_rules"],
      harnesses: ["codex"],
      changes: [{ surface: "codex_rules", kind: "update", path: "~/.codex/AGENTS.md", applied: true, restored: false }],
      operation_counts: { create: 0, update: 1, remove: 0 },
      backup_files: 1,
      is_newest_completed: true,
      undoable: true,
      receipt: { synced: ["claude_rules"], left_for_you: [{ surface: "cursor_agents", reason: "conflict" }] },
      ...overrides,
    };
  }

  it("shows the receipt of the newest update from the history in the inspector and offers Undo only where the backend does", async () => {
    history = [entry()];
    const { props: p } = renderOverview();
    const undo = await within(inspector()).findByRole("button", { name: "Undo this update…" });
    expect(within(inspector()).getByText(/^Last update · Codex/)).toBeTruthy();
    expect(inspector().textContent).toContain("Changedcodex rules · 1 file");
    expect(inspector().textContent).toContain("Left for youcursor agents · you edited it");
    fireEvent.click(undo);
    // Undo only names the transaction; the dry run and the confirm are the owner's.
    expect(p.onUndo).toHaveBeenCalledWith("1792663200000000000");
  });

  it("leads to the History page", async () => {
    history = [entry()];
    const { props: p } = renderOverview();
    fireEvent.click(await within(inspector()).findByRole("button", { name: "History" }));
    expect(p.onNavigate).toHaveBeenCalledWith("history");
  });

  it("offers no Undo for an update that is not the newest completed one, or is already undone", async () => {
    history = [entry({ status: "rolled_back", undoable: false })];
    renderOverview();
    expect(await within(inspector()).findByText("Undone")).toBeTruthy();
    expect(within(inspector()).queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("shows the task instead of the receipt while it runs, and the receipt again when it ends", async () => {
    history = [entry()];
    const view = renderOverview({ wsRunning: "update all" });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_setup_history", expect.anything()));
    expect(within(inspector()).queryByRole("button", { name: /Undo/ })).toBeNull();
    view.rerenderFrame(<OverviewView {...view.props} wsRunning={null} />);
    const undo = await within(inspector()).findByRole("button", { name: "Undo this update…" });
    expect(undo.getAttribute("aria-disabled")).toBeNull();
  });

  it("shows no receipt without a history", async () => {
    renderOverview();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_setup_history", expect.anything()));
    expect(inspector().textContent).not.toContain("Last update");
  });

  it("filters the receipt to the selected agent's surfaces and says when an agent was not part of it", async () => {
    history = [
      entry({
        harnesses: ["codex", "claude"],
        surfaces: ["codex_rules", "claude_rules"],
        changes: [
          { surface: "codex_rules", kind: "update", path: "~/.codex/AGENTS.md", applied: true, restored: false },
          { surface: "claude_rules", kind: "update", path: "~/.claude/CLAUDE.md", applied: true, restored: false },
        ],
        receipt: { synced: ["claude_agents", "codex_agents"], left_for_you: [{ surface: "cursor_agents", reason: "conflict" }] },
      }),
    ];
    const { props: p } = renderOverview();
    await within(inspector()).findByRole("button", { name: "Undo this update…" });
    fireEvent.click(node("Claude"));
    const claude = inspector().textContent!;
    expect(claude).toContain("Changedclaude rules · 1 file");
    expect(claude).toContain("Checkedclaude agents · current");
    expect(claude).not.toContain("codex");
    expect(claude).not.toContain("cursor agents");
    fireEvent.click(within(inspector()).getByRole("button", { name: "Undo this update…" }));
    expect(p.onUndo).toHaveBeenCalledWith("1792663200000000000");
    fireEvent.click(node("Cursor"));
    expect(inspector().textContent).toContain("Left for youcursor agents · you edited it");
    fireEvent.click(node("OpenCode"));
    expect(within(inspector()).getByText("Not part of the last update.")).toBeTruthy();
    expect(within(inspector()).queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("puts a glow on the curves of the agents the update wrote", async () => {
    history = [entry({ harnesses: ["claude"], changes: [{ surface: "claude_rules", kind: "update", path: "~/.claude/CLAUDE.md", applied: true, restored: false }] })];
    renderOverview();
    await waitFor(() => expect(map().querySelectorAll(".flow-glow").length).toBeGreaterThan(0));
    const glowing = [...map().querySelectorAll(".flow-ln.has-glow")].map(line => line.getAttribute("data-agent"));
    expect(new Set(glowing)).toEqual(new Set(["claude"]));
  });
});

describe("Overview keys", () => {
  it("opens the review of every update with u and a read-only preview with p", () => {
    const { props: p } = renderOverview();
    press("u");
    expect(p.install.open).toHaveBeenCalledWith("all", { scope: "start" });
    press("p");
    expect(p.install.open).toHaveBeenLastCalledWith("all", { readOnly: true, scope: "start" });
  });

  it("does not open the review when everything is up to date, and says why", () => {
    const current = installationStatus("current", [surfaceStatus("codex_rules", "current")]);
    const { props: p } = renderOverview({ overview: overviewOf({ workspace: OVERVIEW.entries.workspace!.status, codex: current }), enabledHarnessIds: ["codex"] });
    act(() => page().focus());
    press("u");
    expect(p.install.open).not.toHaveBeenCalled();
    const update = hint(/update all/);
    expect(update.getAttribute("aria-disabled")).toBe("true");
    expect(update.getAttribute("title")).toBe("Everything Riggverk can update is already up to date.");
  });

  it("uses the reason the shell computed for Update all when it hands one over", () => {
    const { props: p } = renderOverview({ updateAllDisabled: "Saving target changes…" });
    press("u");
    expect(p.install.open).not.toHaveBeenCalled();
  });

  it("checks again with r", () => {
    const { props: p } = renderOverview();
    press("r");
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("offers the folder and the backups on the page, by key and as hints", () => {
    const { props: p } = renderOverview();
    act(() => page().focus());
    fireEvent.click(hint(/open folder/));
    fireEvent.click(hint(/backups/));
    expect(p.onOpenFolder).toHaveBeenCalledTimes(1);
    expect(p.onOpenBackupsFolder).toHaveBeenCalledTimes(1);
    press("o");
    press("B", { shiftKey: true });
    expect(p.onOpenFolder).toHaveBeenCalledTimes(2);
    expect(p.onOpenBackupsFolder).toHaveBeenCalledTimes(2);
  });

  it("offers no folder key while a task runs, and none for an unusable folder", () => {
    const { props: p } = renderOverview({ wsRunning: "update all" });
    press("o");
    expect(p.onOpenFolder).not.toHaveBeenCalled();
    cleanup();
    const unusable = renderOverview({ workspaceDiagnostics: INVALID_DIAGNOSTICS, dataFolderOk: false, overview: overviewOf({}) });
    press("o");
    expect(unusable.props.onOpenFolder).not.toHaveBeenCalled();
  });
});

describe("Overview workspace folder", () => {
  function folder() {
    return screen.getByRole("region", { name: "Workspace folder" });
  }

  it("is collapsed, with its state and path in view, and opens with the keyboard", () => {
    renderOverview({ rollbackTransactionId: "1710000000000" });
    const toggle = within(folder()).getByRole("button", { name: /Workspace folder/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("/tmp/workspace");
    expect(within(folder()).getByText("Up to date")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(folder()).getByLabelText("Workspace folder facts").textContent).toContain("2 runs · /tmp/backups");
    expect(within(folder()).getByLabelText("Workspace folder facts").textContent).toContain("1710000000000 · rollback available");
    expect(screen.getByRole("region", { name: "Uninstall" })).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
  });

  it("tells what the data folder holds and the old copies an update removes", () => {
    const workspace = installationStatus(
      "update_available",
      [
        {
          ...surfaceStatus("workspace_bundle", "update_available", "133 old copies to remove, 1 left in place"),
          data_folder: { personal_docs: 3, ownership_records: false, left_in_place: 1 },
        },
      ],
      { remove_count: 133 },
    );
    renderOverview({ overview: overviewOf({ workspace }), enabledHarnessIds: [] });
    expect(within(folder()).getByText("Update ready")).toBeTruthy();
    expect(within(folder()).getByText("133 old copies to remove, 1 left in place")).toBeTruthy();
    fireEvent.click(within(folder()).getByRole("button", { name: /Workspace folder/ }));
    const facts = within(folder()).getByLabelText("Workspace folder facts").textContent;
    expect(facts).toContain("personal docs3");
    expect(facts).toContain("ownership recordsnone yet");
    expect(facts).toContain("left in place1 · edited old copies the app no longer reads");
  });

  it("keeps what an earlier release left behind in view while collapsed", () => {
    const earlier = "/Users/me/.config/agent-workspace"; // residue-allow: the earlier folder a note names
    renderOverview({
      workspaceDiagnostics: {
        ...VALID_DIAGNOSTICS,
        layout_notes: [
          `Riggverk kept using ${earlier} because it could not rename it to /Users/me/.config/riggverk (Permission denied).`,
          `An earlier folder ${earlier} still exists next to /Users/me/.config/riggverk; Riggverk left the earlier folder untouched.`,
        ],
      },
    });
    expect(folder().textContent).toContain(`Riggverk kept using ${earlier} because it could not rename it`);
    expect(folder().textContent).toContain("left the earlier folder untouched");
  });

  it("shows no layout note when the diagnostics carry none", () => {
    renderOverview({ workspaceDiagnostics: { ...VALID_DIAGNOSTICS, layout_notes: [] } });
    expect(folder().textContent).not.toContain("earlier folder");
  });

  it("says why the folder is unusable and offers no uninstall", () => {
    renderOverview({ workspaceDiagnostics: INVALID_DIAGNOSTICS, dataFolderOk: false, overview: overviewOf({}) });
    expect(folder().textContent).toContain("the folder is a symlink");
    fireEvent.click(within(folder()).getByRole("button", { name: /Workspace folder/ }));
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
  });

  it("opens by itself for a pending :uninstall request, so the card that handles it is mounted", () => {
    const handled = vi.fn();
    renderOverview({ uninstallPreviewRequested: true, onUninstallPreviewHandled: handled });
    expect(within(folder()).getByRole("button", { name: /Workspace folder/ }).getAttribute("aria-expanded")).toBe("true");
    expect(handled).toHaveBeenCalled();
  });

  it("opens by itself when an uninstall can be recovered, also while the folder is gone", () => {
    renderOverview({
      workspaceDiagnostics: INVALID_DIAGNOSTICS,
      dataFolderOk: false,
      overview: overviewOf({}),
      uninstallRecoveryTransactionId: "1710000000000",
    });
    expect(screen.getByRole("region", { name: /recover previous uninstall/i })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Uninstall" })).toBeNull();
  });

  it("has the folder and backups buttons, with the reason when a task runs", () => {
    const { props: p } = renderOverview();
    fireEvent.click(within(folder()).getByRole("button", { name: /Workspace folder/ }));
    fireEvent.click(within(folder()).getByRole("button", { name: "Open folder" }));
    fireEvent.click(within(folder()).getByRole("button", { name: "Backups folder" }));
    expect(p.onOpenFolder).toHaveBeenCalledTimes(1);
    expect(p.onOpenBackupsFolder).toHaveBeenCalledTimes(1);
    cleanup();
    renderOverview({ wsRunning: "update all" });
    fireEvent.click(within(folder()).getByRole("button", { name: /Workspace folder/ }));
    expect(within(folder()).getByRole("button", { name: "Open folder" }).getAttribute("title")).toBe("update all is running");
  });
});

describe("Overview install review", () => {
  it("shows the plan instead of the page while the review is open", () => {
    const flow = flowOf([op("workspace_bundle", "update")], { label: "update all", surfaces: ["workspace_bundle"] });
    renderOverview({ install: installScreenOf(flow, "start"), wsRunning: "update all" });
    expect(screen.getByRole("grid", { name: "Install plan" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Overview" })).toBeNull();
    const review = screen.getByRole("region", { name: "Workspace install review" });
    expect(review.classList.contains("review")).toBe(true);
    expect([...review.children].map(child => child.getAttribute("data-pane-id"))).toEqual(["plan"]);
  });

  it("hands apply to the install screen when y is pressed, and never on Enter", () => {
    const flow = flowOf([op("workspace_bundle", "update")], { label: "update all", surfaces: ["workspace_bundle"] });
    const install = installScreenOf(flow, "start");
    renderOverview({ install });
    const plan = screen.getByRole("grid", { name: "Install plan" });
    fireEvent.keyDown(plan, { key: "Enter" });
    expect(install.apply).not.toHaveBeenCalled();
    fireEvent.keyDown(plan, { key: "y" });
    expect(install.apply).toHaveBeenCalledTimes(1);
  });

  it("does not show a review that belongs to another page", () => {
    const flow = flowOf([op("claude_rules", "update")]);
    renderOverview({ install: installScreenOf(flow, "claude") });
    expect(screen.queryByRole("grid", { name: "Install plan" })).toBeNull();
    expect(page()).toBeTruthy();
  });
});

describe("Overview run panel", () => {
  it("leaves the run panel to the app frame, which shows it on every page", () => {
    renderOverview({ wsRunning: "update claude", wsProgress: { task: "apply_setup", phase: "apply", done: 4, total: 7, file: "~/.claude/skills/handoff/SKILL.md" } });
    expect(screen.queryByRole("region", { name: "Run" })).toBeNull();
    // The inspector still follows the run.
    expect(within(inspector()).getByText("Update claude")).toBeTruthy();
  });
});

describe("Overview run in the inspector", () => {
  const progress = (file: string | null, overrides: Partial<ApplyProgress> = {}): ApplyProgress => ({
    task: "apply_setup",
    phase: "apply",
    done: 4,
    total: 7,
    file,
    ...overrides,
  });
  const originalLength = (SVGElement.prototype as unknown as { getTotalLength?: unknown }).getTotalLength;
  const originalPoint = (SVGElement.prototype as unknown as { getPointAtLength?: unknown }).getPointAtLength;

  beforeEach(() => {
    const proto = SVGElement.prototype as unknown as Record<string, unknown>;
    proto.getTotalLength = () => 100;
    proto.getPointAtLength = () => ({ x: 1, y: 2 });
  });

  afterEach(() => {
    const proto = SVGElement.prototype as unknown as Record<string, unknown>;
    proto.getTotalLength = originalLength;
    proto.getPointAtLength = originalPoint;
    document.documentElement.removeAttribute("data-motion");
    vi.restoreAllMocks();
  });

  it("follows the task: its name, progress, the file and the agents reached, instead of the selection", async () => {
    renderOverview({ wsRunning: "update all", wsProgress: progress("~/.claude/skills/handoff/SKILL.md"), agentTargets: TARGETS });
    const run = inspector();
    expect(within(run).getByRole("heading", { name: "Update all" })).toBeTruthy();
    expect(within(run).getByRole("progressbar").getAttribute("aria-valuetext")).toBe("4 of 7");
    expect(within(run).getByText("~/.claude/skills/handoff/SKILL.md")).toBeTruthy();
    await waitFor(() => {
      const items = within(within(run).getByRole("list", { name: "Agents in this run" })).getAllByRole("listitem").map(item => item.textContent);
      // The agents that were waiting for an update when it started, then the one whose file is being written.
      expect(items).toEqual(["OpenCodewaiting", "Cursorwaiting", "Claude1 file"]);
    });
  });

  it("keeps the per-file text out of the live region and announces only the phase", () => {
    const view = renderOverview({ wsRunning: "update all", wsProgress: progress("~/.claude/skills/handoff/SKILL.md"), agentTargets: TARGETS });
    expect(inspector().getAttribute("aria-live")).toBe("off");
    const status = within(inspector()).getByRole("status");
    expect(status.textContent).toBe("Update all: Writing");
    view.rerenderFrame(<OverviewView {...view.props} wsRunning="update all" wsProgress={progress("~/.claude/skills/tdd/SKILL.md", { done: 5 })} />);
    // Another file of the same phase changes nothing that is announced.
    expect(within(inspector()).getByRole("status").textContent).toBe("Update all: Writing");
    view.rerenderFrame(<OverviewView {...view.props} wsRunning="update all" wsProgress={progress(null, { phase: "backup", done: 0 })} />);
    expect(within(inspector()).getByRole("status").textContent).toBe("Update all: Backing up");
  });

  it("marks the agent whose folder holds the file as live, with its curves and a sub-line", async () => {
    renderOverview({ wsRunning: "update all", wsProgress: progress("~/.claude/skills/handoff/SKILL.md"), agentTargets: TARGETS });
    await waitFor(() => expect(node("Claude").classList.contains("is-live")).toBe(true));
    expect(node("Claude").textContent).toContain("writing 1 file");
    expect(node("Codex").classList.contains("is-live")).toBe(false);
    const live = [...map().querySelectorAll(".flow-ln.live")].map(line => line.getAttribute("data-agent"));
    expect(new Set(live)).toEqual(new Set(["claude"]));
  });

  it("marks no agent for a file in a folder that belongs to none of them", async () => {
    renderOverview({ wsRunning: "update all", wsProgress: progress("~/.agents/skills/tdd/SKILL.md"), agentTargets: TARGETS });
    await within(inspector()).findByRole("progressbar");
    expect(map().querySelector(".flow-agent.is-live")).toBeNull();
  });

  it("says only a phase word until the backend reports, and ignores clicks on the map", () => {
    renderOverview({ wsRunning: "update all", wsProgress: null, agentTargets: TARGETS });
    expect(within(inspector()).queryByRole("progressbar")).toBeNull();
    expect(within(inspector()).getByText("working…")).toBeTruthy();
    fireEvent.click(node("Codex"));
    expect(within(inspector()).getByRole("heading", { name: "Update all" })).toBeTruthy();
  });

  it("runs dots along the live agent's curves while the run goes on, and removes them when it ends", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => frames.push(callback));
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { unmount } = renderOverview({ wsRunning: "update all", wsProgress: progress("~/.claude/skills/handoff/SKILL.md"), agentTargets: TARGETS });
    await waitFor(() => expect(map().querySelectorAll(".flow-pulse").length).toBeGreaterThan(0));
    expect(map().querySelectorAll(".flow-pulse").length).toBe(map().querySelectorAll(".flow-ln[data-agent='claude']:not(.is-ghost)").length);
    unmount();
    expect(cancel).toHaveBeenCalled();
    expect(document.querySelectorAll(".flow-pulse")).toHaveLength(0);
  });

  it("stops the dots when the task ends", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const view = renderOverview({ wsRunning: "update all", wsProgress: progress("~/.claude/skills/handoff/SKILL.md"), agentTargets: TARGETS });
    await waitFor(() => expect(map().querySelectorAll(".flow-pulse").length).toBeGreaterThan(0));
    view.rerenderFrame(<OverviewView {...view.props} wsRunning={null} wsProgress={null} />);
    await waitFor(() => expect(document.querySelectorAll(".flow-pulse")).toHaveLength(0));
    expect(map().querySelector(".flow-agent.is-live")).toBeNull();
  });

  it("draws no dots and no draw-in when motion is off", async () => {
    document.documentElement.setAttribute("data-motion", "off");
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    renderOverview({ wsRunning: "update all", wsProgress: progress("~/.claude/skills/handoff/SKILL.md"), agentTargets: TARGETS });
    await waitFor(() => expect(node("Claude").classList.contains("is-live")).toBe(true));
    expect(map().querySelectorAll(".flow-pulse")).toHaveLength(0);
    expect(raf).not.toHaveBeenCalled();
    expect(map().querySelectorAll(".flow-ln.draw")).toHaveLength(0);
  });

  it("starts no animation loop while idle", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    renderOverview({ agentTargets: TARGETS });
    expect(raf).not.toHaveBeenCalled();
  });
});

describe("Overview page keys scope", () => {
  it("makes the page the default pane, so the keys work right after the view opens", () => {
    renderOverview();
    expect(page().getAttribute("data-pane-id")).toBe("page");
    expect(page().hasAttribute("data-pane-default")).toBe(true);
    expect(page().getAttribute("tabindex")).toBe("-1");
  });
});
