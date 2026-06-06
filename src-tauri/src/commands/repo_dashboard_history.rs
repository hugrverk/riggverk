use std::path::Path;
use std::time::Duration;

use super::process::{run_cmd_bounded, BoundedCmdOptions};
use super::repo_dashboard::RepoCommitEntry;

const PAGE_SIZE: usize = 500;
const PAGE_BYTES: usize = 8 * 1024 * 1024;
const STDERR_BYTES: usize = 512 * 1024;
const PAGE_TIMEOUT: Duration = Duration::from_secs(60);
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
        let record = raw_record.trim_start_matches(|c| c == '\n' || c == '\r');
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
            subject: fields[6]
                .trim_end_matches(|c| c == '\n' || c == '\r')
                .to_string(),
            is_merge: fields[5].split_whitespace().count() > 1,
        });
    }
    Ok(commits)
}

fn load_page(repo: &Path, head: &str, offset: usize) -> Result<Vec<RepoCommitEntry>, String> {
    let offset_arg = offset.to_string();
    let page_size_arg = PAGE_SIZE.to_string();
    let pretty_arg = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s%x1e";
    let pretty = format!("--pretty=format:{pretty_arg}");
    let result = run_cmd_bounded(
        "git",
        &[
            "log",
            "--topo-order",
            &pretty,
            "--skip",
            &offset_arg,
            "-n",
            &page_size_arg,
            head,
        ],
        repo,
        BoundedCmdOptions {
            timeout: Some(PAGE_TIMEOUT),
            stdout_cap: PAGE_BYTES,
            stderr_cap: STDERR_BYTES,
            ..BoundedCmdOptions::default()
        },
    );
    if result.timed_out {
        return Err("commit history page timed out".to_string());
    }
    if !result.success {
        return Err(format!(
            "commit history page failed with exit code {:?}",
            result.exit_code
        ));
    }
    if result.stdout_truncated {
        return Err("commit history page exceeded its bounded output limit".to_string());
    }
    parse_commit_records(&result.stdout)
}

fn collect_pages<F>(mut load: F) -> Result<Vec<RepoCommitEntry>, String>
where
    F: FnMut(usize) -> Result<Vec<RepoCommitEntry>, String>,
{
    let mut commits = Vec::new();
    let mut offset = 0usize;
    loop {
        let page = load(offset)?;
        let page_len = page.len();
        commits.extend(page);
        if page_len < PAGE_SIZE {
            break;
        }
        offset = offset.saturating_add(page_len);
    }
    Ok(commits)
}

fn resolve_head(repo: &Path) -> Result<String, String> {
    let result = run_cmd_bounded(
        "git",
        &["rev-parse", "--verify", "HEAD"],
        repo,
        BoundedCmdOptions {
            timeout: Some(PAGE_TIMEOUT),
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
    let result = run_cmd_bounded(
        "git",
        &["rev-parse", "--is-shallow-repository"],
        repo,
        BoundedCmdOptions {
            timeout: Some(PAGE_TIMEOUT),
            stdout_cap: 64,
            stderr_cap: 256,
            ..BoundedCmdOptions::default()
        },
    );
    result.success && result.stdout.trim() == "true"
}

pub(super) fn load_all_commits(repo: &Path) -> Result<FullCommitHistory, String> {
    let head = resolve_head(repo)?;
    let commits = collect_pages(|offset| load_page(repo, &head, offset))?;
    let incomplete = is_shallow(repo);
    let warning = incomplete.then(|| {
        "repository is a shallow clone; all locally available commits were loaded, but older history is not present locally"
            .to_string()
    });
    Ok(FullCommitHistory {
        commits,
        incomplete,
        warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(index: usize) -> RepoCommitEntry {
        RepoCommitEntry {
            sha: format!("sha-{index}"),
            short_sha: format!("s-{index}"),
            author_name: "Author".to_string(),
            author_email: "author@example.test".to_string(),
            authored_at: index as i64,
            subject: format!("Commit {index}"),
            is_merge: false,
        }
    }

    #[test]
    fn collects_all_commits_across_multiple_pages() {
        let source: Vec<RepoCommitEntry> = (0..1_205).map(commit).collect();
        let commits = collect_pages(|offset| {
            Ok(source
                .iter()
                .skip(offset)
                .take(PAGE_SIZE)
                .cloned()
                .collect())
        })
        .expect("collect pages");

        assert_eq!(commits.len(), 1_205);
        assert_eq!(
            commits.first().map(|entry| entry.sha.as_str()),
            Some("sha-0")
        );
        assert_eq!(
            commits.last().map(|entry| entry.sha.as_str()),
            Some("sha-1204")
        );
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
