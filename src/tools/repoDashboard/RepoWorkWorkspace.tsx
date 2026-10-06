import type { RepoDashboardWorkItem, RepoDashboardWorkType } from "../../types";
import { Pane } from "../../ui/Pane";
import { isPromptContextEligibleWorkItem } from "../promptLoops/contextHandoff";
import type {
  CanonicalSourceFilter,
  CanonicalWorkSummary,
  PriorityFilter,
  WorkPartition,
} from "./model";
import {
  partitionCanonicalWorkItems,
  partitionWorkItems,
  workItemCanonicalSource,
} from "./model";

const WORK_ITEMS_DISPLAY_CAP = 120;

function sourceBadgeLabel(item: RepoDashboardWorkItem): string {
  const src = workItemCanonicalSource(item);
  if (src === "backlog") return "Backlog";
  if (src === "audit") return "Audit";
  if (src === "github") return "GitHub";
  return item.source;
}

function CanonicalWorkCard({
  item,
  onUsePromptContext,
}: {
  item: RepoDashboardWorkItem;
  onUsePromptContext?: (item: RepoDashboardWorkItem) => void;
}) {
  return (
    <div className="repo-dashboard-work-item repo-dashboard-work-item-canonical">
      <div className="repo-dashboard-work-item-head">
        <span className="repo-dashboard-work-id font-mono">
          {item.workId ?? item.text.slice(0, 24)}
        </span>
        {item.priority ? (
          <span className="repo-dashboard-chip note">{item.priority}</span>
        ) : null}
        <span className="repo-dashboard-chip todo">{sourceBadgeLabel(item)}</span>
        {item.status === "started" ? (
          <span className="repo-dashboard-work-status">Started</span>
        ) : null}
      </div>
      {item.area ? (
        <div className="repo-dashboard-work-area text-muted small">{item.area}</div>
      ) : null}
      <div className="repo-dashboard-work-text">{item.text}</div>
      {item.nextAction ? (
        <div className="repo-dashboard-work-meta small">
          <span className="text-muted">Next:</span> {item.nextAction}
        </div>
      ) : null}
      {item.verification ? (
        <div className="repo-dashboard-work-meta small">
          <span className="text-muted">Verify:</span> {item.verification}
        </div>
      ) : null}
      <div className="repo-dashboard-work-loc text-muted">
        {item.path}
        {item.line ? `:${item.line}` : ""}
      </div>
      {onUsePromptContext && isPromptContextEligibleWorkItem(item) ? (
        <div className="repo-dashboard-work-actions">
          <button
            type="button"
            className="repo-dashboard-btn repo-dashboard-btn-secondary repo-dashboard-use-context-btn"
            onClick={() => onUsePromptContext(item)}
            aria-label={`Use ${item.workId ?? "item"} as Prompt Builder context`}
          >
            Use as context
          </button>
        </div>
      ) : null}
    </div>
  );
}

function GenericWorkCard({
  item,
  onUsePromptContext,
}: {
  item: RepoDashboardWorkItem;
  onUsePromptContext?: (item: RepoDashboardWorkItem) => void;
}) {
  return (
    <div className="repo-dashboard-work-item">
      <div className="repo-dashboard-work-item-head">
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
            aria-label={`Use this ${item.type} item as Prompt Builder context`}
          >
            Use as context
          </button>
        </div>
      ) : null}
    </div>
  );
}

function WorkItemsList({
  items,
  emptyMessage = "No matching items found.",
  canonicalMode,
  onUsePromptContext,
}: {
  items: RepoDashboardWorkItem[];
  emptyMessage?: string;
  canonicalMode: boolean;
  onUsePromptContext?: (item: RepoDashboardWorkItem) => void;
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
        {shown.map((item, index) =>
          canonicalMode ? (
            <CanonicalWorkCard
              key={`${item.source}-${item.path}-${item.line ?? 0}-${index}`}
              item={item}
              onUsePromptContext={onUsePromptContext}
            />
          ) : (
            <GenericWorkCard
              key={`${item.source}-${item.path}-${item.line ?? 0}-${index}`}
              item={item}
              onUsePromptContext={onUsePromptContext}
            />
          ),
        )}
      </div>
    </>
  );
}

function WorkColumn({
  title,
  index,
  count,
  items,
  emptyMessage,
  canonicalMode,
  defaultFocus,
  onUsePromptContext,
}: {
  title: string;
  /** `[n]` in the pane title. */
  index: number;
  count: number;
  items: RepoDashboardWorkItem[];
  emptyMessage: string;
  canonicalMode: boolean;
  defaultFocus: boolean;
  onUsePromptContext?: (item: RepoDashboardWorkItem) => void;
}) {
  return (
    <Pane
      id={`work-${title.toLowerCase()}`}
      index={index}
      title={title.toLowerCase()}
      meta={`· ${count}`}
      label={`${title} work`}
      className="repo-dashboard-work-column"
      bodyClassName="repo-dashboard-work-column-body"
      defaultFocus={defaultFocus}
    >
      <div
        className="repo-dashboard-work-column-scroll"
        role="region"
        aria-label={`${title} items`}
        tabIndex={0}
        data-pane-primary=""
      >
        <WorkItemsList
          items={items}
          canonicalMode={canonicalMode}
          onUsePromptContext={onUsePromptContext}
          emptyMessage={emptyMessage}
        />
      </div>
    </Pane>
  );
}

export interface RepoWorkWorkspaceProps {
  items: RepoDashboardWorkItem[];
  totalItemCount: number;
  canonicalMode: boolean;
  sourceFilter: CanonicalSourceFilter;
  priorityFilter: PriorityFilter;
  typeFilter: RepoDashboardWorkType | "all";
  workTypes: RepoDashboardWorkType[];
  canonicalSummary: CanonicalWorkSummary | null;
  onSourceFilterChange: (source: CanonicalSourceFilter) => void;
  onPriorityFilterChange: (priority: PriorityFilter) => void;
  onTypeFilterChange: (type: RepoDashboardWorkType | "all") => void;
  onResetFilters: () => void;
  onUsePromptContext?: (item: RepoDashboardWorkItem) => void;
  emptyMessage: string;
}

export function RepoWorkWorkspace({
  items,
  totalItemCount,
  canonicalMode,
  sourceFilter,
  priorityFilter,
  typeFilter,
  workTypes,
  canonicalSummary,
  onSourceFilterChange,
  onPriorityFilterChange,
  onTypeFilterChange,
  onResetFilters,
  onUsePromptContext,
  emptyMessage,
}: RepoWorkWorkspaceProps) {
  const partition: WorkPartition = partitionWorkItems(items);
  const canonicalPartition = partitionCanonicalWorkItems(items);
  const filtersActive = canonicalMode
    ? sourceFilter !== "all" || priorityFilter !== "all"
    : typeFilter !== "all";

  const displayedCount = canonicalMode
    ? items.length
    : partition.activeStarted.length + partition.activeOpen.length + partition.done.length;

  const columns = canonicalMode
    ? ([
        ["Bugs", canonicalPartition.bugs, "repo-dashboard-work-bugs-title", "No open bugs in the canonical queue."],
        ["Verify", canonicalPartition.verify, "repo-dashboard-work-verify-title", "No verify items in the canonical queue."],
        [
          "Enhancements",
          canonicalPartition.enhancements,
          "repo-dashboard-work-enhancements-title",
          "No enhancements in the canonical queue.",
        ],
      ] as const)
    : ([
        ["Started", partition.activeStarted, "repo-dashboard-work-started-title", "No started work items."],
        ["Open", partition.activeOpen, "repo-dashboard-work-open-title", "No open work items."],
        ["Done", partition.done, "repo-dashboard-work-done-title", "No completed work items."],
      ] as const);

  return (
    <div className="repo-dashboard-work-workspace">
      <Pane
        id="work-summary"
        index={2}
        title="work"
        label="Work summary and filters"
        className="repo-dashboard-work-summary-pane"
        bodyClassName="repo-dashboard-pane-body"
      >
        <header className="repo-dashboard-work-head">
          <div className="repo-dashboard-work-summary-row">
            <div className="repo-dashboard-work-summary-stats font-mono" role="status">
              {canonicalMode && canonicalSummary ? (
                <>
                  <span className="repo-dashboard-work-summary-stat">
                    <strong>{canonicalSummary.displayed}</strong>
                    <span className="repo-dashboard-work-summary-label">
                      of {canonicalSummary.total} active
                    </span>
                  </span>
                  <span className="repo-dashboard-work-summary-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="repo-dashboard-work-summary-stat">
                    <span className="repo-dashboard-work-summary-label">bugs</span>
                    <strong>{canonicalSummary.bugs}</strong>
                  </span>
                  <span className="repo-dashboard-work-summary-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="repo-dashboard-work-summary-stat">
                    <span className="repo-dashboard-work-summary-label">verify</span>
                    <strong>{canonicalSummary.verify}</strong>
                  </span>
                  <span className="repo-dashboard-work-summary-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="repo-dashboard-work-summary-stat">
                    <span className="repo-dashboard-work-summary-label">enhancements</span>
                    <strong>{canonicalSummary.enhancements}</strong>
                  </span>
                  {canonicalSummary.other ? (
                    <>
                      <span className="repo-dashboard-work-summary-sep" aria-hidden="true">
                        ·
                      </span>
                      <span className="repo-dashboard-work-summary-stat">
                        <span className="repo-dashboard-work-summary-label">other</span>
                        <strong>{canonicalSummary.other}</strong>
                      </span>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="repo-dashboard-work-summary-stat">
                    <strong>{displayedCount}</strong>
                    <span className="repo-dashboard-work-summary-label">of {totalItemCount} items</span>
                  </span>
                  <span className="repo-dashboard-work-summary-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="repo-dashboard-work-summary-stat">
                    <span className="repo-dashboard-work-summary-label">started</span>
                    <strong>{partition.activeStarted.length}</strong>
                  </span>
                  <span className="repo-dashboard-work-summary-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="repo-dashboard-work-summary-stat">
                    <span className="repo-dashboard-work-summary-label">open</span>
                    <strong>{partition.activeOpen.length}</strong>
                  </span>
                  <span className="repo-dashboard-work-summary-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="repo-dashboard-work-summary-stat">
                    <span className="repo-dashboard-work-summary-label">done</span>
                    <strong>{partition.done.length}</strong>
                  </span>
                </>
              )}
            </div>
            <div className="repo-dashboard-work-filters font-mono">
              {canonicalMode ? (
                <>
                  <select
                      className="repo-dashboard-field repo-dashboard-work-filter-select"
                      value={sourceFilter}
                      onChange={e =>
                        onSourceFilterChange(e.target.value as CanonicalSourceFilter)
                      }
                      aria-label="Filter by work source"
                    >
                      <option value="all">All sources</option>
                      <option value="backlog">Backlog</option>
                      <option value="audit">Audit</option>
                      <option value="github">GitHub</option>
                    </select>
                  <select
                      className="repo-dashboard-field repo-dashboard-work-filter-select"
                      value={priorityFilter}
                      onChange={e =>
                        onPriorityFilterChange(e.target.value as PriorityFilter)
                      }
                      aria-label="Filter by priority"
                    >
                      <option value="all">All priorities</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                      <option value="unspecified">Unspecified</option>
                    </select>
                </>
              ) : (
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
              )}
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
          </div>
        </header>
      </Pane>

      <div
        className={`repo-dashboard-work-primary-columns${canonicalMode ? " repo-dashboard-work-canonical-columns" : ""}`}
      >
        {columns.map(([title, columnItems, columnId, emptyDefault], columnIndex) => (
          <WorkColumn
            key={columnId}
            title={title}
            index={columnIndex + 3}
            defaultFocus={columnIndex === 0}
            count={columnItems.length}
            items={columnItems}
            canonicalMode={canonicalMode}
            onUsePromptContext={onUsePromptContext}
            emptyMessage={
              filtersActive
                ? `No ${title.toLowerCase()} items match the current filters.`
                : emptyDefault
            }
          />
        ))}
      </div>

      {canonicalMode && canonicalPartition.other.length ? (
        <Pane
          id="work-other"
          index={columns.length + 3}
          title="other"
          meta={`· ${canonicalPartition.other.length}`}
          label="Other work items"
          className="repo-dashboard-work-other-section"
          bodyClassName="repo-dashboard-pane-body"
          scrollable
        >
          <WorkItemsList
            items={canonicalPartition.other}
            canonicalMode
            onUsePromptContext={onUsePromptContext}
            emptyMessage="No other items."
          />
        </Pane>
      ) : null}

      {!displayedCount && emptyMessage ? (
        <p className="text-muted small repo-dashboard-work-empty-note" role="status">
          {emptyMessage}
        </p>
      ) : null}
    </div>
  );
}
