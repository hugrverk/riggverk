use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::process::run_cmd;
use crate::path_utils::normalize_user_workspace_path_for_save;

const MAX_GIT_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_COMMITS: usize = 500;
const MAX_CHANGED_FILES: usize = 200;

const DOC_PATHS: [&str; 6] = [
    "README.md",
    "docs/ROADMAP.md",
    "docs/KNOWN_GAPS.md",
    "docs/FEATURES.md",
    "docs/VALIDATION.md",
    "docs/TODO.md",
];

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

fn read_local_docs(repo: &Path) -> Vec<RepoDocFile> {
    DOC_PATHS
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
                Ok(content) => RepoDocFile {
                    path: (*rel).to_string(),
                    found: true,
                    content,
                    error: None,
                },
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

fn parse_github_slug(remote: &str) -> Option<String> {
    let trimmed = remote.trim();
    if trimmed.starts_with("git@github.com:") {
        let slug = trimmed
            .trim_start_matches("git@github.com:")
            .trim_end_matches(".git");
        return Some(slug.to_string());
    }
    if trimmed.contains("github.com/") {
        let after = trimmed.split("github.com/").nth(1)?;
        let slug = after.trim_end_matches(".git");
        if slug.contains('/') {
            return Some(slug.to_string());
        }
    }
    None
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
}
