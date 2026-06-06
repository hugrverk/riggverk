import type { RepoCommitEntry } from "../../types";
import {
  buildContributorStats,
  contributorTopScopes,
  contributorTopTypes,
} from "./model";

function formatContributorDate(timestamp: number | null): string {
  if (timestamp == null) return "—";
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    year: "2-digit",
    month: "short",
    day: "numeric",
  });
}

export function ContributorStatsPanel({ commits }: { commits: RepoCommitEntry[] }) {
  const stats = buildContributorStats(commits);

  if (!stats.length) {
    return (
      <div className="repo-dashboard-card repo-dashboard-contributors-card">
        <h2 className="font-mono">Contributor activity</h2>
        <p className="text-muted small" role="status">
          No commits in the loaded local git history.
        </p>
      </div>
    );
  }

  return (
    <div className="repo-dashboard-card repo-dashboard-contributors-card">
      <h2 className="font-mono">Contributor activity</h2>
      <p className="text-muted small repo-dashboard-contributors-note">
        Based on loaded local git history and commit subjects only — not effort, ownership, or code
        quality.
      </p>
      <div className="repo-dashboard-contributors-table-wrap">
        <table className="repo-dashboard-contributors-table font-mono">
          <thead>
            <tr>
              <th scope="col">Contributor</th>
              <th scope="col">Commits</th>
              <th scope="col">Share</th>
              <th scope="col">Active</th>
              <th scope="col">Common types</th>
              <th scope="col">Common scopes</th>
            </tr>
          </thead>
          <tbody>
            {stats.map(stat => (
              <tr key={stat.id}>
                <td>{stat.displayName}</td>
                <td>{stat.commitCount}</td>
                <td>{stat.percentage}%</td>
                <td>
                  {formatContributorDate(stat.firstCommitAt)} →{" "}
                  {formatContributorDate(stat.latestCommitAt)}
                </td>
                <td>{contributorTopTypes(stat) || "—"}</td>
                <td>{contributorTopScopes(stat) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
