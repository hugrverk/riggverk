import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { flowLayout } from "../../lib/flowLayout";
import {
  highlightOf,
  lineWeight,
  resolveRef,
  sameRef,
  type FlowAgent,
  type FlowEdge,
  type FlowModel,
  type FlowRef,
  type FlowSource,
} from "../../lib/flowModel";
import { useMotion } from "../../lib/motion";
import type { InstallAgent } from "../../types";
import { cx } from "../../ui/tone";
import { useFlowPulses } from "./useFlowPulses";

export interface FlowMapProps {
  model: FlowModel;
  selected: FlowRef | null;
  /** A click or Enter on a node or a curve; the owner toggles the selection. */
  onSelect: (ref: FlowRef) => void;
  /** The agent whose file the running task is writing, and how many files of it are written so far. */
  live: InstallAgent | null;
  liveFiles: number;
}

const FALLBACK_WIDTH = 480;
const AGENT_HIT_WIDTH = 176;

/** The width of an element, kept current. Without a ResizeObserver (a test renderer) it stays at the fallback. */
function useElementWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const next = element.getBoundingClientRect().width;
      if (next > 0) setWidth(next);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sourceDescription(source: FlowSource): string {
  const kind = source.kind === "pack" ? "skill pack" : source.kind === "base" ? "base" : "yours";
  const total = source.total > 0 ? `, ${source.total} ${source.total === 1 ? "item" : "items"}` : "";
  return `${source.label}, ${kind}${total}${source.state === "fix" ? ", held" : ""}`;
}

function keyActivates(event: KeyboardEvent, activate: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    activate();
  }
}

/**
 * Sources on the left, the agents on the right, a cubic curve from each source to each agent it reaches. At rest the
 * curves already say something: their weight is the number of items that flow, a dashed one waits for an update, a
 * faint glow marks the agents the newest update wrote to. Hover or focus lights a node with its curves and puts the
 * counts on them; Enter or a click selects (the inspector then shows it); curves draw in once, when the map first
 * appears. The agent a run is writing is marked live and gets travelling dots. Nodes are real tab stops with
 * `role="button"`; the curves are for the pointer, and everything they say is in the inspector of their two ends.
 */
export function FlowMap({ model, selected, onSelect, live, liveFiles }: FlowMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const width = useElementWidth(wrapRef);
  const layout = useMemo(() => flowLayout(model, width), [model, width]);
  const motion = useMotion();
  // Curves draw in when the map first appears and not on later renders: decided once.
  const [intro] = useState(() => motion === "full");
  const [pointed, setPointed] = useState<FlowRef | null>(null);
  const [focused, setFocused] = useState<FlowRef | null>(null);

  const current = useMemo(() => resolveRef(model, selected), [model, selected]);
  const active = resolveRef(model, pointed) ?? resolveRef(model, focused) ?? current;
  const highlight = useMemo(() => highlightOf(model, active), [model, active]);

  const pulseSignature = model.edges.map(edge => edge.id).join(",") + `@${layout.width}`;
  useFlowPulses(svgRef, live, motion === "full", pulseSignature);

  const bind = (ref: FlowRef) => ({
    onMouseEnter: () => setPointed(ref),
    onMouseLeave: () => setPointed(null),
    onClick: () => onSelect(ref),
  });
  const bindNode = (ref: FlowRef) => ({
    ...bind(ref),
    tabIndex: 0,
    role: "button" as const,
    "aria-pressed": sameRef(current, ref),
    onFocus: () => setFocused(ref),
    onBlur: () => setFocused(null),
    onKeyDown: (event: KeyboardEvent) => keyActivates(event, () => onSelect(ref)),
  });

  const edgeClass = (edge: FlowEdge) =>
    cx(
      "flow-ln",
      `is-${edge.status}`,
      edge.glow && "has-glow",
      intro && edge.status === "ok" && "draw",
      live === edge.agent && edge.status !== "ghost" && "live",
      highlight?.edges.has(edge.id) && "hl",
      current?.type === "edge" && current.id === edge.id && "sel",
    );

  const countedEdges = highlight ? model.edges.filter(edge => highlight.edges.has(edge.id) && edge.status !== "ghost") : [];

  return (
    <div className="flow-map" ref={wrapRef} data-hl={highlight ? "" : undefined}>
      <svg
        ref={svgRef}
        className={cx("flow-svg", highlight && "has-hl")}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="group"
        aria-label="What flows from each source to each agent"
      >
        {model.edges.map(edge => edge.glow && <path key={`glow:${edge.id}`} className="flow-glow" d={layout.curves[edge.id]!.d} />)}
        {model.edges.map((edge, index) => (
          <path
            key={edge.id}
            className={edgeClass(edge)}
            d={layout.curves[edge.id]!.d}
            data-source={edge.source}
            data-agent={edge.agent}
            pathLength={intro && edge.status === "ok" ? 1 : undefined}
            style={{ strokeWidth: lineWeight(edge.total), "--i": Math.min(index, 30) } as CSSProperties}
          />
        ))}
        {model.edges
          .filter(edge => edge.status !== "ghost")
          .map(edge => (
            <path key={`hit:${edge.id}`} className="flow-hit" d={layout.curves[edge.id]!.d} aria-hidden="true" {...bind({ type: "edge", id: edge.id })}>
              <title>{`${edge.source} → ${edge.agent}`}</title>
            </path>
          ))}

        {model.sources.map(source => {
          const y = layout.sourceY[source.id]!;
          const ref: FlowRef = { type: "source", id: source.id };
          return (
            <g
              key={source.id}
              className={cx("flow-src", `is-${source.kind}`, source.state === "fix" && "is-fix", highlight?.sources.has(source.id) && "hl", sameRef(current, ref) && "sel")}
              aria-label={sourceDescription(source)}
              {...bindNode(ref)}
            >
              <rect className="flow-node-hit" x={0} y={y - 19} width={layout.sourceDot + 14} height={38} />
              <circle className="flow-ring" cx={layout.sourceDot} cy={y} r={3.5} />
              <text className="flow-name" x={layout.labelEnd} y={y} textAnchor="end">
                {truncate(source.label, 20)}
              </text>
              <text className="flow-sub" x={layout.labelEnd} y={y + 14} textAnchor="end">
                {source.state === "fix" ? "held" : source.total > 0 ? `${source.total} ${source.total === 1 ? "item" : "items"}` : "nothing yet"}
              </text>
            </g>
          );
        })}

        {model.agents.map(agent => (
          <AgentNode
            key={agent.id}
            agent={agent}
            y={layout.agentY[agent.id]!}
            x={layout.agentX}
            marker={layout.agentMarker}
            live={live === agent.id}
            liveFiles={liveFiles}
            highlighted={!!highlight?.agents.has(agent.id)}
            selected={sameRef(current, { type: "agent", id: agent.id })}
            props={bindNode({ type: "agent", id: agent.id })}
          />
        ))}

        {countedEdges.map(edge => (
          <text key={`cnt:${edge.id}`} className="flow-cnt" x={layout.curves[edge.id]!.mx} y={layout.curves[edge.id]!.my + 3.5} textAnchor="middle">
            {edge.total}
          </text>
        ))}
      </svg>
    </div>
  );
}

function AgentNode({
  agent,
  x,
  y,
  marker,
  live,
  liveFiles,
  highlighted,
  selected,
  props,
}: {
  agent: FlowAgent;
  x: number;
  y: number;
  marker: number;
  live: boolean;
  liveFiles: number;
  highlighted: boolean;
  selected: boolean;
  props: object;
}) {
  const state = agent.status === "active" ? (agent.state ?? "off") : agent.status;
  const sub = live ? `writing ${liveFiles} ${liveFiles === 1 ? "file" : "files"}` : agent.sub;
  return (
    <g
      className={cx("flow-agent", `is-${state}`, agent.status !== "active" && "is-dim", live && "is-live", highlighted && "hl", selected && "sel")}
      aria-label={`${agent.label}, ${agent.status === "active" ? agent.pillText : agent.sub}`}
      {...props}
    >
      <rect className="flow-node-hit" x={x} y={y - 19} width={AGENT_HIT_WIDTH} height={38} />
      {agent.decision ? (
        <rect className="flow-square" x={marker - 4.5} y={y - 4.5} width={9} height={9} />
      ) : (
        <circle className="flow-ring" cx={marker} cy={y} r={4.5} />
      )}
      <text className="flow-name" x={x + 24} y={y}>
        {agent.label}
      </text>
      <text className="flow-sub" x={x + 24} y={y + 14}>
        {sub}
      </text>
    </g>
  );
}
