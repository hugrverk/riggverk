use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::process::{
    run_cmd_bounded, run_cmd_with_timeout, run_git_bounded, BoundedCmdOptions,
};
use crate::path_utils::normalize_user_workspace_path_for_save;
use std::time::Duration;

const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(60);
const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
const TOOL_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const GH_AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const GH_LIST_TIMEOUT: Duration = Duration::from_secs(60);
const GIT_NONINTERACTIVE_ENV: [(&str, &str); 2] =
    [("GCM_INTERACTIVE", "never"), ("GIT_ASKPASS", "")];

const MAX_GIT_OUTPUT_BYTES: usize = 512 * 1024;
/// Documented commit history cap (README contract).
const MAX_COMMITS_LOADED: usize = 500;
/// Full `git log` for commit history / heatmap (separate from generic git output cap).
const MAX_COMMIT_LOG_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOC_CONTENT_BYTES: usize = 512 * 1024;
const MAX_CHANGED_FILES: usize = 200;
const MAX_GH_MERGED_PRS: usize = 2000;
const MAX_GH_OPEN_ISSUES: usize = 2000;

const CORE_DOC_PATHS: [&str; 6] = [
    "README.md",
    "docs/ROADMAP.md",
    "docs/KNOWN_GAPS.md",
    "docs/BACKLOG.md",
    "docs/CURRENT_STATE.md",
    "docs/START_HERE.md",
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

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DocsSource {
    Remote,
    CachedRemote,
    LocalFallback,
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
    pub docs_source: DocsSource,
    pub docs_ref: String,
    pub docs_stale: bool,
    pub gh: RepoGhEnhancement,
    pub warnings: Vec<String>,
}

fn truncate_utf8_bytes(raw: String, max_bytes: usize) -> (String, bool) {
    if raw.len() <= max_bytes {
        return (raw, false);
    }
    let mut end = max_bytes;
    while end > 0 && !raw.is_char_boundary(end) {
        end -= 1;
    }
    (raw[..end].to_string(), true)
}

fn truncate_doc_content(content: String) -> (String, bool) {
    truncate_utf8_bytes(content, MAX_DOC_CONTENT_BYTES)
}

fn git_run(repo: &Path, args: &[&str], stdout_cap: usize) -> (bool, String, String, bool) {
    let result = run_git_bounded(
        args,
        repo,
        BoundedCmdOptions {
            timeout: Some(GIT_LOCAL_TIMEOUT),
            stdout_cap,
            stderr_cap: MAX_GIT_OUTPUT_BYTES,
            ..BoundedCmdOptions::default()
        },
    );
    (
        result.success,
        result.stdout,
        result.stderr,
        result.stdout_truncated || result.stderr_truncated,
    )
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
    let (ok, stdout, stderr, _) = git_run(repo, args, MAX_GIT_OUTPUT_BYTES);
    (ok, stdout, stderr)
}

fn is_git_repo(repo: &Path) -> bool {
    let (ok, out, _) = git_in_repo(repo, &["rev-parse", "--is-inside-work-tree"]);
    ok && out.trim() == "true"
}

/// True only when `dir` is itself the top level of a work tree, not a subfolder of one.
fn is_git_toplevel(dir: &Path) -> bool {
    let (ok, out, _) = git_in_repo(dir, &["rev-parse", "--show-toplevel"]);
    if !ok {
        return false;
    }
    match (fs::canonicalize(out.trim()), fs::canonicalize(dir)) {
        (Ok(toplevel), Ok(dir)) => toplevel == dir,
        _ => false,
    }
}

/// Conservative subset of `git check-ref-format` for a branch name that is passed to git
/// as a refspec: rejects option-like, revision-syntax, whitespace, and traversal forms.
fn is_safe_branch_name(branch: &str) -> bool {
    if branch.is_empty()
        || branch.starts_with(['-', '/'])
        || branch.ends_with(['/', '.'])
        || branch.ends_with(".lock")
        || branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
        || branch == "@"
    {
        return false;
    }
    !branch
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || ":?*[\\^~".contains(c))
}

fn warn_invalid_configured_branch(configured: Option<&str>, warnings: &mut Vec<String>) {
    if let Some(branch) = configured.map(str::trim).filter(|b| !b.is_empty()) {
        if !is_safe_branch_name(branch) {
            warnings.push("configured default branch name is invalid and was ignored".into());
        }
    }
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
    if let Some(branch) = configured
        .map(str::trim)
        .filter(|b| !b.is_empty() && is_safe_branch_name(b))
    {
        return Some(branch.to_string());
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

/// Bounded recent-commit list; only the fallback when the full history cannot be loaded.
pub(super) fn load_commits(repo: &Path) -> (Vec<RepoCommitEntry>, bool) {
    let format = "%H|%h|%an|%ae|%at|%s";
    let max_count = (MAX_COMMITS_LOADED + 1).to_string();
    let (ok, stdout, _, _) = git_run(
        repo,
        &[
            "log",
            &format!("--pretty=format:{}", format),
            "-n",
            &max_count,
        ],
        MAX_COMMIT_LOG_OUTPUT_BYTES,
    );
    if !ok {
        return (Vec::new(), false);
    }
    let (stdout, byte_truncated) = truncate_git_log_output(stdout);
    let mut commits: Vec<RepoCommitEntry> = stdout.lines().filter_map(parse_commit_line).collect();
    let record_truncated = commits.len() > MAX_COMMITS_LOADED;
    if record_truncated {
        commits.truncate(MAX_COMMITS_LOADED);
    }
    (commits, record_truncated || byte_truncated)
}

fn parse_name_status_z(out: &str) -> Vec<RepoChangedFile> {
    let mut files = Vec::new();
    let mut tokens = out.split('\0').filter(|token| !token.is_empty());
    while let Some(status) = tokens.next() {
        let status_trimmed = status.trim();
        if status_trimmed.is_empty() {
            continue;
        }
        let first = status_trimmed.chars().next().unwrap_or(' ');
        if first == 'R' || first == 'C' {
            let _old_path = tokens.next();
            let new_path = tokens.next().map(str::trim).filter(|p| !p.is_empty());
            if let Some(path) = new_path {
                files.push(RepoChangedFile {
                    path: path.to_string(),
                    status: status_trimmed.to_string(),
                });
            }
            continue;
        }
        let path = tokens.next().map(str::trim).filter(|p| !p.is_empty());
        if let Some(path) = path {
            files.push(RepoChangedFile {
                path: path.to_string(),
                status: status_trimmed.to_string(),
            });
        }
    }
    files
}

fn load_changed_files(repo: &Path) -> Vec<RepoChangedFile> {
    let (ok, out, _) = git_in_repo(
        repo,
        &["show", "--name-status", "-z", "--pretty=format:", "HEAD"],
    );
    if !ok {
        return Vec::new();
    }
    parse_name_status_z(&out)
        .into_iter()
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

fn try_collect_doc_path(paths: &mut Vec<String>, seen: &HashSet<String>, rel: String) -> bool {
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

fn unreadable_doc_file(rel: &str, read_error: String) -> RepoDocFile {
    RepoDocFile {
        path: rel.to_string(),
        found: true,
        readable: false,
        truncated: false,
        content: String::new(),
        read_error: Some(read_error),
    }
}

fn missing_doc_file(rel: &str) -> RepoDocFile {
    RepoDocFile {
        path: rel.to_string(),
        found: false,
        readable: false,
        truncated: false,
        content: String::new(),
        read_error: None,
    }
}

fn read_doc_file(repo: &Path, repo_root: Option<&Path>, rel: &str) -> RepoDocFile {
    let full = repo.join(rel);
    let meta = match fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(_) => return missing_doc_file(rel),
    };

    if meta.file_type().is_symlink() {
        return unreadable_doc_file(rel, format!("{rel}: symlink not allowed"));
    }
    if !meta.is_file() {
        return missing_doc_file(rel);
    }

    let Some(repo_root) = repo_root else {
        return unreadable_doc_file(rel, format!("{rel}: repository path not canonical"));
    };
    if !safe_file_under_repo(repo_root, &full) {
        return unreadable_doc_file(rel, format!("{rel}: path escapes repository"));
    }

    match fs::read_to_string(&full) {
        Ok(content) => {
            let (content, truncated) = truncate_doc_content(content);
            RepoDocFile {
                path: rel.to_string(),
                found: true,
                readable: true,
                truncated,
                content,
                read_error: None,
            }
        }
        Err(e) => unreadable_doc_file(rel, format!("read {rel}: {e}")),
    }
}

fn read_local_docs(repo: &Path) -> Vec<RepoDocFile> {
    let repo_root = canonical_repo_root(repo);
    collect_doc_paths(repo)
        .iter()
        .map(|rel| read_doc_file(repo, repo_root.as_deref(), rel))
        .collect()
}

fn normalize_git_doc_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

fn is_safe_git_doc_path(rel: &str) -> bool {
    let normalized = normalize_git_doc_path(rel);
    if normalized.is_empty() || normalized.starts_with('/') {
        return false;
    }
    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return false;
        }
    }
    let file_name = normalized.rsplit('/').next().unwrap_or("");
    if file_name.starts_with('.') || !is_markdown_file_name(file_name) {
        return false;
    }
    if !normalized.contains('/') {
        return true;
    }
    if !normalized.starts_with("docs/") {
        return false;
    }
    !normalized.split('/').any(should_skip_doc_dir)
}

fn collect_doc_paths_from_git_listing(listing: &[String]) -> Vec<String> {
    let mut paths: Vec<String> = CORE_DOC_PATHS.iter().map(|p| (*p).to_string()).collect();
    let mut seen: HashSet<String> = paths.iter().cloned().collect();
    let mut discovered: Vec<String> = listing
        .iter()
        .map(|p| normalize_git_doc_path(p))
        .filter(|p| is_safe_git_doc_path(p))
        .collect();
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

fn git_list_tree_paths(repo: &Path, tree_ref: &str, warnings: &mut Vec<String>) -> Vec<String> {
    let (ok, out, _, truncated) = git_run(
        repo,
        &["ls-tree", "-r", "--name-only", tree_ref],
        MAX_GIT_OUTPUT_BYTES,
    );
    if !ok {
        return Vec::new();
    }
    if truncated {
        warnings.push(
            "Repository documentation listing was truncated; some docs may be missing.".into(),
        );
    }
    out.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn read_doc_from_git(repo: &Path, tree_ref: &str, rel: &str) -> RepoDocFile {
    let object = format!("{}:{}", tree_ref, rel);
    let (ok, stdout, stderr) = git_in_repo(repo, &["show", &object]);
    if !ok {
        let err = stderr.trim();
        if err.contains("does not exist")
            || err.contains("exists on disk")
            || err.contains("fatal: path")
        {
            return missing_doc_file(rel);
        }
        return unreadable_doc_file(
            rel,
            if err.is_empty() {
                format!("show {rel}: git failed")
            } else {
                format!("show {rel}: {err}")
            },
        );
    }
    let (content, truncated) = truncate_doc_content(stdout);
    RepoDocFile {
        path: rel.to_string(),
        found: true,
        readable: true,
        truncated,
        content,
        read_error: None,
    }
}

fn read_docs_from_git_ref(
    repo: &Path,
    tree_ref: &str,
    warnings: &mut Vec<String>,
) -> Vec<RepoDocFile> {
    let paths = collect_doc_paths_from_git_listing(&git_list_tree_paths(repo, tree_ref, warnings));
    paths
        .iter()
        .map(|rel| read_doc_from_git(repo, tree_ref, rel))
        .collect()
}

fn remote_tracking_ref(branch: &str) -> String {
    format!("refs/remotes/origin/{}", branch)
}

fn git_ref_exists(repo: &Path, git_ref: &str) -> bool {
    let (ok, _, _) = git_in_repo(repo, &["rev-parse", "--verify", git_ref]);
    ok
}

/// Transports a dashboard fetch may use. `GIT_ALLOW_PROTOCOL` beats every `protocol.*.allow`
/// key in repo config, so a repository cannot re-enable `ext::` (runs a command) or `file`.
/// Consequence: a local-path or helper-based (`hg::`, `codecommit::`) origin is not fetched
/// and the dashboard falls back to the cached ref or the local checkout.
const GIT_FETCH_ALLOWED_PROTOCOLS: &str = "https:http:ssh:git";

/// Env for the fetch: non-interactive auth, restricted transports, no `core.gitProxy`.
/// A value the user already exports is kept, because the environment outranks repo config.
fn fetch_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = GIT_NONINTERACTIVE_ENV
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    for (key, value) in [
        ("GIT_ALLOW_PROTOCOL", GIT_FETCH_ALLOWED_PROTOCOLS),
        ("GIT_PROXY_COMMAND", ""),
    ] {
        if std::env::var_os(key).is_none() {
            env.push((key.to_string(), value.to_string()));
        }
    }
    env
}

/// `core.sshCommand` for the fetch: the system or global value (so a personal `ssh -i key`
/// keeps working), else a quoted `GIT_SSH`, else plain `ssh`. Forcing it with `-c` stops a
/// repository-local `core.sshCommand` from running; `GIT_SSH_COMMAND` in the environment
/// still outranks it. `scoped` is `git config --show-scope --get-all core.sshcommand`.
fn trusted_ssh_command_from(scoped: &str, git_ssh: Option<&str>) -> String {
    scoped
        .lines()
        .rev()
        .find_map(|line| {
            let (scope, value) = line.split_once('\t')?;
            (matches!(scope, "system" | "global") && !value.trim().is_empty())
                .then(|| value.to_string())
        })
        .or_else(|| {
            git_ssh
                .filter(|path| !path.is_empty())
                .map(|path| format!("'{}'", path.replace('\'', "'\\''")))
        })
        .unwrap_or_else(|| "ssh".to_string())
}

fn trusted_ssh_command(repo: &Path) -> String {
    let (_, scoped, _) = git_in_repo(
        repo,
        &["config", "--show-scope", "--get-all", "core.sshcommand"],
    );
    trusted_ssh_command_from(&scoped, std::env::var("GIT_SSH").ok().as_deref())
}

/// `--upload-pack` is passed explicitly: `remote.origin.uploadpack` from repo config beats
/// `-c` (git keeps the first value), while the option outranks the config.
fn fetch_git_args(branch: &str, ssh_command: &str) -> Vec<String> {
    vec![
        "-c".into(),
        format!("core.sshCommand={ssh_command}"),
        "fetch".into(),
        "--quiet".into(),
        "--prune".into(),
        "--upload-pack=git-upload-pack".into(),
        "--".into(),
        "origin".into(),
        branch.into(),
    ]
}

fn fetch_origin_branch(repo: &Path, branch: &str) -> bool {
    if !is_safe_branch_name(branch) {
        return false;
    }
    let args = fetch_git_args(branch, &trusted_ssh_command(repo));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run_git_bounded(
        &args,
        repo,
        BoundedCmdOptions {
            timeout: Some(GIT_FETCH_TIMEOUT),
            stdout_cap: MAX_GIT_OUTPUT_BYTES,
            stderr_cap: MAX_GIT_OUTPUT_BYTES,
            extra_env: fetch_env(),
            ..BoundedCmdOptions::default()
        },
    );
    result.success && !result.timed_out
}

struct DocsLoadResult {
    docs: Vec<RepoDocFile>,
    source: DocsSource,
    docs_ref: String,
    stale: bool,
}

fn load_repository_docs(
    repo: &Path,
    configured_default_branch: Option<&str>,
    warnings: &mut Vec<String>,
) -> DocsLoadResult {
    let default_branch = detect_default_branch(repo, configured_default_branch);
    if let Some(branch) = default_branch {
        let remote_ref = remote_tracking_ref(&branch);
        let fetch_ok = fetch_origin_branch(repo, &branch);
        if git_ref_exists(repo, &remote_ref) {
            let docs = read_docs_from_git_ref(repo, &remote_ref, warnings);
            if fetch_ok {
                return DocsLoadResult {
                    docs,
                    source: DocsSource::Remote,
                    docs_ref: remote_ref,
                    stale: false,
                };
            }
            warnings.push(
                "Could not fetch latest documentation from origin — showing cached remote ref."
                    .into(),
            );
            return DocsLoadResult {
                docs,
                source: DocsSource::CachedRemote,
                docs_ref: remote_ref,
                stale: true,
            };
        }
    }

    warnings.push("No remote documentation ref available — using local checkout.".into());
    DocsLoadResult {
        docs: read_local_docs(repo),
        source: DocsSource::LocalFallback,
        docs_ref: "local-checkout".into(),
        stale: true,
    }
}

fn gh_available() -> bool {
    let (ok, _, _, _) = run_cmd_with_timeout(
        "gh",
        &["--version"],
        &repo_root_fallback(),
        TOOL_PROBE_TIMEOUT,
    );
    ok
}

fn git_cli_available(cwd: &Path) -> bool {
    let (ok, _, _, _) = run_cmd_with_timeout("git", &["--version"], cwd, TOOL_PROBE_TIMEOUT);
    ok
}

fn repo_root_fallback() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

fn gh_auth_status() -> (bool, Option<String>) {
    if !gh_available() {
        return (false, Some("gh CLI not found".into()));
    }
    let (ok, stdout, stderr, _) = run_cmd_with_timeout(
        "gh",
        &["auth", "status"],
        &repo_root_fallback(),
        GH_AUTH_TIMEOUT,
    );
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

/// Runs a bounded `gh ... list` and returns its stdout. A non-zero exit or timeout is
/// reported through `warnings` instead of silently producing an empty list.
fn run_gh_list(
    repo: &Path,
    args: &[&str],
    what: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let result = run_cmd_bounded(
        "gh",
        args,
        repo,
        BoundedCmdOptions {
            timeout: Some(GH_LIST_TIMEOUT),
            ..BoundedCmdOptions::default()
        },
    );
    if result.success {
        return Some(result.stdout);
    }
    if result.timed_out {
        warnings.push(format!(
            "gh {what} timed out after {}s",
            GH_LIST_TIMEOUT.as_secs()
        ));
        return None;
    }
    let detail: String = redact_gh_status(result.stderr)
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().chars().take(200).collect())
        .unwrap_or_default();
    warnings.push(if detail.is_empty() {
        format!("gh {what} failed (exit {:?})", result.exit_code)
    } else {
        format!("gh {what} failed (exit {:?}): {detail}", result.exit_code)
    });
    None
}

fn gh_merged_prs(repo: &Path, warnings: &mut Vec<String>) -> (Vec<RepoGhPullRequest>, bool) {
    let (ok, out, _) = git_in_repo(repo, &["remote", "get-url", "origin"]);
    if !ok {
        return (Vec::new(), false);
    }
    let remote = out.trim();
    let slug = parse_github_slug(remote);
    let Some(slug) = slug else {
        return (Vec::new(), false);
    };

    // One extra record detects truncation. `gh pr list` has no `--paginate`; `--limit` pages internally.
    let limit = (MAX_GH_MERGED_PRS + 1).to_string();
    let Some(stdout) = run_gh_list(
        repo,
        &[
            "pr",
            "list",
            "--repo",
            &slug,
            "--state",
            "merged",
            "--limit",
            &limit,
            "--json",
            "number,title,mergedAt,author,body",
        ],
        "pr list",
        warnings,
    ) else {
        return (Vec::new(), false);
    };
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

/// Lightweight git metadata for Prompt Builder (no gh, docs, commits, or history).
pub fn inspect_repo_prompt_context(
    repo_path: &str,
    configured_default_branch: Option<&str>,
) -> Result<RepoPromptContext, String> {
    let path = resolve_repo_path(repo_path)?;
    let mut warnings = Vec::new();

    let git_on_path = git_cli_available(&path);
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
    warn_invalid_configured_branch(configured_default_branch, &mut warnings);
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

fn gh_open_issues(repo: &Path, warnings: &mut Vec<String>) -> (Vec<RepoGhIssue>, bool) {
    let (ok, out, _) = git_in_repo(repo, &["remote", "get-url", "origin"]);
    if !ok {
        return (Vec::new(), false);
    }
    let Some(slug) = parse_github_slug(out.trim()) else {
        return (Vec::new(), false);
    };
    let limit = (MAX_GH_OPEN_ISSUES + 1).to_string();
    let Some(stdout) = run_gh_list(
        repo,
        &[
            "issue",
            "list",
            "--repo",
            &slug,
            "--state",
            "open",
            "--limit",
            &limit,
            "--json",
            "number,title,state,labels",
        ],
        "issue list",
        warnings,
    ) else {
        return (Vec::new(), false);
    };
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

    let git_on_path = git_cli_available(&path);

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
            docs_source: DocsSource::LocalFallback,
            docs_ref: "local-checkout".into(),
            docs_stale: true,
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
            docs_source: DocsSource::LocalFallback,
            docs_ref: "local-checkout".into(),
            docs_stale: true,
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
    warn_invalid_configured_branch(configured_default_branch, &mut warnings);
    let default_branch = detect_default_branch(&path, configured_default_branch);
    let (ahead, behind) = default_branch
        .as_deref()
        .map(|b| ahead_behind(&path, b))
        .unwrap_or((None, None));

    let changed_files = load_changed_files(&path);
    let docs_load = load_repository_docs(&path, configured_default_branch, &mut warnings);
    let docs = docs_load.docs;

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
        gh_merged_prs(&path, &mut warnings)
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
        gh_open_issues(&path, &mut warnings)
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
        latest_commit: None,
        commits: Vec::new(),
        commits_truncated: false,
        changed_files,
        docs,
        docs_source: docs_load.source,
        docs_ref: docs_load.docs_ref,
        docs_stale: docs_load.stale,
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
    std::path::Path::new(path.trim_end_matches('/'))
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Repository".to_string())
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
    if !is_git_toplevel(path) {
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
        if is_git_toplevel(&child) {
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
    fn read_local_docs_rejects_readme_symlink_to_external_file() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-readme-symlink-{stamp}"));
        let outside = std::env::temp_dir().join(format!("agent-workspace-readme-outside-{stamp}"));
        fs::create_dir_all(&root).expect("mkdir root");
        fs::create_dir_all(&outside).expect("mkdir outside");
        fs::write(outside.join("SECRET.md"), "# external secret content").expect("write outside");
        symlink(outside.join("SECRET.md"), root.join("README.md")).expect("symlink readme");

        let docs = read_local_docs(&root);
        let readme = docs
            .iter()
            .find(|d| d.path == "README.md")
            .expect("readme entry");
        assert!(readme.found);
        assert!(!readme.readable);
        assert!(readme.content.is_empty());
        assert!(!readme.content.contains("external secret"));
        assert!(readme
            .read_error
            .as_deref()
            .unwrap_or("")
            .contains("symlink"));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn read_local_docs_rejects_backlog_symlink_to_external_file() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-backlog-symlink-{stamp}"));
        let outside = std::env::temp_dir().join(format!("agent-workspace-backlog-outside-{stamp}"));
        fs::create_dir_all(root.join("docs")).expect("mkdir docs");
        fs::create_dir_all(&outside).expect("mkdir outside");
        fs::write(outside.join("SECRET.md"), "# leaked backlog secret").expect("write outside");
        fs::write(root.join("README.md"), "# safe readme").expect("write readme");
        symlink(outside.join("SECRET.md"), root.join("docs/BACKLOG.md")).expect("symlink backlog");

        let docs = read_local_docs(&root);
        let backlog = docs
            .iter()
            .find(|d| d.path == "docs/BACKLOG.md")
            .expect("backlog entry");
        assert!(backlog.found);
        assert!(!backlog.readable);
        assert!(backlog.content.is_empty());
        assert!(!backlog.content.contains("leaked backlog"));
        assert!(backlog
            .read_error
            .as_deref()
            .unwrap_or("")
            .contains("symlink"));

        let readme = docs
            .iter()
            .find(|d| d.path == "README.md")
            .expect("readme entry");
        assert!(readme.readable);
        assert_eq!(readme.content, "# safe readme");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn read_local_docs_loads_normal_core_and_nested_markdown() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-read-docs-{stamp}"));
        fs::create_dir_all(root.join("docs/product/nested")).expect("mkdir nested");
        fs::write(root.join("README.md"), "# hi").expect("write readme");
        fs::write(root.join("docs/BACKLOG.md"), "# backlog").expect("write backlog");
        fs::write(root.join("docs/product/nested/DETAIL.md"), "# detail").expect("write detail");

        let docs = read_local_docs(&root);
        let readme = docs.iter().find(|d| d.path == "README.md").expect("readme");
        assert!(readme.readable);
        assert_eq!(readme.content, "# hi");

        let backlog = docs
            .iter()
            .find(|d| d.path == "docs/BACKLOG.md")
            .expect("backlog");
        assert!(backlog.readable);
        assert_eq!(backlog.content, "# backlog");

        let detail = docs
            .iter()
            .find(|d| d.path == "docs/product/nested/DETAIL.md")
            .expect("detail");
        assert!(detail.readable);
        assert_eq!(detail.content, "# detail");
        assert!(!detail.content.contains("external"));

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
        assert_eq!(
            unreadable_json["read_error"],
            "read docs/ROADMAP.md: denied"
        );
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
    fn collect_doc_paths_from_git_listing_filters_tree() {
        let listing = vec![
            "README.md".into(),
            "CHANGELOG.md".into(),
            "docs/BACKLOG.md".into(),
            "docs/product/FEATURES.md".into(),
            "node_modules/evil.md".into(),
            "docs/escape/SECRET.md".into(),
            ".hidden.md".into(),
            "src/foo.md".into(),
        ];
        let paths = collect_doc_paths_from_git_listing(&listing);
        assert!(paths.iter().any(|p| p == "README.md"));
        assert!(paths.iter().any(|p| p == "docs/BACKLOG.md"));
        assert!(paths.iter().any(|p| p == "docs/product/FEATURES.md"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
        assert!(!paths.iter().any(|p| p.contains("src/")));
        assert!(!paths.iter().any(|p| p.starts_with('.')));
    }

    #[test]
    fn is_safe_git_doc_path_rejects_traversal() {
        assert!(!is_safe_git_doc_path("../README.md"));
        assert!(!is_safe_git_doc_path("docs/../SECRET.md"));
        assert!(is_safe_git_doc_path("docs/BACKLOG.md"));
        assert!(is_safe_git_doc_path("docs/notes..draft.md"));
    }

    #[test]
    fn parse_name_status_z_handles_spaces_and_renames() {
        let files = parse_name_status_z("M\0docs/my file.md\0R100\0old name.md\0new name.md\0");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "docs/my file.md");
        assert_eq!(files[0].status, "M");
        assert_eq!(files[1].path, "new name.md");
        assert!(files[1].status.starts_with('R'));
    }

    #[test]
    fn docs_source_serializes_kebab_case() {
        let value = serde_json::to_value(DocsSource::CachedRemote).expect("serialize");
        assert_eq!(value, "cached-remote");
    }

    #[test]
    fn read_docs_from_git_ref_reads_committed_markdown() {
        use std::process::Command;
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-remote-docs-{stamp}"));
        fs::create_dir_all(root.join("docs")).expect("mkdir docs");
        fs::write(root.join("README.md"), "# remote readme").expect("write readme");
        fs::write(root.join("docs/BACKLOG.md"), "# backlog").expect("write backlog");

        let status = Command::new("git")
            .args(["init"])
            .current_dir(&root)
            .status()
            .expect("git init");
        assert!(status.success());
        Command::new("git")
            .args(["add", "."])
            .current_dir(&root)
            .status()
            .expect("git add");
        Command::new("git")
            .args(["commit", "-m", "docs"])
            .env("GIT_AUTHOR_NAME", "test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .current_dir(&root)
            .status()
            .expect("git commit");

        let mut warnings = Vec::new();
        let docs = read_docs_from_git_ref(&root, "HEAD", &mut warnings);
        let readme = docs.iter().find(|d| d.path == "README.md").expect("readme");
        assert!(readme.readable);
        assert_eq!(readme.content, "# remote readme");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn load_repository_docs_uses_local_fallback_without_remote() {
        use std::process::Command;
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-local-docs-{stamp}"));
        fs::create_dir_all(&root).expect("mkdir");
        fs::write(root.join("README.md"), "# local").expect("write readme");
        let status = Command::new("git")
            .args(["init"])
            .current_dir(&root)
            .status()
            .expect("git init");
        assert!(status.success());

        let mut warnings = Vec::new();
        let loaded = load_repository_docs(&root, None, &mut warnings);
        assert_eq!(loaded.source, DocsSource::LocalFallback);
        assert!(loaded.stale);
        assert!(warnings.iter().any(|w| w.contains("local checkout")));

        let _ = fs::remove_dir_all(&root);
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

    fn temp_dir_for(label: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-workspace-dash-{label}-{stamp}"));
        fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn git_init(dir: &Path) {
        let status = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(dir)
            .status()
            .expect("git init");
        assert!(status.success());
    }

    #[test]
    fn is_safe_branch_name_accepts_normal_branches() {
        for branch in [
            "main",
            "master",
            "release/1.2",
            "feat/hugrverk-overhaul",
            "v1.0",
        ] {
            assert!(is_safe_branch_name(branch), "{branch}");
        }
    }

    #[test]
    fn is_safe_branch_name_rejects_option_and_revision_syntax() {
        for branch in [
            "",
            "-x",
            "--upload-pack=touch /tmp/pwned",
            "a:b",
            "main one",
            "main\tone",
            "a..b",
            "a//b",
            "/main",
            "main/",
            "main.",
            "main.lock",
            "main@{1}",
            "@",
            "a~1",
            "a^",
            "a?b",
            "a*b",
            "a[b",
            "a\\b",
            "a\nb",
        ] {
            assert!(!is_safe_branch_name(branch), "{branch:?}");
        }
    }

    #[test]
    fn fetch_origin_branch_refuses_option_like_branch_names() {
        let repo = temp_dir_for("fetch-reject");
        git_init(&repo);
        let marker = repo.join("pwned");
        let branch = format!("--upload-pack=touch {}", marker.display());
        assert!(!fetch_origin_branch(&repo, &branch));
        assert!(!marker.exists());
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn detect_default_branch_ignores_invalid_configured_name() {
        let repo = temp_dir_for("branch-ignore");
        git_init(&repo);
        assert_eq!(detect_default_branch(&repo, Some("-x")), None);
        assert_eq!(
            detect_default_branch(&repo, Some(" develop ")),
            Some("develop".to_string())
        );
        let mut warnings = Vec::new();
        warn_invalid_configured_branch(Some("-x"), &mut warnings);
        warn_invalid_configured_branch(Some("main"), &mut warnings);
        assert_eq!(warnings.len(), 1);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn discover_ignores_subfolders_of_a_repository() {
        let repo = temp_dir_for("discover-subfolders");
        git_init(&repo);
        fs::create_dir_all(repo.join("packages/a")).expect("mkdir a");
        fs::create_dir_all(repo.join("packages/b")).expect("mkdir b");

        assert!(is_git_repo(&repo.join("packages/a")));
        assert!(!is_git_toplevel(&repo.join("packages/a")));
        assert!(is_git_toplevel(&repo));

        let result =
            discover_local_git_repos(repo.to_string_lossy().as_ref()).expect("discover repo");
        assert!(result.repos.is_empty(), "{:?}", result.repos);

        let _ = fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    fn install_fake_gh(label: &str, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir_for(label);
        let gh = dir.join("gh");
        fs::write(&gh, format!("#!/bin/sh\n{script}\n")).expect("write fake gh");
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).expect("chmod");
        let old = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{old}", dir.display()));
        dir
    }

    #[cfg(unix)]
    fn repo_with_github_origin(label: &str) -> PathBuf {
        let repo = temp_dir_for(label);
        git_init(&repo);
        let status = std::process::Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repo.git",
            ])
            .current_dir(&repo)
            .status()
            .expect("git remote add");
        assert!(status.success());
        repo
    }

    #[cfg(unix)]
    #[test]
    fn gh_merged_prs_uses_limit_not_paginate_and_parses_output() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let bin = install_fake_gh(
            "gh-ok",
            r#"printf '%s\n' "$@" > "$(dirname "$0")/args.txt"
echo '[{"number":7,"title":"t","mergedAt":"2026-01-01T00:00:00Z","author":{"login":"a"},"body":"b"}]'"#,
        );
        let repo = repo_with_github_origin("gh-ok-repo");

        let mut warnings = Vec::new();
        let (prs, truncated) = gh_merged_prs(&repo, &mut warnings);

        let args = fs::read_to_string(bin.join("args.txt")).expect("recorded args");
        let args: Vec<&str> = args.lines().collect();
        let _ = fs::remove_dir_all(&bin);
        let _ = fs::remove_dir_all(&repo);
        assert_eq!(prs.len(), 1);
        assert!(!truncated);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!args.contains(&"--paginate"), "{args:?}");
        let limit_at = args.iter().position(|a| *a == "--limit").expect("--limit");
        assert_eq!(args[limit_at + 1], (MAX_GH_MERGED_PRS + 1).to_string());
        assert_eq!(&args[..2], &["pr", "list"]);
    }

    #[cfg(unix)]
    #[test]
    fn gh_list_failure_is_reported_as_a_warning() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let bin = install_fake_gh("gh-fail", "echo 'unknown flag: --boom' >&2\nexit 1");
        let repo = repo_with_github_origin("gh-fail-repo");

        let mut warnings = Vec::new();
        let (prs, _) = gh_merged_prs(&repo, &mut warnings);
        let (issues, _) = gh_open_issues(&repo, &mut warnings);

        let _ = fs::remove_dir_all(&bin);
        let _ = fs::remove_dir_all(&repo);
        assert!(prs.is_empty());
        assert!(issues.is_empty());
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings[0].contains("gh pr list failed"), "{warnings:?}");
        assert!(warnings[0].contains("unknown flag"), "{warnings:?}");
        assert!(warnings[1].contains("gh issue list failed"), "{warnings:?}");
    }

    #[cfg(unix)]
    #[test]
    fn gh_issue_list_uses_limit_not_paginate() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let bin = install_fake_gh(
            "gh-issues",
            r#"printf '%s\n' "$@" > "$(dirname "$0")/args.txt"
echo '[{"number":3,"title":"i","state":"OPEN","labels":[{"name":"bug"}]}]'"#,
        );
        let repo = repo_with_github_origin("gh-issues-repo");

        let mut warnings = Vec::new();
        let (issues, truncated) = gh_open_issues(&repo, &mut warnings);

        let args = fs::read_to_string(bin.join("args.txt")).expect("recorded args");
        let args: Vec<&str> = args.lines().collect();
        let _ = fs::remove_dir_all(&bin);
        let _ = fs::remove_dir_all(&repo);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].labels, vec!["bug".to_string()]);
        assert!(!truncated);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!args.contains(&"--paginate"), "{args:?}");
        let limit_at = args.iter().position(|a| *a == "--limit").expect("--limit");
        assert_eq!(args[limit_at + 1], (MAX_GH_OPEN_ISSUES + 1).to_string());
    }

    #[test]
    fn is_dirty_does_not_take_the_index_lock() {
        let repo = temp_dir_for("dirty-no-lock");
        git_init(&repo);
        fs::write(repo.join("file.txt"), "x").expect("write file");
        assert!(is_dirty(&repo));
        assert!(!repo.join(".git/index.lock").exists());
        let _ = fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    fn git_ok(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
            .args(args)
            .current_dir(dir)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?}");
    }

    /// An executable that records its own run in `sentinel`, then exits non-zero so it never
    /// stands in for a working transport.
    #[cfg(unix)]
    fn sentinel_script(dir: &Path, name: &str, sentinel: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join(name);
        fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\nexit 1\n", sentinel.display()),
        )
        .expect("write script");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("chmod");
        script
    }

    /// A bare origin with one commit on `main`, and a clone-less work repo pointing at it.
    #[cfg(unix)]
    fn work_repo_with_local_origin(label: &str) -> (PathBuf, PathBuf) {
        let root = temp_dir_for(label);
        let origin = root.join("origin.git");
        let work = root.join("work");
        fs::create_dir_all(&work).expect("mkdir work");
        git_ok(
            &root,
            &["init", "--quiet", "--bare", "-b", "main", "origin.git"],
        );
        git_ok(&work, &["init", "--quiet", "-b", "main"]);
        fs::write(work.join("README.md"), "hello").expect("write readme");
        git_ok(&work, &["add", "-A"]);
        git_ok(&work, &["commit", "--quiet", "-m", "init"]);
        git_ok(
            &work,
            &["remote", "add", "origin", origin.to_string_lossy().as_ref()],
        );
        git_ok(&work, &["push", "--quiet", "origin", "main"]);
        (root, work)
    }

    #[cfg(unix)]
    #[test]
    fn fetch_args_do_not_run_repo_config_uploadpack() {
        let _guard = crate::test_env::guard::lock();
        let (root, work) = work_repo_with_local_origin("fetch-uploadpack");
        let sentinel = root.join("uploadpack-ran");
        let script = sentinel_script(&root, "evil-upload-pack", &sentinel);
        git_ok(
            &work,
            &[
                "config",
                "remote.origin.uploadpack",
                script.to_string_lossy().as_ref(),
            ],
        );

        // Same args as the dashboard fetch, without the transport allowlist, so a local
        // remote can actually connect and the upload-pack choice is what gets tested.
        let args = fetch_git_args("main", "ssh");
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = run_git_bounded(&args, &work, BoundedCmdOptions::default());

        let ran = sentinel.exists();
        let fetched = git_ref_exists(&work, "refs/remotes/origin/main");
        let _ = fs::remove_dir_all(&root);
        assert!(!ran, "repo-config uploadpack was executed");
        assert!(result.success, "{result:?}");
        assert!(fetched, "fetch should succeed with the stock upload-pack");
    }

    #[cfg(unix)]
    #[test]
    fn fetch_origin_branch_does_not_use_local_path_remotes() {
        let _guard = crate::test_env::guard::lock();
        let (root, work) = work_repo_with_local_origin("fetch-file-transport");
        let sentinel = root.join("uploadpack-ran");
        let script = sentinel_script(&root, "evil-upload-pack", &sentinel);
        git_ok(
            &work,
            &[
                "config",
                "remote.origin.uploadpack",
                script.to_string_lossy().as_ref(),
            ],
        );

        let fetched = fetch_origin_branch(&work, "main");

        let ran = sentinel.exists();
        let _ = fs::remove_dir_all(&root);
        assert!(!ran, "repo-config uploadpack was executed");
        assert!(
            !fetched,
            "local-path origins are outside the allowed transports"
        );
    }

    #[cfg(unix)]
    #[test]
    fn fetch_origin_branch_refuses_ext_transport_enabled_by_repo_config() {
        let _guard = crate::test_env::guard::lock();
        let root = temp_dir_for("fetch-ext");
        let work = root.join("work");
        fs::create_dir_all(&work).expect("mkdir work");
        git_init(&work);
        let sentinel = root.join("ext-ran");
        let script = sentinel_script(&root, "ext-helper", &sentinel);
        git_ok(
            &work,
            &[
                "config",
                "remote.origin.url",
                &format!("ext::{}", script.display()),
            ],
        );
        git_ok(&work, &["config", "protocol.ext.allow", "always"]);

        let fetched = fetch_origin_branch(&work, "main");

        let ran = sentinel.exists();
        let _ = fs::remove_dir_all(&root);
        assert!(!ran, "ext:: transport command was executed");
        assert!(!fetched);
    }

    #[cfg(unix)]
    #[test]
    fn fetch_origin_branch_ignores_repo_core_ssh_command() {
        let _guard = crate::test_env::guard::lock();
        let root = temp_dir_for("fetch-ssh");
        let work = root.join("work");
        fs::create_dir_all(&work).expect("mkdir work");
        git_init(&work);
        let sentinel = root.join("ssh-ran");
        let script = sentinel_script(&root, "ssh-wrapper", &sentinel);
        git_ok(
            &work,
            &["remote", "add", "origin", "ssh://git@example.invalid/x.git"],
        );
        git_ok(
            &work,
            &[
                "config",
                "core.sshCommand",
                script.to_string_lossy().as_ref(),
            ],
        );

        let fetched = fetch_origin_branch(&work, "main");

        let ran = sentinel.exists();
        let _ = fs::remove_dir_all(&root);
        assert!(!ran, "repo-config core.sshCommand was executed");
        assert!(!fetched);
    }

    #[cfg(unix)]
    #[test]
    fn fetch_origin_branch_ignores_repo_core_git_proxy() {
        let _guard = crate::test_env::guard::lock();
        let root = temp_dir_for("fetch-gitproxy");
        let work = root.join("work");
        fs::create_dir_all(&work).expect("mkdir work");
        git_init(&work);
        let sentinel = root.join("proxy-ran");
        let script = sentinel_script(&root, "git-proxy", &sentinel);
        git_ok(
            &work,
            &["remote", "add", "origin", "git://example.invalid/x.git"],
        );
        git_ok(
            &work,
            &["config", "core.gitProxy", script.to_string_lossy().as_ref()],
        );

        let fetched = fetch_origin_branch(&work, "main");

        let ran = sentinel.exists();
        let _ = fs::remove_dir_all(&root);
        assert!(!ran, "repo-config core.gitProxy was executed");
        assert!(!fetched);
    }

    #[test]
    fn trusted_ssh_command_prefers_the_last_system_or_global_value() {
        let scoped = "system\tssh -F /etc/ssh_sys\nglobal\tssh -i ~/.ssh/work\nlocal\t./evil.sh\n";
        assert_eq!(
            trusted_ssh_command_from(scoped, Some("/usr/bin/other-ssh")),
            "ssh -i ~/.ssh/work"
        );
    }

    #[test]
    fn trusted_ssh_command_never_returns_a_local_value() {
        assert_eq!(trusted_ssh_command_from("local\t./evil.sh\n", None), "ssh");
        assert_eq!(trusted_ssh_command_from("", None), "ssh");
    }

    #[test]
    fn trusted_ssh_command_quotes_git_ssh_when_nothing_else_is_configured() {
        assert_eq!(
            trusted_ssh_command_from("", Some("/opt/my ssh/it's")),
            "'/opt/my ssh/it'\\''s'"
        );
    }
}
