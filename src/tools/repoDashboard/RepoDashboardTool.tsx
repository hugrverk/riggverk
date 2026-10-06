import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppSettings,
  DiscoverLocalGitReposResult,
  DiscoveredLocalGitRepo,
  RepoDashboardEntry,
  RepoDashboardSnapshot,
  RepoDashboardWorkItem,
  RepoDashboardWorkType,
  RepoCommitEntry,
} from "../../types";
import {
  discoveredToDashboardEntry,
  isRepoPathAlreadySaved,
  mergeImportedRepoEntries,
  upsertRepoEntry,
} from "../../lib/repoDashboardEntries";
import { mergeWorkItemsDetailed } from "./docsParser";
import {
  authorLabel,
  activeDocWorkCount,
  buildCanonicalWorkSummary,
  buildDocSourceSummaries,
  buildHeatmapCells,
  buildWorkStatusCounts,
  filterDocsSnapshotWarnings,
  filterWorkItemsByCanonicalSource,
  filterWorkItemsByPriority,
  ghIssuesKpiLabel,
  isCanonicalWorkMode,
  normalizePriorityValue,
  normalizeRepoPathForCompare,
  workItemCanonicalSource,
  type CanonicalSourceFilter,
  type PriorityFilter,
} from "./model";
import { useTransientStatus } from "../../lib/useTransientStatus";
import { ToolSectionTabs } from "../../components/ToolSectionTabs";
import { LatestChangeCard } from "./LatestChangeCard";
import { RepoActivityInsights } from "./RepoActivityInsights";
import { pickReadableDocPath, RepoDocsWorkspace } from "./RepoDocsWorkspace";
import { RepoWorkWorkspace } from "./RepoWorkWorkspace";

export type RepoDashboardSection = "overview" | "work" | "docs";

const SECTIONS: { id: RepoDashboardSection; label: string; purpose: string }[] = [
  { id: "overview", label: "Overview", purpose: "Repository summary, charts, recent activity, and contributors" },
  { id: "work", label: "Work", purpose: "Active and completed work from docs and gh issues" },
  { id: "docs", label: "Docs", purpose: "Searchable repository Markdown documentation" },
];

const WORK_TYPES: RepoDashboardWorkType[] = ["roadmap", "feature", "gap", "todo", "fix", "note"];
export const RECENT_ACTIVITY_LOAD_CAP = 30;

type SyncVisualState = "idle" | "loading" | "synced" | "stale";

const STALE_MS = 10 * 60 * 1000;

function syncVisualState(loading: boolean, lastSynced: Date | null): SyncVisualState {
  if (loading) return "loading";
  if (!lastSynced) return "idle";
  if (Date.now() - lastSynced.getTime() > STALE_MS) return "stale";
  return "synced";
}

function RecentActivityList({ commits }: { commits: RepoCommitEntry[] }) {
  if (!commits.length) {
    return <p className="text-muted small" role="status">No recent commits in loaded range.</p>;
  }
  return <CommitHistoryList commits={commits} />;
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

export interface RepoDashboardPromptContextPayload {
  item: RepoDashboardWorkItem;
  repoPath: string;
}

interface RepoDashboardToolProps {
  onUsePromptContext?: (payload: RepoDashboardPromptContextPayload) => void;
  savedEntries?: RepoDashboardEntry[];
  activeEntryId?: string | null;
  mutateSavedEntries?: (mutator: (current: AppSettings) => AppSettings) => Promise<AppSettings>;
}

export function RepoDashboardTool({
  onUsePromptContext,
  savedEntries: savedEntriesProp = [],
  activeEntryId = null,
  mutateSavedEntries,
}: RepoDashboardToolProps) {
  const [section, setSection] = useState<RepoDashboardSection>("overview");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RepoDashboardSnapshot | null>(null);
  // The path the snapshot was requested with; the backend echoes an expanded path (e.g. `~`), so compare against this.
  const [snapshotRequestPath, setSnapshotRequestPath] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [typeFilter, setTypeFilter] = useState<RepoDashboardWorkType | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<CanonicalSourceFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const savedEntries = savedEntriesProp;
  const [saveError, setSaveError] = useState<string | null>(null);
  const { status: saveStatus, showStatus: showSaveStatus, clearStatus: clearSaveStatus } = useTransientStatus(2500);
  const { status: pickerStatus, showStatus: showPickerStatus } = useTransientStatus(2500);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverParentPath, setDiscoverParentPath] = useState("");
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverResult, setDiscoverResult] = useState<DiscoverLocalGitReposResult | null>(null);
  const [discoverSelectedPaths, setDiscoverSelectedPaths] = useState<Set<string>>(() => new Set());
  const [discoverImportStatus, setDiscoverImportStatus] = useState<string | null>(null);
  const [docsSelectedPath, setDocsSelectedPath] = useState<string | null>(null);
  const [docsSearchQuery, setDocsSearchQuery] = useState("");
  const loadSeqRef = useRef(0);
  const discoverSeqRef = useRef(0);
  const [syncClock, setSyncClock] = useState(0);

  useEffect(() => {
    if (!lastSynced || loading) return;
    const id = window.setInterval(() => setSyncClock(t => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [lastSynced, loading]);

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
      setSnapshotRequestPath(trimmedPath);
      setLastSynced(new Date());
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setError(String(e));
      setSnapshot(null);
      setSnapshotRequestPath(null);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await refreshFor(repoPath, defaultBranch);
  }, [repoPath, defaultBranch, refreshFor]);

  const initialActiveLoadedRef = useRef(false);
  useEffect(() => {
    if (initialActiveLoadedRef.current || !savedEntries.length) return;
    const activeEntry = savedEntries.find(e => e.id === activeEntryId) ?? savedEntries[0];
    if (activeEntry?.path) {
      const branch = activeEntry.default_branch ?? "";
      setRepoPath(activeEntry.path);
      setDefaultBranch(branch);
      void refreshFor(activeEntry.path, branch);
      initialActiveLoadedRef.current = true;
    }
  }, [activeEntryId, refreshFor, savedEntries]);

  useEffect(() => {
    if (!snapshot) {
      setDocsSelectedPath(null);
      return;
    }
    setDocsSelectedPath(prev => pickReadableDocPath(snapshot.docs, prev));
  }, [snapshot]);

  const runDiscoverScan = useCallback(async (parentPath: string) => {
    const seq = discoverSeqRef.current + 1;
    discoverSeqRef.current = seq;
    setDiscoverLoading(true);
    setDiscoverError(null);
    setDiscoverResult(null);
    setDiscoverImportStatus(null);
    try {
      const result = await invoke<DiscoverLocalGitReposResult>("discover_local_git_repos", {
        parentPath,
      });
      if (seq !== discoverSeqRef.current) return;
      setDiscoverResult(result);
      const selectable = result.repos.filter(
        r => !isRepoPathAlreadySaved(r.path, savedEntries ?? []),
      );
      setDiscoverSelectedPaths(new Set(selectable.map(r => r.path)));
    } catch (e) {
      if (seq !== discoverSeqRef.current) return;
      setDiscoverError(String(e));
      setDiscoverSelectedPaths(new Set());
    } finally {
      if (seq === discoverSeqRef.current) setDiscoverLoading(false);
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
    discoverSeqRef.current += 1;
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
      if (!mutateSavedEntries) throw new Error("settings mutation unavailable");
      await mutateSavedEntries(settings => ({
        ...settings,
        repo_dashboard_entries: mergeImportedRepoEntries(settings.repo_dashboard_entries ?? [], toImport),
      }));
      setDiscoverImportStatus(`imported ${toImport.length}`);
      closeDiscoverPanel();
    } catch (e) {
      setDiscoverError(String(e));
    }
  }, [closeDiscoverPanel, discoverResult, discoverSelectedPaths, mutateSavedEntries]);

  const saveCurrentRepo = useCallback(async () => {
    const path = repoPath.trim();
    clearSaveStatus();
    setSaveError(null);
    if (!path) {
      setSaveError("Enter a local repository path");
      return;
    }
    try {
      if (!mutateSavedEntries) throw new Error("settings mutation unavailable");
      const branch = defaultBranch.trim() || null;
      await mutateSavedEntries(settings => {
        const { entries, id } = upsertRepoEntry(settings.repo_dashboard_entries ?? [], path, branch);
        return {
          ...settings,
          repo_dashboard_entries: entries,
          active_repo_dashboard_id: id,
        };
      });
      showSaveStatus("saved");
    } catch (e) {
      setSaveError(String(e));
    }
  }, [clearSaveStatus, defaultBranch, mutateSavedEntries, repoPath, showSaveStatus]);

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
    () => (snapshot ? buildDocSourceSummaries(snapshot.docs, workItems).filter(
      summary => summary.found || !summary.optional,
    ) : []),
    [snapshot, workItems],
  );

  const canonicalMode = useMemo(
    () => (snapshot ? isCanonicalWorkMode(snapshot.docs) : false),
    [snapshot],
  );

  useEffect(() => {
    if (!snapshot) return;
    if (canonicalMode) {
      if (
        sourceFilter !== "all" &&
        !workItems.some(i => workItemCanonicalSource(i) === sourceFilter)
      ) {
        setSourceFilter("all");
      }
      if (
        priorityFilter !== "all" &&
        !workItems.some(i => normalizePriorityValue(i.priority) === priorityFilter)
      ) {
        setPriorityFilter("all");
      }
      return;
    }
    if (typeFilter !== "all" && !workItems.some(i => i.type === typeFilter)) {
      setTypeFilter("all");
    }
  }, [snapshot, workItems, canonicalMode, sourceFilter, priorityFilter, typeFilter]);

  const filteredWorkItems = useMemo(() => {
    let list = workItems;
    if (canonicalMode) {
      list = filterWorkItemsByCanonicalSource(list, sourceFilter);
      list = filterWorkItemsByPriority(list, priorityFilter);
    } else if (typeFilter !== "all") {
      list = list.filter(i => i.type === typeFilter);
    }
    return list;
  }, [workItems, canonicalMode, sourceFilter, priorityFilter, typeFilter]);

  const canonicalSummary = useMemo(
    () =>
      canonicalMode
        ? buildCanonicalWorkSummary(workItems, filteredWorkItems)
        : null,
    [canonicalMode, workItems, filteredWorkItems],
  );

  const workStatusCounts = useMemo(() => buildWorkStatusCounts(workItems), [workItems]);

  const heatmap = useMemo(
    () => (snapshot ? buildHeatmapCells(snapshot.commits) : []),
    [snapshot],
  );

  const recentCommits = useMemo(
    () => (snapshot ? snapshot.commits.slice(0, RECENT_ACTIVITY_LOAD_CAP) : []),
    [snapshot],
  );

  const latestMerge = snapshot?.gh.merged_prs[0] ?? null;
  const latestCommit = snapshot?.latest_commit ?? null;
  const selectedSavedId =
    savedEntries?.find(e => normalizeRepoPathForCompare(e.path) === normalizeRepoPathForCompare(repoPath))?.id ?? "";
  const snapshotMatchesPath =
    snapshot != null &&
    snapshotRequestPath != null &&
    repoPath.trim() !== "" &&
    normalizeRepoPathForCompare(snapshotRequestPath) ===
      normalizeRepoPathForCompare(repoPath);

  const syncState = useMemo(
    () => syncVisualState(loading, lastSynced),
    [loading, lastSynced, syncClock],
  );
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
    if (id === "overview") return String(snapshot.commits.length);
    if (id === "work") return String(workStatusCounts.open + workStatusCounts.started);
    if (id === "docs") {
      return String(snapshot.docs.filter(d => d.found && d.readable).length);
    }
    return "-";
  };

  const needsPlanningCount = canonicalMode
    ? 0
    : workItems.filter(i => i.needsPlan && i.status !== "done").length;

  const ghIssuesLabel = snapshot
    ? ghIssuesKpiLabel(snapshot.gh.available, snapshot.gh.authenticated)
    : "gh issues";
  const docOpenCount = activeDocWorkCount(workItems);

  return (
    <div className="repo-dashboard-tool">
      <section className="repo-dashboard-main">
        <header className="repo-dashboard-topbar">
          <div className="repo-dashboard-topbar-nav">
            <ToolSectionTabs
              className="repo-dashboard-section-tabs"
              items={SECTIONS.map(({ id, label }) => ({
                id,
                label,
                count: sectionCount(id),
              }))}
              activeId={section}
              onSelect={id => setSection(id as RepoDashboardSection)}
              ariaLabel="Dashboard sections"
            />
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
          </div>
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
              <div className="repo-dashboard-path-field">
                <input
                  className="repo-dashboard-field repo-dashboard-field-path"
                  value={repoPath}
                  onChange={e => setRepoPath(e.target.value)}
                  placeholder="Local repository path"
                  aria-label="Local repository path"
                  spellCheck={false}
                />
                <span
                  className={`repo-dashboard-sync-status repo-dashboard-sync-status-${syncState}`}
                  role="status"
                  aria-live="polite"
                >
                  {syncLabel}
                  {pickerStatus ? ` · ${pickerStatus}` : ""}
                  {saveStatus ? ` · ${saveStatus}` : ""}
                </span>
              </div>
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
              title="Default branch override (empty = auto-detect)"
              spellCheck={false}
            />
            <button
              type="button"
              className="repo-dashboard-btn repo-dashboard-btn-secondary"
              onClick={() => void startDiscoverLocalRepos()}
              disabled={loading || discoverLoading}
              aria-label="Discover local git repositories in a folder"
              title="Scan a parent folder for local git checkouts"
            >
              Discover
            </button>
            <div className="repo-dashboard-strip-actions">
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
                  Imports add to saved Repo Dashboard entries for Prompt Builder.
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

          {saveError && (
            <div className="repo-dashboard-card repo-dashboard-error" role="alert">
              <h2 className="font-mono">Save failed</h2>
              <pre className="font-mono">{saveError}</pre>
            </div>
          )}

          {!loading && !error && !snapshot && (
            <div className="repo-dashboard-card" role="status">
              <h2 className="font-mono">Not synced</h2>
              <p className="text-muted small">
                Enter a local checkout path and press refresh. Git history and working-tree data
                come from that checkout. Documentation loads from the remote default branch when
                available, with cached-remote or local-checkout fallback. Optional gh CLI
                enrichment when authenticated. No GitHub token stored.
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
              <RepoActivityInsights
                commits={snapshot.commits}
                commitsTruncated={snapshot.commits_truncated}
                heatmapCells={heatmap}
                metrics={{
                  docsFound: docSources.filter(d => d.found).length,
                  docsTotal: docSources.length,
                  headFileCount: snapshot.changed_files.length,
                  commitsLoaded: snapshot.commits.length,
                  docOpenCount,
                  workOpenCount: workStatusCounts.open,
                  ghIssuesValue: snapshot.gh.authenticated
                    ? snapshot.gh.open_issues.length
                    : null,
                  ghIssuesLabel,
                  needsPlanningCount,
                }}
                onNavigate={setSection}
              />

              <div className="repo-dashboard-overview-lower">
                <div className="repo-dashboard-card repo-dashboard-latest">
                  <h2 className="font-mono">Latest merge / commit</h2>
                  <LatestChangeCard
                    snapshot={snapshot}
                    latestMerge={latestMerge}
                    latestCommit={latestCommit}
                  />
                </div>
                <div className="repo-dashboard-card repo-dashboard-recent-activity-card">
                  <h2 className="font-mono">Recent activity</h2>
                  <div
                    className="repo-dashboard-recent-activity-scroll"
                    role="region"
                    aria-label="Recent commits"
                    tabIndex={0}
                  >
                    <RecentActivityList commits={recentCommits} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {snapshot && snapshotMatchesPath && !loading && section === "docs" && (
            <RepoDocsWorkspace
              docs={snapshot.docs}
              docsSource={snapshot.docs_source}
              docsRef={snapshot.docs_ref}
              docsStale={snapshot.docs_stale}
              parserWarnings={parserWarnings}
              repoWarnings={filterDocsSnapshotWarnings(snapshot.warnings, snapshot.docs_source)}
              ghMessage={snapshot.gh.message}
              selectedPath={docsSelectedPath}
              onSelectPath={setDocsSelectedPath}
              searchQuery={docsSearchQuery}
              onSearchQueryChange={setDocsSearchQuery}
            />
          )}

          {snapshot && snapshotMatchesPath && !loading && section === "work" && (
            <RepoWorkWorkspace
              items={filteredWorkItems}
              totalItemCount={workItems.length}
              canonicalMode={canonicalMode}
              sourceFilter={sourceFilter}
              priorityFilter={priorityFilter}
              typeFilter={typeFilter}
              workTypes={WORK_TYPES}
              canonicalSummary={canonicalSummary}
              onSourceFilterChange={setSourceFilter}
              onPriorityFilterChange={setPriorityFilter}
              onTypeFilterChange={setTypeFilter}
              onResetFilters={() => {
                setSourceFilter("all");
                setPriorityFilter("all");
                setTypeFilter("all");
              }}
              onUsePromptContext={onUsePromptContext ? handleUsePromptContext : undefined}
              emptyMessage={
                (canonicalMode && (sourceFilter !== "all" || priorityFilter !== "all")) ||
                (!canonicalMode && typeFilter !== "all")
                  ? "No items match the active filters. Try clearing filters."
                  : docSources.every(d => !d.contributes) && !snapshot.gh.authenticated
                    ? "No work items parsed. Add canonical docs (BACKLOG, audit/ISSUES) or authenticate gh for issues."
                    : docSources.every(d => !d.contributes)
                      ? "Docs were found but no active queue rows matched the parser."
                      : "No active work items in this snapshot."
              }
            />
          )}

        </div>
      </section>
    </div>
  );
}
