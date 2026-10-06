use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOS,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOS
        } else {
            Platform::Linux
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct PlatformEnv {
    pub home: Option<String>,
    pub userprofile: Option<String>,
    pub homedrive: Option<String>,
    pub homepath: Option<String>,
    pub appdata: Option<String>,
    pub xdg_config_home: Option<String>,
}

impl PlatformEnv {
    pub fn from_process_env() -> Self {
        Self {
            home: non_empty_env("HOME"),
            userprofile: non_empty_env("USERPROFILE"),
            homedrive: non_empty_env("HOMEDRIVE"),
            homepath: non_empty_env("HOMEPATH"),
            appdata: non_empty_env("APPDATA"),
            xdg_config_home: non_empty_env("XDG_CONFIG_HOME"),
        }
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn windows_home_from_drive_path(env: &PlatformEnv) -> Option<PathBuf> {
    let drive = env.homedrive.as_ref()?.trim();
    let path = env.homepath.as_ref()?.trim();
    if drive.is_empty() || path.is_empty() {
        return None;
    }
    let drive_root = if drive.ends_with(':') {
        drive.to_string()
    } else {
        format!("{drive}:")
    };
    let child = path.trim_start_matches(['\\', '/']);
    Some(PathBuf::from(format!("{drive_root}\\{child}")))
}

pub fn resolve_user_home(env: &PlatformEnv, platform: Platform) -> Result<PathBuf, String> {
    match platform {
        Platform::Windows => {
            if let Some(ref profile) = env.userprofile {
                return Ok(PathBuf::from(profile));
            }
            if let Some(path) = windows_home_from_drive_path(env) {
                return Ok(path);
            }
            if let Some(ref home) = env.home {
                return Ok(PathBuf::from(home));
            }
        }
        Platform::MacOS | Platform::Linux => {
            if let Some(ref home) = env.home {
                return Ok(PathBuf::from(home));
            }
        }
    }
    Err("user home directory is not set (HOME or USERPROFILE)".into())
}

pub fn app_support_dir(env: &PlatformEnv, platform: Platform) -> Result<PathBuf, String> {
    match platform {
        Platform::MacOS => {
            let home = resolve_user_home(env, platform)?;
            Ok(home.join("Library/Application Support/ai.agentworkspace.app"))
        }
        Platform::Windows => {
            let appdata = env
                .appdata
                .as_ref()
                .ok_or_else(|| "APPDATA is not set".to_string())?;
            Ok(PathBuf::from(appdata).join("ai.agentworkspace.app"))
        }
        Platform::Linux => {
            let config_home = env
                .xdg_config_home
                .clone()
                .or_else(|| {
                    resolve_user_home(env, platform)
                        .ok()
                        .map(|h| h.join(".config").to_string_lossy().into_owned())
                })
                .ok_or_else(|| "cannot resolve XDG config home".to_string())?;
            Ok(PathBuf::from(config_home).join("ai.agentworkspace.app"))
        }
    }
}

pub fn settings_file_path(env: &PlatformEnv, platform: Platform) -> Result<PathBuf, String> {
    Ok(app_support_dir(env, platform)?.join("settings.json"))
}

pub fn backup_root_path(env: &PlatformEnv, platform: Platform) -> Result<PathBuf, String> {
    Ok(app_support_dir(env, platform)?.join("backups"))
}

pub fn default_installed_workspace_path(
    env: &PlatformEnv,
    platform: Platform,
) -> Result<PathBuf, String> {
    let home = resolve_user_home(env, platform)?;
    Ok(home.join(".config/agent-workspace"))
}

pub fn default_cursor_profile_root(
    env: &PlatformEnv,
    platform: Platform,
) -> Result<PathBuf, String> {
    let home = resolve_user_home(env, platform)?;
    Ok(home.join(".cursor"))
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

pub fn is_windows_drive_root(path: &Path) -> bool {
    let raw = path.to_string_lossy();
    let normalized = strip_windows_extended_prefix(&raw);
    let normalized = normalized.trim_end_matches(['\\', '/']);
    let bytes = normalized.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || (bytes.len() == 3 && (bytes[2] == b'\\' || bytes[2] == b'/')))
}

pub fn is_unc_share_root(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    let raw = strip_windows_extended_prefix(&path_str);
    raw.starts_with(r"\\") || raw.starts_with("//")
}

pub fn is_broad_write_root(path: &Path, user_home: &Path, platform: Platform) -> bool {
    if path.as_os_str().is_empty() {
        return true;
    }
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
    if platform == Platform::Windows && is_windows_drive_root(path) {
        return true;
    }
    if is_unc_share_root(path) {
        return true;
    }
    false
}

pub fn reject_broad_write_root(
    path: &Path,
    user_home: &Path,
    platform: Platform,
    label: &str,
) -> Result<(), String> {
    if is_broad_write_root(path, user_home, platform) {
        return Err(format!("refusing broad {label} path: {}", path.display()));
    }
    Ok(())
}

/// Strip `\\?\` or `//?/` extended-length prefixes for user-facing display only.
pub fn strip_windows_extended_prefix(path: &str) -> &str {
    path.strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix("//?/"))
        .unwrap_or(path)
}

/// Format a native path for display in the UI or docs.
pub fn display_path(path: &Path, platform: Platform) -> String {
    let raw = path.to_string_lossy();
    let stripped = strip_windows_extended_prefix(&raw);
    if platform == Platform::Windows {
        stripped.replace('\\', "/")
    } else {
        stripped.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win_env() -> PlatformEnv {
        PlatformEnv {
            home: None,
            userprofile: Some(r"C:\Users\Example".into()),
            homedrive: None,
            homepath: None,
            appdata: Some(r"C:\Users\Example\AppData\Roaming".into()),
            xdg_config_home: None,
        }
    }

    fn mac_env() -> PlatformEnv {
        PlatformEnv {
            home: Some("/Users/example".into()),
            userprofile: None,
            homedrive: None,
            homepath: None,
            appdata: None,
            xdg_config_home: None,
        }
    }

    fn linux_env() -> PlatformEnv {
        PlatformEnv {
            home: Some("/home/example".into()),
            userprofile: None,
            homedrive: None,
            homepath: None,
            appdata: None,
            xdg_config_home: None,
        }
    }

    #[test]
    fn windows_userprofile_wins_when_home_differs() {
        let env = PlatformEnv {
            home: Some(r"D:\WrongHome".into()),
            userprofile: Some(r"C:\Users\Example".into()),
            ..PlatformEnv::default()
        };
        assert_eq!(
            resolve_user_home(&env, Platform::Windows).expect("home"),
            PathBuf::from(r"C:\Users\Example")
        );
    }

    #[test]
    fn windows_home_falls_back_to_userprofile() {
        let env = win_env();
        assert_eq!(
            resolve_user_home(&env, Platform::Windows).expect("home"),
            PathBuf::from(r"C:\Users\Example")
        );
    }

    #[test]
    fn windows_home_falls_back_to_homedrive_homepath() {
        let env = PlatformEnv {
            homedrive: Some("C:".into()),
            homepath: Some(r"\Users\Example".into()),
            ..PlatformEnv::default()
        };
        assert_eq!(
            resolve_user_home(&env, Platform::Windows).expect("home"),
            PathBuf::from(r"C:\Users\Example")
        );
    }

    #[test]
    fn macos_home_unchanged_when_userprofile_set() {
        let env = PlatformEnv {
            home: Some("/Users/example".into()),
            userprofile: Some(r"C:\Users\Example".into()),
            ..PlatformEnv::default()
        };
        assert_eq!(
            resolve_user_home(&env, Platform::MacOS).expect("home"),
            PathBuf::from("/Users/example")
        );
    }

    #[test]
    fn windows_settings_under_appdata() {
        let env = win_env();
        assert_eq!(
            settings_file_path(&env, Platform::Windows).expect("settings"),
            PathBuf::from(r"C:\Users\Example\AppData\Roaming")
                .join("ai.agentworkspace.app")
                .join("settings.json")
        );
    }

    #[test]
    fn windows_app_support_under_appdata() {
        let env = win_env();
        assert_eq!(
            app_support_dir(&env, Platform::Windows).expect("app support"),
            PathBuf::from(r"C:\Users\Example\AppData\Roaming").join("ai.agentworkspace.app")
        );
    }

    #[test]
    fn windows_backup_root_under_appdata_app_support() {
        let env = win_env();
        assert_eq!(
            backup_root_path(&env, Platform::Windows).expect("backups"),
            PathBuf::from(r"C:\Users\Example\AppData\Roaming")
                .join("ai.agentworkspace.app")
                .join("backups")
        );
    }

    #[test]
    fn windows_app_support_requires_appdata() {
        let env = PlatformEnv {
            appdata: None,
            ..win_env()
        };
        assert_eq!(
            app_support_dir(&env, Platform::Windows).expect_err("missing APPDATA"),
            "APPDATA is not set"
        );
        assert_eq!(
            backup_root_path(&env, Platform::Windows).expect_err("missing APPDATA"),
            "APPDATA is not set"
        );
    }

    #[test]
    fn macos_settings_preserve_application_support() {
        let env = mac_env();
        assert_eq!(
            settings_file_path(&env, Platform::MacOS).expect("settings"),
            PathBuf::from(
                "/Users/example/Library/Application Support/ai.agentworkspace.app/settings.json"
            )
        );
    }

    #[test]
    fn linux_settings_use_xdg_config() {
        let env = linux_env();
        assert_eq!(
            settings_file_path(&env, Platform::Linux).expect("settings"),
            PathBuf::from("/home/example/.config/ai.agentworkspace.app/settings.json")
        );
    }

    #[test]
    fn linux_settings_honor_xdg_override() {
        let env = PlatformEnv {
            xdg_config_home: Some("/custom/config".into()),
            ..linux_env()
        };
        assert_eq!(
            settings_file_path(&env, Platform::Linux).expect("settings"),
            PathBuf::from("/custom/config/ai.agentworkspace.app/settings.json")
        );
    }

    #[test]
    fn backup_root_aligns_with_app_support() {
        let env = mac_env();
        assert_eq!(
            backup_root_path(&env, Platform::MacOS).expect("backups"),
            PathBuf::from(
                "/Users/example/Library/Application Support/ai.agentworkspace.app/backups"
            )
        );
    }

    #[test]
    fn default_workspace_under_home_config() {
        let env = win_env();
        assert_eq!(
            default_installed_workspace_path(&env, Platform::Windows).expect("workspace"),
            PathBuf::from(r"C:\Users\Example")
                .join(".config")
                .join("agent-workspace")
        );
    }

    #[test]
    fn default_cursor_profile_under_home() {
        let env = mac_env();
        assert_eq!(
            default_cursor_profile_root(&env, Platform::MacOS).expect("cursor"),
            PathBuf::from("/Users/example/.cursor")
        );
    }

    #[test]
    fn empty_home_and_userprofile_fails() {
        let env = PlatformEnv::default();
        assert!(resolve_user_home(&env, Platform::Windows).is_err());
    }

    #[test]
    fn rejects_broad_windows_drive_root() {
        let home = PathBuf::from(r"C:\Users\Example");
        assert!(is_windows_drive_root(Path::new(r"C:\")));
        assert!(is_windows_drive_root(Path::new(r"C:")));
        assert!(is_broad_write_root(
            Path::new(r"C:\"),
            &home,
            Platform::Windows
        ));
    }

    #[test]
    fn rejects_unc_share_root() {
        let home = PathBuf::from(r"C:\Users\Example");
        let unc = Path::new(r"\\server\share");
        assert!(is_unc_share_root(unc));
        assert!(is_broad_write_root(unc, &home, Platform::Windows));
    }

    #[test]
    fn accepts_normal_backup_and_skill_paths() {
        let home = PathBuf::from("/Users/example");
        let backup = home.join("Library/Application Support/ai.agentworkspace.app/backups");
        let skills = home.join(".cursor/skills");
        assert!(!is_broad_write_root(&backup, &home, Platform::MacOS));
        assert!(!is_broad_write_root(&skills, &home, Platform::MacOS));
    }

    #[test]
    fn rejects_unix_filesystem_root() {
        let home = PathBuf::from("/home/example");
        assert!(is_broad_write_root(Path::new("/"), &home, Platform::Linux));
        assert!(is_broad_write_root(&home, &home, Platform::Linux));
    }

    #[test]
    fn display_strips_extended_prefix_on_windows() {
        let path = Path::new(r"\\?\C:\Users\Example\.cursor\mcp.json");
        assert_eq!(
            display_path(path, Platform::Windows),
            "C:/Users/Example/.cursor/mcp.json"
        );
    }

    #[test]
    fn display_preserves_unix_paths() {
        let path = Path::new("/home/example/.cursor/mcp.json");
        assert_eq!(
            display_path(path, Platform::MacOS),
            "/home/example/.cursor/mcp.json"
        );
    }
}
