import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { RepoCommitEntry } from "../../types";
import {
  activityInsightsChartValue,
  buildActivityInsightsSeries,
  buildContributorStats,
  contributorTopScopes,
  contributorTopTypes,
  filterCommitsByContributor,
  filterCommitsForActivityInsights,
  type ActivityInsightsPoint,
  type ContributorStat,
} from "./model";

function formatContributorDate(timestamp: number | null): string {
  if (timestamp == null) return "—";
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    year: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function ActivityInsightsChart({ points }: { points: ActivityInsightsPoint[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const chartTitleId = useId();

  const values = useMemo(
    () => points.map(point => activityInsightsChartValue(point, "period")),
    [points],
  );
  const max = Math.max(1, ...values);

  const w = 820;
  const h = 300;
  const L = 40;
  const R = 16;
  const T = 20;
  const B = 52;

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

  const every = Math.max(1, Math.ceil(points.length / 8));
  const activePoint = activeIndex != null ? points[activeIndex] : null;
  const activeValue =
    activePoint != null ? activityInsightsChartValue(activePoint, "period") : null;

  if (!points.length) {
    return (
      <p className="text-muted small" role="status">
        No commits in the last 90 days.
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
        <title id={chartTitleId}>Commits per day — last 90 days</title>
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
        {points.map((point, index) => {
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
        })}
        {points.map((point, index) =>
          index % every === 0 || index === points.length - 1 ? (
            <text
              key={`${point.date}-label`}
              className="repo-dashboard-chart-text"
              x={xAt(index)}
              y={h - 16}
              textAnchor="middle"
            >
              {point.date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      {activePoint ? (
        <p className="repo-dashboard-activity-tooltip font-mono" role="status" aria-live="polite">
          {activePoint.date}: {activeValue} commits
        </p>
      ) : null}
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
  const [contributorId, setContributorId] = useState<"all" | string>("all");

  const allStats = useMemo(() => buildContributorStats(commits), [commits]);
  const rangeCommits = useMemo(() => filterCommitsForActivityInsights(commits), [commits]);
  const filteredCommits = useMemo(
    () => filterCommitsByContributor(rangeCommits, contributorId),
    [rangeCommits, contributorId],
  );
  const series = useMemo(() => buildActivityInsightsSeries(filteredCommits), [filteredCommits]);

  useEffect(() => {
    if (contributorId === "all") return;
    if (!allStats.some(stat => stat.id === contributorId)) {
      setContributorId("all");
    }
  }, [allStats, contributorId]);

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
          <p className="text-muted small repo-dashboard-activity-insights-meta">
            90-day local git activity
          </p>
        </div>
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

      {!commits.length ? (
        <p className="text-muted small" role="status">
          No commits in loaded local git history.
        </p>
      ) : (
        <div className="repo-dashboard-activity-insights-body">
          <ActivityInsightsChart points={series} />
          {selectedStat ? (
            <div className="repo-dashboard-contributor-panel repo-dashboard-contributor-panel-detail">
              <h3 className="font-mono repo-dashboard-contributor-focus-name">
                {selectedStat.displayName}
              </h3>
              <ContributorDetail stat={selectedStat} />
            </div>
          ) : allStats.length ? (
            <div className="repo-dashboard-contributor-panel">
              <div className="repo-dashboard-contributors-table-wrap">
                <table className="repo-dashboard-contributors-table font-mono">
                  <thead>
                    <tr>
                      <th scope="col">Contributor</th>
                      <th scope="col">Commits</th>
                      <th scope="col">Share</th>
                      <th scope="col">Merges</th>
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
                        <td>{stat.mergeCommitCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
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
