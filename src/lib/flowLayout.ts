import type { InstallAgent } from "../types";
import type { FlowModel } from "./flowModel";

/** Where the map's parts sit, in the SVG's own units (one unit is one CSS pixel: the viewBox is as wide as the map). */
export interface FlowLayout {
  width: number;
  height: number;
  /** Source labels end here, right-aligned; the ring of the source sits just after. */
  labelEnd: number;
  sourceDot: number;
  agentX: number;
  /** Left edge of the agent's icon (16 units wide); its state badge sits on the icon's bottom-right corner. */
  agentIcon: number;
  /** Where the agent's name and its sub-line start, clear of the icon and its badge. */
  agentText: number;
  sourceY: Record<string, number>;
  agentY: Partial<Record<InstallAgent, number>>;
  curves: Record<string, FlowCurve>;
}

export interface FlowCurve {
  d: string;
  /** Where the curve's count is drawn: the middle of a cubic with both control points at the middle x. */
  mx: number;
  my: number;
}

export const MIN_MAP_WIDTH = 420;
export const MAX_MAP_WIDTH = 760;
const AGENT_WIDTH = 176;
const LABEL_END = 148;
const AGENT_ROW = 44;
/** The icon starts this far in from the agent's left edge, and the name this far. */
export const AGENT_ICON_INSET = 4;
export const AGENT_TEXT_INSET = 32;
const PAD = 14;

/** A cubic from a source to an agent: both control points at the middle x, so every curve leaves and arrives level. */
export function cubic(x1: number, y1: number, x2: number, y2: number): FlowCurve {
  const mx = (x1 + x2) / 2;
  return { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, mx, my: (y1 + y2) / 2 };
}

function centred(count: number, row: number, height: number): number[] {
  const offset = (height - count * row) / 2;
  return Array.from({ length: count }, (_, index) => offset + row / 2 + index * row);
}

/** The positions of the map at a width. Pure, so the component memoises it on the model and the width. */
export function flowLayout(model: FlowModel, measured: number): FlowLayout {
  const width = Math.min(MAX_MAP_WIDTH, Math.max(MIN_MAP_WIDTH, Math.round(measured)));
  const sourceRow = model.sources.length > 5 ? 38 : 56;
  const height = Math.max(model.agents.length * AGENT_ROW, model.sources.length * sourceRow) + PAD * 2;
  const sourceYs = centred(model.sources.length, sourceRow, height);
  const agentYs = centred(model.agents.length, AGENT_ROW, height);
  const sourceY: Record<string, number> = {};
  model.sources.forEach((source, index) => (sourceY[source.id] = sourceYs[index]!));
  const agentY: Partial<Record<InstallAgent, number>> = {};
  model.agents.forEach((agent, index) => (agentY[agent.id] = agentYs[index]!));
  const sourceDot = LABEL_END + 12;
  const agentX = width - AGENT_WIDTH;
  const curves: Record<string, FlowCurve> = {};
  for (const edge of model.edges) {
    curves[edge.id] = cubic(sourceDot + 8, sourceY[edge.source]!, agentX, agentY[edge.agent]!);
  }
  return { width, height, labelEnd: LABEL_END, sourceDot, agentX, agentIcon: agentX + AGENT_ICON_INSET, agentText: agentX + AGENT_TEXT_INSET, sourceY, agentY, curves };
}
