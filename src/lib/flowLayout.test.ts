import { describe, expect, it } from "vitest";
import { cubic, flowLayout, MAX_MAP_WIDTH, MIN_MAP_WIDTH } from "./flowLayout";
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
