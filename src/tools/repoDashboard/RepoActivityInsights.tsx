import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { RepoCommitEntry } from "../../types";
import {
  ACTIVITY_INSIGHTS_DAYS,
  buildContributorActivitySeries,
  buildContributorStats,
  contributorChartColor,
  defaultVisibleContributorIds,
  filterCommitsForActivityInsights,
  filterContributorActivitySeries,
  reconcileVisibleContributorIds,
  visibleContributorSeriesMax,
  type ActivityInsightsVisualMode,
  type ContributorActivitySeries,
  type ContributorStat,
  type HeatmapCell,
} from "./model";
import { ActivityHeatmap } from "./RepoDashboardCharts";

interface ChartFocus {
  seriesId: string;
  dayIndex: number;
}

function ActivityInsightsChart({
  series,
  mode,
}: {
  series: ContributorActivitySeries[];
  mode: ActivityInsightsVisualMode;
}) {
  const [focus, setFocus] = useState<ChartFocus | null>(null);
  const chartTitleId = useId();
  const chartDescId = useId();

  const dayCount = series[0]?.points.length ?? 0;
  const max = useMemo(() => visibleContributorSeriesMax(series), [series]);

  const w = 820;
  const h = 230;
  const L = 40;
  const R = 28;
  const T = 16;
  const B = 44;

  const slotWidth = dayCount > 0 ? (w - L - R) / dayCount : 0;
  const xCenter = useCallback(
    (index: number) => L + index * slotWidth + slotWidth / 2,
    [slotWidth],
  );
  const xAt = useCallback(
    (index: number) =>
      dayCount === 1 ? L + (w - L - R) / 2 : L + (index * (w - L - R)) / (dayCount - 1),
    [dayCount],
  );
  const yAt = useCallback(
    (value: number) => T + ((max - value) * (h - T - B)) / max,
    [max],
  );

  const every = Math.max(1, Math.ceil(dayCount / 8));
  const dayKeys = series[0]?.points.map(point => point.date) ?? [];

  const activeEntry = focus
    ? series.find(entry => entry.id === focus.seriesId) ?? null
    : null;
  const activePoint =
    activeEntry && focus ? activeEntry.points[focus.dayIndex] ?? null : null;

  if (!series.length || !dayCount) {
    return (
      <p className="text-muted small" role="status">
        Select at least one contributor to chart activity.
      </p>
    );
  }

  const contributorCount = series.length;
  const innerGap = 2;
  const maxBarW = 10;
  const barW =
    mode === "bars"
      ? Math.min(
          maxBarW,
          Math.max(2, (slotWidth - innerGap * (contributorCount - 1)) / contributorCount),
        )
      : 0;

  return (
    <div className="repo-dashboard-activity-insights-chart">
      <div className="repo-dashboard-activity-chart-main">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-labelledby={`${chartTitleId} ${chartDescId}`}
        className="repo-dashboard-activity-insights-svg"
      >
        <title id={chartTitleId}>Contributor commits per day — last 90 days</title>
        <desc id={chartDescId}>
          {mode === "lines" ? "Line chart" : "Grouped bar chart"} of daily commits per
          contributor over the last 90 days.
        </desc>
        <line className="repo-dashboard-axis" x1={L} y1={h - B} x2={w - R} y2={h - B} />
        <line className="repo-dashboard-axis" x1={L} y1={T} x2={L} y2={h - B} />
        {[0, Math.ceil(max / 2), max].map(v => (
          <g key={v}>
            <line className="repo-dashboard-gridline" x1={L} y1={yAt(v)} x2={w - R} y2={yAt(v)} />
            <text className="repo-dashboard-chart-text" x={6} y={yAt(v) + 3}>
              {v}
            </text>
          </g>
        ))}

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
                <g key={entry.id}>
                  <path
                    className="repo-dashboard-activity-line"
                    d={path}
                    stroke={color}
                    fill="none"
                  />
                  {entry.points.map((point, index) => (
                    <circle
                      key={`${entry.id}-${point.date}`}
                      className="repo-dashboard-activity-point"
                      cx={xAt(index)}
                      cy={yAt(point.commitCount)}
                      r={point.commitCount > 0 ? 3.5 : 2}
                      fill={color}
                      aria-hidden="true"
                      onMouseEnter={() => setFocus({ seriesId: entry.id, dayIndex: index })}
                      onMouseLeave={() => setFocus(null)}
                    />
                  ))}
                </g>
              );
            })
          : dayKeys.map((date, dayIndex) => {
              const totalWidth =
                contributorCount * barW + Math.max(0, contributorCount - 1) * innerGap;
              const groupStart = xCenter(dayIndex) - totalWidth / 2;
              return series.map((entry, contributorIndex) => {
                const point = entry.points[dayIndex];
                if (!point?.commitCount) return null;
                const color = contributorChartColor(entry.colorIndex);
                const x = groupStart + contributorIndex * (barW + innerGap);
                const y = yAt(point.commitCount);
                const barH = h - B - y;
                return (
                  <rect
                    key={`${entry.id}-${date}`}
                    className="repo-dashboard-activity-bar"
                    x={x}
                    y={y}
                    width={barW}
                    height={barH}
                    rx={1.5}
                    fill={color}
                    aria-hidden="true"
                    onMouseEnter={() => setFocus({ seriesId: entry.id, dayIndex })}
                    onMouseLeave={() => setFocus(null)}
                  />
                );
              });
            })}

        {dayKeys.map((date, index) =>
          index % every === 0 || index === dayKeys.length - 1 ? (
            <text
              key={`${date}-label`}
              className="repo-dashboard-chart-text"
              x={mode === "bars" ? xCenter(index) : xAt(index)}
              y={h - 16}
              textAnchor="middle"
            >
              {date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>

      {activeEntry && activePoint ? (
        <p className="repo-dashboard-activity-tooltip font-mono" role="status" aria-live="polite">
          {activeEntry.displayName} · {activePoint.date}: {activePoint.commitCount} commits
        </p>
      ) : null}
      </div>

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
    </div>
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

export function RepoActivityInsights({
  commits,
  commitsTruncated,
  heatmapCells,
}: {
  commits: RepoCommitEntry[];
  commitsTruncated: boolean;
  heatmapCells: HeatmapCell[];
}) {
  const [chartMode, setChartMode] = useState<ActivityInsightsVisualMode>("lines");
  const [visibleContributorIds, setVisibleContributorIds] = useState<string[]>([]);

  const allStats = useMemo(() => buildContributorStats(commits), [commits]);
  const rangeCommits = useMemo(() => filterCommitsForActivityInsights(commits), [commits]);
  const allSeries = useMemo(
    () => buildContributorActivitySeries(rangeCommits, ACTIVITY_INSIGHTS_DAYS),
    [rangeCommits],
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

  const chartModeGroupId = useId();

  return (
    <section
      className="repo-dashboard-card repo-dashboard-activity-insights"
      aria-label="Repository activity and contributors"
    >
      <div className="repo-dashboard-activity-insights-head">
        <div>
          <h2 className="font-mono">Activity &amp; contributors</h2>
          <p className="text-muted small repo-dashboard-activity-insights-meta">
            90-day local git activity
          </p>
        </div>
        <div
          className="repo-dashboard-activity-insights-controls"
          role="group"
          aria-labelledby={chartModeGroupId}
        >
          <span id={chartModeGroupId} className="repo-dashboard-activity-control-label font-mono">
            Chart
          </span>
          <div className="repo-dashboard-toolbar">
            <button
              type="button"
              className={`repo-dashboard-seg${chartMode === "lines" ? " active" : ""}`}
              aria-pressed={chartMode === "lines"}
              onClick={() => setChartMode("lines")}
            >
              Lines
            </button>
            <button
              type="button"
              className={`repo-dashboard-seg${chartMode === "bars" ? " active" : ""}`}
              aria-pressed={chartMode === "bars"}
              onClick={() => setChartMode("bars")}
            >
              Bars
            </button>
          </div>
        </div>
      </div>

      {!commits.length ? (
        <p className="text-muted small" role="status">
          No commits in loaded local git history.
        </p>
      ) : (
        <div className="repo-dashboard-activity-insights-body">
          <ActivityInsightsChart series={visibleSeries} mode={chartMode} />
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
