import { describe, expect, it } from "vitest";
import { installationStatus, overviewOf, surfaceStatus } from "../test/pageFixtures";
import type { AppSettings, InstallAgent, PackLibrary, RulesFileSummary, SetupHistoryEntry } from "../types";
import {
  agentForFile,
  agentsReachedBy,
  buildFlowModel,
  decisionsOf,
  EMPTY_TRACE,
  highlightOf,
  homePill,
  lineWeight,
  nothingInstalled,
  receivedBy,
  resolveRef,
  runChecklist,
  sourcesFeeding,
  traceStep,
  type FlowSourceData,
} from "./flowModel";
import { defaultSettings } from "./settingsDraft";
import { overviewSummaryModel, type AgentCardModel } from "./overviewModel";

const SETTINGS: Pick<AppSettings, "enabled_target_ids" | "enabled_harness_ids"> = {
  enabled_harness_ids: ["codex", "claude", "cursor"],
  enabled_target_ids: ["codex_rules", "codex_agents", "claude_rules", "claude_agents", "cursor_setup"],
};

const WORKSPACE = installationStatus("current", [surfaceStatus("workspace_bundle", "current")]);
const RULES = { layout: "legacy" as const, refinement_lines: 0, user_managed: false };

function cardsFor(statuses: Parameters<typeof overviewOf>[0], harnesses: InstallAgent[] = ["codex", "claude", "cursor"]): AgentCardModel[] {
  return overviewSummaryModel({
    overview: overviewOf({ workspace: WORKSPACE, ...statuses }),
    settings: { ...SETTINGS, enabled_harness_ids: harnesses },
    enabledHarnessIds: harnesses,
    dataFolderOk: true,
    diagnostics: { error: null },
  }).cards;
}

const CURRENT = {
  codex: installationStatus("current", [surfaceStatus("codex_rules", "current"), surfaceStatus("codex_agents", "current"), surfaceStatus("skills", "current")]),
  claude: installationStatus("current", [surfaceStatus("claude_rules", "current"), surfaceStatus("claude_agents", "current"), surfaceStatus("skills", "current")]),
  cursor: installationStatus("current", [surfaceStatus("cursor_agents", "current"), surfaceStatus("skills", "current")]),
};

function rulesFile(surface: RulesFileSummary["surface"], refinementLines: number): RulesFileSummary {
  return {
    surface,
    label: surface,
    file: "~/x",
    layout: "managed" as RulesFileSummary["layout"],
    conflict: null,
    malformed: null,
    refinement_lines: refinementLines,
    editable: true,
    reason: null,
  };
}

const SOURCES: FlowSourceData = {
  bundledSkills: 24,
  bundledAgents: 6,
  rulesFiles: [rulesFile("codex_rules", 0), rulesFile("claude_rules", 14)],
  packs: {
    folder: "~/packs",
    packs: [
      { name: "mine", state: "ok", reason: "", forgettable: false },
      { name: "old-pack", state: "missing", reason: "the pack folder is gone", forgettable: true },
    ],
    skills: [
      { id: "pack:mine/a", name: "a", description: "", pack: "mine", state: "active", reason: "", path: "" },
      { id: "pack:mine/b", name: "b", description: "", pack: "mine", state: "active", reason: "", path: "" },
      { id: "pack:mine/tdd", name: "tdd", description: "", pack: "mine", state: "shadowed", reason: "the bundle wins", path: "" },
      { id: "pack:old-pack/x", name: "x", description: "", pack: "old-pack", state: "missing", reason: "pack missing", path: "" },
    ],
    ignored: [],
  } satisfies PackLibrary,
};

function entry(overrides: Partial<SetupHistoryEntry> = {}): SetupHistoryEntry {
  return {
    transaction_id: "1",
    created_at: "1792663200000000000",
    finished_at: "1792663202000000000",
    status: "applied",
    surfaces: ["claude_rules"],
    harnesses: ["claude"],
    changes: [{ surface: "claude_rules", kind: "update", path: "~/.claude/CLAUDE.md", applied: true, restored: false }],
    operation_counts: { create: 0, update: 1, remove: 0 },
    backup_files: 1,
    is_newest_completed: true,
    undoable: true,
    receipt: { synced: ["codex_rules"], left_for_you: [] },
    ...overrides,
  };
}

const edge = (model: ReturnType<typeof buildFlowModel>, source: string, agent: InstallAgent) => model.edges.find(candidate => candidate.id === `${source}>${agent}`);

describe("buildFlowModel sources and reach", () => {
  const model = buildFlowModel({ cards: cardsFor(CURRENT), sources: SOURCES, personalDocs: 2, lastUpdate: null });

  it("has the base, your refinements and one node per pack, in that order", () => {
    expect(model.sources.map(source => source.id)).toEqual(["base", "yours", "pack:mine", "pack:old-pack"]);
    expect(model.sources[0]!.items.map(item => [item.key, item.n])).toEqual([["skills", 24], ["agents", 6], ["rules", 2]]);
  });

  it("lists every agent, with the ones that are off dimmed", () => {
    expect(model.agents.map(agent => [agent.id, agent.status])).toEqual([
      ["codex", "active"],
      ["opencode", "off"],
      ["cursor", "active"],
      ["claude", "active"],
      ["copilot", "off"],
      ["pi", "off"],
      ["kilo", "off"],
      ["antigravity", "off"],
    ]);
    expect(model.agents.find(agent => agent.id === "opencode")!.sub).toBe("off in Settings");
  });

  it("reaches every enabled agent from the base, and an agent that is off only by a ghost curve", () => {
    expect(agentsReachedBy(model, "base").map(agent => agent.id)).toEqual(["codex", "cursor", "claude"]);
    expect(edge(model, "base", "opencode")?.status).toBe("ghost");
    // Only the base has a ghost curve: no pack or refinements reach an agent that is off.
    expect(model.edges.filter(candidate => candidate.status === "ghost").every(candidate => candidate.source === "base")).toBe(true);
    expect(edge(model, "pack:mine", "opencode")).toBeUndefined();
  });

  it("sends your refinements only to the agents whose rules file has some, with the line count", () => {
    expect(agentsReachedBy(model, "yours").map(agent => agent.id)).toEqual(["claude"]);
    expect(edge(model, "yours", "claude")!.items).toEqual([{ key: "refinements", label: "Refinements", n: 14, unit: ["line", "lines"] }]);
    expect(model.sources.find(source => source.id === "yours")!.items.map(item => [item.key, item.n])).toEqual([["refinements", 14], ["docs", 2]]);
  });

  it("leaves your refinements out when there is nothing: no lines and no personal docs", () => {
    const none = buildFlowModel({ cards: cardsFor(CURRENT), sources: { ...SOURCES, rulesFiles: [rulesFile("claude_rules", 0)] }, personalDocs: 0, lastUpdate: null });
    expect(none.sources.map(source => source.id)).not.toContain("yours");
  });

  it("counts a pack's active skills and says what is shadowed", () => {
    const mine = model.sources.find(source => source.id === "pack:mine")!;
    expect(mine.total).toBe(2);
    expect(mine.state).toBe("ok");
    expect(mine.notes.join(" ")).toContain("1 skill shadowed by a bundled skill");
    expect(edge(model, "pack:mine", "claude")).toMatchObject({ total: 2, status: "ok" });
  });

  it("shows a pack whose folder is gone with the fix state and a dashed fix curve", () => {
    const old = model.sources.find(source => source.id === "pack:old-pack")!;
    expect(old.state).toBe("fix");
    expect(old.notes).toContain("the pack folder is gone");
    expect(edge(model, "pack:old-pack", "codex")).toMatchObject({ status: "fix" });
  });

  it("omits a count that no read gives instead of inventing it", () => {
    const unknown = buildFlowModel({
      cards: cardsFor(CURRENT),
      sources: { bundledSkills: null, bundledAgents: null, rulesFiles: null, packs: null },
      personalDocs: null,
      lastUpdate: null,
    });
    expect(unknown.sources.map(source => source.id)).toEqual(["base"]);
    expect(unknown.sources[0]!.items).toEqual([]);
    // What the base still brings, one rules file and nothing else, is only what the cards themselves say.
    expect(edge(unknown, "base", "codex")!.items.map(item => item.key)).toEqual(["rules"]);
    expect(unknown.edges.every(candidate => candidate.total > 0)).toBe(true);
  });

  it("weights a curve by the items on it, heavier for more", () => {
    expect(lineWeight(37)).toBeGreaterThan(lineWeight(5));
    expect(lineWeight(1)).toBeGreaterThan(0.8);
    expect(edge(model, "base", "claude")!.total).toBeGreaterThan(edge(model, "pack:mine", "claude")!.total);
  });

  it("tells what an agent receives in total and who feeds it", () => {
    expect(receivedBy(model, "claude")).toMatchObject({ skills: 24 + 2, agents: 6, rules: 1 });
    expect(sourcesFeeding(model, "claude").map(source => source.id)).toEqual(["base", "yours", "pack:mine"]);
    expect(sourcesFeeding(model, "codex").map(source => source.id)).toEqual(["base", "pack:mine"]);
  });
});

describe("buildFlowModel states of the agents and curves", () => {
  it("dashes the curves of an agent with an update ready", () => {
    const cards = cardsFor({ ...CURRENT, cursor: installationStatus("update_available", [surfaceStatus("cursor_agents", "update_available")]) });
    const model = buildFlowModel({ cards, sources: SOURCES, personalDocs: null, lastUpdate: null });
    expect(edge(model, "base", "cursor")!.status).toBe("ready");
    expect(edge(model, "pack:mine", "cursor")!.status).toBe("ready");
    expect(edge(model, "base", "claude")!.status).toBe("ok");
    expect(model.agents.find(agent => agent.id === "cursor")!.sub).toBe("update ready");
  });

  it("marks an agent with a decision as a square and names the row in its sub-line", () => {
    const conflict = installationStatus("conflict", [
      { ...surfaceStatus("claude_rules", "conflict"), rules: { ...RULES, conflict_reason: "legacy_diverged" } },
      surfaceStatus("claude_agents", "current"),
      surfaceStatus("skills", "current"),
    ]);
    const cards = cardsFor({ ...CURRENT, claude: conflict });
    const model = buildFlowModel({ cards, sources: SOURCES, personalDocs: null, lastUpdate: null });
    const claude = model.agents.find(agent => agent.id === "claude")!;
    expect(claude).toMatchObject({ decision: true, state: "decide", sub: "Rules · needs decision", pillText: "1 to decide" });
    expect(model.agents.find(agent => agent.id === "codex")!.decision).toBe(false);
    expect(decisionsOf(cards)).toEqual([expect.objectContaining({ harness: "claude", label: "Claude", rows: [expect.objectContaining({ label: "Rules" })] })]);
  });

  it("says how many surfaces are in sync for an agent that is up to date", () => {
    const model = buildFlowModel({ cards: cardsFor(CURRENT), sources: SOURCES, personalDocs: null, lastUpdate: null });
    expect(model.agents.find(agent => agent.id === "claude")!.sub).toBe("3 of 3 in sync");
  });

  it("treats an agent the backend finds nowhere as missing, with a ghost curve from the base only", () => {
    const gone = installationStatus("unavailable", [surfaceStatus("cursor_agents", "unavailable"), surfaceStatus("skills", "unavailable"), surfaceStatus("cursor_mcp", "unavailable")]);
    const model = buildFlowModel({ cards: cardsFor({ ...CURRENT, cursor: gone }), sources: SOURCES, personalDocs: null, lastUpdate: null });
    const cursor = model.agents.find(agent => agent.id === "cursor")!;
    expect(cursor).toMatchObject({ status: "missing", sub: "not on this Mac" });
    expect(edge(model, "base", "cursor")!.status).toBe("ghost");
    expect(edge(model, "pack:mine", "cursor")).toBeUndefined();
  });

  it("tells a failed check and an unusable folder from one that is still running", () => {
    const summaryFor = (entryOf: (id: InstallAgent) => { status: null; loading: boolean; error: string | null }, dataFolderOk = true) => {
      const overview = overviewOf({ workspace: WORKSPACE });
      for (const id of ["codex", "claude", "cursor"] as const) overview.entries[id] = { id, ...entryOf(id) };
      return overviewSummaryModel({ overview, settings: defaultSettings(), enabledHarnessIds: ["codex", "claude", "cursor"], dataFolderOk, diagnostics: { error: null } }).cards;
    };
    const codex = (cards: AgentCardModel[]) => buildFlowModel({ cards, sources: SOURCES, personalDocs: null, lastUpdate: null }).agents.find(agent => agent.id === "codex")!;

    expect(codex(summaryFor(() => ({ status: null, loading: true, error: null })))).toMatchObject({ sub: "checking…", pillText: "Checking…", state: null });
    expect(codex(summaryFor(() => ({ status: null, loading: false, error: "boom" })))).toMatchObject({ sub: "check failed", pillText: "Couldn't check", state: "fix", decision: false });
    expect(codex(summaryFor(() => ({ status: null, loading: false, error: null }), false))).toMatchObject({ sub: "workspace folder unusable", pillText: "Folder unusable", state: "fix" });
  });

  it("says not installed while everything waits for its first install", () => {
    const fresh = cardsFor({
      codex: installationStatus("not_installed", [surfaceStatus("codex_rules", "not_installed"), surfaceStatus("skills", "not_installed")]),
      claude: installationStatus("not_installed", [surfaceStatus("claude_rules", "not_installed"), surfaceStatus("skills", "not_installed")]),
      cursor: installationStatus("not_installed", [surfaceStatus("cursor_agents", "not_installed")]),
    });
    expect(nothingInstalled(fresh)).toBe(true);
    expect(buildFlowModel({ cards: fresh, sources: SOURCES, personalDocs: null, lastUpdate: null }).agents.find(agent => agent.id === "codex")!.sub).toBe("not installed");
    expect(nothingInstalled(cardsFor(CURRENT))).toBe(false);
  });
});

describe("buildFlowModel glow from the newest update", () => {
  const cards = cardsFor(CURRENT);

  it("glows on the curves of the agents the update wrote, and nowhere else", () => {
    const model = buildFlowModel({ cards, sources: SOURCES, personalDocs: null, lastUpdate: entry() });
    expect(edge(model, "base", "claude")!.glow).toBe(true);
    expect(edge(model, "pack:mine", "claude")!.glow).toBe(true);
    expect(edge(model, "base", "codex")!.glow).toBe(false);
  });

  it("glows for an agent whose surface the update changed even if the entry names no agent", () => {
    const model = buildFlowModel({ cards, sources: SOURCES, personalDocs: null, lastUpdate: entry({ harnesses: [] }) });
    expect(edge(model, "base", "claude")!.glow).toBe(true);
  });

  it("does not glow for an update that was undone, nor on a held pack", () => {
    const undone = buildFlowModel({ cards, sources: SOURCES, personalDocs: null, lastUpdate: entry({ status: "rolled_back" }) });
    expect(undone.edges.some(candidate => candidate.glow)).toBe(false);
    const model = buildFlowModel({ cards, sources: SOURCES, personalDocs: null, lastUpdate: entry() });
    expect(edge(model, "pack:old-pack", "claude")!.glow).toBe(false);
  });
});

describe("highlight and references", () => {
  const model = buildFlowModel({ cards: cardsFor(CURRENT), sources: SOURCES, personalDocs: null, lastUpdate: null });

  it("lights a node with its curves and the nodes at their other ends", () => {
    const light = highlightOf(model, { type: "agent", id: "codex" })!;
    expect([...light.sources]).toEqual(["base", "pack:mine", "pack:old-pack"]);
    expect([...light.agents]).toEqual(["codex"]);
    expect(light.edges.has("base>codex")).toBe(true);
    const one = highlightOf(model, { type: "edge", id: "base>codex" })!;
    expect([...one.edges]).toEqual(["base>codex"]);
    expect(highlightOf(model, null)).toBeNull();
  });

  it("drops a reference to something that is gone", () => {
    expect(resolveRef(model, { type: "agent", id: "claude" })).toEqual({ type: "agent", id: "claude" });
    expect(resolveRef(model, { type: "source", id: "pack:gone" })).toBeNull();
    expect(resolveRef(model, { type: "edge", id: "pack:mine>kilo" })).toBeNull();
  });
});

describe("homePill", () => {
  const zero = { ok: 0, ready: 0, decide: 0, yours: 0, fix: 0, off: 0 };
  it("names the most urgent state that is counted", () => {
    expect(homePill({ ...zero, ok: 4, ready: 2, decide: 1 }, false)).toEqual({ state: "decide", text: "1 to decide" });
    expect(homePill({ ...zero, ok: 4, ready: 2 }, false)).toEqual({ state: "ready", text: "Update ready" });
    expect(homePill({ ...zero, ready: 3 }, true)).toEqual({ state: "ready", text: "Ready to install" });
    expect(homePill({ ...zero, ok: 4 }, false)).toEqual({ state: "ok", text: "Up to date" });
    expect(homePill(zero, false)).toBeNull();
  });
});

describe("the run", () => {
  const homes = { claude: "~/.claude", codex: "~/.codex", opencode: "~/.config/opencode", pi: "~/.pi/agent" };

  it("maps a file to the agent whose folder holds it, and a shared folder to nobody", () => {
    expect(agentForFile("~/.claude/skills/tdd/SKILL.md", homes)).toBe("claude");
    expect(agentForFile("~/.config/opencode/agents/scribe.md", homes)).toBe("opencode");
    expect(agentForFile("~/.pi/agent/AGENTS.md", homes)).toBe("pi");
    expect(agentForFile("~/.claude-other/x", homes)).toBeNull();
    expect(agentForFile("~/.agents/skills/tdd/SKILL.md", homes)).toBeNull();
  });

  it("follows the files: the current agent, the agents seen and the files counted once", () => {
    let trace = traceStep(EMPTY_TRACE, { phase: "backup", file: "~/.claude/CLAUDE.md" }, homes);
    expect(trace.current).toBeNull();
    trace = traceStep(trace, { phase: "apply", file: "~/.codex/AGENTS.md" }, homes);
    trace = traceStep(trace, { phase: "apply", file: "~/.codex/AGENTS.md" }, homes);
    expect(trace).toMatchObject({ current: "codex", seen: ["codex"], counts: { codex: 1 } });
    trace = traceStep(trace, { phase: "apply", file: "~/.claude/CLAUDE.md" }, homes);
    expect(trace).toMatchObject({ current: "claude", seen: ["codex", "claude"], counts: { codex: 1, claude: 1 } });
    expect(runChecklist(trace, ["claude", "codex", "opencode"]).map(row => [row.agent, row.state, row.files])).toEqual([
      ["claude", "current", 1],
      ["codex", "done", 1],
      ["opencode", "waiting", 0],
    ]);
    trace = traceStep(trace, { phase: "apply", file: null }, homes);
    expect(trace.current).toBeNull();
    expect(runChecklist(trace, []).every(row => row.state === "done")).toBe(true);
  });
});
