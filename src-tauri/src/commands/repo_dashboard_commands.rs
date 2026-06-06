use std::path::Path;

use crate::commands::repo_dashboard::{
    discover_local_git_repos as scan_local_git_repos, inspect_repo, inspect_repo_prompt_context,
    DiscoverLocalGitReposResult, RepoDashboardSnapshot, RepoPromptContext,
};
use crate::commands::repo_dashboard_history::load_all_commits;

#[tauri::command]
pub fn get_repo_dashboard_snapshot(
    repo_path: String,
    default_branch: Option<String>,
    include_gh: Option<bool>,
) -> Result<RepoDashboardSnapshot, String> {
    let mut snapshot = inspect_repo(
        &repo_path,
        default_branch.as_deref(),
        include_gh.unwrap_or(true),
    )?;

    if snapshot.git_available && snapshot.is_repo {
        let history = load_all_commits(Path::new(&snapshot.repo_path))?;
        snapshot.commits = history.commits;
        snapshot.latest_commit = snapshot.commits.first().cloned();
        snapshot.commits_truncated = history.incomplete;
        snapshot
            .warnings
            .retain(|warning| !warning.starts_with("local git commit log truncated at"));
        if let Some(warning) = history.warning {
            snapshot.warnings.push(warning);
        }
    }

    Ok(snapshot)
}

#[tauri::command]
pub fn get_repo_prompt_context(
    repo_path: String,
    default_branch: Option<String>,
) -> Result<RepoPromptContext, String> {
    inspect_repo_prompt_context(&repo_path, default_branch.as_deref())
}

#[tauri::command]
pub fn discover_local_git_repos(
    parent_path: String,
) -> Result<DiscoverLocalGitReposResult, String> {
    scan_local_git_repos(&parent_path)
}
