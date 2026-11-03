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

/// Name of the per-user app data directory (settings, the OpenCode model
/// override, and backups). It equals the Tauri bundle identifier, which is the
/// `appConfigDir` convention, but it is a constant on purpose and never read
/// from the Tauri config at runtime: a later identifier change must not move
/// user data as a side effect. `identity_contract` pins the equality; the next
/// move needs its own migration, like `app_data_migration`.
pub const APP_DATA_DIR_NAME: &str = "se.hugrverk.riggverk";

/// Name of the app data directory before the Riggverk rename. Only
/// `app_data_migration` reads it, to move an existing directory to
/// `APP_DATA_DIR_NAME`. Nothing else may use it.
pub const LEGACY_APP_DATA_DIR_NAME: &str = "ai.agentworkspace.app";

/// Per-user directory for settings, the OpenCode model override, and backups.
pub fn app_support_dir(env: &PlatformEnv, platform: Platform) -> Result<PathBuf, String> {
    app_data_dir_named(env, platform, APP_DATA_DIR_NAME)
}

/// The app data directory of builds before the Riggverk rename. Same location
/// rules as `app_support_dir`, only the last component differs.
pub fn legacy_app_support_dir(env: &PlatformEnv, platform: Platform) -> Result<PathBuf, String> {
    app_data_dir_named(env, platform, LEGACY_APP_DATA_DIR_NAME)
}

fn app_data_dir_named(
    env: &PlatformEnv,
    platform: Platform,
    dir_name: &str,
) -> Result<PathBuf, String> {
    match platform {
        Platform::MacOS => {
            let home = resolve_user_home(env, platform)?;
            Ok(home.join("Library/Application Support").join(dir_name))
        }
        Platform::Windows => {
            let appdata = env
                .appdata
                .as_ref()
                .ok_or_else(|| "APPDATA is not set".to_string())?;
            Ok(PathBuf::from(appdata).join(dir_name))
        }
        Platform::Linux => {
            let config_home = xdg_config_home_dir(env.xdg_config_home.as_deref())
                .or_else(|| {
                    resolve_user_home(env, platform)
                        .ok()
                        .map(|h| h.join(".config"))
                })
                .ok_or_else(|| "cannot resolve XDG config home".to_string())?;
            Ok(config_home.join(dir_name))
        }
    }
}

pub fn settings_file_path(env: &PlatformEnv, platform: Platform) -> Result<PathBuf, String> {
    Ok(app_support_dir(env, platform)?.join("settings.json"))
}

pub fn backup_root_path(env: &PlatformEnv, platform: Platform) -> Result<PathBuf, String> {
    Ok(app_support_dir(env, platform)?.join("backups"))
}

/// Name of the default data folder under `~/.config`.
pub const DEFAULT_WORKSPACE_DIR_NAME: &str = "riggverk";

/// Name of the default data folder before the Riggverk rename. Only the layout migration reads it:
/// an existing folder of this name is used in place until the first write moves it.
pub const LEGACY_WORKSPACE_DIR_NAME: &str = "agent-workspace";

pub fn default_installed_workspace_path(
    env: &PlatformEnv,
    platform: Platform,
) -> Result<PathBuf, String> {
    let home = resolve_user_home(env, platform)?;
    Ok(home.join(".config").join(DEFAULT_WORKSPACE_DIR_NAME))
}

/// The default data folder of builds before the Riggverk rename (see `workspace_layout`).
pub fn legacy_default_installed_workspace_path(
    env: &PlatformEnv,
    platform: Platform,
) -> Result<PathBuf, String> {
    let home = resolve_user_home(env, platform)?;
    Ok(home.join(".config").join(LEGACY_WORKSPACE_DIR_NAME))
}

pub fn default_cursor_profile_root(
    env: &PlatformEnv,
    platform: Platform,
) -> Result<PathBuf, String> {
    let home = resolve_user_home(env, platform)?;
    Ok(home.join(".cursor"))
}

/// `$XDG_CONFIG_HOME` when it names one plain absolute folder: not the file system root and no
/// `..`. A relative value is ignored, as the XDG Base Directory specification says: file
/// operations would resolve it against the working directory, where no harness looks for it.
pub fn xdg_config_home_dir(value: Option<&str>) -> Option<PathBuf> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|dir| {
            dir.is_absolute()
                && dir.parent().is_some()
                && !dir
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
        })
}

/// OpenCode's global config folder for `home` and an `XDG_CONFIG_HOME` value, the way OpenCode
/// itself finds it on every OS (`xdg-basedir`): `$XDG_CONFIG_HOME/opencode`, else
/// `<home>/.config/opencode`. Every OpenCode file the app installs, checks or reads lives in it.
pub fn opencode_config_dir_for(home: &Path, xdg_config_home: Option<&str>) -> PathBuf {
    match xdg_config_home_dir(xdg_config_home) {
        Some(dir) => dir.join("opencode"),
        None => home.join(".config").join("opencode"),
    }
}

/// [`opencode_config_dir_for`] with `XDG_CONFIG_HOME` from the app's own environment. The folder
/// moves when the variable does: what the app wrote to the old folder stays there untouched.
pub fn opencode_config_dir(home: &Path) -> PathBuf {
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    opencode_config_dir_for(home, xdg.as_deref())
}

/// Whether `XDG_CONFIG_HOME` moves the OpenCode config folder away from `~/.config/opencode`.
/// Labels then name the folder `$XDG_CONFIG_HOME/opencode`: a folder that moves with an
/// environment variable is named by that, not by today's value.
pub fn opencode_config_moved_for(home: &Path, xdg_config_home: Option<&str>) -> bool {
    opencode_config_dir_for(home, xdg_config_home) != home.join(".config").join("opencode")
}

/// [`opencode_config_moved_for`] with `XDG_CONFIG_HOME` from the app's own environment.
pub fn opencode_config_moved(home: &Path) -> bool {
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    opencode_config_moved_for(home, xdg.as_deref())
}

pub fn path_comparison_key(path: &Path, platform: Platform) -> PathBuf {
    match platform {
        Platform::Linux => path.to_path_buf(),
        Platform::MacOS | Platform::Windows => {
            PathBuf::from(path.to_string_lossy().to_ascii_lowercase())
        }
    }
}

/// Whether two file names are the same file under `platform`'s case rules: exact on Linux,
/// ASCII-case-insensitive on macOS and Windows (APFS and NTFS defaults).
pub fn names_match(a: &str, b: &str, platform: Platform) -> bool {
    match platform {
        Platform::Linux => a == b,
        Platform::MacOS | Platform::Windows => a.eq_ignore_ascii_case(b),
    }
}

pub fn normalized_path_key(path: &Path) -> String {
    let normalized = path
        .components()
        .map(|component| match component {
            Component::Prefix(prefix) => prefix.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => "/".into(),
            Component::CurDir => ".".into(),
            Component::ParentDir => "..".into(),
            Component::Normal(part) => part.to_string_lossy().into_owned(),
        })
        .collect::<Vec<_>>()
        .join("/");
    path_comparison_key(Path::new(&normalized), Platform::current())
        .to_string_lossy()
        .into_owned()
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
    #[test]
    fn path_comparison_obeys_platform_case_rules() {
        use super::{path_comparison_key, Platform};
        use std::path::Path;
        for (platform, equal) in [
            (Platform::MacOS, true),
            (Platform::Windows, true),
            (Platform::Linux, false),
        ] {
            assert_eq!(
                path_comparison_key(Path::new("Foo"), platform)
                    == path_comparison_key(Path::new("foo"), platform),
                equal
            );
        }
    }

    #[test]
    fn names_match_obeys_platform_case_rules() {
        use super::{names_match, Platform};
        for (platform, folds) in [
            (Platform::MacOS, true),
            (Platform::Windows, true),
            (Platform::Linux, false),
        ] {
            assert_eq!(names_match("Notes.md", "notes.md", platform), folds);
            assert!(names_match("notes.md", "notes.md", platform));
            assert!(!names_match("notes.md", "other.md", platform));
        }
    }

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
                .join("se.hugrverk.riggverk")
                .join("settings.json")
        );
    }

    #[test]
    fn windows_app_support_under_appdata() {
        let env = win_env();
        assert_eq!(
            app_support_dir(&env, Platform::Windows).expect("app support"),
            PathBuf::from(r"C:\Users\Example\AppData\Roaming").join("se.hugrverk.riggverk")
        );
    }

    #[test]
    fn windows_backup_root_under_appdata_app_support() {
        let env = win_env();
        assert_eq!(
            backup_root_path(&env, Platform::Windows).expect("backups"),
            PathBuf::from(r"C:\Users\Example\AppData\Roaming")
                .join("se.hugrverk.riggverk")
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
                "/Users/example/Library/Application Support/se.hugrverk.riggverk/settings.json"
            )
        );
    }

    #[test]
    fn linux_settings_use_xdg_config() {
        let env = linux_env();
        assert_eq!(
            settings_file_path(&env, Platform::Linux).expect("settings"),
            PathBuf::from("/home/example/.config/se.hugrverk.riggverk/settings.json")
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
            PathBuf::from("/custom/config/se.hugrverk.riggverk/settings.json")
        );
    }

    #[test]
    fn linux_settings_ignore_a_relative_or_unsafe_xdg_override() {
        // A relative value would resolve against the working directory (XDG Base Directory
        // specification: ignore it), the root or a `..` would escape a plain folder.
        for value in ["relative/config", "/", "/custom/../config"] {
            let env = PlatformEnv {
                xdg_config_home: Some(value.into()),
                ..linux_env()
            };
            assert_eq!(
                settings_file_path(&env, Platform::Linux).expect("settings"),
                PathBuf::from("/home/example/.config/se.hugrverk.riggverk/settings.json"),
                "{value}"
            );
        }
    }

    #[test]
    fn backup_root_aligns_with_app_support() {
        let env = mac_env();
        assert_eq!(
            backup_root_path(&env, Platform::MacOS).expect("backups"),
            PathBuf::from(
                "/Users/example/Library/Application Support/se.hugrverk.riggverk/backups"
            )
        );
    }

    #[test]
    fn legacy_app_support_dir_differs_only_in_the_last_component() {
        let custom_xdg = PlatformEnv {
            xdg_config_home: Some("/custom/config".into()),
            ..linux_env()
        };
        let cases = [
            (
                Platform::MacOS,
                mac_env(),
                "/Users/example/Library/Application Support",
            ),
            (Platform::Linux, linux_env(), "/home/example/.config"),
            (Platform::Linux, custom_xdg, "/custom/config"),
        ];
        for (platform, env, parent) in cases {
            assert_eq!(
                legacy_app_support_dir(&env, platform).expect("legacy"),
                PathBuf::from(parent).join("ai.agentworkspace.app"),
                "{platform:?}"
            );
            assert_eq!(
                app_support_dir(&env, platform).expect("current"),
                PathBuf::from(parent).join("se.hugrverk.riggverk"),
                "{platform:?}"
            );
        }
        let env = win_env();
        assert_eq!(
            legacy_app_support_dir(&env, Platform::Windows).expect("legacy"),
            PathBuf::from(r"C:\Users\Example\AppData\Roaming").join("ai.agentworkspace.app")
        );
        assert_eq!(
            legacy_app_support_dir(
                &PlatformEnv {
                    appdata: None,
                    ..win_env()
                },
                Platform::Windows
            )
            .expect_err("missing APPDATA"),
            "APPDATA is not set"
        );
    }

    #[test]
    fn default_workspace_under_home_config() {
        let env = win_env();
        assert_eq!(
            default_installed_workspace_path(&env, Platform::Windows).expect("workspace"),
            PathBuf::from(r"C:\Users\Example")
                .join(".config")
                .join("riggverk")
        );
        assert_eq!(
            legacy_default_installed_workspace_path(&env, Platform::Windows).expect("legacy"),
            PathBuf::from(r"C:\Users\Example")
                .join(".config")
                .join(LEGACY_WORKSPACE_DIR_NAME)
        );
    }

    #[test]
    fn the_opencode_config_folder_follows_an_absolute_xdg_config_home_only() {
        // Absolute on every OS, so the same cases hold on Windows.
        let root = std::env::temp_dir().join("aw-opencode-config-dir");
        let home = root.join("home");
        let default = home.join(".config").join("opencode");
        let text = |path: &Path| path.to_string_lossy().into_owned();
        let parent_dir = text(&home.join("..").join("other"));
        // Unset, empty, blank, relative, the file system root or a `..` path: the default.
        for ignored in [
            None,
            Some(""),
            Some("   "),
            Some("relative/config"),
            Some("./config"),
            Some("/"),
            Some(parent_dir.as_str()),
        ] {
            assert_eq!(
                opencode_config_dir_for(&home, ignored),
                default,
                "{ignored:?}"
            );
            assert!(!opencode_config_moved_for(&home, ignored), "{ignored:?}");
            assert_eq!(xdg_config_home_dir(ignored), None, "{ignored:?}");
        }
        // An absolute value wins, outside or inside the home folder, trimmed like the app's own
        // config folder.
        let outside = root.join("custom");
        let inside = home.join("dotfiles");
        for (value, expected) in [
            (text(&outside), outside.join("opencode")),
            (format!(" {} ", text(&outside)), outside.join("opencode")),
            (text(&inside), inside.join("opencode")),
        ] {
            assert_eq!(
                opencode_config_dir_for(&home, Some(&value)),
                expected,
                "{value:?}"
            );
            assert!(opencode_config_moved_for(&home, Some(&value)), "{value:?}");
        }
        // Pointing at the default folder is no move.
        let dot_config = text(&home.join(".config"));
        assert_eq!(opencode_config_dir_for(&home, Some(&dot_config)), default);
        assert!(!opencode_config_moved_for(&home, Some(&dot_config)));
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
        let backup = home.join("Library/Application Support/se.hugrverk.riggverk/backups");
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
