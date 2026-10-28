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

/// The variable that sets the workspace path and its non-empty value: the current name, else its
/// alias. An empty value counts as unset, as it always did for the workspace path.
pub fn workspace_path_override_var() -> Option<(&'static str, String)> {
    non_empty_value([WORKSPACE_PATH_ENV, LEGACY_WORKSPACE_PATH_ENV])
}

/// The non-empty value of `RIGGVERK_WORKSPACE_PATH`, else of its alias.
pub fn workspace_path_override() -> Option<String> {
    workspace_path_override_var().map(|(_, value)| value)
}

/// The variable that sets the backup folder and its value: the first of the current name and the
/// alias with a non-empty value, so an empty current name falls back to the alias like the
/// workspace variable does. When every variable that is set is empty, the current name (or the
/// alias, if only that is set) is returned empty and the caller refuses it.
pub fn backup_dir_override() -> Option<(&'static str, String)> {
    non_empty_value([BACKUP_DIR_ENV, LEGACY_BACKUP_DIR_ENV]).or_else(|| {
        [BACKUP_DIR_ENV, LEGACY_BACKUP_DIR_ENV]
            .into_iter()
            .find_map(|name| std::env::var(name).ok().map(|value| (name, value)))
    })
}

fn non_empty_value(names: [&'static str; 2]) -> Option<(&'static str, String)> {
    names.into_iter().find_map(|name| {
        let value = std::env::var(name).ok()?;
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| (name, trimmed.to_string()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::guard;

    fn set(name: &str, value: &str) {
        unsafe { std::env::set_var(name, value) };
    }

    #[test]
    fn the_workspace_variable_named_is_the_one_that_is_set() {
        let _lock = guard::lock();
        let _isolated = guard::isolate_data_location_env();
        assert_eq!(workspace_path_override_var(), None);
        set(LEGACY_WORKSPACE_PATH_ENV, " /alias ");
        assert_eq!(
            workspace_path_override_var(),
            Some((LEGACY_WORKSPACE_PATH_ENV, "/alias".to_string()))
        );
        set(WORKSPACE_PATH_ENV, "/current");
        assert_eq!(
            workspace_path_override_var(),
            Some((WORKSPACE_PATH_ENV, "/current".to_string()))
        );
        set(WORKSPACE_PATH_ENV, "  ");
        assert_eq!(
            workspace_path_override_var().map(|(name, _)| name),
            Some(LEGACY_WORKSPACE_PATH_ENV),
            "an empty current name falls through to the alias"
        );
    }

    #[test]
    fn an_empty_backup_variable_falls_back_to_the_alias_and_is_refused_when_nothing_else_is_set() {
        let _lock = guard::lock();
        let _isolated = guard::isolate_data_location_env();
        set(BACKUP_DIR_ENV, "");
        assert_eq!(backup_dir_override(), Some((BACKUP_DIR_ENV, String::new())));
        set(LEGACY_BACKUP_DIR_ENV, "/alias-backups");
        assert_eq!(
            backup_dir_override(),
            Some((LEGACY_BACKUP_DIR_ENV, "/alias-backups".to_string()))
        );
        set(BACKUP_DIR_ENV, "/current-backups");
        assert_eq!(
            backup_dir_override(),
            Some((BACKUP_DIR_ENV, "/current-backups".to_string()))
        );
    }
}
