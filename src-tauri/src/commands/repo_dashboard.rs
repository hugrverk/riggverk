use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::process::run_cmd;
use crate::path_utils::normalize_user_workspace_path_for_save;

const MAX_GIT_OUTPUT_BYTES: usize = 512 * 1024;
/// Full `git log` for commit history / heatmap (separate from generic git output cap).
const MAX_COMMIT_LOG_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOC_CONTENT_BYTES: usize = 512 * 1024;
const MAX_CHANGED_FILES: usize = 200;
const MAX_GH_MERGED_PRS: usize = 2000;
const MAX_GH_OPEN_ISSUES: usize = 2000;
const GH_LIST_PAGE_LIMIT: &str = "100";

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

const MAX_DISCOVERED_DOC_PATHS: usize = 96;
const MAX_DOCS_TREE_DEPTH: usize = 12;

const SKIP_DOC_DIR_NAMES: &[&str] = &[".git", "node_modules", "target", "dist", "build", "vendor"];

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
    pub readable: bool,
    pub truncated: bool,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_error: Option<String>,
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
    pub commits_truncated: bool,
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

fn truncate_git_log_output(raw: String) -> (String, bool) {
    if raw.len() <= MAX_COMMIT_LOG_OUTPUT_BYTES {
        return (raw, false);
    }
    let mut end = MAX_COMMIT_LOG_OUTPUT_BYTES;
    while end > 0 && !raw.is_char_boundary(end) {
        end -= 1;
    }
    let boundary = raw[..end].rfind('\n').unwrap_or(end);
    (raw[..boundary].to_string(), true)
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

fn load_commits(repo: &Path) -> (Vec<RepoCommitEntry>, bool) {
    let format = "%H|%h|%an|%ae|%at|%s";
    let (ok, stdout, _, _) = run_cmd(
        "git",
        &["log", &format!("--pretty=format:{}", format)],
        repo,
    );
    if !ok {
        return (Vec::new(), false);
    }
    let (stdout, truncated) = truncate_git_log_output(stdout);
    let commits = stdout.lines().filter_map(parse_commit_line).collect();
    (commits, truncated)
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

fn should_skip_doc_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DOC_DIR_NAMES.contains(&name)
}

fn is_markdown_file_name(name: &str) -> bool {
    name.ends_with(".md") || name.ends_with(".markdown")
}

fn canonical_repo_root(repo: &Path) -> Option<PathBuf> {
    let meta = fs::symlink_metadata(repo).ok()?;
    if meta.file_type().is_symlink() {
        return None;
    }
    fs::canonicalize(repo).ok()
}

fn safe_file_under_repo(repo_root: &Path, path: &Path) -> bool {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(_) => return false,
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return false;
    }
    match fs::canonicalize(path) {
        Ok(canonical) => canonical.starts_with(repo_root),
        Err(_) => false,
    }
}

fn safe_dir_under_repo(repo_root: &Path, path: &Path) -> bool {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(_) => return false,
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return false;
    }
    match fs::canonicalize(path) {
        Ok(canonical) => canonical.starts_with(repo_root),
        Err(_) => false,
    }
}

fn try_collect_doc_path(
    paths: &mut Vec<String>,
    seen: &HashSet<String>,
    rel: String,
) -> bool {
    if seen.contains(&rel) || paths.len() >= MAX_DISCOVERED_DOC_PATHS {
        return false;
    }
    paths.push(rel);
    true
}

fn discover_root_markdown(
    repo: &Path,
    repo_root: &Path,
    paths: &mut Vec<String>,
    seen: &HashSet<String>,
) {
    let Ok(entries) = fs::read_dir(repo) else {
        return;
    };
    let mut root_files: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !is_markdown_file_name(&name) {
                return None;
            }
            if !safe_file_under_repo(repo_root, &entry.path()) {
                return None;
            }
            Some(name)
        })
        .collect();
    root_files.sort();
    for rel in root_files {
        if paths.len() >= MAX_DISCOVERED_DOC_PATHS {
            break;
        }
        try_collect_doc_path(paths, seen, rel);
    }
}

fn discover_docs_tree(
    repo: &Path,
    repo_root: &Path,
    rel_dir: &str,
    depth: usize,
    paths: &mut Vec<String>,
    seen: &HashSet<String>,
) {
    if depth > MAX_DOCS_TREE_DEPTH || paths.len() >= MAX_DISCOVERED_DOC_PATHS {
        return;
    }
    let dir = repo.join(rel_dir);
    if !safe_dir_under_repo(repo_root, &dir) {
        return;
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut subdirs: Vec<String> = Vec::new();
    let mut md_files: Vec<String> = Vec::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let child = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if should_skip_doc_dir(&name) {
                continue;
            }
            if safe_dir_under_repo(repo_root, &child) {
                subdirs.push(name);
            }
            continue;
        }
        if file_type.is_file()
            && is_markdown_file_name(&name)
            && safe_file_under_repo(repo_root, &child)
        {
            md_files.push(format!("{}/{}", rel_dir, name));
        }
    }
    md_files.sort();
    for rel in md_files {
        if paths.len() >= MAX_DISCOVERED_DOC_PATHS {
            return;
        }
        try_collect_doc_path(paths, seen, rel);
    }
    subdirs.sort();
    for sub in subdirs {
        if paths.len() >= MAX_DISCOVERED_DOC_PATHS {
            return;
        }
        discover_docs_tree(
            repo,
            repo_root,
            &format!("{}/{}", rel_dir, sub),
            depth + 1,
            paths,
            seen,
        );
    }
}

fn collect_doc_paths(repo: &Path) -> Vec<String> {
    let mut paths: Vec<String> = CORE_DOC_PATHS.iter().map(|p| (*p).to_string()).collect();
    let mut seen: HashSet<String> = paths.iter().cloned().collect();

    let Some(repo_root) = canonical_repo_root(repo) else {
        paths.truncate(MAX_DISCOVERED_DOC_PATHS);
        return paths;
    };

    let mut discovered: Vec<String> = Vec::new();
    discover_root_markdown(repo, &repo_root, &mut discovered, &seen);
    if repo.join("docs").is_dir() {
        discover_docs_tree(repo, &repo_root, "docs", 1, &mut discovered, &seen);
    }

    discovered.sort();
    for rel in discovered {
        if paths.len() >= MAX_DISCOVERED_DOC_PATHS {
            break;
        }
        if seen.insert(rel.clone()) {
            paths.push(rel);
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
                    readable: false,
                    truncated: false,
                    content: String::new(),
                    read_error: None,
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
                        readable: true,
                        truncated,
                        content,
                        read_error: None,
                    }
                }
                Err(e) => RepoDocFile {
                    path: (*rel).to_string(),
                    found: true,
                    readable: false,
                    truncated: false,
                    content: String::new(),
                    read_error: Some(format!("read {}: {}", rel, e)),
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

fn gh_merged_prs(repo: &Path) -> (Vec<RepoGhPullRequest>, bool) {
    let (ok, out, _) = git_in_repo(repo, &["remote", "get-url", "origin"]);
    if !ok {
        return (Vec::new(), false);
    }
    let remote = out.trim();
    let slug = parse_github_slug(remote);
    let Some(slug) = slug else {
        return (Vec::new(), false);
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
            "--paginate",
            "--limit",
            GH_LIST_PAGE_LIMIT,
            "--json",
            "number,title,mergedAt,author,body",
        ],
        repo,
    );
    if !ok {
        return (Vec::new(), false);
    }
    let mut prs = parse_gh_prs(&stdout);
    let truncated = prs.len() > MAX_GH_MERGED_PRS;
    if truncated {
        prs.truncate(MAX_GH_MERGED_PRS);
    }
    (prs, truncated)
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

fn gh_open_issues(repo: &Path) -> (Vec<RepoGhIssue>, bool) {
    let (ok, out, _) = git_in_repo(repo, &["remote", "get-url", "origin"]);
    if !ok {
        return (Vec::new(), false);
    }
    let Some(slug) = parse_github_slug(out.trim()) else {
        return (Vec::new(), false);
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
            "--paginate",
            "--limit",
            GH_LIST_PAGE_LIMIT,
            "--json",
            "number,title,state,labels",
        ],
        repo,
    );
    if !ok {
        return (Vec::new(), false);
    }
    let mut issues = parse_gh_issues(&stdout);
    let truncated = issues.len() > MAX_GH_OPEN_ISSUES;
    if truncated {
        issues.truncate(MAX_GH_OPEN_ISSUES);
    }
    (issues, truncated)
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
            commits_truncated: false,
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
            commits_truncated: false,
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

    let (commits, commits_truncated) = load_commits(&path);
    if commits_truncated {
        warnings.push(format!(
            "local git commit log truncated at {} MB — sync or shallow clone may hide older history",
            MAX_COMMIT_LOG_OUTPUT_BYTES / (1024 * 1024)
        ));
    }
    let latest_commit = commits.first().cloned();
    let changed_files = load_changed_files(&path);
    let docs = read_local_docs(&path);

    for doc in &docs {
        if doc.truncated {
            warnings.push(format!(
                "read {}: content truncated to {} bytes",
                doc.path, MAX_DOC_CONTENT_BYTES
            ));
        }
        if let Some(err) = &doc.read_error {
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

    let (merged_prs, gh_prs_truncated) = if include_gh && gh_available_flag && gh_authenticated {
        gh_merged_prs(&path)
    } else {
        (Vec::new(), false)
    };
    if gh_prs_truncated {
        warnings.push(format!(
            "merged pull requests capped at {} items",
            MAX_GH_MERGED_PRS
        ));
    }
    let (open_issues, gh_issues_truncated) = if include_gh && gh_available_flag && gh_authenticated
    {
        gh_open_issues(&path)
    } else {
        (Vec::new(), false)
    };
    if gh_issues_truncated {
        warnings.push(format!(
            "open issues capped at {} items",
            MAX_GH_OPEN_ISSUES
        ));
    }

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
        commits_truncated,
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
    fn truncate_git_log_output_keeps_line_boundary() {
        let line =
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef|deadbee|Ann|a@b.com|1700000000|subject\n";
        let mut raw = String::new();
        while raw.len() < MAX_COMMIT_LOG_OUTPUT_BYTES + line.len() {
            raw.push_str(line);
        }
        let (truncated, did) = truncate_git_log_output(raw);
        assert!(did);
        assert!(truncated.len() <= MAX_COMMIT_LOG_OUTPUT_BYTES);
        assert!(truncated
            .lines()
            .all(|line| parse_commit_line(line).is_some()));
    }

    #[test]
    fn collect_doc_paths_includes_core_root_and_nested_docs() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-docs-{stamp}"));
        fs::create_dir_all(root.join("docs/product/nested")).expect("mkdir nested");
        fs::create_dir_all(root.join("docs/audit")).expect("mkdir audit");
        fs::create_dir_all(root.join("node_modules/pkg")).expect("mkdir node_modules");
        fs::write(root.join("README.md"), "# hi").expect("write readme");
        fs::write(root.join("CHANGELOG.md"), "# log").expect("write changelog");
        fs::write(root.join("docs/BACKLOG.md"), "# backlog").expect("write backlog");
        fs::write(root.join("docs/product/FEATURES.md"), "# features").expect("write features");
        fs::write(root.join("docs/product/nested/DETAIL.md"), "# detail").expect("write detail");
        fs::write(root.join("docs/audit/ISSUES.md"), "# issues").expect("write issues");
        fs::write(root.join("node_modules/pkg/EVIL.md"), "# evil").expect("write evil");

        let paths = collect_doc_paths(&root);
        assert!(paths.iter().any(|p| p == "README.md"));
        assert!(paths.iter().any(|p| p == "CHANGELOG.md"));
        assert!(paths.iter().any(|p| p == "docs/BACKLOG.md"));
        assert!(paths.iter().any(|p| p == "docs/product/FEATURES.md"));
        assert!(paths.iter().any(|p| p == "docs/product/nested/DETAIL.md"));
        assert!(paths.iter().any(|p| p == "docs/audit/ISSUES.md"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));

        let sorted_tail: Vec<_> = paths
            .iter()
            .filter(|p| !CORE_DOC_PATHS.contains(&p.as_str()))
            .cloned()
            .collect();
        let mut expected_sorted = sorted_tail.clone();
        expected_sorted.sort();
        assert_eq!(sorted_tail, expected_sorted);

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn collect_doc_paths_skips_symlink_escape() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-docs-symlink-{stamp}"));
        let outside = std::env::temp_dir().join(format!("agent-workspace-docs-outside-{stamp}"));
        fs::create_dir_all(root.join("docs")).expect("mkdir docs");
        fs::create_dir_all(&outside).expect("mkdir outside");
        fs::write(outside.join("SECRET.md"), "# secret").expect("write outside");
        fs::write(root.join("README.md"), "# hi").expect("write readme");
        symlink(&outside, root.join("docs/escape")).expect("symlink dir");
        symlink(outside.join("SECRET.md"), root.join("docs/LEAK.md")).expect("symlink file");

        let paths = collect_doc_paths(&root);
        assert!(paths.iter().any(|p| p == "README.md"));
        assert!(!paths.iter().any(|p| p.contains("SECRET")));
        assert!(!paths.iter().any(|p| p == "docs/LEAK.md"));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn collect_doc_paths_respects_file_limit() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-docs-limit-{stamp}"));
        fs::create_dir_all(root.join("docs/extra")).expect("mkdir extra");
        fs::write(root.join("README.md"), "# hi").expect("write readme");
        for i in 0..120 {
            fs::write(root.join(format!("docs/extra/file-{i:03}.md")), "# x").expect("write");
        }

        let paths = collect_doc_paths(&root);
        assert!(paths.len() <= MAX_DISCOVERED_DOC_PATHS);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn repo_doc_file_serializes_structured_states() {
        let readable = RepoDocFile {
            path: "README.md".into(),
            found: true,
            readable: true,
            truncated: false,
            content: "# hi".into(),
            read_error: None,
        };
        let value = serde_json::to_value(&readable).expect("serialize");
        assert_eq!(value["path"], "README.md");
        assert_eq!(value["readable"], true);
        assert_eq!(value["truncated"], false);
        assert!(value.get("read_error").is_none());

        let truncated = RepoDocFile {
            path: "docs/BACKLOG.md".into(),
            found: true,
            readable: true,
            truncated: true,
            content: "# x".into(),
            read_error: None,
        };
        assert_eq!(
            serde_json::to_value(&truncated).expect("serialize")["truncated"],
            true
        );

        let unreadable = RepoDocFile {
            path: "docs/ROADMAP.md".into(),
            found: true,
            readable: false,
            truncated: false,
            content: String::new(),
            read_error: Some("read docs/ROADMAP.md: denied".into()),
        };
        let unreadable_json = serde_json::to_value(&unreadable).expect("serialize");
        assert_eq!(unreadable_json["readable"], false);
        assert_eq!(unreadable_json["read_error"], "read docs/ROADMAP.md: denied");
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
