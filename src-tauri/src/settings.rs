use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static SETTINGS_WRITE_MUTEX: Mutex<()> = Mutex::new(());

use super::agent_targets;
use crate::path_utils::{
    is_legacy_default_workspace_path, normalize_user_workspace_path,
    normalize_user_workspace_path_for_save,
};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RepoDashboardEntry {
    pub id: String,
    pub label: String,
    pub path: String,
    #[serde(default)]
    pub default_branch: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppSettings {
    pub appearance: String,
    #[serde(default = "default_app_font_size")]
    pub app_font_size: String,
    pub workspace_path: Option<String>,
    #[serde(default = "agent_targets::default_enabled_ids")]
    pub enabled_target_ids: Vec<String>,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub background_color: Option<String>,
    #[serde(default)]
    pub foreground_color: Option<String>,
    #[serde(default)]
    pub repo_dashboard_entries: Vec<RepoDashboardEntry>,
    #[serde(default)]
    pub active_repo_dashboard_id: Option<String>,
    #[serde(default)]
    pub revision: u64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: "dark".into(),
            app_font_size: default_app_font_size(),
            workspace_path: None,
            enabled_target_ids: agent_targets::default_enabled_ids(),
            accent_color: None,
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            revision: 0,
        }
    }
}

pub const SETTINGS_CONFLICT_ERROR: &str = "settings conflict";
pub const SETTINGS_CORRUPT_RECOVERY_MESSAGE: &str =
    "settings file was corrupt and moved to a local backup; using defaults";

#[derive(Serialize, Clone, Debug)]
pub struct GetSettingsResponse {
    pub settings: AppSettings,
    pub load_warning: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MutationOutcome {
    Unchanged,
    Changed,
}

struct DiskLoad {
    settings: AppSettings,
    warning: Option<String>,
}

fn default_app_font_size() -> String {
    "medium".into()
}

fn normalize_app_font_size(value: &str) -> String {
    match value {
        "small" | "medium" | "large" | "extra-large" => value.to_string(),
        _ => default_app_font_size(),
    }
}

fn validate_hex_color(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let hex = if !trimmed.starts_with('#') {
        return None;
    } else {
        &trimmed[1..]
    };
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", hex.to_lowercase()))
}

fn normalize(settings: &mut AppSettings) {
    match settings.appearance.as_str() {
        "dark" | "light" | "system" => {}
        _ => settings.appearance = "dark".into(),
    }
    settings.app_font_size = normalize_app_font_size(&settings.app_font_size);

    if let Some(ref val) = settings.workspace_path {
        if is_legacy_default_workspace_path(val) {
            settings.workspace_path = None;
        } else {
            settings.workspace_path = normalize_user_workspace_path(val);
        }
    }

    settings.enabled_target_ids =
        agent_targets::normalize_enabled_ids(&settings.enabled_target_ids);

    settings.accent_color = settings
        .accent_color
        .as_deref()
        .and_then(validate_hex_color);
    settings.background_color = settings
        .background_color
        .as_deref()
        .and_then(validate_hex_color);
    settings.foreground_color = settings
        .foreground_color
        .as_deref()
        .and_then(validate_hex_color);

    for entry in &mut settings.repo_dashboard_entries {
        normalize_loaded_repo_dashboard_entry(entry);
    }
    settings.active_repo_dashboard_id = settings
        .active_repo_dashboard_id
        .as_ref()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
}

fn normalize_for_save(settings: &mut AppSettings) -> Result<(), String> {
    match settings.appearance.as_str() {
        "dark" | "light" | "system" => {}
        _ => settings.appearance = "dark".into(),
    }
    settings.app_font_size = normalize_app_font_size(&settings.app_font_size);

    if let Some(ref val) = settings.workspace_path {
        if is_legacy_default_workspace_path(val) {
            settings.workspace_path = None;
        } else {
            settings.workspace_path = normalize_user_workspace_path_for_save(val)?;
        }
    }

    settings.enabled_target_ids =
        agent_targets::normalize_enabled_ids(&settings.enabled_target_ids);

    settings.accent_color = settings
        .accent_color
        .as_deref()
        .and_then(validate_hex_color);
    settings.background_color = settings
        .background_color
        .as_deref()
        .and_then(validate_hex_color);
    settings.foreground_color = settings
        .foreground_color
        .as_deref()
        .and_then(validate_hex_color);

    normalize_repo_dashboard_entries(&mut settings.repo_dashboard_entries)?;

    settings.active_repo_dashboard_id = settings
        .active_repo_dashboard_id
        .as_ref()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());

    Ok(())
}

fn settings_file() -> Result<PathBuf, String> {
    crate::platform_paths::settings_file_path(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
}

fn backup_corrupt_settings_file(path: &PathBuf) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let backup_path = path.with_extension(format!("json.corrupt.{nanos}.bak"));
    fs::rename(path, &backup_path).map_err(|e| format!("recover corrupt settings: {e}"))?;
    Ok(())
}

fn read_settings_from_path(path: &PathBuf, recover_corrupt: bool) -> Result<DiskLoad, String> {
    let json = match fs::read_to_string(path) {
        Ok(json) => json,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DiskLoad {
                settings: AppSettings::default(),
                warning: None,
            });
        }
        Err(error) => return Err(format!("read settings: {error}")),
    };

    match serde_json::from_str::<AppSettings>(&json) {
        Ok(mut settings) => {
            normalize(&mut settings);
            Ok(DiskLoad {
                settings,
                warning: None,
            })
        }
        Err(_) if recover_corrupt => {
            backup_corrupt_settings_file(path)?;
            Ok(DiskLoad {
                settings: AppSettings::default(),
                warning: Some(SETTINGS_CORRUPT_RECOVERY_MESSAGE.to_string()),
            })
        }
        Err(_) => Ok(DiskLoad {
            settings: AppSettings::default(),
            warning: None,
        }),
    }
}

fn disk_load_under_write_lock(recover_corrupt: bool) -> Result<DiskLoad, String> {
    let path = settings_file()?;
    read_settings_from_path(&path, recover_corrupt)
}

/// Read settings for action/status callers without recovery side effects or load warnings.
pub fn load() -> AppSettings {
    let path = match settings_file() {
        Ok(path) => path,
        Err(_) => return AppSettings::default(),
    };
    read_settings_from_path(&path, false)
        .map(|loaded| loaded.settings)
        .unwrap_or_default()
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn get_settings_snapshot() -> Result<GetSettingsResponse, String> {
    get_settings_snapshot_with_mutate(|_| Ok(MutationOutcome::Unchanged))
}

pub fn get_settings_snapshot_with_mutate<F>(mutator: F) -> Result<GetSettingsResponse, String>
where
    F: FnOnce(&mut AppSettings) -> Result<MutationOutcome, String>,
{
    let _guard = SETTINGS_WRITE_MUTEX
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?;
    let DiskLoad {
        mut settings,
        warning,
    } = disk_load_under_write_lock(true)?;
    let loaded_revision = settings.revision;
    let outcome = mutator(&mut settings)?;
    let settings = match outcome {
        MutationOutcome::Unchanged => settings,
        MutationOutcome::Changed => {
            settings.revision = loaded_revision.saturating_add(1);
            save_inner(&mut settings)?
        }
    };
    Ok(GetSettingsResponse {
        settings,
        load_warning: warning,
    })
}

fn mutate_settings_locked<F>(mutator: F) -> Result<AppSettings, String>
where
    F: FnOnce(&mut AppSettings) -> Result<MutationOutcome, String>,
{
    let DiskLoad {
        mut settings,
        warning: _,
    } = disk_load_under_write_lock(true)?;
    let loaded_revision = settings.revision;
    let outcome = mutator(&mut settings)?;
    match outcome {
        MutationOutcome::Unchanged => Ok(settings),
        MutationOutcome::Changed => {
            settings.revision = loaded_revision.saturating_add(1);
            save_inner(&mut settings)
        }
    }
}

pub fn mutate_settings<F>(mutator: F) -> Result<AppSettings, String>
where
    F: FnOnce(&mut AppSettings) -> Result<MutationOutcome, String>,
{
    let _guard = SETTINGS_WRITE_MUTEX
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?;
    mutate_settings_locked(mutator)
}

#[allow(dead_code)]
pub fn save(settings: AppSettings) -> Result<AppSettings, String> {
    let _guard = SETTINGS_WRITE_MUTEX
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?;
    let incoming = settings;
    mutate_settings_locked(|current| {
        *current = incoming;
        Ok(MutationOutcome::Changed)
    })
}

pub fn save_with_revision_check(
    settings: AppSettings,
    expected_revision: Option<u64>,
) -> Result<AppSettings, String> {
    let _guard = SETTINGS_WRITE_MUTEX
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?;
    let incoming = settings;
    mutate_settings_locked(|current| {
        if let Some(expected) = expected_revision {
            if current.revision != expected {
                return Err(SETTINGS_CONFLICT_ERROR.to_string());
            }
        }
        *current = incoming;
        Ok(MutationOutcome::Changed)
    })
}

fn save_inner(settings: &mut AppSettings) -> Result<AppSettings, String> {
    normalize_for_save(settings)?;

    let path = settings_file()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create settings dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| format!("serialize: {}", e))?;
    let temp_path = path.with_extension("json.tmp");
    {
        let mut file =
            File::create(&temp_path).map_err(|e| format!("write settings temp: {}", e))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("write settings temp: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("sync settings temp: {}", e))?;
    }
    fs::rename(&temp_path, &path).map_err(|e| format!("write settings: {}", e))?;
    Ok(settings.clone())
}

fn normalize_loaded_repo_dashboard_entry(entry: &mut RepoDashboardEntry) {
    if entry.label.trim().is_empty() {
        entry.label = "Repository".into();
    }
    if let Some(path) = normalize_user_workspace_path(&entry.path) {
        entry.path = path;
    }
    entry.default_branch = entry
        .default_branch
        .as_ref()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
}

fn normalize_repo_dashboard_entries(entries: &mut [RepoDashboardEntry]) -> Result<(), String> {
    for entry in entries.iter_mut() {
        entry.label = entry.label.trim().to_string();
        if entry.label.is_empty() {
            entry.label = "Repository".into();
        }
        entry.id = entry.id.trim().to_string();
        if entry.id.is_empty() {
            return Err("repo dashboard entry id cannot be empty".into());
        }
        entry.path = normalize_user_workspace_path_for_save(&entry.path)?
            .ok_or_else(|| format!("repo dashboard path is required for {}", entry.id))?;
        entry.default_branch = entry
            .default_branch
            .as_ref()
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        get_settings_snapshot, get_settings_snapshot_with_mutate, load, mutate_settings, normalize,
        normalize_for_save, save, save_with_revision_check, validate_hex_color, AppSettings,
        MutationOutcome, SETTINGS_CONFLICT_ERROR, SETTINGS_CORRUPT_RECOVERY_MESSAGE,
    };
    use crate::path_utils::is_legacy_default_workspace_path;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    fn settings_with_path(path: Option<&str>) -> AppSettings {
        AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: path.map(|s| s.to_string()),
            enabled_target_ids: vec![],
            accent_color: None,
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            revision: 0,
        }
    }

    #[test]
    fn saved_workspace_path_expands_tilde_home() {
        let home = crate::test_env::process_home()
            .to_string_lossy()
            .into_owned();
        let mut settings = settings_with_path(Some("~"));

        normalize_for_save(&mut settings).expect("save normalization should succeed");

        assert_eq!(settings.workspace_path, Some(home));
    }

    #[test]
    fn saved_workspace_path_expands_tilde_child() {
        let home = crate::test_env::process_home();
        let expected = home.join("Desktop/test").to_string_lossy().into_owned();
        let mut settings = settings_with_path(Some("~/Desktop/test"));

        normalize_for_save(&mut settings).expect("save normalization should succeed");

        assert_eq!(settings.workspace_path, Some(expected));
    }

    #[test]
    fn saved_workspace_path_accepts_trimmed_absolute_path() {
        let workspace = std::env::temp_dir().join("workspace");
        let workspace_str = workspace.to_string_lossy().into_owned();
        let workspace_input = format!("  {workspace_str}  ");
        let mut settings = settings_with_path(Some(&workspace_input));

        normalize_for_save(&mut settings).expect("save normalization should succeed");

        assert_eq!(settings.workspace_path, Some(workspace_str));
    }

    #[test]
    fn saved_empty_workspace_path_becomes_none() {
        let mut settings = settings_with_path(Some(" \n\t "));

        normalize_for_save(&mut settings).expect("save normalization should succeed");

        assert_eq!(settings.workspace_path, None);
    }

    #[test]
    fn saved_workspace_path_rejects_relative_paths() {
        for path in ["workspace/local", "./workspace", "../workspace"] {
            let mut settings = settings_with_path(Some(path));

            let result = normalize_for_save(&mut settings);

            assert!(result.is_err(), "expected {path:?} to be rejected");
            assert_eq!(
                result.unwrap_err(),
                "workspace path must be absolute or start with ~/"
            );
        }
    }

    #[test]
    fn loaded_legacy_agent_workspace_default_becomes_none() {
        let mut settings = settings_with_path(Some("~/Agent Workspace"));
        normalize(&mut settings);
        assert_eq!(settings.workspace_path, None);
        assert!(is_legacy_default_workspace_path("~/Agent Workspace"));
    }

    #[test]
    fn loaded_legacy_relative_workspace_path_becomes_none() {
        let mut settings = settings_with_path(Some("workspace/local"));

        normalize(&mut settings);

        assert_eq!(settings.workspace_path, None);
    }

    #[test]
    fn loaded_stale_enabled_target_ids_drop_unknown_values() {
        let mut settings = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: None,
            enabled_target_ids: vec![
                "codex_rules".into(),
                "legacy_removed_rules".into(),
                "opencode_config".into(),
                "unknown".into(),
            ],
            accent_color: None,
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            revision: 0,
        };

        normalize(&mut settings);

        assert_eq!(
            settings.enabled_target_ids,
            vec!["codex_rules".to_string(), "opencode_config".to_string()]
        );
    }

    #[test]
    fn app_font_size_defaults_to_medium() {
        assert_eq!(AppSettings::default().app_font_size, "medium");
    }

    #[test]
    fn app_font_size_accepts_constrained_values() {
        for value in ["small", "medium", "large", "extra-large"] {
            let mut settings = settings_with_path(None);
            settings.app_font_size = value.into();

            normalize(&mut settings);

            assert_eq!(settings.app_font_size, value);
        }
    }

    #[test]
    fn app_font_size_invalid_becomes_medium() {
        let mut settings = settings_with_path(None);
        settings.app_font_size = "huge".into();

        normalize(&mut settings);

        assert_eq!(settings.app_font_size, "medium");
    }

    // ── accent_color tests ──

    #[test]
    fn accent_color_accepts_valid_hex() {
        assert_eq!(validate_hex_color("#ff00aa"), Some("#ff00aa".into()));
    }

    #[test]
    fn accent_color_normalizes_uppercase() {
        assert_eq!(validate_hex_color("#FF00AA"), Some("#ff00aa".into()));
    }

    #[test]
    fn accent_color_rejects_missing_hash() {
        assert_eq!(validate_hex_color("ff00aa"), None);
    }

    #[test]
    fn accent_color_rejects_invalid_hex() {
        assert_eq!(validate_hex_color("#xyzxyz"), None);
    }

    #[test]
    fn accent_color_rejects_three_digit_hex() {
        assert_eq!(validate_hex_color("#fff"), None);
    }

    #[test]
    fn accent_color_empty_string_is_none() {
        assert_eq!(validate_hex_color(""), None);
    }

    #[test]
    fn accent_color_whitespace_only_is_none() {
        assert_eq!(validate_hex_color("   "), None);
    }

    #[test]
    fn accent_color_normalized_in_settings() {
        let mut s = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: None,
            enabled_target_ids: vec![],
            accent_color: Some("#FFAA00".into()),
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            revision: 0,
        };
        normalize(&mut s);
        assert_eq!(s.accent_color, Some("#ffaa00".into()));
    }

    #[test]
    fn accent_color_invalid_becomes_none_in_settings() {
        let mut s = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: None,
            enabled_target_ids: vec![],
            accent_color: Some("bad".into()),
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            revision: 0,
        };
        normalize(&mut s);
        assert_eq!(s.accent_color, None);
    }

    fn with_temp_home<F: FnOnce(&PathBuf)>(test: F) {
        let _guard = crate::test_env::guard::lock();
        let dir = std::env::temp_dir().join(format!(
            "aw-settings-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp home");
        let _restore = crate::test_env::guard::EnvRestore::capture();
        crate::test_env::set_test_user_dirs(&dir);
        test(&dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_with_revision_check_rejects_stale_revision() {
        with_temp_home(|_| {
            let first = save(AppSettings::default()).expect("initial save");
            assert_eq!(first.revision, 1);

            let mut stale = first.clone();
            stale.appearance = "light".into();
            let err = save_with_revision_check(stale, Some(0)).expect_err("stale revision");
            assert_eq!(err, SETTINGS_CONFLICT_ERROR);
        });
    }

    fn settings_path_for_home(dir: &std::path::Path) -> PathBuf {
        let home_str = dir.to_string_lossy().into_owned();
        let env = if cfg!(windows) {
            crate::platform_paths::PlatformEnv {
                home: None,
                userprofile: Some(home_str),
                appdata: Some(
                    dir.join("AppData")
                        .join("Roaming")
                        .to_string_lossy()
                        .into_owned(),
                ),
                local_appdata: Some(
                    dir.join("AppData")
                        .join("Local")
                        .to_string_lossy()
                        .into_owned(),
                ),
                ..crate::platform_paths::PlatformEnv::default()
            }
        } else {
            crate::platform_paths::PlatformEnv {
                home: Some(home_str),
                ..crate::platform_paths::PlatformEnv::default()
            }
        };
        crate::platform_paths::settings_file_path(&env, crate::platform_paths::Platform::current())
            .expect("settings path")
    }

    fn write_settings_file(dir: &std::path::Path, json: &str) {
        let path = settings_path_for_home(dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create settings parent");
        }
        fs::write(path, json).expect("write settings");
    }

    #[test]
    fn missing_settings_file_returns_defaults() {
        with_temp_home(|_| {
            let snapshot = get_settings_snapshot().expect("snapshot");
            assert_eq!(snapshot.settings, AppSettings::default());
            assert!(snapshot.load_warning.is_none());
        });
    }

    #[test]
    fn malformed_settings_file_recovers_without_looping() {
        with_temp_home(|dir| {
            write_settings_file(dir, "{not-json");
            let first = get_settings_snapshot().expect("first load");
            assert_eq!(first.settings, AppSettings::default());
            assert_eq!(
                first.load_warning.as_deref(),
                Some(SETTINGS_CORRUPT_RECOVERY_MESSAGE)
            );

            let second = get_settings_snapshot().expect("second load");
            assert_eq!(second.settings, AppSettings::default());
            assert!(second.load_warning.is_none());
        });
    }

    #[test]
    fn mutate_settings_increments_revision_from_locked_load() {
        with_temp_home(|_| {
            let first = save(AppSettings::default()).expect("initial save");
            assert_eq!(first.revision, 1);

            let second = mutate_settings(|settings| {
                settings.appearance = "light".into();
                Ok(MutationOutcome::Changed)
            })
            .expect("mutate");
            assert_eq!(second.revision, 2);
            assert_eq!(second.appearance, "light");
        });
    }

    #[test]
    fn save_with_revision_check_preserves_unrelated_fields_under_lock() {
        with_temp_home(|_| {
            let saved = save(AppSettings {
                enabled_target_ids: vec!["codex_rules".into(), "opencode_config".into()],
                ..AppSettings::default()
            })
            .expect("save");
            assert_eq!(saved.revision, 1);

            let mut stale = saved.clone();
            stale.appearance = "light".into();
            let err = save_with_revision_check(stale, Some(0)).expect_err("stale revision");
            assert_eq!(err, SETTINGS_CONFLICT_ERROR);

            let latest = get_settings_snapshot().expect("reload").settings;
            assert_eq!(latest.appearance, "dark");
            assert_eq!(latest.enabled_target_ids.len(), 2);
        });
    }

    #[test]
    fn workspace_path_mutation_rejects_stale_revision() {
        with_temp_home(|_| {
            let first = save(AppSettings::default()).expect("first save");
            let _second = save({
                let mut next = first.clone();
                next.appearance = "light".into();
                next
            })
            .expect("second save");

            let mut stale_workspace = first.clone();
            stale_workspace.workspace_path = Some(
                std::env::temp_dir()
                    .join("workspace")
                    .to_string_lossy()
                    .into_owned(),
            );
            let err = save_with_revision_check(stale_workspace, Some(first.revision))
                .expect_err("stale workspace write");
            assert_eq!(err, SETTINGS_CONFLICT_ERROR);
        });
    }

    #[test]
    fn save_writes_valid_json_atomically() {
        with_temp_home(|dir| {
            let saved = save(AppSettings::default()).expect("save");
            assert_eq!(saved.revision, 1);

            let path = settings_path_for_home(dir);
            assert!(path.is_file());
            assert!(!path.with_extension("json.tmp").exists());

            let reloaded: AppSettings =
                serde_json::from_str(&fs::read_to_string(&path).expect("read")).expect("parse");
            assert_eq!(reloaded.revision, 1);
        });
    }

    #[test]
    fn load_does_not_recover_corrupt_settings_or_consume_warning() {
        with_temp_home(|dir| {
            write_settings_file(dir, "{not-json");

            let loaded = load();
            assert_eq!(loaded, AppSettings::default());

            let settings_path = settings_path_for_home(dir);
            assert!(
                settings_path.is_file(),
                "read-only load must not rename corrupt file"
            );

            let snapshot = get_settings_snapshot().expect("snapshot");
            assert_eq!(snapshot.settings, AppSettings::default());
            assert_eq!(
                snapshot.load_warning.as_deref(),
                Some(SETTINGS_CORRUPT_RECOVERY_MESSAGE)
            );
        });
    }

    #[test]
    fn concurrent_recovery_and_update_preserves_valid_write() {
        with_temp_home(|dir| {
            write_settings_file(dir, "{not-json");

            let barrier = Arc::new(Barrier::new(2));
            let barrier_reader = Arc::clone(&barrier);
            let barrier_writer = Arc::clone(&barrier);

            let reader = thread::spawn(move || {
                barrier_reader.wait();
                get_settings_snapshot().expect("recovery snapshot")
            });

            let writer = thread::spawn(move || {
                barrier_writer.wait();
                thread::sleep(Duration::from_millis(5));
                save(AppSettings {
                    appearance: "light".into(),
                    ..AppSettings::default()
                })
                .expect("valid update")
            });

            let snapshot = reader.join().expect("reader join");
            let saved = writer.join().expect("writer join");

            let latest = get_settings_snapshot().expect("final snapshot").settings;
            assert_eq!(latest.appearance, saved.appearance);
            assert_eq!(latest.revision, saved.revision);
            assert!(
                snapshot.load_warning.is_some() || latest.appearance == "light",
                "recovery warning or valid write must be visible"
            );
        });
    }

    #[test]
    fn recovery_warning_is_returned_exactly_once() {
        with_temp_home(|dir| {
            write_settings_file(dir, "{not-json");

            let first = get_settings_snapshot().expect("first snapshot");
            assert_eq!(
                first.load_warning.as_deref(),
                Some(SETTINGS_CORRUPT_RECOVERY_MESSAGE)
            );

            let second = get_settings_snapshot().expect("second snapshot");
            assert!(second.load_warning.is_none());
        });
    }

    #[test]
    fn stale_workspace_scrub_preserves_unrelated_settings() {
        with_temp_home(|_| {
            let saved = save(AppSettings {
                appearance: "light".into(),
                enabled_target_ids: vec!["codex_rules".into(), "opencode_config".into()],
                workspace_path: Some(
                    std::env::temp_dir()
                        .join("agent-workspace-scrub-missing")
                        .to_string_lossy()
                        .into_owned(),
                ),
                ..AppSettings::default()
            })
            .expect("seed save");

            let snapshot = get_settings_snapshot_with_mutate(|current| {
                if current.workspace_path.take().is_some() {
                    Ok(MutationOutcome::Changed)
                } else {
                    Ok(MutationOutcome::Unchanged)
                }
            })
            .expect("scrub snapshot");

            assert_eq!(snapshot.settings.appearance, saved.appearance);
            assert_eq!(
                snapshot.settings.enabled_target_ids,
                saved.enabled_target_ids
            );
            assert_eq!(snapshot.settings.workspace_path, None);
            assert!(snapshot.load_warning.is_none());
            assert_eq!(snapshot.settings.revision, saved.revision.saturating_add(1));
        });
    }
}
