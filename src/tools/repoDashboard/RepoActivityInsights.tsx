import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { RepoCommitEntry } from "../../types";
import {
  ACTIVITY_INSIGHTS_RANGE_DAYS,
  activityChartDayX,
  activityChartKeyAction,
  activityChartXAxisLabelIndices,
  activityInsightsChartDescription,
  activityInsightsChartTitle,
  activityInsightsRangeFooterText,
  applyActivityChartKeyAction,
  buildContributorActivitySeries,
  buildContributorStats,
  contributorChartColor,
  DEFAULT_ACTIVITY_INSIGHTS_DAYS,
  defaultVisibleContributorIds,
  filterCommitsForActivityInsights,
  filterContributorActivitySeries,
  nearestActivityDayIndex,
  reconcileActiveDayIndexOnRangeChange,
  reconcileVisibleContributorIds,
  visibleContributorSeriesMax,
  type ActivityInsightsRangeDays,
  type ActivityInsightsVisualMode,
  type ContributorActivitySeries,
  type ContributorStat,
  type HeatmapCell,
} from "./model";
import { ActivityHeatmap } from "./RepoDashboardCharts";

const CHART_W = 820;
const CHART_H = 230;
const CHART_L = 40;
const CHART_R = 28;
const CHART_T = 8;
const CHART_B = 44;

function ActivityInsightsChart({
  series,
  mode,
  rangeDays,
}: {
  series: ContributorActivitySeries[];
  mode: ActivityInsightsVisualMode;
  rangeDays: ActivityInsightsRangeDays;
}) {
  const [activeDayIndex, setActiveDayIndex] = useState<number | null>(null);
  const [animateLines, setAnimateLines] = useState(mode === "lines");
  const [animateBars, setAnimateBars] = useState(mode === "bars");
  const svgRef = useRef<SVGSVGElement>(null);
  const prevModeRef = useRef(mode);
  const prevRangeDaysRef = useRef(rangeDays);
  const chartTitleId = useId();
  const chartDescId = useId();
  const liveStatusId = useId();
  const plotFocusId = useId();

  const dayCount = series[0]?.points.length ?? 0;
  const max = useMemo(() => visibleContributorSeriesMax(series), [series]);

  const slotWidth = dayCount > 0 ? (CHART_W - CHART_L - CHART_R) / dayCount : 0;
  const xCenter = useCallback(
    (index: number) => CHART_L + index * slotWidth + slotWidth / 2,
    [slotWidth],
  );
  const xAt = useCallback(
    (index: number) =>
      activityChartDayX(index, dayCount, CHART_L, CHART_R, CHART_W, "lines"),
    [dayCount],
  );
  const yAt = useCallback(
    (value: number) => CHART_T + ((max - value) * (CHART_H - CHART_T - CHART_B)) / max,
    [max],
  );

  const labelIndices = useMemo(
    () => new Set(activityChartXAxisLabelIndices(dayCount)),
    [dayCount],
  );
  const dayKeys = series[0]?.points.map(point => point.date) ?? [];

  useEffect(() => {
    setActiveDayIndex(current =>
      reconcileActiveDayIndexOnRangeChange(current, dayCount),
    );
    if (prevRangeDaysRef.current !== rangeDays) {
      if (mode === "lines") setAnimateLines(true);
      if (mode === "bars") setAnimateBars(true);
      prevRangeDaysRef.current = rangeDays;
    }
  }, [dayCount, mode, rangeDays]);

  useEffect(() => {
    if (prevModeRef.current === mode) return;
    setAnimateLines(mode === "lines");
    setAnimateBars(mode === "bars");
    prevModeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (!animateLines) return;
    const timer = window.setTimeout(() => setAnimateLines(false), 480);
    return () => window.clearTimeout(timer);
  }, [animateLines]);

  useEffect(() => {
    if (!animateBars) return;
    const timer = window.setTimeout(() => setAnimateBars(false), 460);
    return () => window.clearTimeout(timer);
  }, [animateBars]);

  const resolveSvgX = useCallback((clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return CHART_L;
    const rect = svg.getBoundingClientRect();
    const scaleX = CHART_W / rect.width;
    return (clientX - rect.left) * scaleX;
  }, []);

  const selectNearestDay = useCallback(
    (clientX: number) => {
      const svgX = resolveSvgX(clientX);
      setActiveDayIndex(
        nearestActivityDayIndex(svgX, dayCount, CHART_L, CHART_R, CHART_W, mode),
      );
    },
    [dayCount, mode, resolveSvgX],
  );

  const handlePlotMouseMove = useCallback(
    (event: MouseEvent<SVGRectElement>) => {
      selectNearestDay(event.clientX);
    },
    [selectNearestDay],
  );

  const handlePlotMouseLeave = useCallback(() => {
    setActiveDayIndex(null);
  }, []);

  const handlePlotKeyDown = useCallback(
    (event: KeyboardEvent<SVGRectElement>) => {
      const action = activityChartKeyAction(event.key);
      if (!action) return;
      event.preventDefault();
      setActiveDayIndex(current => applyActivityChartKeyAction(current, action, dayCount));
    },
    [dayCount],
  );

  if (!series.length || !dayCount) {
    return (
      <p className="text-muted small" role="status">
        Select at least one contributor to chart activity.
      </p>
    );
  }

  const contributorCount = series.length;
  const innerGap = 3;
  const maxBarW = 9;
  const barW =
    mode === "bars"
      ? Math.min(
          maxBarW,
          Math.max(2, (slotWidth - innerGap * (contributorCount - 1)) / contributorCount),
        )
      : 0;

  const activeDate = activeDayIndex != null ? dayKeys[activeDayIndex] : null;
  const activeX =
    activeDayIndex != null
      ? activityChartDayX(activeDayIndex, dayCount, CHART_L, CHART_R, CHART_W, mode)
      : null;

  const tooltipLeft =
    activeX != null
      ? Math.min(Math.max(activeX - 72, CHART_L), CHART_W - CHART_R - 144)
      : CHART_L;

  const liveSummary =
    activeDayIndex != null && activeDate
      ? `${activeDate}: ${series
          .map(
            entry =>
              `${entry.displayName} ${entry.points[activeDayIndex]?.commitCount ?? 0} commits`,
          )
          .join(", ")}`
      : "";

  return (
    <>
      <div className="repo-dashboard-activity-chart-main">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-labelledby={`${chartTitleId} ${chartDescId}`}
          className={`repo-dashboard-activity-insights-svg${activeDayIndex != null ? " repo-dashboard-activity-insights-svg-active" : ""}`}
          data-chart-mode={mode}
        >
          <title id={chartTitleId}>{activityInsightsChartTitle(rangeDays)}</title>
          <desc id={chartDescId}>{activityInsightsChartDescription(rangeDays, mode)}</desc>

          {[0, Math.ceil(max / 2), max].map(v => (
            <g key={v} aria-hidden="true">
              {v > 0 ? (
                <line
                  className="repo-dashboard-activity-gridline"
                  x1={CHART_L}
                  y1={yAt(v)}
                  x2={CHART_W - CHART_R}
                  y2={yAt(v)}
                />
              ) : null}
              <text className="repo-dashboard-activity-chart-text" x={6} y={yAt(v) + 3}>
                {v}
              </text>
            </g>
          ))}

          <line
            className="repo-dashboard-activity-axis"
            x1={CHART_L}
            y1={CHART_H - CHART_B}
            x2={CHART_W - CHART_R}
            y2={CHART_H - CHART_B}
            aria-hidden="true"
          />

          {activeX != null ? (
            <line
              className="repo-dashboard-activity-guide"
              x1={activeX}
              y1={CHART_T}
              x2={activeX}
              y2={CHART_H - CHART_B}
              aria-hidden="true"
            />
          ) : null}

          {mode === "lines"
            ? series.map(entry => {
                const color = contributorChartColor(entry.colorIndex);
                const path = entry.points
                  .map((point, index) => {
                    const x = xAt(index);
                    const y = yAt(point.commitCount);
                    return `${index === 0 ? "M" : "L"} ${x} ${y}`;
                  })
                  .join(" ");
                return (
                  <g key={entry.id} className="repo-dashboard-activity-series">
                    <path
                      className={`repo-dashboard-activity-line${animateLines ? " repo-dashboard-activity-line-animate" : ""}${activeDayIndex != null ? " repo-dashboard-activity-line-dimmed" : ""}`}
                      d={path}
                      stroke={color}
                      fill="none"
                      pathLength={1}
                    />
                    {activeDayIndex != null
                      ? (() => {
                          const point = entry.points[activeDayIndex];
                          if (!point) return null;
                          return (
                            <circle
                              className="repo-dashboard-activity-active-point"
                              cx={xAt(activeDayIndex)}
                              cy={yAt(point.commitCount)}
                              r={point.commitCount > 0 ? 4 : 3}
                              fill={color}
                              aria-hidden="true"
                            />
                          );
                        })()
                      : null}
                  </g>
                );
              })
            : dayKeys.map((date, dayIndex) => {
                const totalWidth =
                  contributorCount * barW + Math.max(0, contributorCount - 1) * innerGap;
                const groupStart = xCenter(dayIndex) - totalWidth / 2;
                const isActiveDay = activeDayIndex === dayIndex;
                return series.map((entry, contributorIndex) => {
                  const point = entry.points[dayIndex];
                  if (!point?.commitCount) return null;
                  const color = contributorChartColor(entry.colorIndex);
                  const x = groupStart + contributorIndex * (barW + innerGap);
                  const y = yAt(point.commitCount);
                  const barH = CHART_H - CHART_B - y;
                  const isActiveBar = isActiveDay;
                  const isDimmed = activeDayIndex != null && !isActiveDay;
                  return (
                    <rect
                      key={`${entry.id}-${date}`}
                      className={`repo-dashboard-activity-bar${animateBars ? " repo-dashboard-activity-bar-animate" : ""}${isActiveBar ? " repo-dashboard-activity-bar-active" : ""}${isDimmed ? " repo-dashboard-activity-bar-dimmed" : ""}`}
                      style={{ animationDelay: animateBars ? `${contributorIndex * 18}ms` : undefined }}
                      x={x}
                      y={y}
                      width={barW}
                      height={barH}
                      rx={2}
                      ry={2}
                      fill={color}
                      aria-hidden="true"
                    />
                  );
                });
              })}

          {dayKeys.map((date, index) =>
            labelIndices.has(index) ? (
              <text
                key={`${date}-label`}
                className="repo-dashboard-activity-chart-text"
                x={mode === "bars" ? xCenter(index) : xAt(index)}
                y={CHART_H - 16}
                textAnchor="middle"
                aria-hidden="true"
              >
                {date.slice(5)}
              </text>
            ) : null,
          )}

          <rect
            id={plotFocusId}
            className="repo-dashboard-activity-plot-hit"
            x={CHART_L}
            y={CHART_T}
            width={CHART_W - CHART_L - CHART_R}
            height={CHART_H - CHART_T - CHART_B}
            tabIndex={0}
            role="application"
            aria-label="Activity chart date navigator. Arrow keys move between dates. Escape clears selection."
            aria-controls={liveStatusId}
            onMouseMove={handlePlotMouseMove}
            onMouseLeave={handlePlotMouseLeave}
            onKeyDown={handlePlotKeyDown}
          />
        </svg>

        <div
          id={liveStatusId}
          className="repo-dashboard-activity-live-status visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {liveSummary}
        </div>

        {activeDayIndex != null && activeDate ? (
          <div
            className="repo-dashboard-activity-tooltip font-mono"
            style={{ left: `${(tooltipLeft / CHART_W) * 100}%` }}
            aria-hidden="true"
          >
            <span className="repo-dashboard-activity-tooltip-date">{activeDate}</span>
            <ul className="repo-dashboard-activity-tooltip-rows">
              {series.map(entry => {
                const count = entry.points[activeDayIndex]?.commitCount ?? 0;
                return (
                  <li key={entry.id}>
                    <span
                      className="repo-dashboard-activity-tooltip-swatch"
                      style={{ background: contributorChartColor(entry.colorIndex) }}
                    />
                    <span className="repo-dashboard-activity-tooltip-name">{entry.displayName}</span>
                    <span className="repo-dashboard-activity-tooltip-value">{count}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="repo-dashboard-activity-chart-footer">
        <ul className="repo-dashboard-activity-legend font-mono" aria-label="Chart series">
          {series.map(entry => (
            <li key={entry.id}>
              <span
                className="repo-dashboard-activity-legend-swatch"
                style={{ background: contributorChartColor(entry.colorIndex) }}
                aria-hidden="true"
              />
              <span>{entry.displayName}</span>
            </li>
          ))}
        </ul>
        <span className="repo-dashboard-activity-chart-meta font-mono text-muted" aria-hidden="true">
          {activityInsightsRangeFooterText(rangeDays)}
        </span>
      </div>
    </>
  );
}

function ContributorVisibilityRow({
  stat,
  visible,
  colorIndex,
  onToggle,
}: {
  stat: ContributorStat;
  visible: boolean;
  colorIndex: number;
  onToggle: () => void;
}) {
  const color = contributorChartColor(colorIndex);
  return (
    <button
      type="button"
      className={`repo-dashboard-contributor-visibility${visible ? " repo-dashboard-contributor-visibility-on" : ""}`}
      aria-pressed={visible}
      aria-label={`${visible ? "Hide" : "Show"} ${stat.displayName} on chart`}
      onClick={onToggle}
    >
      <span
        className="repo-dashboard-contributor-visibility-swatch"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className="repo-dashboard-contributor-visibility-state" aria-hidden="true">
        {visible ? "Shown" : "Hidden"}
      </span>
      <span className="repo-dashboard-contributor-visibility-name">{stat.displayName}</span>
      <span className="repo-dashboard-contributor-visibility-stat">{stat.commitCount}</span>
      <span className="repo-dashboard-contributor-visibility-stat">{stat.percentage}%</span>
      <span className="repo-dashboard-contributor-visibility-stat">{stat.mergeCommitCount}</span>
    </button>
  );
}

export type ActivityInsightsKpiTarget = "overview" | "work" | "docs";

export interface ActivityInsightsMetrics {
  docsFound: number;
  docsTotal: number;
  headFileCount: number;
  commitsLoaded: number;
  docOpenCount: number;
  workOpenCount: number;
  ghIssuesValue: number | null;
  ghIssuesLabel: string;
  needsPlanningCount: number;
}

function ActivityInsightsMetricsBar({
  metrics,
  onNavigate,
}: {
  metrics: ActivityInsightsMetrics;
  onNavigate: (target: ActivityInsightsKpiTarget) => void;
}) {
  return (
    <div className="repo-dashboard-kpis" role="group" aria-label="Overview metrics">
      <button type="button" className="repo-dashboard-kpi" onClick={() => onNavigate("docs")}>
        <div className="repo-dashboard-kpi-num font-mono">
          {metrics.docsFound}/{metrics.docsTotal}
        </div>
        <div className="repo-dashboard-kpi-label">docs found</div>
        <div className="repo-dashboard-kpi-hint text-muted">
          {metrics.headFileCount} HEAD file{metrics.headFileCount === 1 ? "" : "s"}
        </div>
      </button>
      <button type="button" className="repo-dashboard-kpi" onClick={() => onNavigate("overview")}>
        <div className="repo-dashboard-kpi-num font-mono">{metrics.commitsLoaded}</div>
        <div className="repo-dashboard-kpi-label">commits loaded</div>
      </button>
      <button type="button" className="repo-dashboard-kpi" onClick={() => onNavigate("work")}>
        <div className="repo-dashboard-kpi-num font-mono">{metrics.docOpenCount}</div>
        <div className="repo-dashboard-kpi-label">open from docs</div>
      </button>
      <button type="button" className="repo-dashboard-kpi" onClick={() => onNavigate("work")}>
        <div className="repo-dashboard-kpi-num font-mono">{metrics.workOpenCount}</div>
        <div className="repo-dashboard-kpi-label">open items</div>
      </button>
      <button type="button" className="repo-dashboard-kpi" onClick={() => onNavigate("work")}>
        <div className="repo-dashboard-kpi-num font-mono">
          {metrics.ghIssuesValue ?? "—"}
        </div>
        <div className="repo-dashboard-kpi-label">{metrics.ghIssuesLabel}</div>
      </button>
      <button type="button" className="repo-dashboard-kpi" onClick={() => onNavigate("work")}>
        <div className="repo-dashboard-kpi-num font-mono">{metrics.needsPlanningCount}</div>
        <div className="repo-dashboard-kpi-label">needs planning</div>
      </button>
    </div>
  );
}

export function RepoActivityInsights({
  commits,
  commitsTruncated,
  heatmapCells,
  metrics,
  onNavigate,
}: {
  commits: RepoCommitEntry[];
  commitsTruncated: boolean;
  heatmapCells: HeatmapCell[];
  metrics: ActivityInsightsMetrics;
  onNavigate: (target: ActivityInsightsKpiTarget) => void;
}) {
  const [chartMode, setChartMode] = useState<ActivityInsightsVisualMode>("bars");
  const [rangeDays, setRangeDays] = useState<ActivityInsightsRangeDays>(
    DEFAULT_ACTIVITY_INSIGHTS_DAYS,
  );
  const [visibleContributorIds, setVisibleContributorIds] = useState<string[]>([]);

  const allStats = useMemo(() => buildContributorStats(commits), [commits]);
  const rangeCommits = useMemo(
    () => filterCommitsForActivityInsights(commits, rangeDays),
    [commits, rangeDays],
  );
  const allSeries = useMemo(
    () => buildContributorActivitySeries(rangeCommits, rangeDays),
    [rangeCommits, rangeDays],
  );

  const colorIndexById = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of allSeries) map.set(entry.id, entry.colorIndex);
    return map;
  }, [allSeries]);

  useEffect(() => {
    const available = defaultVisibleContributorIds(allSeries);
    setVisibleContributorIds(prev => {
      if (!prev.length && available.length) return available;
      return reconcileVisibleContributorIds(prev, available);
    });
  }, [allSeries]);

  const visibleSeries = useMemo(
    () => filterContributorActivitySeries(allSeries, new Set(visibleContributorIds)),
    [allSeries, visibleContributorIds],
  );

  const visibleIdSet = useMemo(() => new Set(visibleContributorIds), [visibleContributorIds]);
  const allContributorsVisible = useMemo(
    () => allStats.length > 0 && allStats.every(stat => visibleIdSet.has(stat.id)),
    [allStats, visibleIdSet],
  );

  const toggleContributor = useCallback((id: string) => {
    setVisibleContributorIds(prev =>
      prev.includes(id) ? prev.filter(entryId => entryId !== id) : [...prev, id],
    );
  }, []);

  const showAllContributors = useCallback(() => {
    setVisibleContributorIds(defaultVisibleContributorIds(allSeries));
  }, [allSeries]);

  return (
    <section
      className="repo-dashboard-card repo-dashboard-activity-insights"
      aria-label="Repository activity and contributors"
    >
      <div className="repo-dashboard-activity-insights-head">
        <ActivityInsightsMetricsBar metrics={metrics} onNavigate={onNavigate} />
      </div>

      {!commits.length ? (
        <p className="text-muted small" role="status">
          No commits in loaded local git history.
        </p>
      ) : (
        <div className="repo-dashboard-activity-insights-body">
          <div className="repo-dashboard-activity-insights-chart">
            <div className="repo-dashboard-activity-chart-header">
              <h3 className="repo-dashboard-activity-chart-title font-mono">Contributions</h3>
              <div className="repo-dashboard-activity-chart-header-controls">
                <div className="repo-dashboard-toolbar" role="group" aria-label="Activity range">
                  {ACTIVITY_INSIGHTS_RANGE_DAYS.map(days => (
                    <button
                      key={days}
                      type="button"
                      className={`repo-dashboard-seg repo-dashboard-seg-compact${rangeDays === days ? " active" : ""}`}
                      aria-pressed={rangeDays === days}
                      onClick={() => setRangeDays(days)}
                    >
                      {days}d
                    </button>
                  ))}
                </div>
                <div className="repo-dashboard-toolbar" role="group" aria-label="Chart type">
                  <button
                    type="button"
                    className={`repo-dashboard-seg repo-dashboard-seg-compact${chartMode === "lines" ? " active" : ""}`}
                    aria-pressed={chartMode === "lines"}
                    onClick={() => setChartMode("lines")}
                  >
                    Lines
                  </button>
                  <button
                    type="button"
                    className={`repo-dashboard-seg repo-dashboard-seg-compact${chartMode === "bars" ? " active" : ""}`}
                    aria-pressed={chartMode === "bars"}
                    onClick={() => setChartMode("bars")}
                  >
                    Bars
                  </button>
                </div>
              </div>
            </div>
            <ActivityInsightsChart
              series={visibleSeries}
              mode={chartMode}
              rangeDays={rangeDays}
            />
          </div>
          <div className="repo-dashboard-activity-sidebar">
            {allStats.length ? (
              <div className="repo-dashboard-contributor-panel">
                <div className="repo-dashboard-contributor-panel-head">
                  <h3 className="font-mono repo-dashboard-contributor-panel-title">Contributors</h3>
                  <button
                    type="button"
                    className={`repo-dashboard-contributor-show-all font-mono${allContributorsVisible ? " repo-dashboard-contributor-show-all-inactive" : ""}`}
                    onClick={showAllContributors}
                    disabled={allContributorsVisible}
                    aria-disabled={allContributorsVisible}
                  >
                    Show all
                  </button>
                </div>
                <div className="repo-dashboard-contributor-visibility-list font-mono">
                  <div
                    className="repo-dashboard-contributor-visibility-header"
                    aria-hidden="true"
                  >
                    <span />
                    <span />
                    <span>Name</span>
                    <span>Commits</span>
                    <span>Share</span>
                    <span>Merges</span>
                  </div>
                  {allStats.map(stat => (
                    <ContributorVisibilityRow
                      key={stat.id}
                      stat={stat}
                      visible={visibleIdSet.has(stat.id)}
                      colorIndex={colorIndexById.get(stat.id) ?? 0}
                      onToggle={() => toggleContributor(stat.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            <div className="repo-dashboard-heatmap-panel">
              <h3 className="font-mono repo-dashboard-heatmap-panel-title">Commit activity</h3>
              {heatmapCells.length ? (
                <ActivityHeatmap cells={heatmapCells} density="default" layout="embedded" />
              ) : (
                <p className="text-muted small" role="status">
                  No activity data.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {commitsTruncated ? (
        <p className="text-muted small repo-dashboard-footnote" role="status">
          Older commits omitted from loaded history.
        </p>
      ) : null}
    </section>
  );
}
