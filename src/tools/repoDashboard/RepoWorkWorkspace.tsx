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
  const activeTotal = activeWorkCount(partition);
  const displayedCount = activeTotal + partition.done.length;
  const filtersActive = laneFilter !== "all" || typeFilter !== "all";

  return (
    <div className="repo-dashboard-work-workspace">
      <header className="repo-dashboard-page-head">
        <h2 className="font-mono repo-dashboard-page-title">Work</h2>
        <p className="text-muted small repo-dashboard-page-desc">
          Active and completed items from docs and gh issues. Filters apply to both columns.
        </p>
        <div className="repo-dashboard-page-toolbar">
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
            {displayedCount} of {totalItemCount} items · started {partition.activeStarted.length} ·
            open {partition.activeOpen.length} · active {activeTotal} · done {partition.done.length}
          </p>
        </div>
      </header>

      <div className="repo-dashboard-work-primary-columns">
        <section
          className="repo-dashboard-work-column repo-dashboard-work-column-active"
          aria-label="Active work"
          aria-labelledby="repo-dashboard-work-active-title"
        >
          <h3 id="repo-dashboard-work-active-title" className="font-mono repo-dashboard-work-column-title">
            Active ({activeTotal})
          </h3>
          <div
            className="repo-dashboard-work-column-scroll"
            role="region"
            aria-label="Active work items"
            tabIndex={0}
          >
            <div className="repo-dashboard-work-group">
              <h4
                id="repo-dashboard-work-started-title"
                className="font-mono repo-dashboard-work-group-title"
              >
                Started ({partition.activeStarted.length})
              </h4>
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
            <div className="repo-dashboard-work-group">
              <h4
                id="repo-dashboard-work-open-title"
                className="font-mono repo-dashboard-work-group-title"
              >
                Open ({partition.activeOpen.length})
              </h4>
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
          </div>
        </section>

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
      </div>

      {!displayedCount && emptyMessage ? (
        <p className="text-muted small repo-dashboard-work-empty-note" role="status">
          {emptyMessage}
        </p>
      ) : null}
    </div>
  );
}
