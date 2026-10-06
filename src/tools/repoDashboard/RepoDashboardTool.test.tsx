import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  git_available: true,
  is_repo: true,
  branch: "develop",
  default_branch: "develop",
  dirty: false,
  ahead: null,
  behind: null,
  latest_commit: null,
  commits: [],
  commits_truncated: false,
  changed_files: [],
  docs: [],
  docs_source: "local-fallback",
  docs_ref: "HEAD",
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

const baseSettings: AppSettings = {
  workspace_path: null,
  enabled_target_ids: [],
  enabled_harness_ids: ["codex", "opencode", "claude", "cursor"],
  appearance: "system",
  app_font_size: "medium",
  accent_color: null,
  background_color: null,
  foreground_color: null,
  reduce_motion: false,
  landing_view: "start",
  repo_dashboard_entries: [],
  active_repo_dashboard_id: null,
  revision: 0,
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
      if (command === "discover_local_git_repos") {
        return Promise.resolve({ repos: [], warnings: [] });
      }
      // Anything else is a contract drift: fail loudly instead of answering with a made-up shape.
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
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
      mutator(baseSettings),
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
    const next = mutateSavedEntries.mock.calls[0][0](baseSettings);
    expect(next.repo_dashboard_entries?.[0]?.default_branch).toBe("develop");
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

  it("discover invokes the folder picker and opens the panel", async () => {
    openMock.mockResolvedValue("/tmp/projects");
    render(<RepoDashboardTool />);
    fireEvent.click(screen.getByRole("button", { name: /Discover local git repositories/i }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Discover local repositories" })).not.toBeNull();
    });
    expect(invokeMock).toHaveBeenCalledWith("discover_local_git_repos", { parentPath: "/tmp/projects" });
  });

  it("shows data for a ~ path even though the backend echoes the expanded path", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_repo_dashboard_snapshot") {
        return Promise.resolve({ ...snapshot, repo_path: "/Users/dev/example-repo" });
      }
      return Promise.resolve({ repos: [], warnings: [] });
    });
    render(<RepoDashboardTool />);
    fireEvent.change(screen.getByLabelText("Local repository path"), { target: { value: "~/example-repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));

    await waitFor(() => expect(screen.getByText("Latest merge / commit")).not.toBeNull());
    expect(screen.queryByText("Path changed")).toBeNull();
  });

  it("flags a snapshot as outdated once the path is edited", async () => {
    render(<RepoDashboardTool />);
    fireEvent.change(screen.getByLabelText("Local repository path"), { target: { value: "/tmp/example-repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await waitFor(() => expect(screen.getByText("Latest merge / commit")).not.toBeNull());

    fireEvent.change(screen.getByLabelText("Local repository path"), { target: { value: "/tmp/other-repo" } });
    expect(screen.getByText("Path changed")).not.toBeNull();
  });

  it("shows a save failure as a save error, not as a sync failure", async () => {
    const mutateSavedEntries = vi.fn(async () => {
      throw new Error("settings conflict");
    });
    render(<RepoDashboardTool mutateSavedEntries={mutateSavedEntries} />);
    fireEvent.change(screen.getByLabelText("Local repository path"), { target: { value: "/tmp/example-repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save repository path to settings" }));

    await waitFor(() => expect(screen.getByText("Save failed")).not.toBeNull());
    expect(screen.queryByText("Sync failed")).toBeNull();
  });

  it("does not overwrite a saved repo with the same folder name but a different path", async () => {
    const mutateSavedEntries = vi.fn(async (mutator: (current: AppSettings) => AppSettings) =>
      mutator(baseSettings),
    );
    render(<RepoDashboardTool mutateSavedEntries={mutateSavedEntries} />);
    fireEvent.change(screen.getByLabelText("Local repository path"), { target: { value: "/b/example-repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save repository path to settings" }));
    await waitFor(() => expect(mutateSavedEntries).toHaveBeenCalled());

    const current: AppSettings = {
      ...baseSettings,
      repo_dashboard_entries: [{ id: "example-repo", label: "example-repo", path: "/a/example-repo" }],
    };
    const next = mutateSavedEntries.mock.calls[0][0](current);
    expect(next.repo_dashboard_entries).toEqual([
      { id: "example-repo", label: "example-repo", path: "/a/example-repo" },
      { id: "example-repo-2", label: "example-repo", path: "/b/example-repo", default_branch: null },
    ]);
    expect(next.active_repo_dashboard_id).toBe("example-repo-2");
  });

  it("clears the saved status after a short delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const mutateSavedEntries = vi.fn(async (mutator: (current: AppSettings) => AppSettings) =>
        mutator(baseSettings),
      );
      render(<RepoDashboardTool mutateSavedEntries={mutateSavedEntries} />);
      fireEvent.change(screen.getByLabelText("Local repository path"), { target: { value: "/tmp/example-repo" } });
      fireEvent.click(screen.getByRole("button", { name: "Save repository path to settings" }));
      await waitFor(() => expect(document.body.textContent).toContain("· saved"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(document.body.textContent).not.toContain("· saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the results of the latest discover scan when an older scan resolves late", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    let scans = 0;
    invokeMock.mockImplementation((command: string, args?: { parentPath?: string }) => {
      if (command === "discover_local_git_repos") {
        scans += 1;
        if (scans === 1) {
          return new Promise(resolve => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          repos: [{ label: "fresh-repo", path: `${args?.parentPath}/fresh-repo` }],
          warnings: [],
        });
      }
      return Promise.resolve(snapshot);
    });
    openMock.mockResolvedValueOnce("/tmp/first").mockResolvedValueOnce("/tmp/second");

    render(<RepoDashboardTool />);
    const discoverButton = screen.getByRole("button", { name: /Discover local git repositories/i });
    fireEvent.click(discoverButton);
    await waitFor(() => expect(scans).toBe(1));
    // Cancel while the first scan is still running, then start another one.
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.click(discoverButton);
    await waitFor(() => expect(scans).toBe(2));
    await waitFor(() => expect(screen.getByText("fresh-repo")).not.toBeNull());

    await act(async () => {
      resolveFirst({ repos: [{ label: "stale-repo", path: "/tmp/first/stale-repo" }], warnings: [] });
    });

    expect(screen.queryByText("stale-repo")).toBeNull();
    expect(screen.getByText("fresh-repo")).not.toBeNull();
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
      source: "issue",
      path: "issues/42",
      priority: "high",
      status: "open",
      needsPlan: false,
    };
    const { container } = render(
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
    // The source badge on the card (the filter dropdown also lists "GitHub").
    expect(container.querySelector(".repo-dashboard-chip.todo")?.textContent).toBe("GitHub");
  });
});
