use std::path::{Component, Path, PathBuf};

use crate::settings;
use crate::shell_runtime::env_path_for_bash;

/// Resolve the user's home directory. On Windows, falls back to USERPROFILE when HOME is unset.
pub fn resolve_user_home() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }

    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            if !profile.is_empty() {
                return Ok(PathBuf::from(profile));
            }
        }
    }

    Err("user home directory is not set (HOME or USERPROFILE)".into())
}

pub fn default_cursor_profile_root() -> Result<PathBuf, String> {
    Ok(resolve_user_home()?.join(".cursor"))
}

fn normalize_profile_root_input(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed == "~" {
        return resolve_user_home().ok().map(|home| home.join(".cursor"));
    }

    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Ok(home) = resolve_user_home() {
            return Some(home.join(rest));
        }
    }

    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return Some(path);
    }

    None
}

pub fn normalized_path_key(path: &Path) -> String {
    path.components()
        .map(|component| match component {
            Component::Prefix(prefix) => prefix.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => "/".into(),
            Component::CurDir => ".".into(),
            Component::ParentDir => "..".into(),
            Component::Normal(part) => part.to_string_lossy().into_owned(),
        })
        .collect::<Vec<_>>()
        .join("/")
        .to_ascii_lowercase()
}

pub fn is_cursor_executable_like_path(path: &Path) -> bool {
    let normalized = normalized_path_key(path);
    if normalized.contains("/programs/cursor/") {
        return true;
    }
    if normalized.contains("/resources/app/bin") {
        return true;
    }
    if normalized.ends_with("/bin") && normalized.contains("/programs/cursor/") {
        return true;
    }
    if normalized.ends_with("/bin/cursor")
        || (normalized.ends_with("/cursor") && normalized.contains("/bin/"))
    {
        return true;
    }
    false
}

fn is_broad_profile_root(path: &Path, user_home: &Path) -> bool {
    if path == Path::new("/") {
        return true;
    }
    if path == user_home {
        return true;
    }
    if let Some(prefix) = path.components().next() {
        if matches!(prefix, Component::Prefix(_) | Component::RootDir) && path.parent().is_none() {
            return true;
        }
    }
    #[cfg(windows)]
    {
        let normalized = path.to_string_lossy();
        if normalized.len() == 3 {
            let mut chars = normalized.chars();
            if chars.next().is_some()
                && chars.next() == Some(':')
                && matches!(chars.next(), Some('\\') | Some('/'))
            {
                return true;
            }
        }
    }
    false
}

pub fn validate_cursor_profile_root(raw: &str) -> Result<PathBuf, String> {
    let Some(path) = normalize_profile_root_input(raw) else {
        return Err("cursor profile path must be absolute or start with ~/".into());
    };

    let user_home = resolve_user_home()?;
    if is_broad_profile_root(&path, &user_home) {
        return Err("cursor profile path is too broad".into());
    }
    if is_cursor_executable_like_path(&path) {
        return Err(
            "this looks like the Cursor CLI/program path, not the Cursor profile/config directory"
                .into(),
        );
    }

    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorProfilePaths {
    pub user_home: PathBuf,
    pub profile_root: PathBuf,
    pub agents: PathBuf,
    pub skills: PathBuf,
    pub mcp_config: PathBuf,
    pub permissions: PathBuf,
    pub source: CursorProfileRootSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorProfileRootSource {
    Default,
    Custom,
}

pub fn resolve_cursor_profile_paths() -> Result<CursorProfilePaths, String> {
    let user_home = resolve_user_home()?;
    let settings = settings::load();
    if let Some(ref custom) = settings.cursor_profile_path {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            let profile_root = validate_cursor_profile_root(trimmed)?;
            return Ok(cursor_profile_paths_from_root(
                user_home,
                profile_root,
                CursorProfileRootSource::Custom,
            ));
        }
    }

    Ok(cursor_profile_paths_from_root(
        user_home,
        default_cursor_profile_root()?,
        CursorProfileRootSource::Default,
    ))
}

pub fn cursor_profile_paths_from_root(
    user_home: PathBuf,
    profile_root: PathBuf,
    source: CursorProfileRootSource,
) -> CursorProfilePaths {
    CursorProfilePaths {
        agents: profile_root.join("agents"),
        skills: profile_root.join("skills"),
        mcp_config: profile_root.join("mcp.json"),
        permissions: profile_root.join("permissions.json"),
        profile_root,
        user_home,
        source,
    }
}

pub fn cursor_profile_env_pairs(
    paths: &CursorProfilePaths,
    bash: &str,
    python: &str,
) -> Vec<(String, String)> {
    let bash_env = if Path::new(bash).is_absolute() || bash.contains('\\') || bash.contains('/') {
        env_path_for_bash(Path::new(bash))
    } else {
        bash.to_string()
    };
    vec![
        ("HOME".into(), env_path_for_bash(&paths.user_home)),
        ("AW_BASH".into(), bash_env),
        (
            "CURSOR_PROFILE_ROOT".into(),
            env_path_for_bash(&paths.profile_root),
        ),
        (
            "CURSOR_AGENTS_PATH".into(),
            env_path_for_bash(&paths.agents),
        ),
        (
            "CURSOR_SKILLS_PATH".into(),
            env_path_for_bash(&paths.skills),
        ),
        (
            "CURSOR_MCP_CONFIG_PATH".into(),
            env_path_for_bash(&paths.mcp_config),
        ),
        (
            "CURSOR_PERMISSIONS_PATH".into(),
            env_path_for_bash(&paths.permissions),
        ),
        ("AW_PYTHON".into(), python.to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvRestore {
        home: Option<String>,
        userprofile: Option<String>,
    }

    impl EnvRestore {
        fn set(home: Option<&str>, userprofile: Option<&str>) -> Self {
            let previous = EnvRestore {
                home: std::env::var("HOME").ok(),
                userprofile: std::env::var("USERPROFILE").ok(),
            };
            match home {
                Some(value) => unsafe { std::env::set_var("HOME", value) },
                None => unsafe { std::env::remove_var("HOME") },
            }
            match userprofile {
                Some(value) => unsafe { std::env::set_var("USERPROFILE", value) },
                None => unsafe { std::env::remove_var("USERPROFILE") },
            }
            previous
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match &self.home {
                Some(value) => unsafe { std::env::set_var("HOME", value) },
                None => unsafe { std::env::remove_var("HOME") },
            }
            match &self.userprofile {
                Some(value) => unsafe { std::env::set_var("USERPROFILE", value) },
                None => unsafe { std::env::remove_var("USERPROFILE") },
            }
        }
    }

    #[test]
    fn windows_like_home_falls_back_to_userprofile() {
        let _guard = env_lock().lock().expect("env lock");
        let _restore = EnvRestore::set(None, Some(r"C:\Users\me"));
        assert_eq!(
            resolve_user_home().expect("home"),
            PathBuf::from(r"C:\Users\me")
        );
        assert_eq!(
            default_cursor_profile_root().expect("profile root"),
            PathBuf::from(r"C:\Users\me\.cursor")
        );
    }

    #[test]
    fn cursor_executable_path_is_rejected_as_profile_root() {
        let executable = PathBuf::from(
            r"C:\Users\me\AppData\Local\Programs\cursor\resources\app\bin\cursor",
        );
        assert!(is_cursor_executable_like_path(&executable));
        let err = validate_cursor_profile_root(&executable.to_string_lossy())
            .expect_err("executable path");
        assert!(err.contains("CLI/program path"));
    }

    #[test]
    fn resolved_profile_root_maps_all_cursor_targets() {
        let user_home = PathBuf::from(r"C:\Users\Example");
        let profile_root = user_home.join(".cursor");
        let paths = cursor_profile_paths_from_root(
            user_home.clone(),
            profile_root.clone(),
            CursorProfileRootSource::Default,
        );
        assert_eq!(paths.profile_root, profile_root);
        assert_eq!(paths.agents, profile_root.join("agents"));
        assert_eq!(paths.skills, profile_root.join("skills"));
        assert_eq!(paths.mcp_config, profile_root.join("mcp.json"));
        assert_eq!(paths.permissions, profile_root.join("permissions.json"));
    }

    #[test]
    fn cursor_app_bin_directory_is_rejected_as_profile_root() {
        let bin_dir = PathBuf::from(
            r"C:\Users\me\AppData\Local\Programs\cursor\resources\app\bin",
        );
        assert!(is_cursor_executable_like_path(&bin_dir));
        let err = validate_cursor_profile_root(&bin_dir.to_string_lossy()).expect_err("bin dir");
        assert!(err.contains("CLI/program path"));
    }

    #[test]
    fn custom_profile_root_maps_targets_under_custom_path() {
        let user_home = PathBuf::from(r"C:\Users\me");
        let profile_root = PathBuf::from(r"D:\AgentWorkspace\cursor-profile");
        let paths = cursor_profile_paths_from_root(
            user_home,
            profile_root.clone(),
            CursorProfileRootSource::Custom,
        );
        assert_eq!(paths.agents, profile_root.join("agents"));
        assert_eq!(paths.skills, profile_root.join("skills"));
        assert_eq!(paths.mcp_config, profile_root.join("mcp.json"));
        assert_eq!(paths.permissions, profile_root.join("permissions.json"));
    }

    #[test]
    fn env_pairs_strip_extended_prefix_for_bash() {
        let paths = cursor_profile_paths_from_root(
            PathBuf::from(r"\\?\C:\Users\Example"),
            PathBuf::from(r"\\?\C:\Users\Example\Desktop\cursor-profile-test"),
            CursorProfileRootSource::Custom,
        );
        let env = cursor_profile_env_pairs(&paths, "bash", "python");
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("CURSOR_AGENTS_PATH").map(String::as_str),
            Some("C:/Users/Example/Desktop/cursor-profile-test/agents")
        );
    }

    #[test]
    fn env_pairs_normalize_windows_paths_for_bash() {
        let paths = cursor_profile_paths_from_root(
            PathBuf::from(r"C:\Users\Example"),
            PathBuf::from(r"C:\Users\Example\Desktop\cursor-profile-test"),
            CursorProfileRootSource::Custom,
        );
        let env = cursor_profile_env_pairs(&paths, "bash", "python");
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("CURSOR_AGENTS_PATH").map(String::as_str),
            Some("C:/Users/Example/Desktop/cursor-profile-test/agents")
        );
    }

    #[test]
    fn env_pairs_include_explicit_target_paths_and_python() {
        let paths = cursor_profile_paths_from_root(
            PathBuf::from(r"C:\Users\Example"),
            PathBuf::from(r"C:\Users\Example\Desktop\cursor-profile-test"),
            CursorProfileRootSource::Custom,
        );
        let env = cursor_profile_env_pairs(&paths, "bash", "python");
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("CURSOR_PROFILE_ROOT").map(String::as_str),
            Some("C:/Users/Example/Desktop/cursor-profile-test")
        );
        assert_eq!(
            map.get("CURSOR_AGENTS_PATH").map(String::as_str),
            Some("C:/Users/Example/Desktop/cursor-profile-test/agents")
        );
        assert_eq!(map.get("AW_PYTHON").map(String::as_str), Some("python"));
        assert_eq!(map.get("AW_BASH").map(String::as_str), Some("bash"));
    }

    #[test]
    fn validate_accepts_tilde_cursor_profile_path() {
        let _guard = env_lock().lock().expect("env lock");
        let _restore = EnvRestore::set(Some("/tmp/aw-cursor-home"), None);
        let path = validate_cursor_profile_root("~/.cursor").expect("valid");
        assert_eq!(path, PathBuf::from("/tmp/aw-cursor-home/.cursor"));
    }

    #[test]
    fn validate_rejects_relative_profile_path() {
        let err = validate_cursor_profile_root(".cursor").expect_err("relative");
        assert!(err.contains("absolute"));
    }

    #[test]
    fn validate_rejects_windows_drive_root() {
        let err = validate_cursor_profile_root(r"C:\").expect_err("drive root");
        assert!(err.contains("too broad"));
    }
}
