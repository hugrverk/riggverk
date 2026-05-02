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

    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::normalize_user_workspace_path;
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
    fn non_tilde_relative_paths_stay_relative() {
        assert_eq!(
            normalize_user_workspace_path("workspace/local"),
            Some("workspace/local".into())
        );
    }
}
