import { useCallback, useId, useMemo, useState } from "react";
import type { RepoCommitEntry } from "../../types";
import {
  activityInsightsChartValue,
  buildActivityInsightsSeries,
  buildContributorStats,
  contributorTopScopes,
  contributorTopTypes,
  filterCommitsByContributor,
  filterCommitsByTimeRange,
  type ActivityChartMode,
  type ActivityInsightsPoint,
  type ActivityTimeRange,
  type ContributorStat,
} from "./model";

const TIME_RANGES: { id: ActivityTimeRange; label: string }[] = [
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "1y", label: "1 year" },
  { id: "all", label: "All loaded" },
];

const CHART_MODES: { id: ActivityChartMode; label: string }[] = [
  { id: "period", label: "Commits per day" },
  { id: "cumulative", label: "Cumulative" },
];

function formatContributorDate(timestamp: number | null): string {
  if (timestamp == null) return "—";
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    year: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function ActivityInsightsChart({
  points,
  mode,
}: {
  points: ActivityInsightsPoint[];
  mode: ActivityChartMode;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const chartTitleId = useId();

  const values = useMemo(
    () => points.map(point => activityInsightsChartValue(point, mode)),
    [points, mode],
  );
  const max = Math.max(1, ...values);

  const w = 820;
  const h = 200;
  const L = 40;
  const R = 16;
  const T = 16;
  const B = 36;

  const xAt = useCallback(
    (index: number) =>
      points.length === 1
        ? L + (w - L - R) / 2
        : L + (index * (w - L - R)) / (points.length - 1),
    [points.length],
  );
  const yAt = useCallback(
    (value: number) => T + ((max - value) * (h - T - B)) / max,
    [max],
  );

  const pathD = useMemo(() => {
    if (!points.length) return "";
    return values
      .map((value, index) => `${index ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`)
      .join(" ");
  }, [points.length, values, xAt, yAt]);

  const every = Math.max(1, Math.ceil(points.length / 8));
  const activePoint = activeIndex != null ? points[activeIndex] : null;
  const activeValue =
    activePoint != null ? activityInsightsChartValue(activePoint, mode) : null;

  if (!points.length) {
    return (
      <p className="text-muted small" role="status">
        No commits in the selected range.
      </p>
    );
  }

  return (
    <div className="repo-dashboard-activity-insights-chart">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-labelledby={chartTitleId}
        className="repo-dashboard-activity-insights-svg"
      >
        <title id={chartTitleId}>
          {mode === "cumulative" ? "Cumulative commits" : "Commits per day"}
        </title>
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
        {mode === "period" ? (
          points.map((point, index) => {
            const value = values[index];
            if (!value) return null;
            const barW = Math.max(2, (w - L - R) / points.length - 1);
            const x = xAt(index) - barW / 2;
            const y = yAt(value);
            const barH = h - B - y;
            return (
              <rect
                key={point.date}
                className="repo-dashboard-activity-bar"
                x={x}
                y={y}
                width={barW}
                height={barH}
                tabIndex={0}
                role="graphics-symbol"
                aria-label={`${point.date}: ${point.commitCount} commits`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              />
            );
          })
        ) : (
          <path className="repo-dashboard-series-blue" d={pathD} />
        )}
        {mode === "cumulative"
          ? points.map((point, index) => (
              <circle
                key={point.date}
                className="repo-dashboard-activity-point"
                cx={xAt(index)}
                cy={yAt(values[index])}
                r={index === activeIndex ? 5 : 3}
                tabIndex={0}
                role="graphics-symbol"
                aria-label={`${point.date}: ${point.cumulativeCount} cumulative commits`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              />
            ))
          : null}
        {points.map((point, index) =>
          index % every === 0 || index === points.length - 1 ? (
            <text
              key={`${point.date}-label`}
              className="repo-dashboard-chart-text"
              x={xAt(index)}
              y={h - 8}
              textAnchor="middle"
            >
              {point.date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      {activePoint ? (
        <p className="repo-dashboard-activity-tooltip font-mono" role="status" aria-live="polite">
          {activePoint.date}: {activeValue}{" "}
          {mode === "cumulative" ? "cumulative commits" : "commits"}
        </p>
      ) : (
        <p className="repo-dashboard-activity-tooltip font-mono text-muted" aria-hidden="true">
          Hover or focus chart points for details
        </p>
      )}
    </div>
  );
}

function ContributorDetail({ stat }: { stat: ContributorStat }) {
  return (
    <dl className="repo-dashboard-contributor-detail font-mono">
      <div>
        <dt>Commits</dt>
        <dd>{stat.commitCount}</dd>
      </div>
      <div>
        <dt>Share</dt>
        <dd>{stat.percentage}%</dd>
      </div>
      <div>
        <dt>Active</dt>
        <dd>
          {formatContributorDate(stat.firstCommitAt)} →{" "}
          {formatContributorDate(stat.latestCommitAt)}
        </dd>
      </div>
      <div>
        <dt>Merges</dt>
        <dd>{stat.mergeCommitCount}</dd>
      </div>
      <div>
        <dt>Types</dt>
        <dd>{contributorTopTypes(stat) || "—"}</dd>
      </div>
      <div>
        <dt>Scopes</dt>
        <dd>{contributorTopScopes(stat) || "—"}</dd>
      </div>
    </dl>
  );
}

export function RepoActivityInsights({
  commits,
  commitsTruncated,
}: {
  commits: RepoCommitEntry[];
  commitsTruncated: boolean;
}) {
  const [timeRange, setTimeRange] = useState<ActivityTimeRange>("90d");
  const [chartMode, setChartMode] = useState<ActivityChartMode>("period");
  const [contributorId, setContributorId] = useState<"all" | string>("all");

  const allStats = useMemo(() => buildContributorStats(commits), [commits]);
  const rangeCommits = useMemo(
    () => filterCommitsByTimeRange(commits, timeRange),
    [commits, timeRange],
  );
  const filteredCommits = useMemo(
    () => filterCommitsByContributor(rangeCommits, contributorId),
    [rangeCommits, contributorId],
  );
  const series = useMemo(() => buildActivityInsightsSeries(filteredCommits), [filteredCommits]);

  const selectedStat =
    contributorId === "all" ? null : allStats.find(stat => stat.id === contributorId) ?? null;

  const contributorSelectId = useId();

  return (
    <section
      className="repo-dashboard-card repo-dashboard-activity-insights"
      aria-label="Repository activity and contributors"
    >
      <div className="repo-dashboard-activity-insights-head">
        <div>
          <h2 className="font-mono">Activity &amp; contributors</h2>
          <p className="text-muted small repo-dashboard-activity-insights-note">
            Based on loaded local git history and commit subjects — not effort or code quality.
          </p>
        </div>
        <div className="repo-dashboard-activity-insights-controls" role="group" aria-label="Activity chart controls">
          <label className="repo-dashboard-activity-control font-mono">
            <span>Range</span>
            <select
              className="repo-dashboard-field"
              value={timeRange}
              onChange={e => setTimeRange(e.target.value as ActivityTimeRange)}
              aria-label="Activity time range"
            >
              {TIME_RANGES.map(range => (
                <option key={range.id} value={range.id}>
                  {range.label}
                </option>
              ))}
            </select>
          </label>
          <label className="repo-dashboard-activity-control font-mono">
            <span>Chart</span>
            <select
              className="repo-dashboard-field"
              value={chartMode}
              onChange={e => setChartMode(e.target.value as ActivityChartMode)}
              aria-label="Activity chart mode"
            >
              {CHART_MODES.map(mode => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          <label className="repo-dashboard-activity-control font-mono" htmlFor={contributorSelectId}>
            <span>Contributor</span>
            <select
              id={contributorSelectId}
              className="repo-dashboard-field"
              value={contributorId}
              onChange={e => setContributorId(e.target.value)}
              aria-label="Contributor filter"
            >
              <option value="all">All contributors</option>
              {allStats.map(stat => (
                <option key={stat.id} value={stat.id}>
                  {stat.displayName} ({stat.commitCount})
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {!commits.length ? (
        <p className="text-muted small" role="status">
          No commits in loaded local git history.
        </p>
      ) : (
        <>
          <ActivityInsightsChart points={series} mode={chartMode} />
          {selectedStat ? (
            <div className="repo-dashboard-contributor-focus">
              <h3 className="font-mono repo-dashboard-contributor-focus-name">
                {selectedStat.displayName}
              </h3>
              <ContributorDetail stat={selectedStat} />
            </div>
          ) : allStats.length ? (
            <div className="repo-dashboard-contributors-table-wrap">
              <table className="repo-dashboard-contributors-table font-mono">
                <thead>
                  <tr>
                    <th scope="col">Contributor</th>
                    <th scope="col">Commits</th>
                    <th scope="col">Share</th>
                    <th scope="col">Active</th>
                    <th scope="col">Merges</th>
                    <th scope="col">Types</th>
                    <th scope="col">Scopes</th>
                  </tr>
                </thead>
                <tbody>
                  {allStats.map(stat => (
                    <tr
                      key={stat.id}
                      className={
                        contributorId === stat.id ? "repo-dashboard-contributor-row-selected" : ""
                      }
                    >
                      <td>
                        <button
                          type="button"
                          className="repo-dashboard-contributor-pick"
                          aria-pressed={contributorId === stat.id}
                          onClick={() => setContributorId(stat.id)}
                        >
                          {stat.displayName}
                        </button>
                      </td>
                      <td>{stat.commitCount}</td>
                      <td>{stat.percentage}%</td>
                      <td>
                        {formatContributorDate(stat.firstCommitAt)} →{" "}
                        {formatContributorDate(stat.latestCommitAt)}
                      </td>
                      <td>{stat.mergeCommitCount}</td>
                      <td>{contributorTopTypes(stat) || "—"}</td>
                      <td>{contributorTopScopes(stat) || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}

      <p className="text-muted small repo-dashboard-footnote">
        {commits.length.toLocaleString()} commits loaded from local git
        {commitsTruncated ? " (older commits omitted — output limit)." : "."}
        {filteredCommits.length !== commits.length ? (
          <>
            {" "}
            Showing {filteredCommits.length.toLocaleString()} in the current range
            {contributorId !== "all" ? " and contributor filter" : ""}.
          </>
        ) : null}
      </p>
    </section>
  );
}
