use crate::commands::repo_dashboard::{
    inspect_repo, inspect_repo_prompt_context, RepoDashboardSnapshot, RepoPromptContext,
};

#[tauri::command]
pub fn get_repo_dashboard_snapshot(
    repo_path: String,
    default_branch: Option<String>,
    include_gh: Option<bool>,
) -> Result<RepoDashboardSnapshot, String> {
    inspect_repo(
        &repo_path,
        default_branch.as_deref(),
        include_gh.unwrap_or(true),
    )
}

#[tauri::command]
pub fn get_repo_prompt_context(
    repo_path: String,
    default_branch: Option<String>,
) -> Result<RepoPromptContext, String> {
    inspect_repo_prompt_context(&repo_path, default_branch.as_deref())
}
