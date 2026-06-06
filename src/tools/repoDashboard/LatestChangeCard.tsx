import { useState } from "react";
import type {
  RepoCommitEntry,
  RepoDashboardSnapshot,
  RepoGhPullRequest,
} from "../../types";
import {
  authorLabel,
  buildHeadFileStatusBreakdown,
  formatAheadBehind,
  formatRelativeAgeFromIso,
  formatRelativeAgeFromUnix,
  prBodyExcerpt,
  summarizeHeadFileBreakdown,
} from "./model";

export function LatestChangeCard({
  snapshot,
  latestMerge,
  latestCommit,
}: {
  snapshot: RepoDashboardSnapshot;
  latestMerge: RepoGhPullRequest | null;
  latestCommit: RepoCommitEntry | null;
}) {
  const [prBodyOpen, setPrBodyOpen] = useState(false);
  const branchLabel = snapshot.branch || snapshot.default_branch || "—";
  const aheadBehind = formatAheadBehind(snapshot.ahead, snapshot.behind);
  const upstreamLabel = snapshot.default_branch?.trim() || "—";
  const fileBreakdown = buildHeadFileStatusBreakdown(snapshot.changed_files);
  const worktreeState = snapshot.dirty ? "dirty working tree" : "clean working tree";

  if (!latestCommit && !latestMerge) {
    return (
      <p className="text-muted small" role="status">
        No local commit or GitHub merge data in this snapshot. Refresh after selecting a git
        repository.
      </p>
    );
  }

  return (
    <div className="repo-dashboard-latest-content">
      {latestCommit ? (
        <section className="repo-dashboard-latest-block" aria-label="Local HEAD">
          <header className="repo-dashboard-latest-hero">
            <div className="repo-dashboard-latest-hero-top">
              <span className="repo-dashboard-source-pill">local HEAD</span>
              {latestCommit.is_merge ? (
                <span className="repo-dashboard-latest-badge">merge commit</span>
              ) : null}
              <span
                className={`repo-dashboard-latest-badge repo-dashboard-latest-badge-${snapshot.dirty ? "dirty" : "clean"}`}
              >
                {snapshot.dirty ? "dirty" : "clean"}
              </span>
            </div>
            <h3 className="font-mono repo-dashboard-latest-headline">{latestCommit.subject}</h3>
          </header>
          <div className="repo-dashboard-latest-meta-row font-mono">
            <span className="repo-dashboard-latest-sha">{latestCommit.short_sha}</span>
            <span>{authorLabel(latestCommit)}</span>
            <time dateTime={new Date(latestCommit.authored_at * 1000).toISOString()}>
              {new Date(latestCommit.authored_at * 1000).toLocaleString()}
            </time>
            <span className="text-muted">
              {formatRelativeAgeFromUnix(latestCommit.authored_at)}
            </span>
          </div>
          <p className="repo-dashboard-latest-state-summary font-mono text-muted small">
            {branchLabel}
            {aheadBehind ? ` · ${aheadBehind}` : ""}
            {fileBreakdown.total
              ? ` · ${fileBreakdown.total} HEAD file${fileBreakdown.total === 1 ? "" : "s"}`
              : ""}
            {" · "}
            {worktreeState}
          </p>
          <div className="repo-dashboard-latest-state-columns">
            <dl className="repo-dashboard-latest-facts-grid font-mono">
              <div>
                <dt>Branch</dt>
                <dd className="repo-dashboard-latest-fact-value">{branchLabel}</dd>
              </div>
              <div>
                <dt>Upstream</dt>
                <dd className="repo-dashboard-latest-fact-value">{upstreamLabel}</dd>
              </div>
              <div>
                <dt>Sync</dt>
                <dd className="repo-dashboard-latest-fact-value">
                  {aheadBehind || "no upstream tracking"}
                </dd>
              </div>
              <div>
                <dt>Worktree</dt>
                <dd className="repo-dashboard-latest-fact-value">{worktreeState}</dd>
              </div>
            </dl>
            <dl className="repo-dashboard-latest-facts-grid font-mono">
              <div>
                <dt>HEAD files</dt>
                <dd className="repo-dashboard-latest-fact-value">{fileBreakdown.total}</dd>
              </div>
              <div>
                <dt>Changed status</dt>
                <dd className="repo-dashboard-latest-fact-value">
                  {fileBreakdown.total ? summarizeHeadFileBreakdown(fileBreakdown) : "none staged"}
                </dd>
              </div>
            </dl>
          </div>
          {fileBreakdown.total ? (
            <div className="repo-dashboard-latest-status-badges font-mono" aria-label="File status breakdown">
              {fileBreakdown.added ? (
                <span className="repo-dashboard-latest-status added">+{fileBreakdown.added}</span>
              ) : null}
              {fileBreakdown.modified ? (
                <span className="repo-dashboard-latest-status modified">~{fileBreakdown.modified}</span>
              ) : null}
              {fileBreakdown.deleted ? (
                <span className="repo-dashboard-latest-status deleted">−{fileBreakdown.deleted}</span>
              ) : null}
              {fileBreakdown.other ? (
                <span className="repo-dashboard-latest-status other">?{fileBreakdown.other}</span>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {latestMerge ? (
        <section
          className="repo-dashboard-latest-block repo-dashboard-latest-gh"
          aria-label="Recent GitHub merged pull request"
        >
          <header className="repo-dashboard-latest-hero">
            <div className="repo-dashboard-latest-hero-top">
              <span className="repo-dashboard-source-pill">gh merge</span>
            </div>
            <h3 className="font-mono repo-dashboard-latest-headline">
              <span className="repo-dashboard-latest-pr-num">#{latestMerge.number}</span>{" "}
              {latestMerge.title}
            </h3>
          </header>
          <div className="repo-dashboard-latest-meta-row font-mono">
            <span>{latestMerge.author}</span>
            <time dateTime={latestMerge.merged_at}>
              {new Date(latestMerge.merged_at).toLocaleString()}
            </time>
            <span className="text-muted">{formatRelativeAgeFromIso(latestMerge.merged_at)}</span>
          </div>
          {latestMerge.body?.trim() ? (
            <div className="repo-dashboard-latest-pr-body">
              <p
                className={`repo-dashboard-latest-pr-excerpt text-muted small${
                  prBodyOpen ? " repo-dashboard-latest-pr-excerpt-expanded" : ""
                }`}
              >
                {prBodyOpen ? latestMerge.body.trim() : prBodyExcerpt(latestMerge.body)}
              </p>
              {latestMerge.body.trim().length > 240 ? (
                <button
                  type="button"
                  className="repo-dashboard-btn repo-dashboard-btn-secondary repo-dashboard-latest-pr-toggle"
                  aria-expanded={prBodyOpen}
                  onClick={() => setPrBodyOpen(open => !open)}
                >
                  {prBodyOpen ? "Show less" : "Show full body"}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : snapshot.gh.available && !snapshot.gh.authenticated ? (
        <p className="text-muted small repo-dashboard-gh-note" role="status">
          gh CLI present but not authenticated — showing local git only.
        </p>
      ) : null}
    </div>
  );
}
