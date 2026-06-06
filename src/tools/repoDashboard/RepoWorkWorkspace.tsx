import type {
  RepoDashboardWorkItem,
  RepoDashboardWorkType,
} from "../../types";
import { isPromptContextEligibleWorkItem } from "../promptLoops/contextHandoff";
import type { DocWorkLaneId, DocWorkLaneSummary } from "./model";
import { activeWorkCount, partitionWorkItems, type WorkPartition } from "./model";

const WORK_ITEMS_DISPLAY_CAP = 120;

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
  const partition: WorkPartition = partitionWorkItems(items);
  const displayedCount =
    partition.activeStarted.length + partition.activeOpen.length + partition.done.length;
  const filtersActive = laneFilter !== "all" || typeFilter !== "all";

  return (
    <div className="repo-dashboard-work-workspace">
      <header className="repo-dashboard-page-head">
        <h2 className="font-mono repo-dashboard-page-title">Work</h2>
        <p className="text-muted small repo-dashboard-page-desc">
          Parsed docs markers and optional gh issues. Active items include open, started, and
          needs-planning work.
        </p>
        <div className="repo-dashboard-page-toolbar">
          <div className="repo-dashboard-toolbar wrap" role="group" aria-label="Doc lane filter">
            <button
              type="button"
              className={`repo-dashboard-seg${laneFilter === "all" ? " active" : ""}`}
              aria-pressed={laneFilter === "all"}
              onClick={() => onLaneFilterChange("all")}
            >
              all lanes
            </button>
            {docLaneSummaries.map(lane => (
              <button
                key={lane.id}
                type="button"
                className={`repo-dashboard-seg${laneFilter === lane.id ? " active" : ""}`}
                aria-pressed={laneFilter === lane.id}
                onClick={() =>
                  onLaneFilterChange(laneFilter === lane.id ? "all" : lane.id)
                }
              >
                {lane.label} ({lane.open + lane.started})
              </button>
            ))}
          </div>
          <div className="repo-dashboard-toolbar wrap" role="group" aria-label="Type filter">
            {workTypes.map(type => (
              <button
                key={type}
                type="button"
                className={`repo-dashboard-seg ${type}${typeFilter === type ? " active" : ""}`}
                aria-pressed={typeFilter === type}
                onClick={() => onTypeFilterChange(typeFilter === type ? "all" : type)}
              >
                {type}
              </button>
            ))}
            <button
              type="button"
              className={`repo-dashboard-seg${typeFilter === "all" ? " active" : ""}`}
              aria-pressed={typeFilter === "all"}
              onClick={() => onTypeFilterChange("all")}
            >
              all types
            </button>
          </div>
          {filtersActive ? (
            <button
              type="button"
              className="repo-dashboard-btn repo-dashboard-btn-secondary repo-dashboard-filter-reset"
              onClick={onResetFilters}
            >
              Reset filters
            </button>
          ) : null}
          <p className="repo-dashboard-filter-summary font-mono text-muted small" role="status">
            Showing {displayedCount} of {totalItemCount} items · open {partition.activeOpen.length} ·
            started {partition.activeStarted.length} · active {activeWorkCount(partition)} · done{" "}
            {partition.done.length}
            {laneFilter !== "all"
              ? ` · lane: ${docLaneSummaries.find(l => l.id === laneFilter)?.label ?? laneFilter}`
              : ""}
            {typeFilter !== "all" ? ` · type: ${typeFilter}` : ""}
          </p>
        </div>
      </header>

      <div className="repo-dashboard-work-columns">
        <section className="repo-dashboard-work-column" aria-label="Active work">
          <h3 className="font-mono repo-dashboard-work-column-title">Active</h3>
          {!partition.activeStarted.length && !partition.activeOpen.length ? (
            <p className="text-muted small" role="status">
              {filtersActive ? "No active items match the current filters." : "No active work items."}
            </p>
          ) : (
            <div className="repo-dashboard-work-column-scroll">
              {partition.activeStarted.length ? (
                <div className="repo-dashboard-work-group">
                  <h4 className="font-mono repo-dashboard-work-group-title">
                    Started ({partition.activeStarted.length})
                  </h4>
                  <WorkItemsList
                    items={partition.activeStarted}
                    onUsePromptContext={onUsePromptContext}
                    startedVisual
                    emptyMessage=""
                  />
                </div>
              ) : null}
              {partition.activeOpen.length ? (
                <div className="repo-dashboard-work-group">
                  <h4 className="font-mono repo-dashboard-work-group-title">
                    Open ({partition.activeOpen.length})
                  </h4>
                  <WorkItemsList
                    items={partition.activeOpen}
                    onUsePromptContext={onUsePromptContext}
                    emptyMessage=""
                  />
                </div>
              ) : null}
            </div>
          )}
        </section>

        <section className="repo-dashboard-work-column" aria-label="Done work">
          <h3 className="font-mono repo-dashboard-work-column-title">
            Done ({partition.done.length})
          </h3>
          <div className="repo-dashboard-work-column-scroll">
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
      </div>

      {!displayedCount && emptyMessage ? (
        <p className="text-muted small repo-dashboard-work-empty-note" role="status">
          {emptyMessage}
        </p>
      ) : null}
    </div>
  );
}
