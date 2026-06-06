import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ActivityLegendEntry, LineChartSeries } from "./model";
import {
  ACTIVITY_BLUE,
  ACTIVITY_GREEN,
  buildHeatmapMonthLabels,
  buildHeatmapWeeks,
  computeHeatmapCellSizePx,
  HEATMAP_DISPLAY_WEEKS,
  sliceHeatmapCellsToWindow,
} from "./model";

interface ActivityLineChartProps {
  data: LineChartSeries;
  legend?: ActivityLegendEntry[];
}

export function ActivityLineChart({ data, legend = [] }: ActivityLineChartProps) {
  const { days, primary, secondary, totals } = data;
  const w = 820;
  const h = 180;
  const L = 38;
  const R = 36;
  const T = 14;
  const B = 36;
  const max = Math.max(1, ...primary, ...secondary);
  const x = (i: number) =>
    days.length === 1 ? L + (w - L - R) / 2 : L + (i * (w - L - R)) / (days.length - 1);
  const y = (v: number) => T + ((max - v) * (h - T - B)) / max;

  const path = (series: number[]) =>
    series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const every = Math.max(1, Math.ceil(days.length / 7));
  const gridValues = [0, Math.ceil(max / 2), max].filter((v, i, arr) => arr.indexOf(v) === i);

  return (
    <div className="repo-dashboard-chart">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
        overflow="visible"
        role="img"
        aria-label="Cumulative activity chart"
      >
        {gridValues.map(v => (
          <g key={v}>
            <line className="repo-dashboard-gridline" x1={L} y1={y(v)} x2={w - R} y2={y(v)} />
            <text className="repo-dashboard-chart-text" x={8} y={y(v) + 3}>
              {v}
            </text>
          </g>
        ))}
        <line className="repo-dashboard-axis" x1={L} y1={h - B} x2={w - R} y2={h - B} />
        <line className="repo-dashboard-axis" x1={L} y1={T} x2={L} y2={h - B} />
        <path className="repo-dashboard-series-blue" d={path(primary)} />
        <path className="repo-dashboard-series-green" d={path(secondary)} />
        {days.map((day, i) =>
          i % every === 0 || i === days.length - 1 ? (
            <text
              key={day}
              className="repo-dashboard-chart-text"
              x={x(i)}
              y={h - 7}
              textAnchor="middle"
            >
              {day.slice(2)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="repo-dashboard-legend font-mono">
        {legend[0] ? (
          <span className="repo-dashboard-blue">
            <i /> {legend[0].label} ({legend[0].commits} commits, cumulative {totals.primary})
          </span>
        ) : (
          <span className="repo-dashboard-blue">
            <i /> Primary author {totals.primary}
          </span>
        )}
        {legend[1] ? (
          <span className="repo-dashboard-green">
            <i /> {legend[1].label} ({legend[1].commits} commits, cumulative {totals.secondary})
          </span>
        ) : totals.secondary > 0 ? (
          <span className="repo-dashboard-green">
            <i /> Second author {totals.secondary}
          </span>
        ) : null}
        {totals.other > 0 ? (
          <span className="text-muted">other authors {totals.other} commits</span>
        ) : null}
        <span className="text-muted">
          {days[0]} → {days[days.length - 1]}
        </span>
      </div>
    </div>
  );
}

export type ActivityHeatmapDensity = "default" | "compact";

interface ActivityHeatmapProps {
  cells: { date: string; count: number; level: 0 | 1 | 2 | 3 | 4 }[];
  density?: ActivityHeatmapDensity;
  /** Narrower layout (e.g. overview two-column row). */
  layout?: "default" | "embedded";
}

export function ActivityHeatmap({
  cells,
  density = "compact",
  layout = "default",
}: ActivityHeatmapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSizePx, setCellSizePx] = useState(11);
  const [hideWeekdayLabels, setHideWeekdayLabels] = useState(false);
  const [monthLabelGap, setMonthLabelGap] = useState(3);

  const displayCells = useMemo(() => sliceHeatmapCellsToWindow(cells), [cells]);
  const weeks = useMemo(() => buildHeatmapWeeks(displayCells), [displayCells]);
  const monthLabels = useMemo(
    () => buildHeatmapMonthLabels(weeks, monthLabelGap),
    [weeks, monthLabelGap],
  );
  const weekCount = HEATMAP_DISPLAY_WEEKS;
  const rangeLabel = `${displayCells[0]?.date ?? ""} to ${displayCells[displayCells.length - 1]?.date ?? ""}`;

  const heatGapPx = density === "default" ? 3 : 2;
  const heatDayLabelPx = hideWeekdayLabels ? 0 : density === "default" ? 30 : 26;
  const heatMaxCellPx = layout === "embedded" ? 12 : 14;
  const heatMinCellPx = layout === "embedded" ? 6 : 5;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const update = (width: number) => {
      const narrow = width < 420;
      setHideWeekdayLabels(narrow);
      setMonthLabelGap(narrow ? 4 : width < 640 ? 3 : 2);
      const dayLabelPx = narrow ? 0 : layout === "embedded" ? 26 : 30;
      const gapPx = narrow ? 1 : heatGapPx;
      setCellSizePx(
        computeHeatmapCellSizePx(width, weekCount, {
          dayLabelPx,
          gapPx,
          minPx: heatMinCellPx,
          maxPx: heatMaxCellPx,
          paddingPx: layout === "embedded" ? 16 : 20,
        }),
      );
    };

    update(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [heatGapPx, heatMaxCellPx, heatMinCellPx, layout, weekCount]);

  const heatStyle = {
    "--heat-week-count": String(weekCount),
    "--heat-cell-size": `${cellSizePx}px`,
    "--heat-gap": `${hideWeekdayLabels ? 1 : heatGapPx}px`,
    "--heat-day-w": `${heatDayLabelPx}px`,
  } as CSSProperties;

  return (
    <div
      ref={containerRef}
      className={`repo-dashboard-heatbox repo-dashboard-heat-density-${density}`}
      data-heatmap-density={density}
      data-heatmap-layout={layout}
      style={heatStyle}
    >
      <div
        className="repo-dashboard-heat-wrap"
        style={heatStyle}
        role="img"
        aria-label={`Commit activity from ${rangeLabel}`}
      >
        <div className="repo-dashboard-heat-months font-mono" aria-hidden="true">
          <div className="repo-dashboard-heat-month-rail">
            {monthLabels.map(({ col, label }) => (
              <span
                key={`${col}-${label}`}
                className="repo-dashboard-heat-month-label"
                style={{ left: `${(col / weekCount) * 100}%` }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        <div
          className={`repo-dashboard-heatbody${
            hideWeekdayLabels ? " repo-dashboard-heatbody-no-days" : ""
          }`}
        >
          {!hideWeekdayLabels ? (
            <div className="repo-dashboard-days font-mono" aria-hidden="true">
              <span />
              <span>Mon</span>
              <span />
              <span>Wed</span>
              <span />
              <span>Fri</span>
              <span />
            </div>
          ) : null}
          <div className="repo-dashboard-heat-grid">
            {weeks.map((week, wi) => (
              <div key={wi} className="repo-dashboard-heat-week">
                {week.map(cell => (
                  <div
                    key={cell.date}
                    className={`repo-dashboard-heat-cell l${cell.level}`}
                    title={`${cell.date}: ${cell.count} commits`}
                    aria-label={`${cell.date}: ${cell.count} commits`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="repo-dashboard-hleg font-mono">
        <span className="repo-dashboard-hleg-range">{rangeLabel}</span>
        <span className="repo-dashboard-hleg-scale" aria-hidden="true">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map(level => (
            <span key={level} className={`repo-dashboard-heat-mini l${level}`} />
          ))}
          <span>More</span>
        </span>
      </div>
    </div>
  );
}

export { ACTIVITY_BLUE, ACTIVITY_GREEN };
