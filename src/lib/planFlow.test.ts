import { describe, expect, it } from "vitest";
import { buildInstallReview } from "../hooks/useInstallFlow";
import type { InstallAgent, PlannedOperation, SetupPlan, SetupSurfaceId } from "../types";
import { edgeId, EMPTY_TRACE, type FlowAgent, type FlowModel, type RunTrace } from "./flowModel";
import { flowLayout } from "./flowLayout";
import { buildAgentPlan, buildPlanGroups } from "./installPlan";
import { buildPlanFlow } from "./planFlow";

function op(surface: SetupSurfaceId, kind: PlannedOperation["kind"], extra: Partial<PlannedOperation> = {}): PlannedOperation {
  return { surface, kind, summary: `${kind} ${surface}`, ...extra };
}

function agentPlanOf(operations: PlannedOperation[], synced: SetupSurfaceId[] = []) {
  const plan: SetupPlan = {
    operations,
    synced,
    conflicts: [],
    manual_steps: [],
    summary: "",
    has_pending_changes: true,
    is_blocked: false,
    plan_fingerprint: "fp",
    preview_token: "tok",
  };
  return buildAgentPlan(buildPlanGroups(buildInstallReview({ label: "update all", surfaces: operations.map(o => o.surface) }, plan)));
}

const PLAN = agentPlanOf([
  op("skills", "update", {
    details: ["+ ~/.agents/skills (3 skills, 3 files)", "- $CODEX_HOME/skills (3 skills, 3 files, owned copies)", "! ~/.cursor/skills/tdd (edited, kept)"],
  }),
  op("open_code_rules", "update"),
  op("open_code_config", "update"),
  op("claude_rules", "update"),
  op("claude_agents", "update", { details: ["+ create agents/sentinel.md", "~ update agents/verifier.md"] }),
]);

function agent(id: InstallAgent, status: FlowAgent["status"] = "active"): FlowAgent {
  return { id, label: id, status, state: null, decision: false, sub: "", pillText: "", card: null };
}

/** The Overview's model: the base and your refinements, four agents on, one off and Grok off in the group. */
const BASE: FlowModel = {
  sources: [
    { id: "base", kind: "base", label: "Riggverk base", state: "ok", items: [], total: 25, notes: [] },
    { id: "yours", kind: "yours", label: "Your refinements", state: "ok", items: [], total: 19, notes: [] },
  ],
  agents: [agent("codex"), agent("opencode"), agent("cursor"), agent("claude"), agent("pi", "missing")],
  offGroup: { agents: [agent("grok", "off")], edges: [] },
  edges: (["codex", "opencode", "cursor", "claude"] as const).map(id => ({
    id: edgeId("yours", id),
    source: "yours",
    agent: id,
    items: [],
    total: 1,
    status: "ok" as const,
    glow: false,
  })),
};

describe("buildPlanFlow", () => {
  it("puts what apply writes to each agent on the base's curve to it, the agents that are off in one group", () => {
    const flow = buildPlanFlow(PLAN, { base: BASE, phase: "review" });
    expect(flow.agents.map(entry => [entry.id, entry.chip, entry.curve, entry.sub, entry.decision])).toEqual([
      ["codex", "− 1 remove", "write", "1 remove", false],
      ["opencode", "~ 2 update", "write", "2 update", false],
      ["claude", "+ 1 · ~ 2", "write", "1 create · 2 update", false],
      ["cursor", "■ 1 kept", "kept", "1 kept, skipped", true],
    ]);
    expect(flow.model.offGroup!.agents.map(entry => entry.id)).toEqual(["pi", "grok"]);
    expect(flow.sourceSub).toEqual({ base: "25 items · 7 writes", yours: "19 items · untouched" });
    // flowLayout places it: one base curve per agent, the refinements' own curves kept.
    const layout = flowLayout(flow.model, 480);
    expect(Object.keys(layout.curves)).toEqual(expect.arrayContaining(["base>codex", "base>claude", "yours>cursor"]));
    expect(layout.offY).not.toBeNull();
  });

  it("says an agent with nothing to write is in sync", () => {
    const flow = buildPlanFlow(agentPlanOf([op("claude_rules", "update")]), { base: BASE, phase: "review" });
    expect(flow.agents.find(entry => entry.id === "codex")).toMatchObject({ curve: "sync", chip: null, sub: "in sync" });
  });

  it("shows only where the run is while it applies: the agent being written, those reached, the rest pending", () => {
    // Progress reports are rate-limited: a reached agent is not proven written, and report counts are not file counts.
    const trace: RunTrace = { ...EMPTY_TRACE, current: "claude", seen: ["opencode", "claude"], counts: { opencode: 2, claude: 1 } };
    const flow = buildPlanFlow(PLAN, { base: BASE, phase: "applying", trace });
    const state = Object.fromEntries(flow.agents.map(entry => [entry.id, [entry.curve, entry.chip, entry.sub]]));
    expect(state).toEqual({
      codex: ["write", "− 1 remove", "pending · 1 remove"],
      opencode: ["seen", "~ 2 update", "reached · 2 update"],
      cursor: ["kept", "■ skipped", "skipped · untouched"],
      claude: ["live", "writing…", "writing…"],
    });
    expect(flow.agents.some(entry => entry.curve === "written")).toBe(false);
    expect(JSON.stringify(flow.agents)).not.toMatch(/\bfiles?\b/);
    expect(flow.sourceSub.base).toBe("25 items · writing…");
    // Without a trace nothing is known yet: every agent with writes is pending.
    expect(buildPlanFlow(PLAN, { base: BASE, phase: "applying" }).agents.filter(entry => entry.curve === "write").map(entry => entry.id)).toEqual(["codex", "opencode", "claude"]);
  });

  it("shows every curve written once the apply is done, the kept conflict still the user's", () => {
    const flow = buildPlanFlow(PLAN, { base: BASE, phase: "done" });
    expect(flow.agents.map(entry => [entry.id, entry.curve, entry.chip])).toEqual([
      ["codex", "written", "✓ 1"],
      ["opencode", "written", "✓ 2"],
      ["claude", "written", "✓ 3"],
      ["cursor", "kept", "■ 1 yours"],
    ]);
    expect(flow.sourceSub.base).toBe("25 items · in sync");
  });

  describe("a pack's curves", () => {
    // A new agent and a pack: the skills lines count the bundle's skills and the pack's together, `pack_writes` names
    // the pack's share and every agent that reads each folder; an edited copy of another pack's skill is kept.
    const packPlan = agentPlanOf([
      op("skills", "update", {
        details: [
          "+ ~/.claude/skills (35 skills, 70 files)",
          "+ ~/.agents/skills (35 skills, 70 files)",
          "+ ~/.gemini/config/skills (35 skills, 70 files)",
          "! ~/.claude/skills/team-x (edited, kept)",
        ],
        pack_writes: [
          { line: 0, pack: "kretsverket", skills: 5, harnesses: ["claude", "opencode"] },
          { line: 1, pack: "kretsverket", skills: 5, harnesses: ["codex", "opencode"] },
          { line: 2, pack: "kretsverket", skills: 5, harnesses: ["antigravity"] },
          { line: 3, pack: "team", skills: 1, harnesses: ["claude"] },
        ],
      }),
    ]);
    const packSource = (name: string, total: number, state: "ok" | "fix" = "ok") =>
      ({ id: `pack:${name}`, kind: "pack" as const, label: name, state, items: [], total, notes: [] });
    const edge = (source: string, id: InstallAgent) =>
      ({ id: edgeId(source, id), source, agent: id, items: [], total: 1, status: "ok" as const, glow: false });
    const PACKS: FlowModel = {
      sources: [...BASE.sources, packSource("kretsverket", 5), packSource("team", 1), packSource("quiet", 2), packSource("broken", 1, "fix")],
      agents: [agent("codex"), agent("opencode"), agent("claude"), agent("antigravity")],
      offGroup: null,
      edges: [
        edge("yours", "claude"),
        ...(["codex", "opencode", "claude", "antigravity"] as const).map(id => edge("pack:kretsverket", id)),
        edge("pack:team", "codex"),
        edge("pack:team", "claude"),
        edge("pack:quiet", "claude"),
        edge("pack:broken", "claude"),
      ],
    };
    const curves = (phase: "review" | "applying" | "done") => buildPlanFlow(packPlan, { base: PACKS, phase }).sourceCurves;

    it("are dashed where the plan writes the pack's skills, a shared folder reaching every agent that reads it", () => {
      expect(curves("review")).toEqual({
        "yours>claude": "sync",
        "pack:kretsverket>codex": "write",
        "pack:kretsverket>opencode": "write",
        "pack:kretsverket>claude": "write",
        "pack:kretsverket>antigravity": "write",
        "pack:team>codex": "sync",
        "pack:team>claude": "kept",
        "pack:quiet>claude": "sync",
        "pack:broken>claude": "fix",
      });
      // Nothing is claimed written before the run succeeded.
      expect(curves("applying")).toEqual(curves("review"));
      expect(buildPlanFlow(packPlan, { base: PACKS, phase: "review" }).sourceSub).toMatchObject({
        "pack:kretsverket": "5 items · to write",
        "pack:team": "1 item · yours kept",
        "pack:quiet": "2 items · in sync",
        "pack:broken": "held",
        yours: "19 items · untouched",
      });
    });

    it("are written once the run succeeded, the rest in sync rather than kept", () => {
      const flow = buildPlanFlow(packPlan, { base: PACKS, phase: "done" });
      expect(Object.entries(flow.sourceCurves).filter(([, curve]) => curve === "written").map(([id]) => id)).toEqual([
        "pack:kretsverket>codex",
        "pack:kretsverket>opencode",
        "pack:kretsverket>claude",
        "pack:kretsverket>antigravity",
      ]);
      expect(flow.sourceCurves["pack:quiet>claude"]).toBe("sync");
      expect(flow.sourceCurves["yours>claude"]).toBe("sync");
      expect(flow.sourceSub).toMatchObject({ "pack:kretsverket": "5 items · written", "pack:quiet": "2 items · in sync" });
    });

    it("leave the agents' own counts alone: a shared folder's pack reach is drawn on the pack's curve only", () => {
      const flow = buildPlanFlow(packPlan, { base: PACKS, phase: "review" });
      expect(flow.agents.map(entry => [entry.id, entry.counts.create + entry.counts.update + entry.counts.remove, entry.chip])).toEqual([
        // Codex and OpenCode own no row: no chip and nothing counted, only the pack's curve reaches them.
        ["codex", 0, null],
        ["opencode", 0, null],
        ["antigravity", 1, "+ 1 create"],
        ["claude", 1, "+ 1 · ■ 1"],
      ]);
      expect(flow.sourceCurves["pack:kretsverket>codex"]).toBe("write");
      expect(flow.writes).toBe(3);
    });

    it("give an agent reached only through a shared folder the pack curve's state, not in sync", () => {
      const node = (phase: "review" | "applying" | "done") => {
        const entry = buildPlanFlow(packPlan, { base: PACKS, phase, trace: phase === "applying" ? EMPTY_TRACE : null }).agents.find(a => a.id === "codex")!;
        return [entry.curve, entry.chip, entry.tone, entry.sub];
      };
      expect(node("review")).toEqual(["write", null, null, "to write"]);
      expect(node("applying")).toEqual(["write", null, null, "writing…"]);
      expect(node("done")).toEqual(["written", null, null, "written"]);
      expect(buildPlanFlow(packPlan, { base: PACKS, phase: "done" }).model.agents.find(a => a.id === "codex")!.sub).toBe("written");
    });

    // A disabled pack skill: the backend gives its copies a `-` line of their own, naming the pack, after the folders' `+` lines.
    const REMOVE_LINE = "- ~/.agents/skills/kv-old (1 file; disabled)";
    const removeOn = (line: number) => ({ line, pack: "kretsverket", skills: 1, harnesses: ["codex", "opencode"] as InstallAgent[] });

    it("say a pack whose rows only remove copies removes them, drawn like a write", () => {
      const plan = agentPlanOf([op("skills", "update", { details: [REMOVE_LINE], pack_writes: [removeOn(0)] })]);
      for (const [phase, word] of [["review", "to remove"], ["applying", "removing…"], ["done", "removed"]] as const) {
        const flow = buildPlanFlow(plan, { base: PACKS, phase, trace: phase === "applying" ? EMPTY_TRACE : null });
        expect(flow.sourceCurves["pack:kretsverket>codex"]).toBe(phase === "done" ? "written" : "write");
        expect(flow.sourceSub["pack:kretsverket"]).toBe(`5 items · ${word}`);
        expect(flow.agents.find(a => a.id === "codex")).toMatchObject({ curve: phase === "done" ? "written" : "write", chip: null, sub: word });
      }
    });

    it("keep the write wording when the same pack creates and removes at the same agent", () => {
      const plan = agentPlanOf([
        op("skills", "update", {
          details: ["+ ~/.agents/skills (6 skills, 6 files)", REMOVE_LINE],
          pack_writes: [{ line: 0, pack: "kretsverket", skills: 5, harnesses: ["codex", "opencode"] }, removeOn(1)],
        }),
      ]);
      const flow = buildPlanFlow(plan, { base: PACKS, phase: "review" });
      expect(flow.sourceCurves["pack:kretsverket>codex"]).toBe("write");
      expect(flow.sourceSub["pack:kretsverket"]).toBe("5 items · to write");
      expect(flow.agents.find(a => a.id === "codex")).toMatchObject({ curve: "write", chip: null, sub: "to write" });
    });

    it("say kept when the skills operation as a whole is a conflict naming the pack", () => {
      const conflictPlan = agentPlanOf([
        op("skills", "conflict", {
          conflict_description: "~/.claude/skills/team-x was edited",
          details: ["! ~/.claude/skills/team-x (edited, kept)"],
          pack_writes: [{ line: 0, pack: "team", skills: 1, harnesses: ["claude"] }],
        }),
        op("claude_rules", "update"),
      ]);
      expect(conflictPlan.conflicts.map(row => row.packs.map(write => write.pack))).toEqual([["team"]]);
      expect(buildPlanFlow(conflictPlan, { base: PACKS, phase: "review" }).sourceCurves["pack:team>claude"]).toBe("kept");
    });
  });

  it("keeps a harness page's counts to the agent's own rows when a shared row carries its pack skills", () => {
    const details = ["+ ~/.agents/skills (35 skills, 70 files)", "- $CODEX_HOME/skills (3 skills, 3 files, owned copies)"];
    const without = buildPlanFlow(agentPlanOf([op("skills", "update", { details })]), { phase: "review" });
    const withPacks = buildPlanFlow(
      agentPlanOf([op("skills", "update", { details, pack_writes: [{ line: 0, pack: "kretsverket", skills: 5, harnesses: ["codex"] }] })]),
      { phase: "review" },
    );
    expect(withPacks.agents.map(entry => [entry.id, entry.counts, entry.chip, entry.sub])).toEqual(
      without.agents.map(entry => [entry.id, entry.counts, entry.chip, entry.sub]),
    );
    expect(withPacks.agents.map(entry => [entry.id, entry.chip])).toEqual([["codex", "− 1 remove"]]);
  });

  it("draws only the plan's own agents from the base without the Overview's model, and none for the workspace bundle", () => {
    const flow = buildPlanFlow(agentPlanOf([op("claude_rules", "update")]), { phase: "review" });
    expect(flow.model.sources.map(source => source.label)).toEqual(["Riggverk base"]);
    expect(flow.agents.map(entry => entry.id)).toEqual(["claude"]);
    expect(flow.model.offGroup).toBeNull();
    expect(buildPlanFlow(agentPlanOf([op("workspace_bundle", "update")]), { base: BASE, phase: "review" }).agents).toEqual([]);
  });
});
