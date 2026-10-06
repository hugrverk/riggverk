use std::path::Path;
use std::time::Duration;

use super::process::{run_git_bounded, BoundedCmdOptions};
use super::repo_dashboard::RepoCommitEntry;

/// Safety bound for one `git log`; the dashboard shows the complete history below it.
const MAX_HISTORY_COMMITS: usize = 100_000;
const MAX_HISTORY_BYTES: usize = 48 * 1024 * 1024;
const STDERR_BYTES: usize = 512 * 1024;
const HISTORY_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const FIELD_SEPARATOR: char = '\u{1f}';
const RECORD_SEPARATOR: char = '\u{1e}';

pub(super) struct FullCommitHistory {
    pub commits: Vec<RepoCommitEntry>,
    pub incomplete: bool,
    pub warning: Option<String>,
}

fn parse_commit_records(raw: &str) -> Result<Vec<RepoCommitEntry>, String> {
    let mut commits = Vec::new();
    for raw_record in raw.split(RECORD_SEPARATOR) {
        let record = raw_record.trim_start_matches(['\n', '\r']);
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.splitn(7, FIELD_SEPARATOR).collect();
        if fields.len() != 7 {
            return Err("invalid commit history record".to_string());
        }
        let authored_at = fields[4]
            .parse::<i64>()
            .map_err(|_| "invalid commit timestamp".to_string())?;
        commits.push(RepoCommitEntry {
            sha: fields[0].to_string(),
            short_sha: fields[1].to_string(),
            author_name: fields[2].to_string(),
            author_email: fields[3].to_string(),
            authored_at,
            subject: fields[6].trim_end_matches(['\n', '\r']).to_string(),
            is_merge: fields[5].split_whitespace().count() > 1,
        });
    }
    Ok(commits)
}

/// One `git log` against a frozen `head`. Paging with `--skip` would rescan the history for
/// every page (quadratic on large repositories).
fn load_history(
    repo: &Path,
    head: &str,
    max_commits: usize,
    max_bytes: usize,
) -> Result<(Vec<RepoCommitEntry>, bool), String> {
    let max_count_arg = max_commits.saturating_add(1).to_string();
    let pretty_arg = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s%x1e";
    let pretty = format!("--pretty=format:{pretty_arg}");
    let result = run_git_bounded(
        &["log", "--topo-order", &pretty, "-n", &max_count_arg, head],
        repo,
        BoundedCmdOptions {
            timeout: Some(HISTORY_TIMEOUT),
            stdout_cap: max_bytes,
            stderr_cap: STDERR_BYTES,
            ..BoundedCmdOptions::default()
        },
    );
    if result.timed_out {
        return Err("commit history timed out".to_string());
    }
    if !result.success {
        return Err(format!(
            "commit history failed with exit code {:?}",
            result.exit_code
        ));
    }
    let mut raw = result.stdout.as_str();
    if result.stdout_truncated {
        // Drop the partial trailing record.
        raw = raw
            .rfind(RECORD_SEPARATOR)
            .map_or("", |end| &raw[..end + RECORD_SEPARATOR.len_utf8()]);
    }
    let mut commits = parse_commit_records(raw)?;
    let count_truncated = commits.len() > max_commits;
    if count_truncated {
        commits.truncate(max_commits);
    }
    Ok((commits, count_truncated || result.stdout_truncated))
}

fn resolve_head(repo: &Path) -> Result<String, String> {
    let result = run_git_bounded(
        &["rev-parse", "--verify", "HEAD"],
        repo,
        BoundedCmdOptions {
            timeout: Some(PROBE_TIMEOUT),
            stdout_cap: 256,
            stderr_cap: STDERR_BYTES,
            ..BoundedCmdOptions::default()
        },
    );
    if !result.success || result.timed_out || result.stdout_truncated {
        return Err("could not resolve repository HEAD for commit history".to_string());
    }
    let head = result.stdout.trim();
    if head.is_empty() {
        return Err("repository HEAD is empty".to_string());
    }
    Ok(head.to_string())
}

fn is_shallow(repo: &Path) -> bool {
    let result = run_git_bounded(
        &["rev-parse", "--is-shallow-repository"],
        repo,
        BoundedCmdOptions {
            timeout: Some(PROBE_TIMEOUT),
            stdout_cap: 64,
            stderr_cap: 256,
            ..BoundedCmdOptions::default()
        },
    );
    result.success && result.stdout.trim() == "true"
}

pub(super) fn load_all_commits(repo: &Path) -> Result<FullCommitHistory, String> {
    let head = resolve_head(repo)?;
    let (commits, truncated) = load_history(repo, &head, MAX_HISTORY_COMMITS, MAX_HISTORY_BYTES)?;
    let shallow = is_shallow(repo);
    let mut warnings = Vec::new();
    if shallow {
        warnings.push(
            "repository is a shallow clone; all locally available commits were loaded, but older history is not present locally"
                .to_string(),
        );
    }
    if truncated {
        warnings.push(format!(
            "commit history is limited to the {} most recent commits; older commits are not shown",
            commits.len()
        ));
    }
    Ok(FullCommitHistory {
        commits,
        incomplete: shallow || truncated,
        warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a repository with `count` empty commits (`c0` oldest) through `git fast-import`.
    fn repo_with_commits(label: &str, count: usize) -> std::path::PathBuf {
        use std::io::Write;
        use std::process::{Command, Stdio};
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let repo = std::env::temp_dir().join(format!("aw-history-{label}-{nonce}"));
        std::fs::create_dir_all(&repo).expect("mkdir repo");
        let init = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&repo)
            .status()
            .expect("git init");
        assert!(init.success());

        let mut stream = String::new();
        for index in 0..count {
            let message = format!("c{index}");
            stream.push_str(&format!(
                "commit refs/heads/trunk\nmark :{mark}\ncommitter Test <test@example.test> {ts} +0000\ndata {len}\n{message}\n",
                mark = index + 1,
                ts = 1_700_000_000 + index,
                len = message.len(),
            ));
            if index > 0 {
                stream.push_str(&format!("from :{index}\n"));
            }
            stream.push('\n');
        }
        let mut import = Command::new("git")
            .args(["fast-import", "--quiet"])
            .current_dir(&repo)
            .stdin(Stdio::piped())
            .spawn()
            .expect("git fast-import");
        import
            .stdin
            .take()
            .expect("stdin")
            .write_all(stream.as_bytes())
            .expect("write stream");
        assert!(import.wait().expect("wait").success());
        let head = Command::new("git")
            .args(["symbolic-ref", "HEAD", "refs/heads/trunk"])
            .current_dir(&repo)
            .status()
            .expect("symbolic-ref");
        assert!(head.success());
        repo
    }

    #[test]
    fn loads_complete_history_beyond_the_old_page_size() {
        let repo = repo_with_commits("full", 1_205);
        let history = load_all_commits(&repo).expect("load history");
        assert_eq!(history.commits.len(), 1_205);
        assert_eq!(history.commits[0].subject, "c1204");
        assert_eq!(history.commits[1_204].subject, "c0");
        assert!(!history.incomplete);
        assert!(history.warning.is_none());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn history_stops_at_the_commit_cap_and_reports_it() {
        let repo = repo_with_commits("cap", 10);
        let head = resolve_head(&repo).expect("head");
        let (commits, truncated) = load_history(&repo, &head, 3, MAX_HISTORY_BYTES).expect("log");
        assert_eq!(commits.len(), 3);
        assert_eq!(commits[0].subject, "c9");
        assert!(truncated);
        let (all, truncated) = load_history(&repo, &head, 10, MAX_HISTORY_BYTES).expect("log");
        assert_eq!(all.len(), 10);
        assert!(!truncated);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn history_byte_cap_drops_the_partial_trailing_record() {
        let repo = repo_with_commits("bytes", 50);
        let head = resolve_head(&repo).expect("head");
        let (commits, truncated) = load_history(&repo, &head, 1_000, 400).expect("log");
        assert!(truncated);
        assert!(
            !commits.is_empty() && commits.len() < 50,
            "{}",
            commits.len()
        );
        assert!(commits.iter().all(|commit| commit.sha.len() == 40));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn parses_commit_records_and_merge_state() {
        let raw = "full\u{1f}short\u{1f}User\u{1f}mail\u{1f}123\u{1f}p1 p2\u{1f}Merge topic\u{1e}";
        let commits = parse_commit_records(raw).expect("parse records");
        assert_eq!(commits.len(), 1);
        assert!(commits[0].is_merge);
    }

    #[test]
    fn rejects_incomplete_records() {
        let error = parse_commit_records("sha\u{1f}short\u{1e}").expect_err("invalid record");
        assert_eq!(error, "invalid commit history record");
    }
}
