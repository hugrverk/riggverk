import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expandOffGroup, type FlowAgent, type FlowEdge, type FlowModel } from "../../lib/flowModel";
import { FlowMap } from "./FlowMap";

afterEach(cleanup);

function agent(id: FlowAgent["id"], label: string, status: FlowAgent["status"]): FlowAgent {
  const on = status === "active";
  return { id, label, status, state: on ? "ok" : null, decision: false, sub: on ? "4 of 4 in sync" : "off in Settings", pillText: on ? "Up to date" : "Off", card: null };
}

function edge(target: FlowAgent["id"], status: FlowEdge["status"]): FlowEdge {
  return { id: `base>${target}`, source: "base", agent: target, items: [], total: 3, status, glow: false };
}

/** Claude and Codex on, Pi and Kilo off: grouped as the model builds it. */
function grouped(): FlowModel {
  return {
    sources: [{ id: "base", kind: "base", label: "Riggverk base", state: "ok", items: [], total: 3, notes: [] }],
    agents: [agent("claude", "Claude", "active"), agent("codex", "Codex", "active")],
    offGroup: { agents: [agent("pi", "Pi", "off"), agent("kilo", "Kilo", "off")], edges: [edge("pi", "ghost"), edge("kilo", "ghost")] },
    edges: [edge("claude", "ok"), edge("codex", "ok")],
  };
}

function renderMap(model: FlowModel, room = 0) {
  const { container } = render(<FlowMap model={model} selected={null} onSelect={vi.fn()} live={null} liveFiles={0} room={room} />);
  return container.querySelector("svg.flow-svg") as SVGSVGElement;
}

describe("FlowMap: the agents that are off", () => {
  it("are one dimmed node with one ghost curve while grouped", () => {
    const svg = renderMap(grouped());
    expect(within(svg as unknown as HTMLElement).getByRole("button", { name: "2 agents off: Pi, Kilo" }).classList.contains("is-dim")).toBe(true);
    expect(svg.querySelectorAll(".flow-ln.is-ghost")).toHaveLength(1);
  });

  it("each get a dimmed row and a ghost curve of their own once expanded, after the agents that are on", () => {
    const svg = renderMap(expandOffGroup(grouped()), 2000);
    const map = within(svg as unknown as HTMLElement);
    expect(map.queryByRole("button", { name: /agents off/ })).toBeNull();
    const names = map.getAllByRole("button").map(node => node.getAttribute("aria-label"));
    expect(names).toEqual(["Riggverk base, base, 3 items", "Claude, Up to date", "Codex, Up to date", "Pi, off in Settings", "Kilo, off in Settings"]);
    expect(map.getByRole("button", { name: "Pi, off in Settings" }).classList.contains("is-dim")).toBe(true);
    expect([...svg.querySelectorAll(".flow-ln.is-ghost")].map(path => path.getAttribute("data-agent"))).toEqual(["pi", "kilo"]);
  });

  it("grows into the room it is given, and is compact without", () => {
    const compact = Number(renderMap(grouped()).getAttribute("height"));
    cleanup();
    const grown = Number(renderMap(grouped(), 600).getAttribute("height"));
    expect(grown).toBeGreaterThan(compact);
    expect(grown).toBeLessThanOrEqual(600);
  });
});
