import { useEffect, type RefObject } from "react";
import type { InstallAgent } from "../../types";

const SVG_NS = "http://www.w3.org/2000/svg";
/** One trip along a curve, in milliseconds. */
const TRIP_MS = 1100;

/**
 * Dots that travel along the curves of one agent while a run writes its files. Only while `enabled` (full motion) and
 * an agent is live; the loop runs on `requestAnimationFrame` and is cancelled, with its dots removed, when the agent
 * changes, the run ends, motion is reduced or the map unmounts. Nothing loops while the page is idle.
 */
export function useFlowPulses(svgRef: RefObject<SVGSVGElement | null>, agent: InstallAgent | null, enabled: boolean, signature: string): void {
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !agent || !enabled) return;
    const paths = [...svg.querySelectorAll<SVGPathElement>(`.flow-ln[data-agent="${agent}"]:not(.is-ghost)`)].filter(path => typeof path.getTotalLength === "function");
    if (paths.length === 0) return;
    const lengths = paths.map(path => path.getTotalLength());
    const dots = paths.map(() => {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("r", "2.5");
      dot.setAttribute("class", "flow-pulse");
      svg.appendChild(dot);
      return dot;
    });
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      paths.forEach((path, index) => {
        const along = (((now - start) / TRIP_MS) + index * 0.37) % 1;
        const point = path.getPointAtLength(along * lengths[index]!);
        dots[index]!.setAttribute("cx", String(point.x));
        dots[index]!.setAttribute("cy", String(point.y));
        dots[index]!.setAttribute("opacity", Math.sin(Math.PI * along).toFixed(2));
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const dot of dots) dot.remove();
    };
  }, [svgRef, agent, enabled, signature]);
}
