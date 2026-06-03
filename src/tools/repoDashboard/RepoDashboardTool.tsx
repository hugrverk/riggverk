import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  AppSettings,
  DiscoverLocalGitReposResult,
  DiscoveredLocalGitRepo,
  RepoDashboardSnapshot,
  RepoDashboardWorkItem,
  RepoDashboardWorkStatus,
  RepoDashboardWorkType,
  RepoGhPullRequest,
  RepoCommitEntry,
} from "../../types";
import {
  discoveredToDashboardEntry,
  isRepoPathAlreadySaved,
  mergeImportedRepoEntries,
  repoEntryIdFromPath,
} from "../../lib/repoDashboardEntries";
import { isPromptContextEligibleWorkItem } from "../promptLoops/contextHandoff";
import { mergeWorkItemsDetailed } from "./docsParser";
import {
  authorLabel,
  buildActivityLegend,
  buildDocLaneSummaries,
  buildDocSourceSummaries,
  buildHeatmapCells,
  buildLineChartData,
  buildSourceHealth,
  buildWorkStatusCounts,
  commitDateRangeLabel,
  countByAuthor,
  eventsFromCommits,
  ghIssuesKpiLabel,
  normalizeRepoPathForCompare,
  repoDashboardBrandLabel,
  workItemDocLane,
  type DocWorkLaneId,
  type DocWorkLaneSummary,
} from "./model";
import { ActivityHeatmap, ActivityLineChart } from "./RepoDashboardCharts";

export type RepoDashboardSection = "overview" | "activity" | "work" | "sources";

const SECTIONS: { id: RepoDashboardSection; label: string; purpose: string }[] = [
  { id: "overview", label: "Overview", purpose: "Repo snapshot and activity summary" },
  { id: "activity", label: "Activity", purpose: "Loaded recent commit history" },
  { id: "work", label: "Work", purpose: "Tracked work items from docs and gh" },
  { id: "sources", label: "Sources", purpose: "Latest change, planning gaps, and source docs" },
];

const WORK_TYPES: RepoDashboardWorkType[] = ["roadmap", "feature", "gap", "todo", "fix", "note"];
const COMMIT_LIST_DISPLAY_CAP = 120;
const WORK_ITEMS_DISPLAY_CAP = 120;

type WorkFilter = "all" | RepoDashboardWorkStatus;

type SyncVisualState = "idle" | "loading" | "synced" | "stale";

const STALE_MS = 10 * 60 * 1000;

function syncVisualState(loading: boolean, lastSynced: Date | null): SyncVisualState {
  if (loading) return "loading";
  if (!lastSynced) return "idle";
  if (Date.now() - lastSynced.getTime() > STALE_MS) return "stale";
  return "synced";
}

function headChangedFilesLabel(
  snapshot: RepoDashboardSnapshot,
  latestCommit: RepoCommitEntry | null,
): string {
  const count = snapshot.changed_files.length;
  if (!count) return "No files changed at HEAD";
  const mergeHint = latestCommit?.is_merge ? " (merge commit)" : "";
  return `${count} file${count === 1 ? "" : "s"} from git show HEAD${mergeHint}`;
}

function LatestChangeCard({
  snapshot,
  latestMerge,
  latestCommit,
}: {
  snapshot: RepoDashboardSnapshot;
  latestMerge: RepoGhPullRequest | null;
  latestCommit: RepoCommitEntry | null;
}) {
  const branchLabel = snapshot.branch || snapshot.default_branch || "—";
  const headFilesLabel = headChangedFilesLabel(snapshot, latestCommit);

  if (!latestCommit && !latestMerge) {
    return (
      <p className="text-muted small" role="status">
        No local commit or gh merge data in this snapshot. Refresh after selecting a git repository.
      </p>
    );
  }

  return (
    <div className="repo-dashboard-latest-content">
      {latestCommit ? (
        <section className="repo-dashboard-latest-block" aria-label="Latest local commit">
          <div className="repo-dashboard-latest-hero">
            <span className="repo-dashboard-source-pill">local HEAD</span>
            <h3 className="font-mono repo-dashboard-latest-headline">{latestCommit.subject}</h3>
            <p className="repo-dashboard-latest-lead text-muted small">
              {latestCommit.short_sha} · {authorLabel(latestCommit)} ·{" "}
              {new Date(latestCommit.authored_at * 1000).toLocaleString()}
              {latestCommit.is_merge ? " · merge commit" : ""}
            </p>
          </div>
          <dl className="repo-dashboard-latest-facts font-mono">
            <div>
              <dt>Branch</dt>
              <dd>{branchLabel}</dd>
            </div>
            <div>
              <dt>HEAD files</dt>
              <dd>{headFilesLabel}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {latestMerge ? (
        <section
          className="repo-dashboard-latest-block repo-dashboard-latest-gh"
          aria-label="Recent GitHub merged pull request"
        >
          <div className="repo-dashboard-latest-hero">
            <span className="repo-dashboard-source-pill">gh merge</span>
            <h3 className="font-mono repo-dashboard-latest-headline">
              #{latestMerge.number} {latestMerge.title}
            </h3>
            <p className="repo-dashboard-latest-lead text-muted small">
              Recent merged PR via gh CLI (separate from HEAD file list) · {latestMerge.author} ·{" "}
              {new Date(latestMerge.merged_at).toLocaleString()}
            </p>
          </div>
          {latestMerge.body ? (
            <pre className="repo-dashboard-code font-mono repo-dashboard-latest-body">
              {latestMerge.body.slice(0, 4000)}
            </pre>
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

function RepoDashboardPage({
  title,
  description,
  toolbar,
  main,
  aside,
}: {
  title: string;
  description?: string;
  toolbar?: ReactNode;
  main: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="repo-dashboard-page">
      <header className="repo-dashboard-page-head">
        <h2 className="font-mono repo-dashboard-page-title">{title}</h2>
        {description ? (
          <p className="text-muted small repo-dashboard-page-desc">{description}</p>
        ) : null}
        {toolbar ? <div className="repo-dashboard-page-toolbar">{toolbar}</div> : null}
      </header>
      <div className={`repo-dashboard-page-body${aside ? " has-aside" : ""}`}>
        <div className="repo-dashboard-page-main">{main}</div>
        {aside ? <aside className="repo-dashboard-page-aside">{aside}</aside> : null}
      </div>
    </div>
  );
}

function ActivitySummaryStrip({ snapshot }: { snapshot: RepoDashboardSnapshot }) {
  const range = commitDateRangeLabel(snapshot.commits);
  const authors = countByAuthor(snapshot.commits);
  const remoteSync =
    snapshot.ahead != null && snapshot.behind != null
      ? `+${snapshot.ahead}/-${snapshot.behind}`
      : "n/a";

  return (
    <div className="repo-dashboard-statstrip font-mono" role="group" aria-label="Activity summary">
      <span className="repo-dashboard-stat">
        <strong>{snapshot.commits.length}</strong> commits loaded
      </span>
      <span className="repo-dashboard-stat">branch {snapshot.branch || "—"}</span>
      <span className="repo-dashboard-stat">remote {remoteSync}</span>
      {range ? <span className="repo-dashboard-stat">{range}</span> : null}
      {authors.slice(0, 5).map(([name, count]) => (
        <span key={name} className="repo-dashboard-stat repo-dashboard-stat-author">
          {name} <strong>{count}</strong>
        </span>
      ))}
    </div>
  );
}

function CommitHistoryList({ commits }: { commits: RepoCommitEntry[] }) {
  if (!commits.length) {
    return <p className="text-muted small">No commits in loaded range.</p>;
  }
  return (
    <div className="repo-dashboard-commit-list">
      {commits.map(commit => (
        <div key={commit.sha} className="repo-dashboard-commit">
          <span className="repo-dashboard-commit-sha font-mono">{commit.short_sha}</span>
          <span className="repo-dashboard-commit-subject font-mono">{commit.subject}</span>
          <span className="repo-dashboard-commit-meta text-muted">
            {authorLabel(commit)} · {new Date(commit.authored_at * 1000).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

function WorkItemsList({
  items,
  emptyMessage = "No matching items found.",
  onUsePromptContext,
}: {
  items: RepoDashboardWorkItem[];
  emptyMessage?: string;
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
      {shown.map((item, index) => (
        <div
          key={`${item.source}-${item.path}-${item.line ?? 0}-${index}`}
          className="repo-dashboard-work-item"
        >
          <div className="repo-dashboard-work-head">
            <span className={`repo-dashboard-chip ${item.type}`}>{item.type}</span>
            <span className="repo-dashboard-work-status">{item.status}</span>
            {item.needsPlan && <span className="repo-dashboard-chip todo">needs planning</span>}
          </div>
          <div className="repo-dashboard-work-text font-mono">{item.text}</div>
          <div className="repo-dashboard-work-loc text-muted">
            {item.source} · {item.path}{item.line ? `:${item.line}` : ""}
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

function PlanningGapsPanel({
  items,
  laneFilter,
  typeFilter,
  onUsePromptContext,
}: {
  items: RepoDashboardWorkItem[];
  laneFilter: DocWorkLaneId | "all";
  typeFilter: RepoDashboardWorkType | "all";
  onUsePromptContext?: (item: RepoDashboardWorkItem) => void;
}) {
  const filtered = items.filter(i => {
    if (!(i.needsPlan || i.status === "open")) return false;
    if (laneFilter !== "all" && workItemDocLane(i) !== laneFilter) return false;
    if (typeFilter !== "all" && i.type !== typeFilter) return false;
    return true;
  });
  const groups = buildDocLaneSummaries(filtered).map(lane => ({
    lane,
    items: filtered.filter(i => workItemDocLane(i) === lane.id),
  }));

  if (!filtered.length) {
    return (
      <p className="text-muted small" role="status">
        No open or needs-planning items for the current filters.
      </p>
    );
  }

  return (
    <div className="repo-dashboard-plan-groups">
      {groups.map(({ lane, items: groupItems }) => (
        <section key={lane.id} className="repo-dashboard-plan-group">
          <h4 className="font-mono repo-dashboard-plan-group-title">
            <span className="repo-dashboard-chip" style={{ color: lane.color, borderColor: "currentColor" }}>
              {lane.label}
            </span>
            <span className="text-muted">{groupItems.length}</span>
          </h4>
          <p className="text-muted small repo-dashboard-lane-hint">{lane.pathHint}</p>
          <WorkItemsList
            items={groupItems}
            emptyMessage=""
            onUsePromptContext={onUsePromptContext}
          />
        </section>
      ))}
    </div>
  );
}

function DocLaneSummaryPanel({
  lanes,
  activeLane,
  onSelectLane,
}: {
  lanes: DocWorkLaneSummary[];
  activeLane: DocWorkLaneId | "all";
  onSelectLane: (lane: DocWorkLaneId) => void;
}) {
  if (!lanes.length) {
    return (
      <p className="text-muted small" role="status">
        No parsed work from BACKLOG, KNOWN_GAPS, or product docs yet.
      </p>
    );
  }

  const maxOpen = Math.max(1, ...lanes.map(l => l.open + l.started));

  return (
    <div className="repo-dashboard-doc-lanes" role="list">
      {lanes.map(lane => (
        <button
          key={lane.id}
          type="button"
          role="listitem"
          className={`repo-dashboard-doc-lane${activeLane === lane.id ? " active" : ""}`}
          style={{ "--lane-color": lane.color } as CSSProperties}
          aria-pressed={activeLane === lane.id}
          onClick={() => onSelectLane(lane.id)}
        >
          <div className="repo-dashboard-doc-lane-head">
            <span className="repo-dashboard-doc-lane-label font-mono">{lane.label}</span>
            <span className="repo-dashboard-doc-lane-open font-mono">{lane.open + lane.started}</span>
          </div>
          <p className="text-muted small repo-dashboard-doc-lane-desc">{lane.description}</p>
          <p className="text-muted small repo-dashboard-doc-lane-path font-mono">{lane.pathHint}</p>
          <div className="repo-dashboard-bar repo-dashboard-doc-lane-bar">
            <div
              className="repo-dashboard-bar-fill"
              style={{
                width: `${Math.max(4, ((lane.open + lane.started) / maxOpen) * 100)}%`,
                background: lane.color,
              }}
            />
          </div>
          <div className="repo-dashboard-doc-lane-meta font-mono">
            <span>{lane.open} open</span>
            <span>{lane.started} started</span>
            <span>{lane.done} done</span>
            {lane.needsPlan > 0 ? <span>{lane.needsPlan} plan</span> : null}
          </div>
        </button>
      ))}
    </div>
  );
}

export interface RepoDashboardPromptContextPayload {
  item: RepoDashboardWorkItem;
  repoPath: string;
}

interface RepoDashboardToolProps {
  toolsSwitcher?: ReactNode;
  onUsePromptContext?: (payload: RepoDashboardPromptContextPayload) => void;
}

export function RepoDashboardTool({ toolsSwitcher, onUsePromptContext }: RepoDashboardToolProps) {
  const [section, setSection] = useState<RepoDashboardSection>("overview");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RepoDashboardSnapshot | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [workFilter, setWorkFilter] = useState<WorkFilter>("all");
  const [typeFilter, setTypeFilter] = useState<RepoDashboardWorkType | "all">("all");
  const [laneFilter, setLaneFilter] = useState<DocWorkLaneId | "all">("all");
  const [savedEntries, setSavedEntries] = useState<AppSettings["repo_dashboard_entries"]>([]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [pickerStatus, setPickerStatus] = useState<string | null>(null);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverParentPath, setDiscoverParentPath] = useState("");
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverResult, setDiscoverResult] = useState<DiscoverLocalGitReposResult | null>(null);
  const [discoverSelectedPaths, setDiscoverSelectedPaths] = useState<Set<string>>(() => new Set());
  const [discoverImportStatus, setDiscoverImportStatus] = useState<string | null>(null);
  const pickerTimerRef = useRef<number | null>(null);
  const loadSeqRef = useRef(0);

  const showPickerStatus = useCallback((text: string) => {
    setPickerStatus(text);
    if (pickerTimerRef.current !== null) window.clearTimeout(pickerTimerRef.current);
    pickerTimerRef.current = window.setTimeout(() => setPickerStatus(null), 2500);
  }, []);

  const refreshFor = useCallback(async (path: string, branch: string) => {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      setError("Enter a local repository path");
      return;
    }
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<RepoDashboardSnapshot>("get_repo_dashboard_snapshot", {
        repoPath: trimmedPath,
        defaultBranch: branch.trim() || null,
        includeGh: true,
      });
      if (seq !== loadSeqRef.current) return;
      setSnapshot(data);
      setLastSynced(new Date());
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setError(String(e));
      setSnapshot(null);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await refreshFor(repoPath, defaultBranch);
  }, [repoPath, defaultBranch, refreshFor]);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(settings => {
        setSavedEntries(settings.repo_dashboard_entries ?? []);
        const active = settings.repo_dashboard_entries?.find(
          e => e.id === settings.active_repo_dashboard_id,
        );
        if (active?.path) {
          const branch = active.default_branch ?? "";
          setRepoPath(active.path);
          setDefaultBranch(branch);
          void refreshFor(active.path, branch);
        }
      })
      .catch(() => {});
  }, [refreshFor]);

  const runDiscoverScan = useCallback(async (parentPath: string) => {
    setDiscoverLoading(true);
    setDiscoverError(null);
    setDiscoverResult(null);
    setDiscoverImportStatus(null);
    try {
      const result = await invoke<DiscoverLocalGitReposResult>("discover_local_git_repos", {
        parentPath,
      });
      setDiscoverResult(result);
      const selectable = result.repos.filter(
        r => !isRepoPathAlreadySaved(r.path, savedEntries ?? []),
      );
      setDiscoverSelectedPaths(new Set(selectable.map(r => r.path)));
    } catch (e) {
      setDiscoverError(String(e));
      setDiscoverSelectedPaths(new Set());
    } finally {
      setDiscoverLoading(false);
    }
  }, [savedEntries]);

  const startDiscoverLocalRepos = useCallback(async () => {
    if (!isTauri()) {
      showPickerStatus("folder picker requires native app");
      return;
    }
    setDiscoverError(null);
    setDiscoverImportStatus(null);
    try {
      const selected = await open({
        title: "Choose folder to scan for git repositories",
        directory: true,
        multiple: false,
        defaultPath: discoverParentPath.trim() || repoPath.trim() || undefined,
      });
      if (selected === null) {
        return;
      }
      if (typeof selected === "string") {
        setDiscoverOpen(true);
        setDiscoverParentPath(selected);
        await runDiscoverScan(selected);
      }
    } catch {
      setDiscoverError("folder picker unavailable");
      setDiscoverLoading(false);
    }
  }, [discoverParentPath, repoPath, runDiscoverScan, showPickerStatus]);

  const closeDiscoverPanel = useCallback(() => {
    setDiscoverOpen(false);
    setDiscoverLoading(false);
    setDiscoverError(null);
    setDiscoverResult(null);
    setDiscoverSelectedPaths(new Set());
    setDiscoverImportStatus(null);
  }, []);

  const toggleDiscoverRepo = useCallback((path: string, checked: boolean) => {
    setDiscoverSelectedPaths(prev => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const importSelectedDiscoveredRepos = useCallback(async () => {
    if (!discoverResult) return;
    const toImport = discoverResult.repos
      .filter(r => discoverSelectedPaths.has(r.path))
      .map(discoveredToDashboardEntry);
    if (!toImport.length) {
      setDiscoverImportStatus("nothing selected");
      return;
    }
    setDiscoverImportStatus(null);
    try {
      const settings = await invoke<AppSettings>("get_settings");
      const entries = mergeImportedRepoEntries(settings.repo_dashboard_entries ?? [], toImport);
      const next: AppSettings = {
        ...settings,
        repo_dashboard_entries: entries,
      };
      const saved = await invoke<AppSettings>("update_settings", { settings: next });
      setSavedEntries(saved.repo_dashboard_entries ?? []);
      setDiscoverImportStatus(`imported ${toImport.length}`);
      closeDiscoverPanel();
    } catch (e) {
      setDiscoverError(String(e));
    }
  }, [closeDiscoverPanel, discoverResult, discoverSelectedPaths]);

  const saveCurrentRepo = useCallback(async () => {
    const path = repoPath.trim();
    if (!path) {
      setError("Enter a local repository path");
      return;
    }
    setSaveStatus(null);
    try {
      const settings = await invoke<AppSettings>("get_settings");
      const id = repoEntryIdFromPath(path);
      const label = path.replace(/\/+$/, "").split("/").pop() || "Repository";
      const branch = defaultBranch.trim() || null;
      const entries = [...(settings.repo_dashboard_entries ?? [])];
      const existingIndex = entries.findIndex(e => e.id === id || e.path === path);
      const entry = { id, label, path, default_branch: branch };
      if (existingIndex >= 0) {
        entries[existingIndex] = entry;
      } else {
        entries.push(entry);
      }
      const next: AppSettings = {
        ...settings,
        repo_dashboard_entries: entries,
        active_repo_dashboard_id: id,
      };
      const saved = await invoke<AppSettings>("update_settings", { settings: next });
      setSavedEntries(saved.repo_dashboard_entries ?? []);
      setSaveStatus("saved");
    } catch (e) {
      setError(String(e));
    }
  }, [repoPath, defaultBranch]);

  const chooseRepoFolder = useCallback(async () => {
    if (!isTauri()) {
      showPickerStatus("folder picker requires native app");
      return;
    }
    try {
      const selected = await open({
        title: "Choose repository folder",
        directory: true,
        multiple: false,
        defaultPath: repoPath.trim() || undefined,
      });
      if (selected === null) return;
      if (typeof selected === "string") {
        setRepoPath(selected);
        setError(null);
        showPickerStatus("folder selected");
        void refreshFor(selected, defaultBranch);
      }
    } catch {
      showPickerStatus("folder picker unavailable");
    }
  }, [repoPath, defaultBranch, refreshFor, showPickerStatus]);

  const { workItems, parserWarnings } = useMemo(() => {
    if (!snapshot) return { workItems: [], parserWarnings: [] as string[] };
    const merged = mergeWorkItemsDetailed(snapshot.docs, snapshot.gh.open_issues);
    return { workItems: merged.items, parserWarnings: merged.parserWarnings };
  }, [snapshot]);

  const docSources = useMemo(
    () => (snapshot ? buildDocSourceSummaries(snapshot.docs, workItems) : []),
    [snapshot, workItems],
  );

  const filteredWorkItems = useMemo(() => {
    let list = workItems;
    if (workFilter !== "all") list = list.filter(i => i.status === workFilter);
    if (laneFilter !== "all") list = list.filter(i => workItemDocLane(i) === laneFilter);
    if (typeFilter !== "all") list = list.filter(i => i.type === typeFilter);
    return list;
  }, [workItems, workFilter, laneFilter, typeFilter]);

  const docLaneSummaries = useMemo(() => buildDocLaneSummaries(workItems), [workItems]);

  const workStatusCounts = useMemo(() => buildWorkStatusCounts(workItems), [workItems]);

  const activityLegend = useMemo(
    () => (snapshot ? buildActivityLegend(snapshot.commits) : []),
    [snapshot],
  );

  const lineChart = useMemo(
    () => (snapshot ? buildLineChartData(eventsFromCommits(snapshot.commits)) : null),
    [snapshot],
  );
  const heatmap = useMemo(
    () => (snapshot ? buildHeatmapCells(snapshot.commits) : []),
    [snapshot],
  );
  const health = useMemo(
    () => (snapshot ? buildSourceHealth(snapshot, workItems) : []),
    [snapshot, workItems],
  );

  const latestMerge = snapshot?.gh.merged_prs[0] ?? null;
  const latestCommit = snapshot?.latest_commit ?? null;
  const selectedSavedId =
    savedEntries?.find(e => e.path === repoPath.trim())?.id ?? "";
  const snapshotMatchesPath =
    snapshot != null &&
    repoPath.trim() !== "" &&
    normalizeRepoPathForCompare(snapshot.repo_path) ===
      normalizeRepoPathForCompare(repoPath);

  const syncState = syncVisualState(loading, lastSynced);
  const syncLabel =
    syncState === "loading"
      ? "Syncing…"
      : syncState === "synced"
        ? `Synced ${lastSynced?.toLocaleTimeString() ?? ""}`
        : syncState === "stale"
          ? "Stale — refresh"
          : "Not synced";

  const handleUsePromptContext = useCallback(
    (item: RepoDashboardWorkItem) => {
      if (!onUsePromptContext) return;
      onUsePromptContext({ item, repoPath: repoPath.trim() });
    },
    [onUsePromptContext, repoPath],
  );

  const sectionCount = (id: RepoDashboardSection): string => {
    if (!snapshot) return "-";
    if (id === "activity") return String(snapshot.commits.length);
    if (id === "work") return String(workStatusCounts.open);
    if (id === "sources") {
      const contributing = docSources.filter(d => d.contributes).length;
      return String(contributing + (latestCommit || latestMerge ? 1 : 0));
    }
    return String(workStatusCounts.open);
  };

  const brandLabel = repoDashboardBrandLabel(repoPath);
  const ghIssuesLabel = snapshot
    ? ghIssuesKpiLabel(snapshot.gh.available, snapshot.gh.authenticated)
    : "gh issues";
  const docOpenCount = workItems.filter(i => i.source === "docs" && i.status !== "done").length;

  return (
    <div className="repo-dashboard-tool">
      <aside className="repo-dashboard-sidebar">
        <div className="tool-context-brand font-mono">
          <span className="tools-title-dot" aria-hidden="true" />
          <span>{brandLabel}</span>
        </div>
        <nav className="repo-dashboard-nav" aria-label="Dashboard sections">
          {SECTIONS.map(({ id, label }, index) => (
            <button
              key={id}
              type="button"
              className={`repo-dashboard-nav-btn${section === id ? " repo-dashboard-nav-btn-active" : ""}`}
              onClick={() => setSection(id)}
              aria-current={section === id ? "page" : undefined}
            >
              <span>{index + 1}. {label}</span>
              <span className="prompt-loops-count">{sectionCount(id)}</span>
            </button>
          ))}
        </nav>
        <footer className="tool-sidebar-footer font-mono">
          {toolsSwitcher}
          {snapshot?.gh.available && (
            <div className="tool-sidebar-status text-muted">
              gh: {snapshot.gh.authenticated ? "enhanced" : "local-only"}
            </div>
          )}
        </footer>
      </aside>

      <section className="repo-dashboard-main">
        <header className="repo-dashboard-topbar">
          <label className="repo-dashboard-section-select-wrap font-mono">
            <select
              className="repo-dashboard-field repo-dashboard-section-select"
              value={section}
              onChange={e => setSection(e.target.value as RepoDashboardSection)}
              aria-label="Dashboard section"
            >
              {SECTIONS.map(({ id, label }) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
          <div className="repo-dashboard-repo-strip">
            {savedEntries && savedEntries.length > 0 && (
              <select
                className="repo-dashboard-field repo-dashboard-field-saved"
                value={selectedSavedId}
                onChange={e => {
                  const entry = savedEntries?.find(x => x.id === e.target.value);
                  if (entry) {
                    const branch = entry.default_branch ?? "";
                    setRepoPath(entry.path);
                    setDefaultBranch(branch);
                    void refreshFor(entry.path, branch);
                  }
                }}
                aria-label="Saved repositories"
                title="Saved repository"
              >
                <option value="">Saved repo…</option>
                {savedEntries.map(entry => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
            )}
            <div className="repo-dashboard-path-group">
              <input
                className="repo-dashboard-field repo-dashboard-field-path"
                value={repoPath}
                onChange={e => setRepoPath(e.target.value)}
                placeholder="Local repository path"
                aria-label="Local repository path"
                spellCheck={false}
              />
              <button
                type="button"
                className="repo-dashboard-btn"
                onClick={() => void chooseRepoFolder()}
                disabled={loading}
                aria-label="Choose repository folder"
                title="Browse folder"
              >
                Browse
              </button>
            </div>
            <input
              className="repo-dashboard-field repo-dashboard-field-branch"
              value={defaultBranch}
              onChange={e => setDefaultBranch(e.target.value)}
              placeholder="Branch"
              aria-label="Default branch override"
              title="Default branch"
            />
            <span
              className={`repo-dashboard-sync-pill repo-dashboard-sync-pill-${syncState}`}
              role="status"
              aria-live="polite"
            >
              {syncLabel}
              {pickerStatus ? ` · ${pickerStatus}` : ""}
              {saveStatus ? ` · ${saveStatus}` : ""}
            </span>
            <div className="repo-dashboard-strip-actions">
              <button
                type="button"
                className="repo-dashboard-btn repo-dashboard-btn-secondary"
                onClick={() => void startDiscoverLocalRepos()}
                disabled={loading || discoverLoading}
                aria-label="Discover local git repositories in a folder"
                title="Scan a parent folder for local git checkouts"
              >
                Discover local repos
              </button>
              <button
                type="button"
                className="repo-dashboard-btn"
                onClick={() => void saveCurrentRepo()}
                disabled={loading || !repoPath.trim()}
                aria-label="Save repository path to settings"
                title="Save to settings"
              >
                Save
              </button>
              <button
                type="button"
                className={`repo-dashboard-btn repo-dashboard-btn-refresh${syncState === "stale" || syncState === "idle" ? " repo-dashboard-btn-refresh-emphasis" : ""}`}
                onClick={() => void refresh()}
                disabled={loading}
                aria-busy={loading}
                aria-label="Refresh dashboard"
                title="Refresh dashboard"
              >
                {loading ? "…" : "Refresh"}
              </button>
            </div>
          </div>
        </header>

        <div className="repo-dashboard-workspace">
          {discoverOpen && (
            <div
              className="repo-dashboard-card repo-dashboard-discover-panel"
              role="region"
              aria-label="Discover local repositories"
            >
              <div className="repo-dashboard-discover-head">
                <h2 className="font-mono repo-dashboard-discover-title">Discover local repos</h2>
                <p className="text-muted small repo-dashboard-discover-desc">
                  Shallow scan of one folder you choose (immediate children and one nested level).
                  Imports add to saved Repo Dashboard entries for Prompt Loops.
                </p>
              </div>
              {discoverParentPath ? (
                <p className="font-mono small repo-dashboard-discover-parent" role="status">
                  Scanning: {discoverParentPath}
                </p>
              ) : null}
              {discoverLoading && (
                <p className="text-muted small" role="status">Scanning for git repositories…</p>
              )}
              {discoverError && (
                <p className="repo-dashboard-discover-error small" role="alert">{discoverError}</p>
              )}
              {discoverResult?.warnings && discoverResult.warnings.length > 0 && (
                <p className="text-muted small repo-dashboard-discover-warnings" role="status">
                  {discoverResult.warnings.join(" · ")}
                </p>
              )}
              {!discoverLoading && discoverResult && discoverResult.repos.length === 0 && !discoverError && (
                <p className="text-muted small" role="status">
                  No git repositories found in this folder.
                </p>
              )}
              {discoverResult && discoverResult.repos.length > 0 && (
                <ul className="repo-dashboard-discover-list">
                  {discoverResult.repos.map((repo: DiscoveredLocalGitRepo) => {
                    const alreadySaved = isRepoPathAlreadySaved(repo.path, savedEntries ?? []);
                    const checked = discoverSelectedPaths.has(repo.path);
                    return (
                      <li key={repo.path} className="repo-dashboard-discover-item">
                        <label className="repo-dashboard-discover-label">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={alreadySaved || discoverLoading}
                            onChange={e => toggleDiscoverRepo(repo.path, e.target.checked)}
                          />
                          <span className="repo-dashboard-discover-name font-mono">{repo.label}</span>
                          <span className="repo-dashboard-discover-path font-mono text-muted">{repo.path}</span>
                          {repo.default_branch ? (
                            <span className="prompt-loops-pill">{repo.default_branch}</span>
                          ) : null}
                          {alreadySaved ? (
                            <span className="repo-dashboard-discover-badge">already saved</span>
                          ) : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="repo-dashboard-discover-actions">
                <button
                  type="button"
                  className="repo-dashboard-btn"
                  onClick={() => void importSelectedDiscoveredRepos()}
                  disabled={
                    discoverLoading ||
                    !discoverResult ||
                    discoverSelectedPaths.size === 0
                  }
                >
                  Import selected
                </button>
                <button
                  type="button"
                  className="repo-dashboard-btn repo-dashboard-btn-secondary"
                  onClick={() => void startDiscoverLocalRepos()}
                  disabled={discoverLoading}
                >
                  Choose folder…
                </button>
                <button
                  type="button"
                  className="repo-dashboard-btn repo-dashboard-btn-secondary"
                  onClick={closeDiscoverPanel}
                >
                  Cancel
                </button>
                {discoverImportStatus ? (
                  <span className="text-muted small" role="status">{discoverImportStatus}</span>
                ) : null}
              </div>
            </div>
          )}

          {loading && (
            <div className="repo-dashboard-card font-mono">syncing local repository…</div>
          )}

          {error && (
            <div className="repo-dashboard-card repo-dashboard-error" role="alert">
              <h2 className="font-mono">Sync failed</h2>
              <pre className="font-mono">{error}</pre>
            </div>
          )}

          {!loading && !error && !snapshot && (
            <div className="repo-dashboard-card" role="status">
              <h2 className="font-mono">Not synced</h2>
              <p className="text-muted small">
                Enter a local checkout path and press refresh. Uses local git and docs by default.
                Optional gh CLI enrichment when authenticated. No GitHub token stored.
              </p>
            </div>
          )}

          {snapshot && !snapshotMatchesPath && !loading && (
            <div className="repo-dashboard-card" role="status">
              <h2 className="font-mono">Path changed</h2>
              <p className="text-muted small">
                Repository path no longer matches the loaded snapshot. Refresh to sync{" "}
                <span className="font-mono">{normalizeRepoPathForCompare(repoPath)}</span>.
              </p>
            </div>
          )}

          {snapshot && snapshotMatchesPath && !loading && section === "overview" && (
            <div className="repo-dashboard-overview">
              <div className="repo-dashboard-kpis" role="group" aria-label="Overview metrics">
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("sources")}>
                  <div className="repo-dashboard-kpi-num font-mono">
                    {latestCommit || latestMerge ? 1 : 0}
                  </div>
                  <div className="repo-dashboard-kpi-label">latest change</div>
                  <div className="repo-dashboard-kpi-hint text-muted">
                    {latestCommit ? "local HEAD" : latestMerge ? "gh only" : "none"}
                  </div>
                </button>
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("activity")}>
                  <div className="repo-dashboard-kpi-num font-mono">{snapshot.commits.length}</div>
                  <div className="repo-dashboard-kpi-label">commits loaded</div>
                </button>
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("work")}>
                  <div className="repo-dashboard-kpi-num font-mono">{docOpenCount}</div>
                  <div className="repo-dashboard-kpi-label">open from docs</div>
                </button>
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("work")}>
                  <div className="repo-dashboard-kpi-num font-mono">{workStatusCounts.open}</div>
                  <div className="repo-dashboard-kpi-label">open items</div>
                </button>
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("work")}>
                  <div className="repo-dashboard-kpi-num font-mono">
                    {snapshot.gh.authenticated ? snapshot.gh.open_issues.length : "—"}
                  </div>
                  <div className="repo-dashboard-kpi-label">{ghIssuesLabel}</div>
                </button>
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("sources")}>
                  <div className="repo-dashboard-kpi-num font-mono">
                    {workItems.filter(i => i.needsPlan && i.status !== "done").length}
                  </div>
                  <div className="repo-dashboard-kpi-label">needs planning</div>
                </button>
              </div>

              <div className="repo-dashboard-grid cols repo-dashboard-overview-charts">
                <div className="repo-dashboard-card repo-dashboard-activity-card">
                  <h2 className="font-mono">Repo activity (loaded history)</h2>
                  {lineChart ? (
                    <ActivityLineChart data={lineChart} legend={activityLegend} />
                  ) : (
                    <p className="text-muted small" role="status">
                      {snapshot.commits.length
                        ? "Not enough author diversity for cumulative chart (single author or unmapped)."
                        : "No commits loaded — refresh after selecting a repository."}
                    </p>
                  )}
                  <p className="text-muted small repo-dashboard-footnote">
                    {snapshot.commits.length.toLocaleString()} commits from local git
                    {snapshot.commits_truncated
                      ? " (older commits omitted — output limit; ensure a full clone)."
                      : ""}
                    .
                    {activityLegend.length ? (
                      <>
                        {" "}
                        {activityLegend.map((entry, i) => (
                          <span key={entry.role}>
                            {i > 0 ? " · " : ""}
                            {entry.role === "primary" ? "Blue" : "Green"} = {entry.label} ({entry.commits})
                          </span>
                        ))}
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="repo-dashboard-card repo-dashboard-latest">
                  <h2 className="font-mono">Latest merge / commit</h2>
                  <LatestChangeCard
                    snapshot={snapshot}
                    latestMerge={latestMerge}
                    latestCommit={latestCommit}
                  />
                </div>
              </div>

              <div className="repo-dashboard-overview-lower">
                <div className="repo-dashboard-heat-stack">
                  <div className="repo-dashboard-card repo-dashboard-heat-card">
                    <h2 className="font-mono">Commit activity</h2>
                    {heatmap.length ? (
                      <ActivityHeatmap cells={heatmap} density="default" />
                    ) : (
                      <p className="text-muted small">No activity data.</p>
                    )}
                  </div>
                  <div className="repo-dashboard-card repo-dashboard-rem-card">
                    <h2 className="font-mono">Open work by doc</h2>
                    <p className="text-muted small repo-dashboard-rem-intro">
                      Grouped by Kretsverket planning files (BACKLOG, KNOWN_GAPS, product, …). Click a
                      lane to filter Work.
                    </p>
                    <DocLaneSummaryPanel
                      lanes={docLaneSummaries}
                      activeLane={laneFilter}
                      onSelectLane={lane => {
                        setLaneFilter(lane);
                        setWorkFilter("open");
                        setSection("work");
                      }}
                    />
                  </div>
                </div>
                <div className="repo-dashboard-card repo-dashboard-health-card">
                  <h2 className="font-mono">Source health</h2>
                  <p className="text-muted small repo-dashboard-health-note">
                    Local git first{snapshot.gh.available ? " · gh when authenticated" : ""}.
                  </p>
                  <div className="repo-dashboard-health-grid">
                    {health.map(row => (
                      <div key={row.label} className="repo-dashboard-health-chip">
                        <span className="repo-dashboard-health-label">{row.label}</span>
                        <span className="prompt-loops-pill">{row.value}</span>
                      </div>
                    ))}
                  </div>
                  {snapshot.warnings.length > 0 && (
                    <pre className="repo-dashboard-code font-mono repo-dashboard-warnings">{snapshot.warnings.join("\n")}</pre>
                  )}
                </div>
              </div>
            </div>
          )}

          {snapshot && snapshotMatchesPath && !loading && section === "activity" && (
            <RepoDashboardPage
              title="Activity"
              description={`Full local git history for charts${snapshot.commits_truncated ? " (truncated at load limit)" : ""}; list shows ${COMMIT_LIST_DISPLAY_CAP}. GitHub issues/PRs via gh when authenticated.`}
              toolbar={<ActivitySummaryStrip snapshot={snapshot} />}
              main={
                <div className="repo-dashboard-card repo-dashboard-scroll-panel">
                  <CommitHistoryList commits={snapshot.commits.slice(0, COMMIT_LIST_DISPLAY_CAP)} />
                </div>
              }
              aside={
                heatmap.length ? (
                  <div className="repo-dashboard-card repo-dashboard-heat-aside">
                    <h3 className="font-mono repo-dashboard-panel-title">Commit activity</h3>
                    <ActivityHeatmap cells={heatmap} density="default" />
                  </div>
                ) : undefined
              }
            />
          )}

          {snapshot && snapshotMatchesPath && !loading && section === "sources" && (
            <RepoDashboardPage
              title="Sources"
              description="Latest change from gh or local git, planning gaps, and tracked source docs."
              main={
                <>
                  <div className="repo-dashboard-card repo-dashboard-latest repo-dashboard-latest-detail repo-dashboard-scroll-panel">
                    <h3 className="font-mono repo-dashboard-panel-title">Latest merge / commit</h3>
                    <LatestChangeCard
                      snapshot={snapshot}
                      latestMerge={latestMerge}
                      latestCommit={latestCommit}
                    />
                  </div>
                  <div className="repo-dashboard-card">
                    <h3 className="font-mono repo-dashboard-panel-title">Changed files at HEAD (local git)</h3>
                    <p className="text-muted small" role="note">
                      {headChangedFilesLabel(snapshot, latestCommit)}. This is not a GitHub PR file list.
                      {latestMerge
                        ? " A recent gh merged PR may appear above; its diff is not shown here."
                        : ""}
                    </p>
                    <div className="repo-dashboard-list">
                      {snapshot.changed_files.map(file => (
                        <div key={file.path} className="repo-dashboard-item">
                          <div className="repo-dashboard-item-title font-mono">{file.path}</div>
                          <div className="repo-dashboard-item-meta">
                            <span>{file.status}</span>
                          </div>
                        </div>
                      ))}
                      {!snapshot.changed_files.length && (
                        <p className="text-muted small">No changed files for HEAD.</p>
                      )}
                    </div>
                  </div>
                </>
              }
              aside={
                <>
                  <div className="repo-dashboard-card repo-dashboard-scroll-panel">
                    <h3 className="font-mono repo-dashboard-panel-title">Planning gaps</h3>
                    <p className="text-muted small repo-dashboard-page-desc">
                      Open or needs-planning items grouped by doc lane (BACKLOG, KNOWN_GAPS, product, …).
                    </p>
                    <PlanningGapsPanel
                      items={workItems}
                      laneFilter={laneFilter}
                      typeFilter={typeFilter}
                      onUsePromptContext={onUsePromptContext ? handleUsePromptContext : undefined}
                    />
                  </div>
                  <div className="repo-dashboard-card repo-dashboard-scroll-panel">
                    <h3 className="font-mono repo-dashboard-panel-title">Source docs</h3>
                    <p className="text-muted small">
                      {docSources.filter(d => d.contributes).length} contributing ·{" "}
                      {docSources.filter(d => d.found).length}/{docSources.length} found
                    </p>
                    <div className="repo-dashboard-source-docs-list" role="list" aria-label="Source docs list">
                      {docSources.map(row => (
                        <div key={row.path} className="repo-dashboard-row repo-dashboard-doc-row" role="listitem">
                          <span className="font-mono repo-dashboard-doc-path">{row.path}</span>
                          <span className="prompt-loops-pill">
                            {!row.found
                              ? row.optional
                                ? "optional"
                                : "missing"
                              : row.contributes
                                ? `${row.itemCount} items (${row.openCount} open)`
                                : "found · 0 items"}
                          </span>
                        </div>
                      ))}
                    </div>
                    {parserWarnings.length > 0 && (
                      <pre
                        className="repo-dashboard-code font-mono repo-dashboard-parser-warnings"
                        role="status"
                      >
                        {parserWarnings.join("\n")}
                      </pre>
                    )}
                    {snapshot.warnings.length > 0 && (
                      <>
                        <h4 className="font-mono repo-dashboard-panel-subtitle">Repo warnings</h4>
                        <pre className="repo-dashboard-code font-mono repo-dashboard-warnings">
                          {snapshot.warnings.join("\n")}
                        </pre>
                      </>
                    )}
                    {snapshot.gh.message && (
                      <p className="text-muted small repo-dashboard-gh-note">{snapshot.gh.message}</p>
                    )}
                  </div>
                </>
              }
            />
          )}

          {snapshot && snapshotMatchesPath && !loading && section === "work" && (
            <RepoDashboardPage
              title="Work"
              description="Parsed docs markers and optional gh issues. Local git first."
              toolbar={
                <>
                  <div className="repo-dashboard-toolbar" role="group" aria-label="Status filter">
                    {(["all", "open", "started", "done"] as WorkFilter[]).map(filter => (
                      <button
                        key={filter}
                        type="button"
                        className={`repo-dashboard-seg${workFilter === filter ? " active" : ""}`}
                        aria-pressed={workFilter === filter}
                        onClick={() => setWorkFilter(filter)}
                      >
                        {filter}
                        {filter !== "all" ? ` (${workStatusCounts[filter]})` : ` (${workStatusCounts.all})`}
                      </button>
                    ))}
                  </div>
                  <div className="repo-dashboard-toolbar wrap" role="group" aria-label="Doc lane filter">
                    <button
                      type="button"
                      className={`repo-dashboard-seg${laneFilter === "all" ? " active" : ""}`}
                      aria-pressed={laneFilter === "all"}
                      onClick={() => setLaneFilter("all")}
                    >
                      all lanes
                    </button>
                    {docLaneSummaries.map(lane => (
                      <button
                        key={lane.id}
                        type="button"
                        className={`repo-dashboard-seg${laneFilter === lane.id ? " active" : ""}`}
                        aria-pressed={laneFilter === lane.id}
                        onClick={() => setLaneFilter(laneFilter === lane.id ? "all" : lane.id)}
                      >
                        {lane.label} ({lane.open + lane.started})
                      </button>
                    ))}
                  </div>
                  <div className="repo-dashboard-toolbar wrap" role="group" aria-label="Type filter">
                    {WORK_TYPES.map(type => (
                      <button
                        key={type}
                        type="button"
                        className={`repo-dashboard-seg ${type}${typeFilter === type ? " active" : ""}`}
                        aria-pressed={typeFilter === type}
                        onClick={() => setTypeFilter(typeFilter === type ? "all" : type)}
                      >
                        {type}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={`repo-dashboard-seg${typeFilter === "all" ? " active" : ""}`}
                      aria-pressed={typeFilter === "all"}
                      onClick={() => setTypeFilter("all")}
                    >
                      all types
                    </button>
                  </div>
                  <p className="repo-dashboard-filter-summary font-mono text-muted small" role="status">
                    Showing {filteredWorkItems.length} of {workItems.length} items
                    {workFilter !== "all" ? ` · status: ${workFilter}` : ""}
                    {laneFilter !== "all"
                      ? ` · lane: ${docLaneSummaries.find(l => l.id === laneFilter)?.label ?? laneFilter}`
                      : ""}
                    {typeFilter !== "all" ? ` · type: ${typeFilter}` : ""}
                  </p>
                </>
              }
              main={
                <div className="repo-dashboard-card repo-dashboard-scroll-panel">
                  <WorkItemsList
                    items={filteredWorkItems}
                    onUsePromptContext={onUsePromptContext ? handleUsePromptContext : undefined}
                    emptyMessage={
                      workFilter !== "all" || typeFilter !== "all"
                        ? "No items match the active filters. Try clearing status or type."
                        : docSources.every(d => !d.contributes) && !snapshot.gh.authenticated
                          ? "No work items parsed. Add or refresh docs (BACKLOG, KNOWN_GAPS, product/*.md) or authenticate gh for issues."
                          : docSources.every(d => !d.contributes)
                            ? "Docs were found but no actionable rows matched the parser. Check BACKLOG/KNOWN_GAPS tables or TODO checkboxes."
                            : "No work items in this snapshot."
                    }
                  />
                </div>
              }
            />
          )}

        </div>
      </section>
    </div>
  );
}
