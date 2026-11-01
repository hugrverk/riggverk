import { useMemo, useRef, type CSSProperties } from "react";
import { flowLayout } from "../lib/flowLayout";
import { BASE_SOURCE_ID, edgeId, lineWeight } from "../lib/flowModel";
import { useMotion } from "../lib/motion";
import type { PlanCurve, PlanFlow, PlanPhase } from "../lib/planFlow";
import type { InstallAgent } from "../types";
import { AgentGlyph } from "../ui/agentIcons";
import { cx } from "../ui/tone";
import { useElementWidth } from "./overview/FlowMap";
import { useFlowPulses } from "./overview/useFlowPulses";

export interface PlanFlowMapProps {
  flow: PlanFlow;
  phase: PlanPhase;
  /** The agent of the table's cursor row: its curve, chip and node are lit, the rest dimmed. */
  highlight: InstallAgent | null;
}

const CURVE_CLASS: Record<PlanCurve, string> = {
  write: "is-ready",
  kept: "is-kept",
  sync: "is-sync",
  live: "live",
  seen: "is-seen",
  written: "is-written",
};

const NODE_CLASS: Record<PlanCurve, string> = {
  write: "is-ready",
  kept: "is-decide",
  sync: "is-ok",
  live: "is-live",
  seen: "is-ready",
  written: "is-ok",
};

/** Mono 11px: about this many units per character, for the chip's backing box. */
const CHIP_CHAR = 6.7;
const BADGE_SIZE = 8;

const CAPTION: Record<PlanPhase, string> = { review: "What apply writes", applying: "Writing", done: "Result" };

/**
 * The install review's map: the Overview's flow drawn with its geometry (`flowLayout`), icons and curve classes, from
 * the base to the agents of the plan, each base curve carrying a chip with what apply writes along it. Dashed waits
 * to be written, dotted is a conflict apply keeps, solid thin is already in sync, solid ok is written; the curve being
 * written is live (travelling dots at full motion only). It is a picture of the table beside it and says nothing the
 * table does not, so it is hidden from assistive technology.
 */
export function PlanFlowMap({ flow, phase, highlight }: PlanFlowMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const width = useElementWidth(wrapRef);
  const layout = useMemo(() => flowLayout(flow.model, width), [flow.model, width]);
  const motion = useMotion();
  const live = flow.agents.find(agent => agent.curve === "live")?.id ?? null;
  useFlowPulses(svgRef, live, motion === "full", `${flow.model.edges.map(edge => edge.id).join(",")}@${layout.width}x${layout.height}`);

  const lit = highlight !== null && flow.agents.some(agent => agent.id === highlight) ? highlight : null;
  const agentCount = flow.agents.length;
  const s = layout.scale;

  return (
    <div className="plan-map" aria-hidden="true">
      <div className="plan-map-cap">
        <span>{CAPTION[phase]}</span>
        <span>
          base → {agentCount} {agentCount === 1 ? "agent" : "agents"}
        </span>
      </div>
      <div ref={wrapRef} className="plan-map-fig">
        <svg
          ref={svgRef}
          className={cx("flow-svg", "plan-svg", lit && "has-hl")}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          style={{ "--flow-scale": s } as CSSProperties}
          focusable="false"
        >
          {layout.offCurve && <path className="flow-ln is-ghost" d={layout.offCurve.d} />}
          {flow.model.edges
            .filter(edge => edge.source !== BASE_SOURCE_ID)
            .map(edge => (
              <path key={edge.id} className={cx("flow-ln", "is-quiet", lit === edge.agent && "hl")} d={layout.curves[edge.id]!.d} data-agent={edge.agent} />
            ))}
          {flow.agents.map(agent => (
            <path
              key={agent.id}
              className={cx("flow-ln", "plan-ln", CURVE_CLASS[agent.curve], lit === agent.id && "hl")}
              d={layout.curves[edgeId(BASE_SOURCE_ID, agent.id)]!.d}
              data-agent={agent.id}
              data-curve={agent.curve}
              style={{ strokeWidth: agent.curve === "sync" || agent.curve === "kept" ? 1.2 : lineWeight(agent.counts.create + agent.counts.update + agent.counts.remove) + 0.4 }}
            />
          ))}

          {flow.model.sources.map(source => {
            const y = layout.sourceY[source.id]!;
            return (
              <g key={source.id} className={cx("flow-src", `is-${source.kind}`, source.state === "fix" && "is-fix")}>
                <circle className="flow-ring" cx={layout.sourceDot} cy={y} r={3.5 * s} />
                <text className="flow-name" x={layout.labelEnd} y={y} textAnchor="end">
                  {source.label.length > 20 ? `${source.label.slice(0, 19)}…` : source.label}
                </text>
                <text className="flow-sub" x={layout.labelEnd} y={y + layout.subDy} textAnchor="end">
                  {flow.sourceSub[source.id]}
                </text>
              </g>
            );
          })}

          {flow.agents.map(agent => {
            const y = layout.agentY[agent.id]!;
            const { agentIcon: icon, iconSize: size } = layout;
            return (
              <g key={agent.id} className={cx("flow-agent", "plan-agent", NODE_CLASS[agent.curve], lit === agent.id && "hl")} data-agent={agent.id}>
                <AgentGlyph harness={agent.id} x={icon} y={y - size / 2} size={size} />
                {agent.decision && phase !== "done" ? (
                  <rect className="flow-square" x={icon + size - BADGE_SIZE / 2 - 1} y={y + size / 2 - BADGE_SIZE / 2 - 1} width={BADGE_SIZE} height={BADGE_SIZE} />
                ) : (
                  <circle className="flow-ring" cx={icon + size - 1} cy={y + size / 2 - 1} r={BADGE_SIZE / 2 - 0.5} />
                )}
                <text className="flow-name" x={layout.agentText} y={y}>
                  {agent.label}
                </text>
                <text className={cx("flow-sub", agent.curve === "written" && "is-ok")} x={layout.agentText} y={y + layout.subDy}>
                  {agent.sub}
                </text>
              </g>
            );
          })}

          {flow.model.offGroup && layout.offY !== null && (
            <g className="flow-agent flow-off-group is-off is-dim">
              <circle className="flow-ring" cx={layout.agentIcon + layout.iconSize / 2} cy={layout.offY} r={7 * s} />
              <text className="flow-name" x={layout.agentText} y={layout.offY}>
                {flow.model.offGroup.agents.length} off
              </text>
              <text className="flow-sub" x={layout.agentText} y={layout.offY + layout.subDy}>
                nothing written
              </text>
            </g>
          )}

          {flow.agents.map(agent => {
            if (!agent.chip) return null;
            const y = layout.agentY[agent.id]!;
            const right = layout.agentX - 10 * s;
            const boxWidth = (agent.chip.length * CHIP_CHAR + 12) * s;
            return (
              <g key={`chip:${agent.id}`} className={cx("plan-chip", lit === agent.id && "hl")} data-agent={agent.id}>
                <rect x={right - boxWidth} y={y - 9 * s} width={boxWidth} height={17 * s} />
                <text className={cx(agent.tone && `is-${agent.tone}`)} x={right - 6 * s} y={y + 3.8 * s} textAnchor="end">
                  {agent.chip}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <ul className="plan-legend">
        {phase !== "done" && (
          <li>
            <i className="lg-write" />
            {phase === "review" ? "will be written" : "pending"}
          </li>
        )}
        {phase === "applying" && (
          <li>
            <i className="lg-live" />
            being written
          </li>
        )}
        {phase === "done" && (
          <li>
            <i className="lg-written" />
            written
          </li>
        )}
        <li>
          <i className="lg-kept" />
          kept, skipped
        </li>
        <li>
          <i className="lg-sync" />
          already in sync
        </li>
      </ul>
    </div>
  );
}
