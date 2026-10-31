import { describe, expect, it } from "vitest";
import { AGENT_ROW, cubic, flowLayout, MAX_MAP_WIDTH, MAX_SCALE, MIN_MAP_WIDTH, OFF_ROW_MIN, offRowsFit } from "./flowLayout";
import { expandOffGroup } from "./flowModel";
import type { FlowAgent, FlowEdge, FlowModel, FlowSource } from "./flowModel";

function model(sourceCount: number, edges: Array<[string, string]> = []): FlowModel {
  const ids = ["codex", "opencode", "cursor", "claude", "copilot", "pi", "kilo"] as const;
  const sources = Array.from({ length: sourceCount }, (_, index): FlowSource => ({
    id: `s${index}`,
    kind: "pack",
    label: `s${index}`,
    state: "ok",
    items: [],
    total: 1,
    notes: [],
  }));
  const agents = ids.map((id): FlowAgent => ({ id, label: id, status: "active", state: "ok", decision: false, sub: "", pillText: "", card: null }));
  return {
    sources,
    agents,
    offGroup: null,
    edges: edges.map(([source, agent]): FlowEdge => ({ id: `${source}>${agent}`, source, agent: agent as FlowAgent["id"], items: [], total: 1, status: "ok", glow: false })),
  };
}

describe("flowLayout", () => {
  it("starts an agent's name clear of its 16 unit icon and the badge on the icon's corner", () => {
    const layout = flowLayout(model(2), 600);
    expect(layout.agentIcon).toBe(layout.agentX + 4);
    expect(layout.agentText).toBeGreaterThanOrEqual(layout.agentIcon + 16 + 4);
    expect(layout.agentText).toBeLessThan(layout.agentX + 176);
  });

  it("clamps the width, so a very narrow or very wide map keeps its proportions", () => {
    expect(flowLayout(model(1), 100).width).toBe(MIN_MAP_WIDTH);
    expect(flowLayout(model(1), 5000).width).toBe(MAX_MAP_WIDTH);
    expect(flowLayout(model(1), 600).width).toBe(600);
  });

  it("puts every agent in its own row, in order, and centres the sources against them", () => {
    const layout = flowLayout(model(2), 600);
    const ys = ["codex", "opencode", "cursor", "claude", "copilot", "pi", "kilo"].map(id => layout.agentY[id as "codex"]!);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(7);
    const middle = (ys[0]! + ys[6]!) / 2;
    expect((layout.sourceY.s0! + layout.sourceY.s1!) / 2).toBeCloseTo(middle, 5);
  });

  it("uses one last row and one base curve for the off group", () => {
    const input = model(1);
    input.sources[0]!.id = "base";
    input.offGroup = { agents: input.agents.slice(2), edges: [] };
    input.agents = input.agents.slice(0, 2);
    const layout = flowLayout(input, 600);
    expect(layout.height).toBe(160);
    expect(layout.offY).toBe(124);
    expect(layout.offCurve!.d).toMatch(`M${layout.sourceDot + 8},${layout.sourceY.base}`);
    expect(layout.offCurve!.d.endsWith(`${layout.agentX},124`)).toBe(true);
    input.offGroup = null;
    expect(flowLayout(input, 600).height).toBe(116);
    expect(flowLayout(input, 600).offCurve).toBeNull();
  });

  it("grows only as far as the taller column needs", () => {
    expect(flowLayout(model(2), 600).height).toBeLessThan(flowLayout(model(12), 600).height);
  });

  it("is the same object-shape every time for the same input, so it can be memoised", () => {
    const input = model(3, [["s0", "codex"], ["s1", "claude"]]);
    expect(flowLayout(input, 640)).toEqual(flowLayout(input, 640));
  });

  it("draws a curve from the source dot to the agent's column, with its count at the middle of the curve", () => {
    const input = model(2, [["s0", "claude"]]);
    const layout = flowLayout(input, 600);
    const curve = layout.curves["s0>claude"]!;
    expect(curve.d.startsWith(`M${layout.sourceDot + 8},${layout.sourceY.s0}`)).toBe(true);
    expect(curve.d.endsWith(`${layout.agentX},${layout.agentY.claude}`)).toBe(true);
    expect(curve.my).toBeCloseTo((layout.sourceY.s0! + layout.agentY.claude!) / 2, 5);
  });

  it("puts the middle of a cubic with level ends at the average of its ends", () => {
    expect(cubic(0, 10, 100, 50)).toMatchObject({ mx: 50, my: 30 });
  });
});


/** Two agents on, five off in one group, and a ghost curve kept aside for each of the five. */
function grouped(sourceCount = 1): FlowModel {
  const input = model(sourceCount);
  input.sources[0]!.id = "base";
  const off = input.agents.slice(2).map(agent => ({ ...agent, status: "off" as const, state: null, sub: "off in Settings" }));
  input.agents = input.agents.slice(0, 2);
  input.offGroup = {
    agents: off,
    edges: off.map((agent): FlowEdge => ({ id: `base>${agent.id}`, source: "base", agent: agent.id, items: [], total: 1, status: "ghost", glow: false })),
  };
  return input;
}

describe("offRowsFit: the agents that are off get rows of their own only with the room for them", () => {
  // Seven rows once expanded, at OFF_ROW_MIN each, plus the padding above and below.
  const threshold = 7 * OFF_ROW_MIN + 28;

  it("expands from the height where every row gets OFF_ROW_MIN, and not a unit below", () => {
    expect(offRowsFit(grouped(), threshold)).toBe(true);
    expect(offRowsFit(grouped(), threshold - 1)).toBe(false);
  });

  it("keeps the group when the room is not measured, or the inspector sits under the map", () => {
    expect(offRowsFit(grouped(), 0)).toBe(false);
  });

  it("asks more room than the expanded map packs into, so opening the rows never packs them tight", () => {
    expect(OFF_ROW_MIN).toBeGreaterThan(AGENT_ROW);
    const expanded = flowLayout(expandOffGroup(grouped()), 600, threshold);
    expect(expanded.offY).toBeNull();
    expect(expanded.height).toBeLessThanOrEqual(threshold);
    const ys = expanded.agentY;
    expect(ys.cursor! - ys.opencode!).toBeGreaterThanOrEqual(OFF_ROW_MIN);
  });

  it("also needs the room for the sources when they are the taller column", () => {
    const many = grouped(12);
    expect(offRowsFit(many, threshold)).toBe(false);
    expect(offRowsFit(many, 12 * 38 + 28)).toBe(true);
  });

  it("has nothing to expand without a group", () => {
    expect(offRowsFit(model(2), 5000)).toBe(false);
  });
});

describe("flowLayout in a room", () => {
  it("is exactly the compact map without room to spare", () => {
    const input = grouped(2);
    const compact = flowLayout(input, 600);
    expect(flowLayout(input, 600, compact.height)).toEqual(compact);
    expect(flowLayout(input, 600, 100)).toEqual(compact);
    expect(compact.scale).toBe(1);
    expect(compact.agentY.opencode! - compact.agentY.codex!).toBe(AGENT_ROW);
  });

  it("grows into the room, never past it, and opens the rows evenly", () => {
    const input = expandOffGroup(grouped(5));
    const layout = flowLayout(input, 1200, 800);
    expect(layout.height).toBeGreaterThan(flowLayout(input, 1200).height);
    expect(layout.height).toBeLessThanOrEqual(800);
    const ys = ["codex", "opencode", "cursor", "claude", "copilot", "pi", "kilo"].map(id => layout.agentY[id as "codex"]!);
    const gaps = ys.slice(1).map((y, index) => y - ys[index]!);
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]!).toBeGreaterThan(AGENT_ROW);
  });

  it("stops opening the rows at a sensible height, however tall the room", () => {
    const layout = flowLayout(expandOffGroup(grouped(5)), 1200, 20000);
    expect(layout.height).toBeLessThan(1200);
  });

  it("enlarges the text and the nodes with the width and the rows, but no more than MAX_SCALE", () => {
    const input = expandOffGroup(grouped(5));
    expect(flowLayout(input, 700, 20000).scale).toBe(1);
    expect(flowLayout(input, 1600, 0).scale).toBe(1);
    const large = flowLayout(input, 1600, 20000);
    expect(large.scale).toBe(MAX_SCALE);
    expect(large.iconSize).toBe(16 * MAX_SCALE);
    expect(large.agentText).toBeGreaterThanOrEqual(large.agentIcon + large.iconSize + 4);
    expect(large.agentX + large.agentWidth).toBe(large.width);
  });
});
