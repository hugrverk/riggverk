import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { mergeWorkItems } from "./docsParser";
import {
  authorLabel,
  buildHeatmapCells,
  buildLineChartData,
  buildRemainingByType,
  buildSourceHealth,
  commitDateRangeLabel,
  countByAuthor,
  eventsFromCommits,
  normalizeRepoPathForCompare,
  WORK_TYPE_COLORS,
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
const COMMITS_LOAD_LIMIT = 500;
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
  const changedCount = snapshot.changed_files.length;

  if (latestMerge) {
    return (
      <div className="repo-dashboard-latest-content">
        <div className="repo-dashboard-latest-hero">
          <span className="repo-dashboard-source-pill">gh merge</span>
          <h3 className="font-mono repo-dashboard-latest-headline">
            #{latestMerge.number} {latestMerge.title}
          </h3>
          <p className="repo-dashboard-latest-lead text-muted small">
            GitHub merged PR via gh CLI · {latestMerge.author} ·{" "}
            {new Date(latestMerge.merged_at).toLocaleString()}
          </p>
        </div>
        <dl className="repo-dashboard-latest-facts font-mono">
          <div>
            <dt>Source</dt>
            <dd>GitHub merged PR (gh)</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{branchLabel}</dd>
          </div>
          <div>
            <dt>Default</dt>
            <dd>{snapshot.default_branch ?? "—"}</dd>
          </div>
          <div>
            <dt>HEAD files</dt>
            <dd>{changedCount} changed (local git show HEAD)</dd>
          </div>
        </dl>
        {latestMerge.body ? (
          <pre className="repo-dashboard-code font-mono repo-dashboard-latest-body">{latestMerge.body.slice(0, 4000)}</pre>
        ) : null}
      </div>
    );
  }

  if (latestCommit) {
    return (
      <div className="repo-dashboard-latest-content">
        <div className="repo-dashboard-latest-hero">
          <span className="repo-dashboard-source-pill">local commit</span>
          <h3 className="font-mono repo-dashboard-latest-headline">{latestCommit.subject}</h3>
          <p className="repo-dashboard-latest-lead text-muted small">
            Latest local commit · {latestCommit.short_sha} · {authorLabel(latestCommit)} ·{" "}
            {new Date(latestCommit.authored_at * 1000).toLocaleString()}
          </p>
        </div>
        <dl className="repo-dashboard-latest-facts font-mono">
          <div>
            <dt>Source</dt>
            <dd>Latest local commit</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{branchLabel}</dd>
          </div>
          <div>
            <dt>Default</dt>
            <dd>{snapshot.default_branch ?? "—"}</dd>
          </div>
          <div>
            <dt>HEAD files</dt>
            <dd>{changedCount} changed at HEAD</dd>
          </div>
        </dl>
      </div>
    );
  }

  return <p className="text-muted small">No latest change found in loaded snapshot.</p>;
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
}: {
  items: RepoDashboardWorkItem[];
  emptyMessage?: string;
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
        </div>
      ))}
      </div>
    </>
  );
}

function PlanningGapsPanel({
  items,
  typeFilter,
}: {
  items: RepoDashboardWorkItem[];
  typeFilter: RepoDashboardWorkType | "all";
}) {
  const filtered = items.filter(
    i => (i.needsPlan || i.status === "open") && (typeFilter === "all" || i.type === typeFilter),
  );
  const groups = WORK_TYPES.map(type => ({
    type,
    items: filtered.filter(i => i.type === type),
  })).filter(g => g.items.length);

  if (!filtered.length) {
    return (
      <p className="text-muted small" role="status">
        No open or needs-planning items for the current type filter.
      </p>
    );
  }

  return (
    <div className="repo-dashboard-plan-groups">
      {groups.map(({ type, items: groupItems }) => (
        <section key={type} className="repo-dashboard-plan-group">
          <h4 className="font-mono repo-dashboard-plan-group-title">
            <span className={`repo-dashboard-chip ${type}`}>{type}</span>
            <span className="text-muted">{groupItems.length}</span>
          </h4>
          <WorkItemsList
            items={groupItems}
            emptyMessage=""
          />
        </section>
      ))}
    </div>
  );
}

interface RepoDashboardToolProps {
  toolsSwitcher?: ReactNode;
}

export function RepoDashboardTool({ toolsSwitcher }: RepoDashboardToolProps) {
  const [section, setSection] = useState<RepoDashboardSection>("overview");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RepoDashboardSnapshot | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [workFilter, setWorkFilter] = useState<WorkFilter>("all");
  const [typeFilter, setTypeFilter] = useState<RepoDashboardWorkType | "all">("all");
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

  const workItems = useMemo(
    () => (snapshot ? mergeWorkItems(snapshot.docs, snapshot.gh.open_issues) : []),
    [snapshot],
  );

  const filteredWorkItems = useMemo(() => {
    let list = workItems;
    if (workFilter !== "all") list = list.filter(i => i.status === workFilter);
    if (typeFilter !== "all") list = list.filter(i => i.type === typeFilter);
    return list;
  }, [workItems, workFilter, typeFilter]);

  const workStatusCounts = useMemo(() => {
    const counts = { all: workItems.length, open: 0, started: 0, done: 0 };
    for (const item of workItems) counts[item.status] += 1;
    return counts;
  }, [workItems]);

  const lineChart = useMemo(
    () => (snapshot ? buildLineChartData(eventsFromCommits(snapshot.commits)) : null),
    [snapshot],
  );
  const heatmap = useMemo(
    () => (snapshot ? buildHeatmapCells(snapshot.commits) : []),
    [snapshot],
  );
  const remaining = useMemo(() => buildRemainingByType(workItems), [workItems]);
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

  const planningCount = workItems.filter(i => i.needsPlan || i.status === "open").length;

  const sectionCount = (id: RepoDashboardSection): string => {
    if (!snapshot) return "-";
    if (id === "activity") return String(snapshot.commits.length);
    if (id === "work") return String(workItems.length);
    if (id === "sources") {
      const latest = latestMerge || latestCommit ? 1 : 0;
      return String(latest + planningCount);
    }
    return String(snapshot.gh.merged_prs.length || snapshot.commits.length);
  };

  return (
    <div className="repo-dashboard-tool">
      <aside className="repo-dashboard-sidebar">
        <div className="tool-context-brand font-mono">
          <span className="tools-title-dot" aria-hidden="true" />
          <span>kretsverket.repo.state</span>
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
              <div className="repo-dashboard-kpis">
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("sources")}>
                  <div className="repo-dashboard-kpi-num font-mono">{snapshot.gh.merged_prs.length || (latestCommit ? 1 : 0)}</div>
                  <div className="repo-dashboard-kpi-label">latest change</div>
                </button>
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("activity")}>
                  <div className="repo-dashboard-kpi-num font-mono">{snapshot.commits.length}</div>
                  <div className="repo-dashboard-kpi-label">commits loaded</div>
                </button>
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("work")}>
                  <div className="repo-dashboard-kpi-num font-mono">{snapshot.gh.open_issues.length}</div>
                  <div className="repo-dashboard-kpi-label">open issues (gh)</div>
                </button>
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("work")}>
                  <div className="repo-dashboard-kpi-num font-mono">{workItems.filter(i => i.status === "open").length}</div>
                  <div className="repo-dashboard-kpi-label">open items</div>
                </button>
                <button type="button" className="repo-dashboard-kpi" onClick={() => setSection("sources")}>
                  <div className="repo-dashboard-kpi-num font-mono">{workItems.filter(i => i.needsPlan).length}</div>
                  <div className="repo-dashboard-kpi-label">needs planning</div>
                </button>
              </div>

              <div className="repo-dashboard-grid cols repo-dashboard-overview-charts">
                <div className="repo-dashboard-card repo-dashboard-activity-card">
                  <h2 className="font-mono">Repo activity (loaded history)</h2>
                  {lineChart ? (
                    <ActivityLineChart data={lineChart} />
                  ) : (
                    <p className="text-muted small">No matching activity.</p>
                  )}
                  <p className="text-muted small repo-dashboard-footnote">
                    Up to {COMMITS_LOAD_LIMIT} recent commits.
                    {snapshot.commits.length >= COMMITS_LOAD_LIMIT ? " Older history not loaded." : ""}
                    {" "}Blue = top commit author · Green = second by volume.
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
                    <h2 className="font-mono">Remaining by type</h2>
                    <div className="repo-dashboard-rem">
                      {remaining.map(row => (
                        <button
                          key={row.type}
                          type="button"
                          className={`repo-dashboard-remitem ${row.type}${typeFilter === row.type ? " active" : ""}`}
                          style={{ color: WORK_TYPE_COLORS[row.type] }}
                          aria-pressed={typeFilter === row.type}
                          onClick={() => {
                            setTypeFilter(row.type);
                            setSection("sources");
                          }}
                        >
                          <div className="repo-dashboard-remtitle">
                            <span>{row.type}</span>
                            <strong>{row.open}</strong>
                          </div>
                          <div className="repo-dashboard-bar">
                            <div
                              className="repo-dashboard-bar-fill"
                              style={{
                                width: `${Math.max(2, (row.open / Math.max(1, ...remaining.map(r => r.open))) * 100)}%`,
                                background: WORK_TYPE_COLORS[row.type],
                              }}
                            />
                          </div>
                          <div className="repo-dashboard-remmeta">
                            <span>{row.pctLeft}% left</span>
                            <span>{row.done} done</span>
                            <span>{row.needsPlan} plan</span>
                          </div>
                        </button>
                      ))}
                    </div>
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
              description={`Recent commit history from local git (up to ${COMMITS_LOAD_LIMIT}${snapshot.commits.length >= COMMITS_LOAD_LIMIT ? ", limit reached" : ""}; list shows 120).`}
              toolbar={<ActivitySummaryStrip snapshot={snapshot} />}
              main={
                <div className="repo-dashboard-card repo-dashboard-scroll-panel">
                  <CommitHistoryList commits={snapshot.commits.slice(0, 120)} />
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
                  <div className="repo-dashboard-card repo-dashboard-scroll-panel">
                    <h3 className="font-mono repo-dashboard-panel-title">Changed files at HEAD (local git)</h3>
                    <p className="text-muted small">
                      {latestMerge
                        ? "Merge title may come from gh; files below are from local git show HEAD, not the PR diff."
                        : "From local git show HEAD — not a GitHub PR file list."}
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
                      Open or needs-planning items grouped by type — actionable decisions, not raw dump.
                    </p>
                    <PlanningGapsPanel items={workItems} typeFilter={typeFilter} />
                  </div>
                  <div className="repo-dashboard-card repo-dashboard-scroll-panel">
                    <h3 className="font-mono repo-dashboard-panel-title">Source docs</h3>
                    {snapshot.docs.map(doc => (
                      <div key={doc.path} className="repo-dashboard-row">
                        <span>{doc.path}</span>
                        <span className="prompt-loops-pill">{doc.found ? "found" : "missing"}</span>
                      </div>
                    ))}
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
                    {typeFilter !== "all" ? ` · type: ${typeFilter}` : ""}
                  </p>
                </>
              }
              main={
                <div className="repo-dashboard-card repo-dashboard-scroll-panel">
                  <WorkItemsList
                    items={filteredWorkItems}
                    emptyMessage={
                      workFilter !== "all" || typeFilter !== "all"
                        ? "No items match the active filters. Try clearing status or type."
                        : "No work items parsed from docs or gh in this snapshot."
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
