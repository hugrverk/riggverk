import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoDashboardTool } from "./RepoDashboardTool";
import { RepoWorkWorkspace } from "./RepoWorkWorkspace";
import type { AppSettings, RepoDashboardEntry, RepoDashboardSnapshot, RepoDashboardWorkItem } from "../../types";

const invokeMock = vi.fn();
const openMock = vi.fn();
const isTauriMock = vi.fn(() => true);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => isTauriMock(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

const savedEntry: RepoDashboardEntry = {
  id: "repo-example",
  label: "example",
  path: "/tmp/example-repo",
  default_branch: "develop",
};

const snapshot: RepoDashboardSnapshot = {
  repo_path: "/tmp/example-repo",
  branch: "develop",
  default_branch: "develop",
  latest_commit: null,
  commits: [],
  commits_truncated: false,
  changed_files: [],
  docs: [],
  docs_source: "local",
  docs_ref: null,
  docs_stale: false,
  warnings: [],
  gh: {
    available: false,
    authenticated: false,
    open_issues: [],
    merged_prs: [],
    message: null,
  },
};

describe("RepoDashboardTool", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    isTauriMock.mockReturnValue(true);
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_repo_dashboard_snapshot") {
        return Promise.resolve(snapshot);
      }
      return Promise.resolve({ repos: [], warnings: [] });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render obsolete switcher or gh sidebar status", () => {
    const { container } = render(<RepoDashboardTool />);
    expect(container.querySelector(".tools-switcher")).toBeNull();
    expect(container.querySelector(".tool-sidebar-footer")).toBeNull();
    expect(container.querySelector(".tool-sidebar-status")).toBeNull();
    expect(container.querySelector(".repo-dashboard-sidebar")).toBeNull();
    expect(screen.queryByText(/gh:\s*enhanced/i)).toBeNull();
    expect(screen.queryByText(/gh:\s*local-only/i)).toBeNull();
  });

  it("renders section tabs and narrow fallback select", () => {
    render(<RepoDashboardTool />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: /Overview/ })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /Work/ })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /Docs/ })).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Dashboard section" })).not.toBeNull();
  });

  it("switches sections from tabs", () => {
    render(<RepoDashboardTool />);
    const workTab = screen.getByRole("tab", { name: /Work/ });
    fireEvent.click(workTab);
    expect(workTab.getAttribute("aria-selected")).toBe("true");
    const docsTab = screen.getByRole("tab", { name: /Docs/ });
    fireEvent.click(docsTab);
    expect(docsTab.getAttribute("aria-selected")).toBe("true");
  });

  it("renders default branch override input", () => {
    render(<RepoDashboardTool />);
    expect(screen.getByLabelText("Default branch override")).not.toBeNull();
  });

  it("editing branch state changes the input", () => {
    render(<RepoDashboardTool />);
    const branchInput = screen.getByLabelText("Default branch override") as HTMLInputElement;
    fireEvent.change(branchInput, { target: { value: "release/1.2" } });
    expect(branchInput.value).toBe("release/1.2");
  });

  it("refresh sends the branch to get_repo_dashboard_snapshot", async () => {
    render(<RepoDashboardTool />);
    const pathInput = screen.getByLabelText("Local repository path");
    fireEvent.change(pathInput, { target: { value: "/tmp/example-repo" } });
    const branchInput = screen.getByLabelText("Default branch override");
    fireEvent.change(branchInput, { target: { value: "develop" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_repo_dashboard_snapshot", {
        repoPath: "/tmp/example-repo",
        defaultBranch: "develop",
        includeGh: true,
      });
    });
  });

  it("save persists default_branch", async () => {
    const mutateSavedEntries = vi.fn(async (mutator: (current: AppSettings) => AppSettings) =>
      mutator({
        workspace_path: null,
        enabled_target_ids: [],
        appearance: "system",
        accent_color: null,
        background_color: null,
        foreground_color: null,
        repo_dashboard_entries: [],
        active_repo_dashboard_id: null,
        revision: 0,
      }),
    );
    render(
      <RepoDashboardTool
        mutateSavedEntries={mutateSavedEntries}
      />,
    );
    fireEvent.change(screen.getByLabelText("Local repository path"), {
      target: { value: "/tmp/example-repo" },
    });
    fireEvent.change(screen.getByLabelText("Default branch override"), {
      target: { value: "develop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save repository path to settings" }));
    await waitFor(() => expect(mutateSavedEntries).toHaveBeenCalled());
    const next = mutateSavedEntries.mock.calls[0][0]({
      workspace_path: null,
      enabled_target_ids: [],
      appearance: "system",
      accent_color: null,
      background_color: null,
      foreground_color: null,
      repo_dashboard_entries: [],
      active_repo_dashboard_id: null,
      revision: 0,
    });
    expect(next.repo_dashboard_entries[0]?.default_branch).toBe("develop");
  });

  it("saved repo selection restores the branch", async () => {
    render(
      <RepoDashboardTool
        savedEntries={[savedEntry]}
        activeEntryId={savedEntry.id}
      />,
    );
    await waitFor(() => {
      const branchInput = screen.getByLabelText("Default branch override") as HTMLInputElement;
      expect(branchInput.value).toBe("develop");
    });
  });

  it("renders discover action", () => {
    render(<RepoDashboardTool />);
    expect(screen.getByRole("button", { name: /Discover local git repositories/i })).not.toBeNull();
  });

  it("discover invokes the folder picker and opens the panel", async () => {
    openMock.mockResolvedValue("/tmp/projects");
    render(<RepoDashboardTool />);
    fireEvent.click(screen.getByRole("button", { name: /Discover local git repositories/i }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Discover local repositories" })).not.toBeNull();
    });
  });
});

describe("RepoWorkWorkspace gh enrichment", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders GitHub-sourced work items when supplied", () => {
    const ghIssue: RepoDashboardWorkItem = {
      workId: "GH-42",
      type: "todo",
      text: "Fix pagination edge case",
      source: "github",
      path: "issues/42",
      line: null,
      area: null,
      priority: "high",
      status: "open",
      nextAction: null,
      verification: null,
    };
    render(
      <RepoWorkWorkspace
        items={[ghIssue]}
        totalItemCount={1}
        canonicalMode={true}
        sourceFilter="all"
        priorityFilter="all"
        typeFilter="all"
        workTypes={["todo"]}
        canonicalSummary={{
          displayed: 1,
          total: 1,
          bugs: 0,
          verify: 0,
          enhancements: 0,
          other: 1,
        }}
        onSourceFilterChange={() => {}}
        onPriorityFilterChange={() => {}}
        onTypeFilterChange={() => {}}
        onResetFilters={() => {}}
        emptyMessage="No work items."
      />,
    );
    expect(screen.getByText("Fix pagination edge case")).not.toBeNull();
    expect(screen.getByText("GitHub")).not.toBeNull();
  });
});
