//! Environment variables that override where Riggverk keeps its data.
//!
//! Each variable has a current name and an alias from before the rename. The current name wins
//! when both are set, so a shell that exports the alias keeps working until the user switches.

/// The data folder (development, tests, smoke runs): an existing folder.
pub const WORKSPACE_PATH_ENV: &str = "RIGGVERK_WORKSPACE_PATH";
/// Alias of [`WORKSPACE_PATH_ENV`] from before the rename.
pub const LEGACY_WORKSPACE_PATH_ENV: &str = "AGENT_WORKSPACE_PATH";

/// The folder backups are written to.
pub const BACKUP_DIR_ENV: &str = "RIGGVERK_BACKUP_DIR";
/// Alias of [`BACKUP_DIR_ENV`] from before the rename.
pub const LEGACY_BACKUP_DIR_ENV: &str = "AGENT_WORKSPACE_BACKUP_DIR";

/// The non-empty value of `RIGGVERK_WORKSPACE_PATH`, else of its alias. An empty value counts as
/// unset, as it always did for the workspace path.
pub fn workspace_path_override() -> Option<String> {
    [WORKSPACE_PATH_ENV, LEGACY_WORKSPACE_PATH_ENV]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

/// The variable that sets the backup folder and its value: the current name when it is set, else
/// the alias. A variable that is set but empty is returned as it is; the caller refuses it.
pub fn backup_dir_override() -> Option<(&'static str, String)> {
    [BACKUP_DIR_ENV, LEGACY_BACKUP_DIR_ENV]
        .into_iter()
        .find_map(|name| std::env::var(name).ok().map(|value| (name, value)))
}
