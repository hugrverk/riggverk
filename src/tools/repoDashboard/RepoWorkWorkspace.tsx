import { useState } from "react";
import type {
  RepoDashboardWorkItem,
  RepoDashboardWorkType,
} from "../../types";
import { isPromptContextEligibleWorkItem } from "../promptLoops/contextHandoff";
import type { DocWorkLaneId, DocWorkLaneSummary } from "./model";
import { activeWorkCount, partitionWorkItems, type WorkPartition } from "./model";

const WORK_ITEMS_DISPLAY_CAP = 120;

type WorkLaneView = "active" | "done";

function WorkItemsList({
  items,
  emptyMessage = "No matching items found.",
  onUsePromptContext,
  startedVisual = false,
}: {
  items: RepoDashboardWorkItem[];
  emptyMessage?: string;
  onUsePromptContext?: (item: RepoDashboardWorkItem) => void;
  startedVisual?: boolean;
}) {
  if (!items.length) {
    return <p className="text-muted small" role="status">{emptyMessage}</p>;
  }
  const shown = items.slice(0, WORK_ITEMS_DISPLAY_CAP);
  const truncated = items.length > WORK_ITEMS_DISPLAY_CAP;
  return (
    <>
      {truncated ? (
        <p className="text-muted small repo-dashboard-list-cap" role="status">
          Showing first {WORK_ITEMS_DISPLAY_CAP} of {items.length} items.
        </p>
      ) : null}
      <div className="repo-dashboard-list">
        {shown.map((item, index) => (
          <div
            key={`${item.source}-${item.path}-${item.line ?? 0}-${index}`}
            className={`repo-dashboard-work-item${startedVisual ? " repo-dashboard-work-item-started" : ""}`}
          >
            <div className="repo-dashboard-work-head">
              <span className={`repo-dashboard-chip ${item.type}`}>{item.type}</span>
              <span className="repo-dashboard-work-status">{item.status}</span>
              {item.needsPlan ? (
                <span className="repo-dashboard-chip todo">needs planning</span>
              ) : null}
            </div>
            <div className="repo-dashboard-work-text font-mono">{item.text}</div>
            <div className="repo-dashboard-work-loc text-muted">
              {item.source} · {item.path}
              {item.line ? `:${item.line}` : ""}
            </div>
            {onUsePromptContext && isPromptContextEligibleWorkItem(item) ? (
              <div className="repo-dashboard-work-actions">
                <button
                  type="button"
                  className="repo-dashboard-btn repo-dashboard-btn-secondary repo-dashboard-use-context-btn"
                  onClick={() => onUsePromptContext(item)}
                  aria-label={`Use this ${item.type} item as Prompt Loops context`}
                >
                  Use as context
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

export interface RepoWorkWorkspaceProps {
  items: RepoDashboardWorkItem[];
  totalItemCount: number;
  laneFilter: DocWorkLaneId | "all";
  typeFilter: RepoDashboardWorkType | "all";
  docLaneSummaries: DocWorkLaneSummary[];
  workTypes: RepoDashboardWorkType[];
  onLaneFilterChange: (lane: DocWorkLaneId | "all") => void;
  onTypeFilterChange: (type: RepoDashboardWorkType | "all") => void;
  onResetFilters: () => void;
  onUsePromptContext?: (item: RepoDashboardWorkItem) => void;
  emptyMessage: string;
}

export function RepoWorkWorkspace({
  items,
  totalItemCount,
  laneFilter,
  typeFilter,
  docLaneSummaries,
  workTypes,
  onLaneFilterChange,
  onTypeFilterChange,
  onResetFilters,
  onUsePromptContext,
  emptyMessage,
}: RepoWorkWorkspaceProps) {
  const [laneView, setLaneView] = useState<WorkLaneView>("active");

  const partition: WorkPartition = partitionWorkItems(items);
  const displayedCount =
    partition.activeStarted.length + partition.activeOpen.length + partition.done.length;
  const filtersActive = laneFilter !== "all" || typeFilter !== "all";

  return (
    <div className="repo-dashboard-work-workspace">
      <header className="repo-dashboard-page-head">
        <h2 className="font-mono repo-dashboard-page-title">Work</h2>
        <p className="text-muted small repo-dashboard-page-desc">
          Open and started items from docs and gh issues. Use filters to narrow by lane or type.
        </p>
        <div className="repo-dashboard-page-toolbar">
          <div className="repo-dashboard-toolbar" role="group" aria-label="Work view">
            <button
              type="button"
              className={`repo-dashboard-seg${laneView === "active" ? " active" : ""}`}
              aria-pressed={laneView === "active"}
              onClick={() => setLaneView("active")}
            >
              Active ({activeWorkCount(partition)})
            </button>
            <button
              type="button"
              className={`repo-dashboard-seg${laneView === "done" ? " active" : ""}`}
              aria-pressed={laneView === "done"}
              onClick={() => setLaneView("done")}
            >
              Done ({partition.done.length})
            </button>
          </div>
          <div className="repo-dashboard-work-filters font-mono">
            <label className="repo-dashboard-work-filter">
              <span className="repo-dashboard-work-filter-label">Lane</span>
              <select
                className="repo-dashboard-field repo-dashboard-work-filter-select"
                value={laneFilter}
                onChange={e => onLaneFilterChange(e.target.value as DocWorkLaneId | "all")}
                aria-label="Filter by doc lane"
              >
                <option value="all">All lanes</option>
                {docLaneSummaries.map(lane => (
                  <option key={lane.id} value={lane.id}>
                    {lane.label} ({lane.open + lane.started})
                  </option>
                ))}
              </select>
            </label>
            <label className="repo-dashboard-work-filter">
              <span className="repo-dashboard-work-filter-label">Type</span>
              <select
                className="repo-dashboard-field repo-dashboard-work-filter-select"
                value={typeFilter}
                onChange={e =>
                  onTypeFilterChange(e.target.value as RepoDashboardWorkType | "all")
                }
                aria-label="Filter by work type"
              >
                <option value="all">All types</option>
                {workTypes.map(type => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            {filtersActive ? (
              <button
                type="button"
                className="repo-dashboard-btn repo-dashboard-btn-secondary repo-dashboard-filter-reset"
                onClick={onResetFilters}
              >
                Clear
              </button>
            ) : null}
          </div>
          <p className="repo-dashboard-filter-summary font-mono text-muted small" role="status">
            {displayedCount} of {totalItemCount} items
            {laneView === "active"
              ? ` · started ${partition.activeStarted.length} · open ${partition.activeOpen.length}`
              : ` · done ${partition.done.length}`}
          </p>
        </div>
      </header>

      {laneView === "active" ? (
        <div className="repo-dashboard-work-columns">
          <section
            className="repo-dashboard-work-column"
            aria-label="Started work"
            aria-labelledby="repo-dashboard-work-started-title"
          >
            <h3 id="repo-dashboard-work-started-title" className="font-mono repo-dashboard-work-column-title">
              Started ({partition.activeStarted.length})
            </h3>
            <div
              className="repo-dashboard-work-column-scroll"
              role="region"
              aria-label="Started work items"
              tabIndex={0}
            >
              <WorkItemsList
                items={partition.activeStarted}
                onUsePromptContext={onUsePromptContext}
                startedVisual
                emptyMessage={
                  filtersActive
                    ? "No started items match the current filters."
                    : "No started work items."
                }
              />
            </div>
          </section>

          <section
            className="repo-dashboard-work-column"
            aria-label="Open work"
            aria-labelledby="repo-dashboard-work-open-title"
          >
            <h3 id="repo-dashboard-work-open-title" className="font-mono repo-dashboard-work-column-title">
              Open ({partition.activeOpen.length})
            </h3>
            <div
              className="repo-dashboard-work-column-scroll"
              role="region"
              aria-label="Open work items"
              tabIndex={0}
            >
              <WorkItemsList
                items={partition.activeOpen}
                onUsePromptContext={onUsePromptContext}
                emptyMessage={
                  filtersActive
                    ? "No open items match the current filters."
                    : "No open work items."
                }
              />
            </div>
          </section>
        </div>
      ) : (
        <section
          className="repo-dashboard-work-column repo-dashboard-work-column-done"
          aria-label="Done work"
          aria-labelledby="repo-dashboard-work-done-title"
        >
          <h3 id="repo-dashboard-work-done-title" className="font-mono repo-dashboard-work-column-title">
            Done ({partition.done.length})
          </h3>
          <div
            className="repo-dashboard-work-column-scroll"
            role="region"
            aria-label="Done work items"
            tabIndex={0}
          >
            <WorkItemsList
              items={partition.done}
              onUsePromptContext={onUsePromptContext}
              emptyMessage={
                filtersActive
                  ? "No done items match the current filters."
                  : "No completed work items."
              }
            />
          </div>
        </section>
      )}

      {!displayedCount && emptyMessage ? (
        <p className="text-muted small repo-dashboard-work-empty-note" role="status">
          {emptyMessage}
        </p>
      ) : null}
    </div>
  );
}
