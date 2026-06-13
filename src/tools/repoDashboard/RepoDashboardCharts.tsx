import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  buildHeatmapMonthLabels,
  buildHeatmapWeeks,
  computeHeatmapCellSizePx,
  HEATMAP_DISPLAY_WEEKS,
  sliceHeatmapCellsToWindow,
} from "./model";

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
          paddingPx: layout === "embedded" ? 24 : 20,
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
            {monthLabels.map(({ col, label }) => {
              const atEnd = col >= weekCount - 2;
              return (
                <span
                  key={`${col}-${label}`}
                  className={`repo-dashboard-heat-month-label${
                    atEnd ? " repo-dashboard-heat-month-label-end" : ""
                  }`}
                  style={{ left: `${(col / weekCount) * 100}%` }}
                >
                  {label}
                </span>
              );
            })}
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
                    aria-hidden="true"
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
