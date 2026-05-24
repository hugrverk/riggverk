import { useMemo } from "react";
import type { LineChartSeries } from "./model";
import {
  ACTIVITY_BLUE,
  ACTIVITY_GREEN,
  buildHeatmapMonthLabels,
  buildHeatmapWeeks,
} from "./model";

interface ActivityLineChartProps {
  data: LineChartSeries;
}

export function ActivityLineChart({ data }: ActivityLineChartProps) {
  const { days, uxsmedjan, PRIVATE, totals } = data;
  const w = 820;
  const h = 180;
  const L = 38;
  const R = 36;
  const T = 14;
  const B = 36;
  const max = Math.max(1, ...uxsmedjan, ...PRIVATE);
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
        <path className="repo-dashboard-series-blue" d={path(uxsmedjan)} />
        <path className="repo-dashboard-series-green" d={path(PRIVATE)} />
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
        <span className="repo-dashboard-blue">
          <i /> uxsmedjan {totals.uxsmedjan}
        </span>
        <span className="repo-dashboard-green">
          <i /> PRIVATE {totals.PRIVATE}
        </span>
        <span className="text-muted">other/unmapped {totals.other}</span>
        <span className="text-muted">
          {days[0]} → {days[days.length - 1]}
        </span>
      </div>
    </div>
  );
}

interface ActivityHeatmapProps {
  cells: { date: string; count: number; level: 0 | 1 | 2 | 3 | 4 }[];
}

const CELL = 13;
const GAP = 3;
const DAY_LABEL_W = 30;
const WEEK_W = CELL + GAP;

export function ActivityHeatmap({ cells }: ActivityHeatmapProps) {
  const weeks = useMemo(() => buildHeatmapWeeks(cells), [cells]);
  const monthLabels = useMemo(() => buildHeatmapMonthLabels(weeks), [weeks]);

  const gridWidth = weeks.length * WEEK_W - GAP;

  return (
    <div className="repo-dashboard-heatbox">
      <div
        className="repo-dashboard-heat-scroll"
        role="img"
        aria-label={`Commit activity from ${cells[0]?.date ?? ""} to ${cells[cells.length - 1]?.date ?? ""}`}
      >
        <div
          className="repo-dashboard-heat-wrap"
          style={
            {
              "--heat-week-w": `${WEEK_W}px`,
              "--heat-day-w": `${DAY_LABEL_W}px`,
            } as Record<string, string>
          }
        >
          <div className="repo-dashboard-heat-months font-mono" aria-hidden="true">
            <div className="repo-dashboard-heat-month-rail" style={{ width: gridWidth }}>
              {monthLabels.map(({ col, label }) => (
                <span
                  key={`${col}-${label}`}
                  className="repo-dashboard-heat-month-label"
                  style={{ left: `${col * WEEK_W}px` }}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
          <div className="repo-dashboard-heatbody">
            <div className="repo-dashboard-days font-mono" aria-hidden="true">
              <span />
              <span>Mon</span>
              <span />
              <span>Wed</span>
              <span />
              <span>Fri</span>
              <span />
            </div>
            <div className="repo-dashboard-heat-grid">
              {weeks.map((week, wi) => (
                <div key={wi} className="repo-dashboard-heat-week" style={{ gap: GAP }}>
                  {week.map(cell => (
                    <div
                      key={cell.date}
                      className={`repo-dashboard-heat-cell l${cell.level}`}
                      style={{ width: CELL, height: CELL }}
                      title={`${cell.date}: ${cell.count} commits`}
                      aria-label={`${cell.date}: ${cell.count} commits`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="repo-dashboard-hleg font-mono">
        <span className="repo-dashboard-hleg-range">
          {cells[0]?.date ?? ""} → {cells[cells.length - 1]?.date ?? ""}
        </span>
        <span className="repo-dashboard-hleg-scale">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map(level => (
            <span key={level} className={`repo-dashboard-heat-mini l${level}`} aria-hidden="true" />
          ))}
          <span>More</span>
        </span>
      </div>
    </div>
  );
}

export function TypeColorBar({
  type,
  count,
  max,
  color,
  active,
  onSelect,
}: {
  type: string;
  count: number;
  max: number;
  color: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`repo-dashboard-type-row${active ? " active" : ""}`} onClick={onSelect}>
      <span>{type}</span>
      <div className="repo-dashboard-bar">
        <div className="repo-dashboard-bar-fill" style={{ width: `${Math.max(2, (count / max) * 100)}%`, background: color }} />
      </div>
      <span>{count}</span>
    </button>
  );
}

export { ACTIVITY_BLUE, ACTIVITY_GREEN };
