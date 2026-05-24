use crate::commands::repo_dashboard::{inspect_repo, RepoDashboardSnapshot};

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
