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
    details: ["+ ~/.agents/skills (3 skills, 3 files)", "- $CODEX_HOME/skills (3 skills, owned copies)", "! ~/.cursor/skills/tdd (edited, kept)"],
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
      ["cursor", "■ 1 kept", "kept", "1 kept, skipped", true],
      ["claude", "+ 1 · ~ 2", "write", "1 create · 2 update", false],
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

  it("draws the curves solid agent by agent as the run's trace reaches them", () => {
    const trace: RunTrace = { ...EMPTY_TRACE, current: "claude", seen: ["opencode", "claude"], counts: { opencode: 2, claude: 1 } };
    const flow = buildPlanFlow(PLAN, { base: BASE, phase: "applying", trace });
    const state = Object.fromEntries(flow.agents.map(entry => [entry.id, [entry.curve, entry.chip]]));
    expect(state).toEqual({
      codex: ["write", "− 1 remove"],
      opencode: ["written", "✓ 2 files"],
      cursor: ["kept", "■ skipped"],
      claude: ["live", "1 written"],
    });
    expect(flow.sourceSub.base).toBe("25 items · writing…");
  });

  it("shows every curve written once the apply is done, the kept conflict still the user's", () => {
    const flow = buildPlanFlow(PLAN, { base: BASE, phase: "done" });
    expect(flow.agents.map(entry => [entry.id, entry.curve, entry.chip])).toEqual([
      ["codex", "written", "✓ 1"],
      ["opencode", "written", "✓ 2"],
      ["cursor", "kept", "■ 1 yours"],
      ["claude", "written", "✓ 3"],
    ]);
    expect(flow.sourceSub.base).toBe("25 items · in sync");
  });

  it("draws only the plan's own agents from the base without the Overview's model, and none for the workspace bundle", () => {
    const flow = buildPlanFlow(agentPlanOf([op("claude_rules", "update")]), { phase: "review" });
    expect(flow.model.sources.map(source => source.label)).toEqual(["Riggverk base"]);
    expect(flow.agents.map(entry => entry.id)).toEqual(["claude"]);
    expect(flow.model.offGroup).toBeNull();
    expect(buildPlanFlow(agentPlanOf([op("workspace_bundle", "update")]), { base: BASE, phase: "review" }).agents).toEqual([]);
  });
});
