#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;

use crate::platform_paths::{
    default_cursor_profile_root, display_path, resolve_user_home as platform_home, Platform,
    PlatformEnv,
};
#[cfg(test)]
use crate::shell_runtime::env_path_for_bash;

pub use crate::platform_paths::normalized_path_key;

pub fn resolve_user_home() -> Result<PathBuf, String> {
    platform_home(&PlatformEnv::from_process_env(), Platform::current())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorProfilePaths {
    pub user_home: PathBuf,
    pub profile_root: PathBuf,
    pub agents: PathBuf,
    pub skills: PathBuf,
    pub mcp_config: PathBuf,
    pub permissions: PathBuf,
}

pub fn resolve_cursor_profile_paths() -> Result<CursorProfilePaths, String> {
    let env = PlatformEnv::from_process_env();
    let platform = Platform::current();
    let user_home = platform_home(&env, platform)?;
    let profile_root = default_cursor_profile_root(&env, platform)?;
    Ok(cursor_profile_paths_from_root(user_home, profile_root))
}

pub fn cursor_profile_paths_from_root(
    user_home: PathBuf,
    profile_root: PathBuf,
) -> CursorProfilePaths {
    CursorProfilePaths {
        agents: profile_root.join("agents"),
        skills: profile_root.join("skills"),
        mcp_config: profile_root.join("mcp.json"),
        permissions: profile_root.join("permissions.json"),
        profile_root,
        user_home,
    }
}

pub fn cursor_profile_root_display(paths: &CursorProfilePaths) -> String {
    display_path(&paths.profile_root, Platform::current())
}

#[cfg(test)]
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
    use crate::platform_paths::{
        default_cursor_profile_root, display_path, resolve_user_home as platform_home, Platform,
        PlatformEnv,
    };
    #[test]
    fn windows_like_home_falls_back_to_userprofile() {
        let env = PlatformEnv {
            userprofile: Some(r"C:\Users\Example".into()),
            ..PlatformEnv::default()
        };
        assert_eq!(
            platform_home(&env, Platform::Windows).expect("home"),
            PathBuf::from(r"C:\Users\Example")
        );
        assert_eq!(
            default_cursor_profile_root(&env, Platform::Windows).expect("profile root"),
            PathBuf::from(r"C:\Users\Example").join(".cursor")
        );
    }

    #[test]
    fn resolved_profile_root_maps_all_cursor_targets() {
        let user_home = PathBuf::from(r"C:\Users\Example");
        let profile_root = user_home.join(".cursor");
        let paths = cursor_profile_paths_from_root(user_home.clone(), profile_root.clone());
        assert_eq!(paths.profile_root, profile_root);
        assert_eq!(paths.agents, profile_root.join("agents"));
        assert_eq!(paths.skills, profile_root.join("skills"));
        assert_eq!(paths.mcp_config, profile_root.join("mcp.json"));
        assert_eq!(paths.permissions, profile_root.join("permissions.json"));
    }

    #[test]
    fn all_operations_resolve_same_root() {
        let user_home = PathBuf::from("/tmp/aw-cursor-home");
        let profile_root = user_home.join(".cursor");
        let paths = cursor_profile_paths_from_root(user_home, profile_root.clone());
        let resolved = cursor_profile_paths_from_root(
            paths.user_home.clone(),
            default_cursor_profile_root(
                &PlatformEnv {
                    home: Some(paths.user_home.to_string_lossy().into_owned()),
                    ..PlatformEnv::default()
                },
                Platform::Linux,
            )
            .expect("default root"),
        );
        assert_eq!(resolved.profile_root, profile_root);
        assert_eq!(resolved.agents, profile_root.join("agents"));
        assert_eq!(resolved.skills, profile_root.join("skills"));
    }

    #[test]
    fn env_pairs_strip_extended_prefix_for_bash() {
        let paths = cursor_profile_paths_from_root(
            PathBuf::from(r"\\?\C:\Users\Example"),
            PathBuf::from(r"\\?\C:\Users\Example\Desktop\cursor-profile-test"),
        );
        let env = cursor_profile_env_pairs(&paths, "bash", "python");
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("CURSOR_AGENTS_PATH").map(String::as_str),
            Some("C:/Users/Example/Desktop/cursor-profile-test/agents")
        );
    }

    #[test]
    fn display_path_strips_extended_prefix() {
        let path = PathBuf::from(r"\\?\C:\Users\Example\.cursor");
        let shown = display_path(&path, Platform::Windows);
        assert!(!shown.starts_with(r"\\?\"));
        assert_eq!(shown, "C:/Users/Example/.cursor");
    }
}


