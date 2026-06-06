import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoDashboardTool } from "./RepoDashboardTool";
import { RepoWorkWorkspace } from "./RepoWorkWorkspace";
import type { RepoDashboardWorkItem } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

describe("RepoDashboardTool", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not render obsolete switcher or gh sidebar status", () => {
    const { container } = render(<RepoDashboardTool />);
    expect(container.querySelector(".tools-switcher")).toBeNull();
    expect(container.querySelector(".tool-sidebar-footer")).toBeNull();
    expect(container.querySelector(".tool-sidebar-status")).toBeNull();
    expect(screen.queryByText(/gh:\s*enhanced/i)).toBeNull();
    expect(screen.queryByText(/gh:\s*local-only/i)).toBeNull();
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
