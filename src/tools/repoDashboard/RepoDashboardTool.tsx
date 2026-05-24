import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  RepoDashboardSnapshot,
  RepoDashboardWorkItem,
  RepoDashboardWorkStatus,
  RepoDashboardWorkType,
} from "../../types";
import { mergeWorkItems } from "./docsParser";
import {
  authorLabel,
  buildHeatmapCells,
  buildLineChartData,
  buildRemainingByType,
  buildSourceHealth,
  countByAuthor,
  eventsFromCommits,
  WORK_TYPE_COLORS,
} from "./model";
import { ActivityHeatmap, ActivityLineChart } from "./RepoDashboardCharts";

export type RepoDashboardSection =
  | "overview"
  | "history"
  | "latest"
  | "work"
  | "planning";

const SECTIONS: { id: RepoDashboardSection; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "history", label: "Git history" },
  { id: "latest", label: "Latest merge" },
  { id: "work", label: "Work state" },
  { id: "planning", label: "Planning gaps" },
];

const WORK_TYPES: RepoDashboardWorkType[] = ["roadmap", "feature", "gap", "todo", "fix", "note"];
const COMMITS_LOAD_LIMIT = 500;

type WorkFilter = "all" | RepoDashboardWorkStatus;

function repoEntryIdFromPath(path: string): string {
  const base = path.replace(/\/+$/, "").split("/").pop() || "repo";
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "repo";
}

function repoEntryLabelFromPath(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || "Repository";
}

function WorkItemsList({ items }: { items: RepoDashboardWorkItem[] }) {
  if (!items.length) {
    return <p className="text-muted small">No matching items found.</p>;
  }
  return (
    <div className="repo-dashboard-list">
      {items.slice(0, 120).map(item => (
        <div key={`${item.path}-${item.line ?? item.text}`} className="repo-dashboard-item">
          <div className="repo-dashboard-item-title font-mono">{item.text}</div>
          <div className="repo-dashboard-item-meta">
            <span className={`repo-dashboard-chip ${item.type}`}>{item.type}</span>
            <span>{item.source}</span>
            <span>/ {item.status}</span>
            <span>/ {item.path}{item.line ? `:${item.line}` : ""}</span>
            {item.needsPlan && <span className="repo-dashboard-chip todo">needs planning</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function RepoDashboardTool() {
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
  const pickerTimerRef = useRef<number | null>(null);

  const showPickerStatus = useCallback((text: string) => {
    setPickerStatus(text);
    if (pickerTimerRef.current !== null) window.clearTimeout(pickerTimerRef.current);
    pickerTimerRef.current = window.setTimeout(() => setPickerStatus(null), 2500);
  }, []);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(settings => {
        setSavedEntries(settings.repo_dashboard_entries ?? []);
        const active = settings.repo_dashboard_entries?.find(
          e => e.id === settings.active_repo_dashboard_id,
        );
        if (active?.path) {
          setRepoPath(active.path);
          setDefaultBranch(active.default_branch ?? "");
        }
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    const path = repoPath.trim();
    if (!path) {
      setError("Enter a local repository path");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<RepoDashboardSnapshot>("get_repo_dashboard_snapshot", {
        repoPath: path,
        defaultBranch: defaultBranch.trim() || null,
        includeGh: true,
      });
      setSnapshot(data);
      setLastSynced(new Date());
    } catch (e) {
      setError(String(e));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [repoPath, defaultBranch]);

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
      const label = repoEntryLabelFromPath(path);
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
      }
    } catch {
      showPickerStatus("folder picker unavailable");
    }
  }, [repoPath, showPickerStatus]);

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

  const sectionCount = (id: RepoDashboardSection): string => {
    if (!snapshot) return "-";
    if (id === "history") return String(snapshot.commits.length);
    if (id === "latest") return latestMerge || latestCommit ? "1" : "0";
    if (id === "work") return String(workItems.length);
    if (id === "planning") return String(workItems.filter(i => i.needsPlan || i.status === "open").length);
    return String(snapshot.gh.merged_prs.length || snapshot.commits.length);
  };

  return (
    <div className="repo-dashboard-tool">
      <aside className="repo-dashboard-sidebar">
        <div className="repo-dashboard-brand font-mono">
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
            >
              <span>{index + 1}. {label}</span>
              <span className="prompt-loops-count">{sectionCount(id)}</span>
            </button>
          ))}
        </nav>
        <footer className="repo-dashboard-sidebar-foot font-mono">
          <div><span className="prompt-loops-pill">local git</span> first</div>
          <div><span className="prompt-loops-pill">no PAT</span> stored</div>
          {snapshot?.gh.available && (
            <div className="text-muted">
              gh: {snapshot.gh.authenticated ? "enhanced" : "local-only"}
            </div>
          )}
        </footer>
      </aside>

      <section className="repo-dashboard-main">
        <header className="repo-dashboard-topbar">
          <div className="repo-dashboard-topbar-head">
            <h2 className="repo-dashboard-section-title">
              {SECTIONS.find(s => s.id === section)?.label ?? "Overview"}
            </h2>
            <p className="repo-dashboard-sync-note text-muted small" aria-live="polite">
              {lastSynced ? `Synced ${lastSynced.toLocaleString()}` : "Not synced"}
              {pickerStatus ? ` · ${pickerStatus}` : ""}
              {saveStatus ? ` · ${saveStatus}` : ""}
            </p>
          </div>
          <div className="repo-dashboard-controls">
            {savedEntries && savedEntries.length > 0 && (
              <label className="repo-dashboard-control">
                <span className="repo-dashboard-control-label">Saved</span>
                <select
                  className="repo-dashboard-field"
                  value={selectedSavedId}
                  onChange={e => {
                    const entry = savedEntries?.find(x => x.id === e.target.value);
                    if (entry) {
                      setRepoPath(entry.path);
                      setDefaultBranch(entry.default_branch ?? "");
                    }
                  }}
                  aria-label="Saved repositories"
                >
                  <option value="">Choose…</option>
                  {savedEntries.map(entry => (
                    <option key={entry.id} value={entry.id}>{entry.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="repo-dashboard-control repo-dashboard-control-grow">
              <span className="repo-dashboard-control-label">Path</span>
              <div className="repo-dashboard-path-row">
                <input
                  className="repo-dashboard-field repo-dashboard-field-path"
                  value={repoPath}
                  onChange={e => setRepoPath(e.target.value)}
                  placeholder="/path/to/repo"
                  aria-label="Local repository path"
                />
                <button
                  type="button"
                  className="repo-dashboard-btn"
                  onClick={() => void chooseRepoFolder()}
                  disabled={loading}
                  aria-label="Choose repository folder"
                >
                  Browse
                </button>
              </div>
            </label>
            <label className="repo-dashboard-control">
              <span className="repo-dashboard-control-label">Branch</span>
              <input
                className="repo-dashboard-field repo-dashboard-field-branch"
                value={defaultBranch}
                onChange={e => setDefaultBranch(e.target.value)}
                placeholder="main"
                aria-label="Default branch override"
              />
            </label>
            <div className="repo-dashboard-control-actions">
              <button
                type="button"
                className="repo-dashboard-btn"
                onClick={() => void saveCurrentRepo()}
                disabled={loading || !repoPath.trim()}
                aria-label="Save repository path to settings"
              >
                Save
              </button>
              <button
                type="button"
                className="repo-dashboard-btn repo-dashboard-btn-primary"
                onClick={() => void refresh()}
                disabled={loading}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>
        </header>

        <div className="repo-dashboard-workspace">
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

          {snapshot && !loading && section === "overview" && (
            <>
              <div className="repo-dashboard-kpis">
                <button type="button" className="repo-dashboard-card repo-dashboard-kpi" onClick={() => setSection("latest")}>
                  <div className="repo-dashboard-kpi-num font-mono">{snapshot.gh.merged_prs.length || (latestCommit ? 1 : 0)}</div>
                  <div className="repo-dashboard-kpi-label">latest change</div>
                </button>
                <button type="button" className="repo-dashboard-card repo-dashboard-kpi" onClick={() => setSection("history")}>
                  <div className="repo-dashboard-kpi-num font-mono">{snapshot.commits.length}</div>
                  <div className="repo-dashboard-kpi-label">commits loaded</div>
                </button>
                <button type="button" className="repo-dashboard-card repo-dashboard-kpi" onClick={() => setSection("work")}>
                  <div className="repo-dashboard-kpi-num font-mono">{snapshot.gh.open_issues.length}</div>
                  <div className="repo-dashboard-kpi-label">open issues (gh)</div>
                </button>
                <button type="button" className="repo-dashboard-card repo-dashboard-kpi" onClick={() => setSection("work")}>
                  <div className="repo-dashboard-kpi-num font-mono">{workItems.filter(i => i.status === "open").length}</div>
                  <div className="repo-dashboard-kpi-label">open items</div>
                </button>
                <button type="button" className="repo-dashboard-card repo-dashboard-kpi" onClick={() => setSection("planning")}>
                  <div className="repo-dashboard-kpi-num font-mono">{workItems.filter(i => i.needsPlan).length}</div>
                  <div className="repo-dashboard-kpi-label">needs planning</div>
                </button>
              </div>

              <div className="repo-dashboard-grid cols repo-dashboard-overview-row">
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
                    {" "}Blue = uxsmedjan · Green = PRIVATE.
                  </p>
                </div>
                <div className="repo-dashboard-card repo-dashboard-latest">
                  <h2 className="font-mono">Latest merge / commit</h2>
                  {latestMerge ? (
                    <div className="repo-dashboard-item">
                      <div className="repo-dashboard-item-title font-mono">#{latestMerge.number} {latestMerge.title}</div>
                      <div className="repo-dashboard-item-meta">
                        <span>by {latestMerge.author}</span>
                        <span>/ merged {new Date(latestMerge.merged_at).toLocaleString()}</span>
                      </div>
                      {latestMerge.body && <pre className="repo-dashboard-code font-mono">{latestMerge.body.slice(0, 4000)}</pre>}
                    </div>
                  ) : latestCommit ? (
                    <div className="repo-dashboard-item">
                      <div className="repo-dashboard-item-title font-mono">{latestCommit.subject}</div>
                      <div className="repo-dashboard-item-meta">
                        <span>{latestCommit.short_sha}</span>
                        <span>/ {authorLabel(latestCommit)}</span>
                        <span>/ {new Date(latestCommit.authored_at * 1000).toLocaleString()}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-muted small">No latest change found.</p>
                  )}
                </div>
              </div>

              <div className="repo-dashboard-grid heatrow repo-dashboard-activity-section">
                <div className="repo-dashboard-card repo-dashboard-heat-card">
                  <h2 className="font-mono">Activity heatmap</h2>
                  {heatmap.length ? <ActivityHeatmap cells={heatmap} /> : <p className="text-muted small">No activity data.</p>}
                  <h2 className="font-mono repo-dashboard-subheading">Remaining by type</h2>
                  <div className="repo-dashboard-rem">
                    {remaining.map(row => (
                      <button
                        key={row.type}
                        type="button"
                        className={`repo-dashboard-remitem ${row.type}${typeFilter === row.type ? " active" : ""}`}
                        style={{ color: WORK_TYPE_COLORS[row.type] }}
                        onClick={() => {
                          setTypeFilter(row.type);
                          setSection("planning");
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
                <div className="repo-dashboard-card repo-dashboard-health-card">
                  <h2 className="font-mono">Source health</h2>
                  {health.map(row => (
                    <div key={row.label} className="repo-dashboard-row">
                      <span className="small">{row.label}</span>
                      <span className="prompt-loops-pill">{row.value}</span>
                    </div>
                  ))}
                  {snapshot.warnings.length > 0 && (
                    <pre className="repo-dashboard-code font-mono repo-dashboard-warnings">{snapshot.warnings.join("\n")}</pre>
                  )}
                </div>
              </div>
            </>
          )}

          {snapshot && !loading && section === "history" && (
            <div className="repo-dashboard-grid cols">
              <div className="repo-dashboard-card">
                <h2 className="font-mono">Commit history (recent)</h2>
                <p className="text-muted small">
                  Showing up to {COMMITS_LOAD_LIMIT} most recent commits
                  {snapshot.commits.length >= COMMITS_LOAD_LIMIT ? " (limit reached)." : "."}
                </p>
                <div className="repo-dashboard-list">
                  {snapshot.commits.slice(0, 120).map(commit => (
                    <div key={commit.sha} className="repo-dashboard-item">
                      <div className="repo-dashboard-item-title font-mono">{commit.subject}</div>
                      <div className="repo-dashboard-item-meta">
                        <span>{commit.short_sha}</span>
                        <span>/ {authorLabel(commit)}</span>
                        <span>/ {new Date(commit.authored_at * 1000).toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="repo-dashboard-card">
                <h2 className="font-mono">Who did what</h2>
                {countByAuthor(snapshot.commits).map(([name, count]) => (
                  <div key={name} className="repo-dashboard-row">
                    <span>{name}</span>
                    <span className="prompt-loops-pill">{count}</span>
                  </div>
                ))}
                <h2 className="font-mono repo-dashboard-subheading">Activity heatmap</h2>
                {heatmap.length ? <ActivityHeatmap cells={heatmap} /> : null}
              </div>
            </div>
          )}

          {snapshot && !loading && section === "latest" && (
            <div className="repo-dashboard-grid cols">
              <div className="repo-dashboard-card repo-dashboard-latest">
                <h2 className="font-mono">Latest merge / commit</h2>
                {latestMerge ? (
                  <div className="repo-dashboard-item">
                    <div className="repo-dashboard-item-title font-mono">#{latestMerge.number} {latestMerge.title}</div>
                    <div className="repo-dashboard-item-meta">
                      <span>by {latestMerge.author}</span>
                      <span>/ merged {new Date(latestMerge.merged_at).toLocaleString()}</span>
                    </div>
                    {latestMerge.body && <pre className="repo-dashboard-code font-mono">{latestMerge.body.slice(0, 4000)}</pre>}
                  </div>
                ) : latestCommit ? (
                  <div className="repo-dashboard-item">
                    <div className="repo-dashboard-item-title font-mono">{latestCommit.subject}</div>
                    <div className="repo-dashboard-item-meta">
                      <span>{latestCommit.short_sha}</span>
                      <span>/ {authorLabel(latestCommit)}</span>
                    </div>
                    <pre className="repo-dashboard-code font-mono">{latestCommit.subject}</pre>
                  </div>
                ) : (
                  <p className="text-muted small">No latest change found.</p>
                )}
              </div>
              <div className="repo-dashboard-card">
                <h2 className="font-mono">Changed files at HEAD (local git)</h2>
                <p className="text-muted small">
                  {latestMerge
                    ? "Latest merge above may come from gh; file list below is from local git show HEAD, not the PR diff."
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
                  {!snapshot.changed_files.length && <p className="text-muted small">No changed files for HEAD.</p>}
                </div>
              </div>
            </div>
          )}

          {snapshot && !loading && section === "work" && (
            <div className="repo-dashboard-grid cols">
              <div className="repo-dashboard-card">
                <h2 className="font-mono">Work filters</h2>
                <div className="repo-dashboard-toolbar">
                  {(["all", "open", "started", "done"] as WorkFilter[]).map(filter => (
                    <button
                      key={filter}
                      type="button"
                      className={`repo-dashboard-seg${workFilter === filter ? " active" : ""}`}
                      onClick={() => setWorkFilter(filter)}
                    >
                      {filter}
                    </button>
                  ))}
                </div>
                <h2 className="font-mono repo-dashboard-subheading">Type filter</h2>
                <div className="repo-dashboard-toolbar wrap">
                  {WORK_TYPES.map(type => (
                    <button
                      key={type}
                      type="button"
                      className={`repo-dashboard-seg ${type}${typeFilter === type ? " active" : ""}`}
                      onClick={() => setTypeFilter(typeFilter === type ? "all" : type)}
                    >
                      {type}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`repo-dashboard-seg${typeFilter === "all" ? " active" : ""}`}
                    onClick={() => setTypeFilter("all")}
                  >
                    all types
                  </button>
                </div>
              </div>
              <div className="repo-dashboard-card">
                <h2 className="font-mono">Items</h2>
                <WorkItemsList items={filteredWorkItems} />
              </div>
            </div>
          )}

          {snapshot && !loading && section === "planning" && (
            <div className="repo-dashboard-grid cols">
              <div className="repo-dashboard-card">
                <h2 className="font-mono">Roadmap / features / gaps left</h2>
                <WorkItemsList
                  items={workItems.filter(i => (i.needsPlan || i.status === "open") && (typeFilter === "all" || i.type === typeFilter))}
                />
              </div>
              <div className="repo-dashboard-card">
                <h2 className="font-mono">Source docs</h2>
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
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
