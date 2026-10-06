import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoCommitEntry } from "../../types";
import { RepoActivityInsights, type ActivityInsightsMetrics } from "./RepoActivityInsights";

const metrics: ActivityInsightsMetrics = {
  docsFound: 0,
  docsTotal: 0,
  headFileCount: 0,
  commitsLoaded: 0,
  docOpenCount: 0,
  workOpenCount: 0,
  ghIssuesValue: null,
  ghIssuesLabel: "gh issues",
  needsPlanningCount: 0,
};

function commit(sha: string, author: string, daysAgo: number): RepoCommitEntry {
  return {
    sha,
    short_sha: sha.slice(0, 7),
    author_name: author,
    author_email: `${author.toLowerCase()}@example.test`,
    authored_at: Math.floor((Date.now() - daysAgo * 86_400_000) / 1000),
    subject: `commit ${sha}`,
    is_merge: false,
  };
}

function renderInsights(commits: RepoCommitEntry[]) {
  return render(
    <RepoActivityInsights
      commits={commits}
      commitsTruncated={false}
      heatmapCells={[]}
      metrics={metrics}
      onNavigate={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RepoActivityInsights", () => {
  it("renders a chart whose peak is one commit without duplicate React keys", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    renderInsights([commit("aaaaaaa1", "Ada", 0)]);

    const keyWarnings = errors.mock.calls.filter(call => String(call[0]).includes("same key"));
    expect(keyWarnings).toEqual([]);
  });

  it("disables the toggle for contributors with no commits in the range", () => {
    renderInsights([commit("aaaaaaa1", "Ada", 0), commit("bbbbbbb1", "Old", 60)]);

    const active = screen.getByRole("button", { name: "Hide Ada on chart" }) as HTMLButtonElement;
    expect(active.disabled).toBe(false);
    const idle = screen.getByRole("button", { name: "Old has no commits in this range" }) as HTMLButtonElement;
    expect(idle.disabled).toBe(true);
    expect(idle.textContent).toContain("Idle");
  });

  it("disables Show all when every charted contributor is visible and re-enables it after hiding one", () => {
    renderInsights([commit("aaaaaaa1", "Ada", 0), commit("bbbbbbb1", "Old", 60)]);
    const showAll = screen.getByRole("button", { name: "Show all" }) as HTMLButtonElement;
    expect(showAll.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Hide Ada on chart" }));
    expect(showAll.disabled).toBe(false);

    fireEvent.click(showAll);
    expect(showAll.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Hide Ada on chart" })).not.toBeNull();
  });
});
