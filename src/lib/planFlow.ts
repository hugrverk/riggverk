import type { InstallAgent } from "../types";
import { BASE_SOURCE_ID, edgeId, type FlowAgent, type FlowEdge, type FlowModel, type FlowSource, type RunTrace } from "./flowModel";
import { HARNESS_LABELS, HARNESS_NAV_ORDER } from "./harnessInstallation";
import { writeChip, writeCounts, writeLine, writesOf, type AgentPlan, type WriteCounts } from "./installPlan";

/**
 * The model behind the install review's map ("What apply writes"): the Overview's sources on the left, the agents of
 * the plan on the right, and on the base's curve to each agent a chip with what apply writes there. It reuses the
 * Overview's `FlowModel` shape so `flowLayout` places it; nothing here touches the DOM.
 */

export type PlanPhase = "review" | "applying" | "done";

/**
 * How the base's curve to an agent is drawn: `write` dashed (apply will write), `kept` dotted (only a conflict, which
 * apply never writes), `sync` thin and solid (nothing to write), `live` the agent being written, `written` solid in
 * the ok hue.
 */
export type PlanCurve = "write" | "kept" | "sync" | "live" | "written";

/** The hue of a chip's text; the sign and the word in it always say the same. */
export type PlanChipTone = "create" | "update" | "remove" | "conflict" | "ok" | "live";

export interface PlanFlowAgent {
  id: InstallAgent;
  label: string;
  counts: WriteCounts;
  curve: PlanCurve;
  chip: string | null;
  tone: PlanChipTone | null;
  /** The line under the agent's name. */
  sub: string;
  /** Apply skips a conflict of this agent: its node carries the filled square. */
  decision: boolean;
}

export interface PlanFlow {
  /** For `flowLayout`: the sources, the plan's agents, the curves between them and the agents that are off. */
  model: FlowModel;
  /** The plan's agents, in the model's order. */
  agents: PlanFlowAgent[];
  /** The line under each source, by source id. */
  sourceSub: Record<string, string>;
  /** Writes the plan makes in all, the shared folders included. */
  writes: number;
}

const SYNTHETIC_BASE: FlowSource = { id: BASE_SOURCE_ID, kind: "base", label: "Riggverk base", state: "ok", items: [], total: 0, notes: [] };

function flowAgent(id: InstallAgent, sub: string, decision: boolean, status: FlowAgent["status"] = "active"): FlowAgent {
  return { id, label: HARNESS_LABELS[id], status, state: null, decision, sub, pillText: "", card: null };
}

function reviewTone(counts: WriteCounts): PlanChipTone | null {
  if (writesOf(counts) === 0) return counts.conflict > 0 ? "conflict" : null;
  if (counts.create > 0) return "create";
  if (counts.update === 0 && counts.remove > 0) return "remove";
  return "update";
}

function agentState(
  id: InstallAgent,
  counts: WriteCounts,
  phase: PlanPhase,
  trace: RunTrace | null,
): Pick<PlanFlowAgent, "curve" | "chip" | "tone" | "sub"> {
  const writes = writesOf(counts);
  const kept = counts.conflict;
  if (writes === 0) {
    if (kept === 0) return { curve: "sync", chip: null, tone: null, sub: counts.manual > 0 ? writeLine(counts) : "in sync" };
    const sub = phase === "review" ? writeLine(counts) : phase === "applying" ? "skipped · untouched" : `${kept} yours, skipped`;
    const chip = phase === "review" ? writeChip(counts) : phase === "applying" ? "■ skipped" : `■ ${kept} yours`;
    return { curve: "kept", chip, tone: "conflict", sub };
  }
  if (phase === "done") {
    return { curve: "written", chip: kept > 0 ? `✓ ${writes} · ■ ${kept}` : `✓ ${writes}`, tone: "ok", sub: kept > 0 ? `in sync · ${kept} yours` : "in sync" };
  }
  if (phase === "applying") {
    const files = trace?.counts[id] ?? 0;
    const fileText = `${files} ${files === 1 ? "file" : "files"}`;
    // Without a trace (no agent folders to read files by) every agent being written counts as live.
    if (!trace || trace.current === id) return { curve: "live", chip: trace ? `${files} written` : "writing", tone: "live", sub: trace ? `writing ${fileText}…` : "writing…" };
    if (trace.seen.includes(id)) return { curve: "written", chip: `✓ ${fileText}`, tone: "ok", sub: `written · ${fileText}` };
    return { curve: "write", chip: writeChip(counts), tone: reviewTone(counts), sub: `queued · ${writeLine(counts)}` };
  }
  return { curve: "write", chip: writeChip(counts), tone: reviewTone(counts), sub: writeLine(counts) };
}

/**
 * The map of a plan. `base` is the Overview's model when the review is on the Overview: its sources and the agents
 * that are on (those with nothing in the plan say "in sync"), the agents that are off as one group. Without it (a
 * harness page) the map has the base and the plan's own agents. A plan that reaches no agent (the workspace bundle
 * alone) has no agents and the owner shows no map.
 */
export function buildPlanFlow(
  plan: AgentPlan,
  { base = null, phase, trace = null }: { base?: FlowModel | null; phase: PlanPhase; trace?: RunTrace | null },
): PlanFlow {
  const inPlan = new Set(plan.groups.map(group => group.agent).filter((agent): agent is InstallAgent => agent !== "shared"));
  const active = base && inPlan.size > 0 ? base.agents.filter(agent => agent.status === "active").map(agent => agent.id) : [];
  const ids = HARNESS_NAV_ORDER.filter(id => inPlan.has(id) || active.includes(id));
  const offIds = base && ids.length > 0
    ? HARNESS_NAV_ORDER.filter(id => !ids.includes(id) && (base.agents.some(agent => agent.id === id) || base.offGroup?.agents.some(agent => agent.id === id)))
    : [];

  const agents: PlanFlowAgent[] = ids.map(id => {
    const group = plan.groups.find(entry => entry.agent === id);
    const counts = writeCounts(group ? [...group.rows, ...group.skipped] : []);
    return { id, label: HARNESS_LABELS[id], counts, decision: counts.conflict > 0, ...agentState(id, counts, phase, trace) };
  });

  const sources = base?.sources.length ? base.sources : [SYNTHETIC_BASE];
  const edges: FlowEdge[] = [];
  for (const agent of agents) {
    edges.push({ id: edgeId(BASE_SOURCE_ID, agent.id), source: BASE_SOURCE_ID, agent: agent.id, items: [], total: writesOf(agent.counts), status: "ok", glow: false });
  }
  for (const edge of base?.edges ?? []) {
    if (edge.source !== BASE_SOURCE_ID && ids.includes(edge.agent) && sources.some(source => source.id === edge.source)) edges.push({ ...edge, glow: false });
  }

  const writes = writesOf(writeCounts(plan.rows));
  const sourceSub: Record<string, string> = {};
  for (const source of sources) {
    const items = source.total > 0 ? `${source.total} ${source.total === 1 ? "item" : "items"}` : "";
    if (source.id === BASE_SOURCE_ID) {
      const state = phase === "done" ? "in sync" : phase === "applying" ? "writing…" : `${writes} ${writes === 1 ? "write" : "writes"}`;
      sourceSub[source.id] = [items, state].filter(Boolean).join(" · ");
    } else if (source.kind === "yours") sourceSub[source.id] = [items, "untouched"].filter(Boolean).join(" · ");
    else sourceSub[source.id] = source.state === "fix" ? "held" : items || "nothing yet";
  }

  const model: FlowModel = {
    sources,
    agents: agents.map(agent => flowAgent(agent.id, agent.sub, agent.decision)),
    offGroup: offIds.length > 0 ? { agents: offIds.map(id => flowAgent(id, "off", false, "off")), edges: [] } : null,
    edges,
  };
  return { model, agents, sourceSub, writes };
}
