use std::path::PathBuf;

pub(crate) fn normalize_user_workspace_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed == "~" {
        if let Ok(home) = std::env::var("HOME") {
            if !home.is_empty() {
                return Some(home);
            }
        }
    }

    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            if !home.is_empty() {
                return Some(
                    PathBuf::from(home)
                        .join(rest)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }

    if PathBuf::from(trimmed).is_absolute() {
        return Some(trimmed.to_string());
    }

    None
}

pub(crate) fn normalize_user_workspace_path_for_save(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    normalize_user_workspace_path(trimmed)
        .map(Some)
        .ok_or_else(|| "workspace path must be absolute or start with ~/".to_string())
}

#[cfg(test)]
mod tests {
    use super::{normalize_user_workspace_path, normalize_user_workspace_path_for_save};
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn tilde_expands_to_home_when_home_available() {
        let _guard = env_lock().lock().expect("lock env");
        let home = std::env::var("HOME").expect("HOME required for test");

        assert_eq!(normalize_user_workspace_path("~"), Some(home));
    }

    #[test]
    fn tilde_slash_expands_to_home_child_when_home_available() {
        let _guard = env_lock().lock().expect("lock env");
        let home = std::env::var("HOME").expect("HOME required for test");
        let expected = std::path::PathBuf::from(home)
            .join("Desktop/test")
            .to_string_lossy()
            .into_owned();

        assert_eq!(
            normalize_user_workspace_path("~/Desktop/test"),
            Some(expected)
        );
    }

    #[test]
    fn whitespace_is_trimmed() {
        assert_eq!(
            normalize_user_workspace_path("  /tmp/example  "),
            Some("/tmp/example".into())
        );
    }

    #[test]
    fn whitespace_only_becomes_none() {
        assert_eq!(normalize_user_workspace_path("   \n\t  "), None);
    }

    #[test]
    fn legacy_non_tilde_relative_paths_become_none() {
        assert_eq!(normalize_user_workspace_path("workspace/local"), None);
    }

    #[test]
    fn save_normalization_rejects_relative_paths() {
        for path in ["workspace/local", "./workspace", "../workspace"] {
            let result = normalize_user_workspace_path_for_save(path);
            assert!(result.is_err(), "expected {path:?} to be rejected");
            assert_eq!(
                result.unwrap_err(),
                "workspace path must be absolute or start with ~/"
            );
        }
    }

    #[test]
    fn save_normalization_accepts_absolute_and_empty_paths() {
        assert_eq!(
            normalize_user_workspace_path_for_save("  /tmp/example  "),
            Ok(Some("/tmp/example".into()))
        );
        assert_eq!(
            normalize_user_workspace_path_for_save("   \n\t  "),
            Ok(None)
        );
    }
}
