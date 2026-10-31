import type { InstallAgent } from "../types";
import type { FlowModel } from "./flowModel";

/** Where the map's parts sit, in the SVG's own units (one unit is one CSS pixel: the viewBox is as wide as the map). */
export interface FlowLayout {
  width: number;
  height: number;
  /** How much the nodes and their text are enlarged on a large map: 1 up to the old fixed size, at most `MAX_SCALE`. */
  scale: number;
  /** Source labels end here, right-aligned; the ring of the source sits just after. */
  labelEnd: number;
  sourceDot: number;
  agentX: number;
  /** The agent column's width: the hit area of an agent node. */
  agentWidth: number;
  /** Left edge of the agent's icon (`iconSize` units wide); its state badge sits on the icon's bottom-right corner. */
  agentIcon: number;
  /** Where the agent's name and its sub-line start, clear of the icon and its badge. */
  agentText: number;
  iconSize: number;
  /** The sub-line's baseline below the name's. */
  subDy: number;
  /** The height of a node's hit area, centred on its row. */
  hitHeight: number;
  sourceY: Record<string, number>;
  agentY: Partial<Record<InstallAgent, number>>;
  curves: Record<string, FlowCurve>;
  offY: number | null;
  offCurve: FlowCurve | null;
}

export interface FlowCurve {
  d: string;
  /** Where the curve's count is drawn: the middle of a cubic with both control points at the middle x. */
  mx: number;
  my: number;
}

export const MIN_MAP_WIDTH = 420;
/** Past this the map stops growing wider: the page's own maximum width keeps it well below in practice. */
export const MAX_MAP_WIDTH = 1600;
/** The width the map used to stop at; its text and nodes are enlarged only past it. */
const BASE_WIDTH = 760;
/** The most the text and the nodes are enlarged, however much room there is. */
export const MAX_SCALE = 1.25;
const AGENT_WIDTH = 176;
const LABEL_END = 148;
/** An agent row at its tightest, and at its widest when the map has height to spare. */
export const AGENT_ROW = 44;
const AGENT_ROW_MAX = 112;
const SOURCE_ROW_MAX = 140;
/**
 * The least room per agent row at which the agents that are off get rows of their own: a name, its sub-line and a clear
 * gap. It is above `AGENT_ROW`, so the rows only open up when they would not be packed tight.
 */
export const OFF_ROW_MIN = 52;
/** The icon starts this far in from the agent's left edge, and the name this far (at scale 1). */
export const AGENT_ICON_INSET = 4;
export const AGENT_TEXT_INSET = 32;
const ICON_SIZE = 16;
const SUB_DY = 14;
const HIT_HEIGHT = 38;
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

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** A source row at its tightest: closer when there are many packs. */
const sourceRow = (count: number): number => (count > 5 ? 38 : 56);

/**
 * Whether the agents that are off get dimmed rows of their own (`expandOffGroup`) instead of the one "N off" node: only
 * when the map's room, the height it may take without pushing the cells below it out of view, gives every agent row,
 * theirs included, at least `OFF_ROW_MIN` units and still holds the sources. With less room, or a room of 0 (not
 * measured, or the inspector sits under the map), they stay grouped.
 */
export function offRowsFit(model: FlowModel, room: number): boolean {
  if (!model.offGroup) return false;
  const rows = model.agents.length + model.offGroup.agents.length;
  const sources = model.sources.length * sourceRow(model.sources.length);
  return room >= Math.max(rows * OFF_ROW_MIN, sources) + PAD * 2;
}

/**
 * The positions of the map at a width, in a room of a height (0: no room to grow into). Without room to spare the map
 * is as tall as its taller column needs; with room it grows into it, its rows opening up to `AGENT_ROW_MAX`, and its
 * text and nodes are enlarged with the width and the rows, to at most `MAX_SCALE`. Pure, so the component memoises it.
 */
export function flowLayout(model: FlowModel, measured: number, room = 0): FlowLayout {
  const width = clamp(Math.round(measured), MIN_MAP_WIDTH, MAX_MAP_WIDTH);
  const agentCount = model.agents.length + (model.offGroup ? 1 : 0);
  const sourceCount = model.sources.length;
  const sourceMin = sourceRow(sourceCount);
  const compact = Math.max(agentCount * AGENT_ROW, sourceCount * sourceMin);
  // The height the room has beyond the compact map, shared out over the rows of each column; none, and it is compact.
  const spare = Math.max(0, room - PAD * 2 - compact);
  const agentRow = agentCount ? Math.floor(Math.min(AGENT_ROW_MAX, AGENT_ROW + spare / agentCount)) : AGENT_ROW;
  const sourcePitch = sourceCount ? Math.floor(Math.min(SOURCE_ROW_MAX, sourceMin + spare / sourceCount)) : sourceMin;
  const height = Math.max(agentCount * agentRow, sourceCount * sourcePitch) + PAD * 2;
  const scale = Math.round(clamp(Math.min(width / BASE_WIDTH, agentRow / AGENT_ROW), 1, MAX_SCALE) * 100) / 100;
  const s = (value: number) => Math.round(value * scale * 10) / 10;

  const sourceYs = centred(sourceCount, sourcePitch, height);
  const agentYs = centred(agentCount, agentRow, height);
  const sourceY: Record<string, number> = {};
  model.sources.forEach((source, index) => (sourceY[source.id] = sourceYs[index]!));
  const agentY: Partial<Record<InstallAgent, number>> = {};
  model.agents.forEach((agent, index) => (agentY[agent.id] = agentYs[index]!));
  const labelEnd = s(LABEL_END);
  const sourceDot = labelEnd + s(12);
  const curveStart = sourceDot + s(8);
  const agentWidth = s(AGENT_WIDTH);
  const agentX = width - agentWidth;
  const curves: Record<string, FlowCurve> = {};
  for (const edge of model.edges) {
    curves[edge.id] = cubic(curveStart, sourceY[edge.source]!, agentX, agentY[edge.agent]!);
  }
  const offY = model.offGroup ? agentYs[model.agents.length]! : null;
  const offCurve = offY !== null ? cubic(curveStart, sourceY.base!, agentX, offY) : null;
  return {
    offY,
    offCurve,
    width,
    height,
    scale,
    labelEnd,
    sourceDot,
    agentX,
    agentWidth,
    agentIcon: agentX + s(AGENT_ICON_INSET),
    agentText: agentX + s(AGENT_TEXT_INSET),
    iconSize: s(ICON_SIZE),
    subDy: s(SUB_DY),
    hitHeight: s(HIT_HEIGHT),
    sourceY,
    agentY,
    curves,
  };
}
