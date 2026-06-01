use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::process::run_cmd;
use crate::path_utils::normalize_user_workspace_path_for_save;

const MAX_GIT_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_DOC_CONTENT_BYTES: usize = 512 * 1024;
const MAX_COMMITS: usize = 500;
const MAX_CHANGED_FILES: usize = 200;

const CORE_DOC_PATHS: [&str; 9] = [
    "README.md",
    "docs/ROADMAP.md",
    "docs/KNOWN_GAPS.md",
    "docs/BACKLOG.md",
    "docs/CURRENT_STATE.md",
    "docs/START_HERE.md",
    "docs/FEATURES.md",
    "docs/VALIDATION.md",
    "docs/TODO.md",
];

const ALLOWLISTED_DOC_DIRS: [(&str, usize); 2] = [("docs/product", 24), ("docs/audit", 12)];

const MAX_DISCOVERED_DOC_PATHS: usize = 48;

#[derive(Serialize, Clone, Debug)]
pub struct RepoCommitEntry {
    pub sha: String,
    pub short_sha: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: i64,
    pub subject: String,
    pub is_merge: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoChangedFile {
    pub path: String,
    pub status: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoDocFile {
    pub path: String,
    pub found: bool,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoGhEnhancement {
    pub available: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub merged_prs: Vec<RepoGhPullRequest>,
    pub open_issues: Vec<RepoGhIssue>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoGhPullRequest {
    pub number: u64,
    pub title: String,
    pub merged_at: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoGhIssue {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub labels: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoDashboardSnapshot {
    pub repo_path: String,
    pub git_available: bool,
    pub is_repo: bool,
    pub branch: String,
    pub default_branch: Option<String>,
    pub dirty: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub latest_commit: Option<RepoCommitEntry>,
    pub commits: Vec<RepoCommitEntry>,
    pub changed_files: Vec<RepoChangedFile>,
    pub docs: Vec<RepoDocFile>,
    pub gh: RepoGhEnhancement,
    pub warnings: Vec<String>,
}

fn truncate_output(raw: String) -> String {
    if raw.len() <= MAX_GIT_OUTPUT_BYTES {
        return raw;
    }
    raw.chars().take(MAX_GIT_OUTPUT_BYTES).collect()
}

fn resolve_repo_path(raw: &str) -> Result<PathBuf, String> {
    let normalized = normalize_user_workspace_path_for_save(raw)?
        .ok_or_else(|| "repository path is required".to_string())?;
    let path = PathBuf::from(normalized);
    if !path.is_absolute() {
        return Err("repository path must be absolute".into());
    }
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("path is not a directory: {}", path.display()));
    }
    Ok(path)
}

fn git_in_repo(repo: &Path, args: &[&str]) -> (bool, String, String) {
    let (ok, stdout, stderr, _) = run_cmd("git", args, repo);
    (ok, truncate_output(stdout), truncate_output(stderr))
}

fn is_git_repo(repo: &Path) -> bool {
    let (ok, out, _) = git_in_repo(repo, &["rev-parse", "--is-inside-work-tree"]);
    ok && out.trim() == "true"
}

fn current_branch(repo: &Path) -> String {
    let (_, out, _) = git_in_repo(repo, &["branch", "--show-current"]);
    let branch = out.trim().to_string();
    if branch.is_empty() {
        "detached".into()
    } else {
        branch
    }
}

fn is_dirty(repo: &Path) -> bool {
    let (_, out, _) = git_in_repo(repo, &["status", "--short"]);
    !out.trim().is_empty()
}

fn detect_default_branch(repo: &Path, configured: Option<&str>) -> Option<String> {
    if let Some(branch) = configured.filter(|b| !b.trim().is_empty()) {
        return Some(branch.trim().to_string());
    }

    let (_, out, _) = git_in_repo(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    );
    let trimmed = out.trim();
    if trimmed.starts_with("origin/") {
        return Some(trimmed.trim_start_matches("origin/").to_string());
    }

    for candidate in ["main", "master"] {
        let (ok, _, _) = git_in_repo(
            repo,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/remotes/origin/{}", candidate),
            ],
        );
        if ok {
            return Some(candidate.to_string());
        }
    }

    None
}

fn ahead_behind(repo: &Path, default_branch: &str) -> (Option<u32>, Option<u32>) {
    let upstream = format!("origin/{}", default_branch);
    let (ok, out, _) = git_in_repo(
        repo,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{}", upstream),
        ],
    );
    if !ok {
        return (None, None);
    }
    let parts: Vec<&str> = out.split_whitespace().collect();
    if parts.len() != 2 {
        return (None, None);
    }
    let ahead = parts[0].parse().ok();
    let behind = parts[1].parse().ok();
    (ahead, behind)
}

pub(crate) fn parse_commit_line(line: &str) -> Option<RepoCommitEntry> {
    let parts: Vec<&str> = line.splitn(6, '|').collect();
    if parts.len() != 6 {
        return None;
    }
    let authored_at = parts[4].parse().ok()?;
    Some(RepoCommitEntry {
        sha: parts[0].to_string(),
        short_sha: parts[1].to_string(),
        author_name: parts[2].to_string(),
        author_email: parts[3].to_string(),
        authored_at,
        subject: parts[5].to_string(),
        is_merge: parts[5].to_lowercase().starts_with("merge "),
    })
}

fn load_commits(repo: &Path) -> Vec<RepoCommitEntry> {
    let format = "%H|%h|%an|%ae|%at|%s";
    let (ok, out, _) = git_in_repo(
        repo,
        &[
            "log",
            &format!("--pretty=format:{}", format),
            &format!("-n{}", MAX_COMMITS),
        ],
    );
    if !ok {
        return Vec::new();
    }
    out.lines().filter_map(parse_commit_line).collect()
}

fn load_changed_files(repo: &Path) -> Vec<RepoChangedFile> {
    let (ok, out, _) = git_in_repo(repo, &["show", "--name-status", "--pretty=format:", "HEAD"]);
    if !ok {
        return Vec::new();
    }
    out.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.split_whitespace();
            let status = parts.next()?.to_string();
            let path = parts.next()?.to_string();
            Some(RepoChangedFile { path, status })
        })
        .take(MAX_CHANGED_FILES)
        .collect()
}

fn collect_doc_paths(repo: &Path) -> Vec<String> {
    let mut paths: Vec<String> = CORE_DOC_PATHS.iter().map(|p| (*p).to_string()).collect();
    let mut seen: HashSet<String> = paths.iter().cloned().collect();

    for (dir_rel, limit) in ALLOWLISTED_DOC_DIRS {
        let dir = repo.join(dir_rel);
        if !dir.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut md_files: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry.path().is_file() && entry.path().extension().is_some_and(|ext| ext == "md")
            })
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    return None;
                }
                Some(format!("{}/{}", dir_rel, name))
            })
            .collect();
        md_files.sort();
        for rel in md_files.into_iter().take(limit) {
            if seen.insert(rel.clone()) {
                paths.push(rel);
            }
        }
    }

    paths.truncate(MAX_DISCOVERED_DOC_PATHS);
    paths
}

fn read_local_docs(repo: &Path) -> Vec<RepoDocFile> {
    collect_doc_paths(repo)
        .iter()
        .map(|rel| {
            let full = repo.join(rel);
            if !full.is_file() {
                return RepoDocFile {
                    path: (*rel).to_string(),
                    found: false,
                    content: String::new(),
                    error: None,
                };
            }
            match fs::read_to_string(&full) {
                Ok(content) => {
                    let (content, truncated) = if content.len() > MAX_DOC_CONTENT_BYTES {
                        (
                            content
                                .chars()
                                .take(MAX_DOC_CONTENT_BYTES)
                                .collect::<String>(),
                            true,
                        )
                    } else {
                        (content, false)
                    };
                    RepoDocFile {
                        path: (*rel).to_string(),
                        found: true,
                        content,
                        error: if truncated {
                            Some(format!(
                                "read {}: content truncated to {} bytes",
                                rel, MAX_DOC_CONTENT_BYTES
                            ))
                        } else {
                            None
                        },
                    }
                }
                Err(e) => RepoDocFile {
                    path: (*rel).to_string(),
                    found: false,
                    content: String::new(),
                    error: Some(format!("read {}: {}", rel, e)),
                },
            }
        })
        .collect()
}

fn gh_available() -> bool {
    let (ok, _, _, _) = run_cmd("gh", &["--version"], &repo_root_fallback());
    ok
}

fn repo_root_fallback() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

fn gh_auth_status() -> (bool, Option<String>) {
    if !gh_available() {
        return (false, Some("gh CLI not found".into()));
    }
    let (ok, stdout, stderr, _) = run_cmd("gh", &["auth", "status"], &repo_root_fallback());
    if ok {
        (true, None)
    } else {
        let msg = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        (false, Some(redact_gh_status(msg)))
    }
}

fn redact_gh_status(raw: String) -> String {
    raw.lines()
        .map(|line| {
            if line.to_ascii_lowercase().contains("token") {
                "token: [redacted]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn gh_merged_prs(repo: &Path) -> Vec<RepoGhPullRequest> {
    let (ok, out, _) = git_in_repo(repo, &["remote", "get-url", "origin"]);
    if !ok {
        return Vec::new();
    }
    let remote = out.trim();
    let slug = parse_github_slug(remote);
    let Some(slug) = slug else {
        return Vec::new();
    };

    let (ok, stdout, _, _) = run_cmd(
        "gh",
        &[
            "pr",
            "list",
            "--repo",
            &slug,
            "--state",
            "merged",
            "--limit",
            "10",
            "--json",
            "number,title,mergedAt,author,body",
        ],
        repo,
    );
    if !ok {
        return Vec::new();
    }
    parse_gh_prs(&stdout)
}

/// Safe GitHub `owner/repo` slug for copyable prompt output. Never returns raw remotes.
pub(crate) fn parse_github_slug(remote: &str) -> Option<String> {
    let trimmed = remote.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("ghp_")
        || trimmed.contains("gho_")
        || trimmed.contains("github_pat_")
        || trimmed.contains("x-access-token")
    {
        return None;
    }
    if trimmed.contains('@') && !trimmed.starts_with("git@github.com:") {
        return None;
    }
    if trimmed.starts_with("git@github.com:") {
        let slug = trimmed
            .trim_start_matches("git@github.com:")
            .trim_end_matches(".git");
        return slug_contains_owner_repo(slug);
    }
    if trimmed.contains("github.com/") {
        let after = trimmed.split("github.com/").nth(1)?;
        let slug = after.trim_end_matches(".git");
        return slug_contains_owner_repo(slug);
    }
    None
}

fn slug_contains_owner_repo(slug: &str) -> Option<String> {
    let slug = slug.trim_matches('/');
    if slug.contains('/') && !slug.starts_with('/') && !slug.contains('@') {
        Some(slug.to_string())
    } else {
        None
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoPromptContext {
    pub repo_slug: Option<String>,
    pub current_branch: Option<String>,
    pub default_branch: Option<String>,
    pub is_repo: bool,
    pub warnings: Vec<String>,
}

/// Lightweight git metadata for Prompt Loops (no gh, docs, commits, or history).
pub fn inspect_repo_prompt_context(
    repo_path: &str,
    configured_default_branch: Option<&str>,
) -> Result<RepoPromptContext, String> {
    let path = resolve_repo_path(repo_path)?;
    let mut warnings = Vec::new();

    let git_on_path = {
        let (ok, _, _, _) = run_cmd("git", &["--version"], &path);
        ok
    };
    if !git_on_path {
        warnings.push("git CLI not found on PATH".into());
        return Ok(RepoPromptContext {
            repo_slug: None,
            current_branch: None,
            default_branch: configured_default_branch
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .map(str::to_string),
            is_repo: false,
            warnings,
        });
    }

    if !is_git_repo(&path) {
        warnings.push("path is not a git repository".into());
        return Ok(RepoPromptContext {
            repo_slug: None,
            current_branch: None,
            default_branch: configured_default_branch
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .map(str::to_string),
            is_repo: false,
            warnings,
        });
    }

    let branch = current_branch(&path);
    let current_branch = Some(branch);
    let default_branch = detect_default_branch(&path, configured_default_branch);

    let repo_slug = {
        let (ok, out, _) = git_in_repo(&path, &["remote", "get-url", "origin"]);
        if ok {
            parse_github_slug(out.trim())
        } else {
            None
        }
    };
    if repo_slug.is_none() {
        warnings.push("Could not determine GitHub repository identity from origin remote.".into());
    }

    Ok(RepoPromptContext {
        repo_slug,
        current_branch,
        default_branch,
        is_repo: true,
        warnings,
    })
}

fn parse_gh_prs(raw: &str) -> Vec<RepoGhPullRequest> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            Some(RepoGhPullRequest {
                number: item.get("number")?.as_u64()?,
                title: item.get("title")?.as_str()?.to_string(),
                merged_at: item.get("mergedAt")?.as_str()?.to_string(),
                author: item
                    .get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|l| l.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                body: item
                    .get("body")
                    .and_then(|b| b.as_str())
                    .map(|s| s.chars().take(4000).collect()),
            })
        })
        .collect()
}

fn gh_open_issues(repo: &Path) -> Vec<RepoGhIssue> {
    let (ok, out, _) = git_in_repo(repo, &["remote", "get-url", "origin"]);
    if !ok {
        return Vec::new();
    }
    let Some(slug) = parse_github_slug(out.trim()) else {
        return Vec::new();
    };
    let (ok, stdout, _, _) = run_cmd(
        "gh",
        &[
            "issue",
            "list",
            "--repo",
            &slug,
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            "number,title,state,labels",
        ],
        repo,
    );
    if !ok {
        return Vec::new();
    }
    parse_gh_issues(&stdout)
}

fn parse_gh_issues(raw: &str) -> Vec<RepoGhIssue> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let labels = item
                .get("labels")
                .and_then(|l| l.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|label| label.get("name").and_then(|n| n.as_str()))
                        .map(|s| s.to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(RepoGhIssue {
                number: item.get("number")?.as_u64()?,
                title: item.get("title")?.as_str()?.to_string(),
                state: item.get("state")?.as_str()?.to_string(),
                labels,
            })
        })
        .collect()
}

pub fn inspect_repo(
    repo_path: &str,
    configured_default_branch: Option<&str>,
    include_gh: bool,
) -> Result<RepoDashboardSnapshot, String> {
    let path = resolve_repo_path(repo_path)?;
    let mut warnings = Vec::new();

    let git_on_path = {
        let (ok, _, _, _) = run_cmd("git", &["--version"], &path);
        ok
    };

    if !git_on_path {
        warnings.push("git CLI not found on PATH".into());
        return Ok(RepoDashboardSnapshot {
            repo_path: path.to_string_lossy().into_owned(),
            git_available: false,
            is_repo: false,
            branch: "n/a".into(),
            default_branch: configured_default_branch.map(|s| s.to_string()),
            dirty: false,
            ahead: None,
            behind: None,
            latest_commit: None,
            commits: Vec::new(),
            changed_files: Vec::new(),
            docs: read_local_docs(&path),
            gh: RepoGhEnhancement {
                available: gh_available(),
                authenticated: false,
                message: Some("git unavailable".into()),
                merged_prs: Vec::new(),
                open_issues: Vec::new(),
            },
            warnings,
        });
    }

    let is_repo = is_git_repo(&path);
    if !is_repo {
        warnings.push("path is not a git repository".into());
        return Ok(RepoDashboardSnapshot {
            repo_path: path.to_string_lossy().into_owned(),
            git_available: true,
            is_repo: false,
            branch: "not git".into(),
            default_branch: configured_default_branch.map(|s| s.to_string()),
            dirty: false,
            ahead: None,
            behind: None,
            latest_commit: None,
            commits: Vec::new(),
            changed_files: Vec::new(),
            docs: read_local_docs(&path),
            gh: RepoGhEnhancement {
                available: gh_available(),
                authenticated: false,
                message: None,
                merged_prs: Vec::new(),
                open_issues: Vec::new(),
            },
            warnings,
        });
    }

    let branch = current_branch(&path);
    let dirty = is_dirty(&path);
    let default_branch = detect_default_branch(&path, configured_default_branch);
    let (ahead, behind) = default_branch
        .as_deref()
        .map(|b| ahead_behind(&path, b))
        .unwrap_or((None, None));

    let commits = load_commits(&path);
    let latest_commit = commits.first().cloned();
    let changed_files = load_changed_files(&path);
    let docs = read_local_docs(&path);

    for doc in &docs {
        if let Some(err) = &doc.error {
            warnings.push(err.clone());
        }
    }

    let gh_available_flag = gh_available();
    let (gh_authenticated, gh_message) = if include_gh && gh_available_flag {
        gh_auth_status()
    } else if !gh_available_flag {
        (false, Some("gh CLI not found — local-git-only mode".into()))
    } else {
        (false, None)
    };

    let merged_prs = if include_gh && gh_available_flag && gh_authenticated {
        gh_merged_prs(&path)
    } else {
        Vec::new()
    };
    let open_issues = if include_gh && gh_available_flag && gh_authenticated {
        gh_open_issues(&path)
    } else {
        Vec::new()
    };

    Ok(RepoDashboardSnapshot {
        repo_path: path.to_string_lossy().into_owned(),
        git_available: true,
        is_repo: true,
        branch,
        default_branch,
        dirty,
        ahead,
        behind,
        latest_commit,
        commits,
        changed_files,
        docs,
        gh: RepoGhEnhancement {
            available: gh_available_flag,
            authenticated: gh_authenticated,
            message: gh_message,
            merged_prs,
            open_issues,
        },
        warnings,
    })
}

const MAX_DISCOVER_TOP_LEVEL_DIRS: usize = 200;
const MAX_DISCOVER_NESTED_DIRS: usize = 50;
const MAX_DISCOVER_DIRS_SCANNED: usize = 250;
const MAX_DISCOVERED_REPOS: usize = 100;

#[derive(Serialize, Clone, Debug)]
pub struct DiscoveredLocalGitRepo {
    pub label: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiscoverLocalGitReposResult {
    pub repos: Vec<DiscoveredLocalGitRepo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

pub(crate) fn normalize_repo_path_for_compare(path: &str) -> String {
    path.trim().trim_end_matches('/').to_string()
}

pub(crate) fn repo_entry_label_from_path(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("Repository")
        .to_string()
}

fn resolve_parent_scan_path(raw: &str) -> Result<PathBuf, String> {
    let normalized = normalize_user_workspace_path_for_save(raw)?
        .ok_or_else(|| "parent folder path is required".to_string())?;
    let path = PathBuf::from(normalized);
    if !path.is_absolute() {
        return Err("parent folder path must be absolute".into());
    }
    if !path.exists() {
        return Err("parent folder does not exist".into());
    }
    if !path.is_dir() {
        return Err("parent path is not a directory".into());
    }
    Ok(path)
}

fn discovered_repo_path_string(path: &Path) -> Option<String> {
    normalize_user_workspace_path_for_save(path.to_string_lossy().as_ref())
        .ok()
        .flatten()
}

fn build_discovered_repo(path: &Path) -> Option<DiscoveredLocalGitRepo> {
    if !is_git_repo(path) {
        return None;
    }
    let path_str = discovered_repo_path_string(path)?;
    let mut warnings = Vec::new();
    let default_branch = detect_default_branch(path, None);
    let repo_slug = {
        let (ok, out, _) = git_in_repo(path, &["remote", "get-url", "origin"]);
        if ok {
            parse_github_slug(out.trim())
        } else {
            None
        }
    };
    if repo_slug.is_none() {
        warnings.push("Could not derive GitHub slug from origin remote.".into());
    }
    Some(DiscoveredLocalGitRepo {
        label: repo_entry_label_from_path(&path_str),
        path: path_str,
        default_branch,
        repo_slug,
        warnings,
    })
}

fn push_discovered_repo(
    path: &Path,
    repos: &mut Vec<DiscoveredLocalGitRepo>,
    seen_paths: &mut HashSet<String>,
) {
    if repos.len() >= MAX_DISCOVERED_REPOS {
        return;
    }
    let Some(repo) = build_discovered_repo(path) else {
        return;
    };
    let key = normalize_repo_path_for_compare(&repo.path);
    if seen_paths.contains(&key) {
        return;
    }
    seen_paths.insert(key);
    repos.push(repo);
}

fn scan_directory_for_git_repos(
    parent: &Path,
    repos: &mut Vec<DiscoveredLocalGitRepo>,
    seen_paths: &mut HashSet<String>,
    dirs_scanned: &mut usize,
    warnings: &mut Vec<String>,
) {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) => {
            warnings.push(format!("cannot read directory: {}", e));
            return;
        }
    };

    for entry in entries.flatten().take(MAX_DISCOVER_TOP_LEVEL_DIRS) {
        if *dirs_scanned >= MAX_DISCOVER_DIRS_SCANNED || repos.len() >= MAX_DISCOVERED_REPOS {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        *dirs_scanned += 1;
        let child = entry.path();
        if is_git_repo(&child) {
            push_discovered_repo(&child, repos, seen_paths);
            continue;
        }

        let nested_entries = match fs::read_dir(&child) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for nested in nested_entries.flatten().take(MAX_DISCOVER_NESTED_DIRS) {
            if *dirs_scanned >= MAX_DISCOVER_DIRS_SCANNED || repos.len() >= MAX_DISCOVERED_REPOS {
                break;
            }
            let Ok(nested_type) = nested.file_type() else {
                continue;
            };
            if !nested_type.is_dir() {
                continue;
            }
            let nested_name = nested.file_name();
            if nested_name.to_string_lossy().starts_with('.') {
                continue;
            }
            *dirs_scanned += 1;
            push_discovered_repo(&nested.path(), repos, seen_paths);
        }
    }
}

/// Bounded shallow scan for local git checkouts under an explicit parent folder.
pub fn discover_local_git_repos(parent_path: &str) -> Result<DiscoverLocalGitReposResult, String> {
    let parent = resolve_parent_scan_path(parent_path)?;
    let mut warnings = Vec::new();
    let mut repos = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut dirs_scanned = 0usize;

    scan_directory_for_git_repos(
        &parent,
        &mut repos,
        &mut seen_paths,
        &mut dirs_scanned,
        &mut warnings,
    );

    if dirs_scanned >= MAX_DISCOVER_DIRS_SCANNED {
        warnings.push(format!(
            "scan stopped after {} directories (limit reached)",
            MAX_DISCOVER_DIRS_SCANNED
        ));
    }
    if repos.len() >= MAX_DISCOVERED_REPOS {
        warnings.push(format!(
            "showing first {} repositories (limit reached)",
            MAX_DISCOVERED_REPOS
        ));
    }

    Ok(DiscoverLocalGitReposResult { repos, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_commit_line_valid() {
        let line = "abc123|abc123|Author|a@b.com|1700000000|fix: thing";
        let parsed = parse_commit_line(line).expect("parse");
        assert_eq!(parsed.short_sha, "abc123");
        assert_eq!(parsed.author_email, "a@b.com");
        assert!(!parsed.is_merge);
    }

    #[test]
    fn parse_commit_line_merge() {
        let line = "abc123|abc123|Author|a@b.com|1700000000|Merge pull request #1";
        let parsed = parse_commit_line(line).expect("parse");
        assert!(parsed.is_merge);
    }

    #[test]
    fn parse_github_slug_https() {
        assert_eq!(
            parse_github_slug("https://github.com/owner/repo.git"),
            Some("owner/repo".into())
        );
    }

    #[test]
    fn parse_github_slug_ssh() {
        assert_eq!(
            parse_github_slug("git@github.com:owner/repo.git"),
            Some("owner/repo".into())
        );
    }

    #[test]
    fn parse_github_slug_rejects_token_remote() {
        assert_eq!(
            parse_github_slug("https://ghp_secrettoken@github.com/owner/repo.git"),
            None
        );
    }

    #[test]
    fn parse_github_slug_rejects_userinfo_https() {
        assert_eq!(
            parse_github_slug("https://user:pass@github.com/owner/repo.git"),
            None
        );
    }

    #[test]
    fn parse_github_slug_rejects_non_github() {
        assert_eq!(parse_github_slug("git@gitlab.com:owner/repo.git"), None);
    }

    #[test]
    fn redact_gh_status_masks_token_lines() {
        let raw = "Logged in to github.com\n✓ Token: ghp_secretvalue\n";
        let redacted = redact_gh_status(raw.to_string());
        assert!(redacted.contains("token: [redacted]"));
        assert!(!redacted.contains("ghp_secretvalue"));
    }

    #[test]
    fn parse_gh_prs_rejects_malformed_json() {
        assert!(parse_gh_prs("not json").is_empty());
        assert!(parse_gh_prs("[]").is_empty());
    }

    #[test]
    fn parse_gh_prs_parses_valid_payload() {
        let raw = r#"[{"number":1,"title":"Fix","mergedAt":"2024-01-01T00:00:00Z","author":{"login":"dev"},"body":"hi"}]"#;
        let prs = parse_gh_prs(raw);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 1);
        assert_eq!(prs[0].title, "Fix");
        assert_eq!(prs[0].author, "dev");
    }

    #[test]
    fn parse_gh_issues_rejects_malformed_json() {
        assert!(parse_gh_issues("{").is_empty());
    }

    #[test]
    fn parse_gh_issues_parses_valid_payload() {
        let raw = r#"[{"number":2,"title":"Bug","state":"OPEN","labels":[{"name":"bug"}]}]"#;
        let issues = parse_gh_issues(raw);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, 2);
        assert_eq!(issues[0].labels, vec!["bug".to_string()]);
    }

    #[test]
    fn max_doc_content_bytes_matches_workspace_docs_limit() {
        assert_eq!(MAX_DOC_CONTENT_BYTES, 512 * 1024);
    }

    #[test]
    fn collect_doc_paths_includes_core_and_allowlisted_dirs() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-docs-{stamp}"));
        fs::create_dir_all(root.join("docs/product")).expect("mkdir product");
        fs::create_dir_all(root.join("docs/audit")).expect("mkdir audit");
        fs::write(root.join("README.md"), "# hi").expect("write readme");
        fs::write(root.join("docs/BACKLOG.md"), "# backlog").expect("write backlog");
        fs::write(root.join("docs/product/FEATURES.md"), "# features").expect("write features");
        fs::write(root.join("docs/audit/ISSUES.md"), "# issues").expect("write issues");

        let paths = collect_doc_paths(&root);
        assert!(paths.iter().any(|p| p == "README.md"));
        assert!(paths.iter().any(|p| p == "docs/BACKLOG.md"));
        assert!(paths.iter().any(|p| p == "docs/product/FEATURES.md"));
        assert!(paths.iter().any(|p| p == "docs/audit/ISSUES.md"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn normalize_repo_path_for_compare_trims_trailing_slash() {
        assert_eq!(normalize_repo_path_for_compare("/tmp/repo/"), "/tmp/repo");
    }

    #[test]
    fn discover_local_git_repos_finds_immediate_and_nested() {
        use std::process::Command;
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let parent = std::env::temp_dir().join(format!("agent-workspace-discover-{stamp}"));
        let immediate = parent.join("alpha");
        let grouped = parent.join("group");
        let nested = grouped.join("beta");
        fs::create_dir_all(&immediate).expect("mkdir immediate");
        fs::create_dir_all(&nested).expect("mkdir nested");
        fs::create_dir_all(parent.join("not-git")).expect("mkdir plain");

        for repo in [&immediate, &nested] {
            let status = Command::new("git")
                .args(["init"])
                .current_dir(repo)
                .status()
                .expect("git init");
            assert!(status.success(), "git init failed");
        }

        let result = discover_local_git_repos(parent.to_string_lossy().as_ref()).expect("discover");
        let paths: Vec<String> = result
            .repos
            .iter()
            .map(|r| normalize_repo_path_for_compare(&r.path))
            .collect();
        assert!(paths.contains(&normalize_repo_path_for_compare(
            immediate.to_string_lossy().as_ref()
        )));
        assert!(paths.contains(&normalize_repo_path_for_compare(
            nested.to_string_lossy().as_ref()
        )));
        assert_eq!(paths.len(), 2);

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn discover_local_git_repos_ignores_plain_child_dirs() {
        use std::process::Command;
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let parent = std::env::temp_dir().join(format!("agent-workspace-discover-plain-{stamp}"));
        let repo = parent.join("solo");
        fs::create_dir_all(&repo).expect("mkdir");
        fs::create_dir_all(parent.join("notes-only")).expect("mkdir plain");
        let status = Command::new("git")
            .args(["init"])
            .current_dir(&repo)
            .status()
            .expect("git init");
        assert!(status.success());

        let result =
            discover_local_git_repos(parent.to_string_lossy().as_ref()).expect("discover parent");
        assert_eq!(result.repos.len(), 1);
        assert_eq!(result.repos[0].label, "solo");

        let _ = fs::remove_dir_all(&parent);
    }
}
