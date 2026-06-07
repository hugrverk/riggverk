use std::path::PathBuf;

use crate::platform_paths::{
    default_installed_workspace_path as platform_workspace_path, Platform, PlatformEnv,
};

/// Display form of the canonical installed workspace path (verified by release-check).
#[allow(dead_code)]
pub(crate) const DEFAULT_INSTALLED_WORKSPACE_DISPLAY: &str = "~/.config/agent-workspace";

fn resolve_home_string() -> Result<String, String> {
    crate::platform_paths::resolve_user_home(&PlatformEnv::from_process_env(), Platform::current())
        .map(|p| p.to_string_lossy().into_owned())
}

pub(crate) fn default_installed_workspace_path() -> Result<PathBuf, String> {
    platform_workspace_path(&PlatformEnv::from_process_env(), Platform::current())
}

/// Previous built-in default (`~/Agent Workspace`). Treated as deprecated, not a custom path.
pub(crate) fn is_legacy_default_workspace_path(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed == "~/Agent Workspace" {
        return true;
    }
    let Some(normalized) = normalize_user_workspace_path(trimmed) else {
        return false;
    };
    let Ok(home) = resolve_home_string() else {
        return false;
    };
    let legacy = PathBuf::from(home)
        .join("Agent Workspace")
        .to_string_lossy()
        .into_owned();
    normalized == legacy
}

pub(crate) fn normalize_user_workspace_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed == "~" {
        if let Ok(home) = resolve_home_string() {
            return Some(home);
        }
    }

    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Ok(home) = resolve_home_string() {
            return Some(
                PathBuf::from(home)
                    .join(rest)
                    .to_string_lossy()
                    .into_owned(),
            );
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
    use super::{
        default_installed_workspace_path, is_legacy_default_workspace_path,
        normalize_user_workspace_path, normalize_user_workspace_path_for_save,
        DEFAULT_INSTALLED_WORKSPACE_DISPLAY,
    };
    #[test]
    fn tilde_expands_to_home_when_home_available() {
        let _guard = crate::test_env::guard::lock();
        let home = crate::test_env::process_home()
            .to_string_lossy()
            .into_owned();

        assert_eq!(normalize_user_workspace_path("~"), Some(home));
    }

    #[test]
    fn tilde_slash_expands_to_home_child_when_home_available() {
        let _guard = crate::test_env::guard::lock();
        let home = crate::test_env::process_home();
        let expected = home
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
        let example = std::env::temp_dir().join("example");
        let example_str = example.to_string_lossy().into_owned();
        assert_eq!(
            normalize_user_workspace_path(&format!("  {example_str}  ")),
            Some(example_str)
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
    fn default_installed_workspace_path_resolves_under_home_config() {
        let home = crate::test_env::process_home();
        let path = default_installed_workspace_path().expect("default path");
        assert_eq!(path, home.join(".config/agent-workspace"));
        assert_eq!(
            DEFAULT_INSTALLED_WORKSPACE_DISPLAY,
            "~/.config/agent-workspace"
        );
    }

    #[test]
    fn legacy_default_workspace_path_is_detected() {
        let home = crate::test_env::process_home();
        let legacy = home.join("Agent Workspace").to_string_lossy().into_owned();
        assert!(is_legacy_default_workspace_path("~/Agent Workspace"));
        assert!(is_legacy_default_workspace_path(&legacy));
        assert!(!is_legacy_default_workspace_path(
            "~/.config/agent-workspace"
        ));
    }

    #[test]
    fn save_normalization_accepts_absolute_and_empty_paths() {
        let example = std::env::temp_dir().join("example");
        let example_str = example.to_string_lossy().into_owned();
        assert_eq!(
            normalize_user_workspace_path_for_save(&format!("  {example_str}  ")),
            Ok(Some(example_str))
        );
        assert_eq!(
            normalize_user_workspace_path_for_save("   \n\t  "),
            Ok(None)
        );
    }
}
