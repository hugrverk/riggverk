use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static SETTINGS_WRITE_MUTEX: Mutex<()> = Mutex::new(());

use super::agent_targets::{self, HarnessId};
use crate::path_utils::{
    is_legacy_default_workspace_path, normalize_user_workspace_path,
    normalize_user_workspace_path_for_save,
};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppSettings {
    pub appearance: String,
    #[serde(default = "default_app_font_size")]
    pub app_font_size: String,
    pub workspace_path: Option<String>,
    #[serde(default = "agent_targets::default_enabled_ids")]
    pub enabled_target_ids: Vec<String>,
    #[serde(
        default = "agent_targets::default_enabled_harness_ids",
        deserialize_with = "deserialize_harness_ids"
    )]
    pub enabled_harness_ids: Vec<HarnessId>,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub background_color: Option<String>,
    #[serde(default)]
    pub foreground_color: Option<String>,
    /// Motion level: "full", "subtle" or "off". Empty means the file predates
    /// the field and is derived from `reduce_motion` by `normalize_motion`.
    #[serde(default)]
    pub motion: String,
    /// Legacy flag, kept in step with `motion` (`true` exactly when motion is
    /// "off") so a downgrade to a build that only knows it keeps the choice.
    #[serde(default)]
    pub reduce_motion: bool,
    #[serde(default = "default_landing_view")]
    pub landing_view: String,
    #[serde(default)]
    pub revision: u64,
    /// Marker for the enabled-target defaults this file was written under.
    /// Files without it predate target gating and are migrated on load.
    #[serde(default)]
    pub target_defaults_version: u32,
}

/// Bump when the default set of enabled targets changes in a way that existing
/// settings files must be migrated for.
pub const TARGET_DEFAULTS_VERSION: u32 = 1;

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: "dark".into(),
            app_font_size: default_app_font_size(),
            workspace_path: None,
            enabled_target_ids: agent_targets::default_enabled_ids(),
            enabled_harness_ids: agent_targets::default_enabled_harness_ids(),
            accent_color: None,
            background_color: None,
            foreground_color: None,
            motion: default_motion(),
            reduce_motion: false,
            landing_view: default_landing_view(),
            revision: 0,
            target_defaults_version: TARGET_DEFAULTS_VERSION,
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
    /// The file predates the current target defaults and was migrated in memory.
    migrated: bool,
}

fn default_app_font_size() -> String {
    "medium".into()
}

fn default_landing_view() -> String {
    "start".into()
}

fn default_motion() -> String {
    "full".into()
}

fn deserialize_harness_ids<'de, D>(deserializer: D) -> Result<Vec<HarnessId>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Vec::<String>::deserialize(deserializer)?;
    Ok(HarnessId::ALL
        .iter()
        .copied()
        .filter(|harness| raw.iter().any(|value| value == harness.as_str()))
        .collect())
}

fn normalize_app_font_size(value: &str) -> String {
    match value {
        "small" | "medium" | "large" | "extra-large" => value.to_string(),
        _ => default_app_font_size(),
    }
}

/// Validate `motion`; a missing value comes from the legacy `reduce_motion`
/// flag (`true` is "off"), an unknown one falls back to "full". Keeps
/// `reduce_motion` in step with the result.
fn normalize_motion(settings: &mut AppSettings) {
    settings.motion = match settings.motion.as_str() {
        "full" | "subtle" | "off" => settings.motion.clone(),
        "" if settings.reduce_motion => "off".into(),
        _ => default_motion(),
    };
    settings.reduce_motion = settings.motion == "off";
}

fn normalize_landing_view(value: &str) -> String {
    match value {
        "start" | "library" => value.to_string(),
        _ => default_landing_view(),
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
    settings.landing_view = normalize_landing_view(&settings.landing_view);
    normalize_motion(settings);

    if let Some(ref val) = settings.workspace_path {
        if is_legacy_default_workspace_path(val) {
            settings.workspace_path = None;
        } else {
            settings.workspace_path = normalize_user_workspace_path(val);
        }
    }

    settings.enabled_target_ids =
        agent_targets::normalize_enabled_ids(&settings.enabled_target_ids);
    settings.enabled_harness_ids =
        agent_targets::normalize_enabled_harness_ids(&settings.enabled_harness_ids);

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
}

fn normalize_for_save(settings: &mut AppSettings) -> Result<(), String> {
    match settings.appearance.as_str() {
        "dark" | "light" | "system" => {}
        _ => settings.appearance = "dark".into(),
    }
    settings.app_font_size = normalize_app_font_size(&settings.app_font_size);
    settings.landing_view = normalize_landing_view(&settings.landing_view);
    normalize_motion(settings);

    if let Some(ref val) = settings.workspace_path {
        if is_legacy_default_workspace_path(val) {
            settings.workspace_path = None;
        } else {
            settings.workspace_path = normalize_user_workspace_path_for_save(val)?;
        }
    }

    settings.enabled_target_ids =
        agent_targets::normalize_enabled_ids(&settings.enabled_target_ids);
    settings.enabled_harness_ids =
        agent_targets::normalize_enabled_harness_ids(&settings.enabled_harness_ids);

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

    // Anything written by this build carries the current target defaults, even
    // when the caller (e.g. the UI) round-tripped an older object without the marker.
    settings.target_defaults_version = TARGET_DEFAULTS_VERSION;

    Ok(())
}

/// Targets whose surfaces already hold managed records in the workspace's managed state.
fn managed_target_ids(settings: &AppSettings) -> Vec<String> {
    let Some(workspace_root) = crate::commands::configured_workspace_path(settings) else {
        return Vec::new();
    };
    let Some(state) = crate::managed_state::read_managed_state(&workspace_root) else {
        return Vec::new();
    };
    state
        .artifacts
        .iter()
        .filter_map(|record| {
            record
                .surface
                .as_deref()
                .and_then(|surface| {
                    serde_json::from_value::<crate::setup_lifecycle::SetupSurfaceId>(
                        serde_json::Value::String(surface.to_string()),
                    )
                    .ok()
                })
                .or_else(|| {
                    serde_json::from_str::<crate::artifact_registry::ArtifactId>(&record.identity)
                        .ok()
                        .map(|artifact| artifact.surface())
                })
        })
        .filter_map(agent_targets::surface_target_id)
        .map(str::to_string)
        .collect()
}

/// Settings written before target toggles gated Install: Install wrote every
/// surface of an enabled harness regardless of `enabled_target_ids`. Move such
/// files to the current defaults, and keep every target the user had enabled or
/// whose surface already holds managed records so nothing is silently dropped.
fn migrate_target_defaults(settings: &mut AppSettings) -> bool {
    if settings.target_defaults_version >= TARGET_DEFAULTS_VERSION {
        return false;
    }
    let mut ids = agent_targets::default_enabled_ids();
    ids.extend(settings.enabled_target_ids.iter().cloned());
    ids.extend(managed_target_ids(settings));
    settings.enabled_target_ids = agent_targets::normalize_enabled_ids(&ids);
    settings.target_defaults_version = TARGET_DEFAULTS_VERSION;
    true
}

pub fn harness_enabled(settings: &AppSettings, harness: HarnessId) -> bool {
    settings.enabled_harness_ids.contains(&harness)
}

pub fn effective_enabled_target_ids(settings: &AppSettings) -> Vec<String> {
    settings
        .enabled_target_ids
        .iter()
        .filter(|id| {
            agent_targets::target_harness(id)
                .is_some_and(|harness| harness_enabled(settings, harness))
        })
        .cloned()
        .collect()
}

/// A surface may be installed when its harness is enabled and, for
/// target-gated surfaces, its target toggle is on.
pub fn surface_enabled(
    settings: &AppSettings,
    surface: crate::setup_lifecycle::SetupSurfaceId,
) -> bool {
    surface
        .harness()
        .is_none_or(|harness| harness_enabled(settings, harness))
        && agent_targets::surface_target_id(surface).is_none_or(|target_id| {
            settings
                .enabled_target_ids
                .iter()
                .any(|enabled| enabled == target_id)
        })
}

pub fn enabled_setup_surfaces(
    settings: &AppSettings,
) -> Vec<crate::setup_lifecycle::SetupSurfaceId> {
    crate::setup_lifecycle::SetupSurfaceId::ALL
        .iter()
        .copied()
        .filter(|surface| surface_enabled(settings, *surface))
        .collect()
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
                migrated: false,
            });
        }
        Err(error) => return Err(format!("read settings: {error}")),
    };

    match serde_json::from_str::<AppSettings>(&json) {
        Ok(mut settings) => {
            normalize(&mut settings);
            let migrated = migrate_target_defaults(&mut settings);
            Ok(DiskLoad {
                settings,
                warning: None,
                migrated,
            })
        }
        Err(_) if recover_corrupt => {
            backup_corrupt_settings_file(path)?;
            Ok(DiskLoad {
                settings: AppSettings::default(),
                warning: Some(SETTINGS_CORRUPT_RECOVERY_MESSAGE.to_string()),
                migrated: false,
            })
        }
        Err(_) => Ok(DiskLoad {
            settings: AppSettings::default(),
            warning: None,
            migrated: false,
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

/// Read settings for a caller that must not act on guessed values. A missing file is the
/// defaults; a file that cannot be read or parsed is an error instead of the defaults, so
/// "which harnesses are enabled" is never answered from a fallback.
pub fn try_load() -> Result<AppSettings, String> {
    let path = settings_file()?;
    let json = match fs::read_to_string(&path) {
        Ok(json) => json,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AppSettings::default());
        }
        Err(error) => return Err(format!("read settings: {error}")),
    };
    let mut settings = serde_json::from_str::<AppSettings>(&json)
        .map_err(|error| format!("settings file is not valid: {error}"))?;
    normalize(&mut settings);
    migrate_target_defaults(&mut settings);
    Ok(settings)
}

#[cfg(test)]
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
        migrated,
    } = disk_load_under_write_lock(true)?;
    let loaded_revision = settings.revision;
    let outcome = persisted_outcome(mutator(&mut settings)?, migrated);
    let settings = match outcome {
        MutationOutcome::Unchanged => settings,
        MutationOutcome::Changed => {
            settings.revision = loaded_revision.saturating_add(1);
            save_inner(&mut settings)?
        }
    };
    Ok(GetSettingsResponse {
        settings,
        load_warning: warning.or_else(crate::app_data_migration::take_startup_warning),
    })
}

/// A migrated file is persisted even when the caller changed nothing, so the
/// migration runs once and later toggles are not re-derived from managed state.
fn persisted_outcome(outcome: MutationOutcome, migrated: bool) -> MutationOutcome {
    if migrated {
        MutationOutcome::Changed
    } else {
        outcome
    }
}

fn mutate_settings_locked<F>(mutator: F) -> Result<AppSettings, String>
where
    F: FnOnce(&mut AppSettings) -> Result<MutationOutcome, String>,
{
    let DiskLoad {
        mut settings,
        warning: _,
        migrated,
    } = disk_load_under_write_lock(true)?;
    let loaded_revision = settings.revision;
    let outcome = persisted_outcome(mutator(&mut settings)?, migrated);
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

#[cfg(test)]
mod tests {
    use super::{
        effective_enabled_target_ids, enabled_setup_surfaces, get_settings_snapshot,
        get_settings_snapshot_with_mutate, load, mutate_settings, normalize, normalize_for_save,
        save_with_revision_check, validate_hex_color, AppSettings, MutationOutcome,
        SETTINGS_CONFLICT_ERROR, SETTINGS_CORRUPT_RECOVERY_MESSAGE, TARGET_DEFAULTS_VERSION,
    };
    use crate::agent_targets;
    use crate::path_utils::is_legacy_default_workspace_path;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    /// Unconditional write through the production path (no revision check), for building fixtures.
    fn save(settings: AppSettings) -> Result<AppSettings, String> {
        save_with_revision_check(settings, None)
    }

    fn settings_with_path(path: Option<&str>) -> AppSettings {
        AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: path.map(|s| s.to_string()),
            enabled_target_ids: vec![],
            enabled_harness_ids: agent_targets::default_enabled_harness_ids(),
            accent_color: None,
            background_color: None,
            foreground_color: None,
            motion: "full".into(),
            reduce_motion: false,
            landing_view: "start".into(),
            revision: 0,
            target_defaults_version: TARGET_DEFAULTS_VERSION,
        }
    }

    #[test]
    fn saved_workspace_path_expands_tilde_home() {
        let _guard = crate::test_env::guard::lock();
        let home = crate::test_env::process_home()
            .to_string_lossy()
            .into_owned();
        let mut settings = settings_with_path(Some("~"));

        normalize_for_save(&mut settings).expect("save normalization should succeed");

        assert_eq!(settings.workspace_path, Some(home));
    }

    #[test]
    fn saved_workspace_path_expands_tilde_child() {
        let _guard = crate::test_env::guard::lock();
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
            enabled_harness_ids: agent_targets::default_enabled_harness_ids(),
            accent_color: None,
            background_color: None,
            foreground_color: None,
            motion: "full".into(),
            reduce_motion: false,
            landing_view: "start".into(),
            revision: 0,
            target_defaults_version: TARGET_DEFAULTS_VERSION,
        };

        normalize(&mut settings);

        assert_eq!(
            settings.enabled_target_ids,
            vec!["codex_rules".to_string(), "opencode_config".to_string()]
        );
    }

    #[test]
    fn missing_enabled_harness_ids_loads_all_defaults() {
        let json = serde_json::to_value(AppSettings::default()).expect("serialize defaults");
        let mut object = json.as_object().cloned().expect("settings object");
        object.shift_remove("enabled_harness_ids");
        let loaded: AppSettings = serde_json::from_value(serde_json::Value::Object(object))
            .expect("load legacy settings");
        assert_eq!(
            loaded.enabled_harness_ids,
            agent_targets::default_enabled_harness_ids()
        );
    }

    #[test]
    fn enabled_harness_ids_ignore_unknowns_deduplicate_and_keep_canonical_order() {
        let mut json = serde_json::to_value(AppSettings::default()).expect("serialize defaults");
        json["enabled_harness_ids"] = serde_json::json!(["claude", "unknown", "codex", "claude"]);
        let loaded: AppSettings = serde_json::from_value(json).expect("load settings");
        assert_eq!(
            loaded.enabled_harness_ids,
            vec![
                agent_targets::HarnessId::Codex,
                agent_targets::HarnessId::Claude
            ]
        );
    }

    #[test]
    fn empty_enabled_harness_ids_remains_empty_and_preserves_raw_targets() {
        let mut settings = AppSettings {
            enabled_harness_ids: vec![],
            enabled_target_ids: vec!["codex_rules".into(), "opencode_config".into()],
            ..AppSettings::default()
        };
        normalize(&mut settings);
        assert!(settings.enabled_harness_ids.is_empty());
        assert_eq!(
            settings.enabled_target_ids,
            vec!["codex_rules".to_string(), "opencode_config".to_string()]
        );
        assert!(effective_enabled_target_ids(&settings).is_empty());
        // Skills belong to no single harness; with none enabled they are planned as nothing.
        assert_eq!(
            enabled_setup_surfaces(&settings),
            vec![
                crate::setup_lifecycle::SetupSurfaceId::Skills,
                crate::setup_lifecycle::SetupSurfaceId::WorkspaceBundle
            ]
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

    // ── motion tests ──

    fn load_settings_json(json: serde_json::Value) -> AppSettings {
        let mut loaded: AppSettings = serde_json::from_value(json).expect("load settings");
        normalize(&mut loaded);
        loaded
    }

    #[test]
    fn motion_defaults_to_full() {
        let settings = AppSettings::default();
        assert_eq!(settings.motion, "full");
        assert!(!settings.reduce_motion);
    }

    #[test]
    fn legacy_reduce_motion_true_migrates_to_off() {
        let loaded = load_settings_json(serde_json::json!({
            "appearance": "dark",
            "reduce_motion": true
        }));
        assert_eq!(loaded.motion, "off");
        assert!(loaded.reduce_motion);
    }

    #[test]
    fn legacy_reduce_motion_false_or_absent_migrates_to_full() {
        let explicit = load_settings_json(serde_json::json!({
            "appearance": "dark",
            "reduce_motion": false
        }));
        assert_eq!(explicit.motion, "full");
        let absent = load_settings_json(serde_json::json!({ "appearance": "dark" }));
        assert_eq!(absent.motion, "full");
        assert!(!absent.reduce_motion);
    }

    #[test]
    fn motion_accepts_constrained_values_and_wins_over_legacy_flag() {
        for (value, legacy) in [("full", false), ("subtle", false), ("off", true)] {
            let loaded = load_settings_json(serde_json::json!({
                "appearance": "dark",
                "motion": value,
                // A stale legacy flag must not override an explicit motion value.
                "reduce_motion": !legacy
            }));
            assert_eq!(loaded.motion, value);
            assert_eq!(loaded.reduce_motion, legacy);
        }
    }

    #[test]
    fn motion_unknown_value_becomes_full() {
        for value in ["reduced", "FULL", " off", "none"] {
            let mut settings = settings_with_path(None);
            settings.motion = value.into();
            settings.reduce_motion = true;

            normalize(&mut settings);

            assert_eq!(settings.motion, "full", "{value:?}");
            assert!(!settings.reduce_motion);
        }
    }

    #[test]
    fn saved_motion_writes_both_fields() {
        for (value, legacy) in [("full", false), ("subtle", false), ("off", true)] {
            let mut settings = settings_with_path(None);
            settings.motion = value.into();
            settings.reduce_motion = false;

            normalize_for_save(&mut settings).expect("save normalization");

            assert_eq!(settings.motion, value);
            assert_eq!(settings.reduce_motion, legacy);
        }
    }

    #[test]
    fn saved_settings_without_motion_derive_it_from_the_legacy_flag() {
        let mut settings = settings_with_path(None);
        settings.motion = String::new();
        settings.reduce_motion = true;

        normalize_for_save(&mut settings).expect("save normalization");

        assert_eq!(settings.motion, "off");
    }

    #[test]
    fn legacy_settings_file_with_reduce_motion_loads_as_off() {
        with_temp_home(|dir| {
            let mut json = serde_json::to_value(AppSettings::default()).expect("serialize");
            let object = json.as_object_mut().expect("settings object");
            object.remove("motion");
            object.insert("reduce_motion".into(), serde_json::json!(true));
            write_settings_file(dir, &json.to_string());

            let loaded = get_settings_snapshot().expect("snapshot").settings;
            assert_eq!(loaded.motion, "off");

            // The next write persists both fields.
            let saved = save(loaded).expect("save");
            let on_disk: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(settings_path_for_home(dir)).expect("read settings"),
            )
            .expect("parse settings");
            assert_eq!(on_disk["motion"], "off");
            assert_eq!(on_disk["reduce_motion"], true);
            assert_eq!(saved.motion, "off");
        });
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
            enabled_harness_ids: agent_targets::default_enabled_harness_ids(),
            accent_color: Some("#FFAA00".into()),
            background_color: None,
            foreground_color: None,
            motion: "full".into(),
            reduce_motion: false,
            landing_view: "start".into(),
            revision: 0,
            target_defaults_version: TARGET_DEFAULTS_VERSION,
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
            enabled_harness_ids: agent_targets::default_enabled_harness_ids(),
            accent_color: Some("bad".into()),
            background_color: None,
            foreground_color: None,
            motion: "full".into(),
            reduce_motion: false,
            landing_view: "start".into(),
            revision: 0,
            target_defaults_version: TARGET_DEFAULTS_VERSION,
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

    fn surfaces_without(
        excluded: &[crate::setup_lifecycle::SetupSurfaceId],
    ) -> Vec<crate::setup_lifecycle::SetupSurfaceId> {
        crate::setup_lifecycle::SetupSurfaceId::ALL
            .iter()
            .copied()
            .filter(|surface| !excluded.contains(surface))
            .collect()
    }

    #[test]
    fn default_settings_gate_only_the_codex_config_surface() {
        use crate::setup_lifecycle::SetupSurfaceId;
        assert_eq!(
            enabled_setup_surfaces(&AppSettings::default()),
            surfaces_without(&[SetupSurfaceId::CodexConfig])
        );
    }

    #[test]
    fn enabling_codex_config_includes_its_surface() {
        use crate::setup_lifecycle::SetupSurfaceId;
        let mut settings = AppSettings::default();
        settings.enabled_target_ids.push("codex_config".into());
        assert!(enabled_setup_surfaces(&settings).contains(&SetupSurfaceId::CodexConfig));
    }

    #[test]
    fn disabled_target_excludes_only_its_surfaces() {
        use crate::setup_lifecycle::SetupSurfaceId;
        let mut settings = AppSettings::default();
        settings
            .enabled_target_ids
            .retain(|id| id != "claude_agents" && id != "cursor_setup");
        assert_eq!(
            enabled_setup_surfaces(&settings),
            surfaces_without(&[
                SetupSurfaceId::CodexConfig,
                SetupSurfaceId::ClaudeAgents,
                SetupSurfaceId::CursorAgents,
                SetupSurfaceId::CursorMcp,
            ])
        );
    }

    #[test]
    fn target_toggle_does_not_enable_a_disabled_harness_surface() {
        use crate::setup_lifecycle::SetupSurfaceId;
        let mut settings = AppSettings::default();
        settings.enabled_target_ids.push("codex_config".into());
        settings.enabled_harness_ids = vec![agent_targets::HarnessId::Claude];
        let surfaces = enabled_setup_surfaces(&settings);
        assert!(!surfaces.contains(&SetupSurfaceId::CodexConfig));
        assert!(!surfaces.contains(&SetupSurfaceId::CodexRules));
        assert!(surfaces.contains(&SetupSurfaceId::ClaudeRules));
    }

    #[test]
    fn saved_landing_view_is_normalized() {
        let mut settings = settings_with_path(None);
        settings.landing_view = "not-a-view".into();
        normalize_for_save(&mut settings).expect("save normalization");
        assert_eq!(settings.landing_view, "start");

        for view in ["start", "library"] {
            settings.landing_view = view.into();
            normalize_for_save(&mut settings).expect("save normalization");
            assert_eq!(settings.landing_view, view);
        }

        // Views that no longer exist load and save as the workspace view.
        for removed in ["repo-dashboard", "prompts"] {
            settings.landing_view = removed.into();
            normalize_for_save(&mut settings).expect("save normalization");
            assert_eq!(settings.landing_view, "start");
        }
    }

    #[test]
    fn legacy_settings_file_with_repo_dashboard_data_loads_and_drops_it_on_save() {
        with_temp_home(|dir| {
            let mut json = serde_json::to_value(AppSettings::default()).expect("serialize");
            let object = json.as_object_mut().expect("settings object");
            object.insert("landing_view".into(), serde_json::json!("repo-dashboard"));
            object.insert(
                "repo_dashboard_entries".into(),
                serde_json::json!([
                    { "id": "r1", "label": "Repo", "path": "/tmp/repo", "default_branch": "main" }
                ]),
            );
            object.insert("active_repo_dashboard_id".into(), serde_json::json!("r1"));
            write_settings_file(dir, &json.to_string());

            let loaded = get_settings_snapshot().expect("snapshot").settings;
            assert_eq!(loaded.landing_view, "start");

            // The next write persists the normalized view and no longer carries the removed fields.
            save(loaded).expect("save");
            let on_disk: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(settings_path_for_home(dir)).expect("read settings"),
            )
            .expect("parse settings");
            assert_eq!(on_disk["landing_view"], "start");
            assert!(on_disk.get("repo_dashboard_entries").is_none());
            assert!(on_disk.get("active_repo_dashboard_id").is_none());
        });
    }

    #[test]
    fn save_with_current_revision_succeeds_and_advances_revision() {
        with_temp_home(|_| {
            let first = save_with_revision_check(AppSettings::default(), Some(0))
                .expect("first save against the current revision");
            assert_eq!(first.revision, 1);

            let mut next = first.clone();
            next.appearance = "light".into();
            let second = save_with_revision_check(next, Some(first.revision))
                .expect("save against the current revision");
            assert_eq!(second.revision, 2);
            assert_eq!(second.appearance, "light");
            assert_eq!(get_settings_snapshot().expect("reload").settings, second);

            let mut stale = second.clone();
            stale.appearance = "dark".into();
            assert_eq!(
                save_with_revision_check(stale, Some(first.revision)).expect_err("stale"),
                SETTINGS_CONFLICT_ERROR
            );

            let third = save_with_revision_check(second.clone(), None)
                .expect("an absent expected revision skips the check");
            assert_eq!(third.revision, 3);
        });
    }

    fn legacy_settings_json(enabled_targets: &[&str]) -> String {
        let mut json = serde_json::to_value(AppSettings::default()).expect("serialize defaults");
        let object = json.as_object_mut().expect("settings object");
        object.remove("target_defaults_version");
        object.insert(
            "enabled_target_ids".into(),
            serde_json::json!(enabled_targets),
        );
        json.to_string()
    }

    fn seed_managed_record(surface: Option<&str>, identity: &str) {
        let root = crate::path_utils::default_installed_workspace_path().expect("workspace path");
        let state = crate::managed_state::ManagedState {
            schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: crate::stable_digest::bytes(b"bundle"),
            artifacts: vec![crate::managed_state::ManagedArtifactRecord {
                identity: identity.to_string(),
                hash: crate::stable_digest::bytes(identity.as_bytes()),
                surface: surface.map(str::to_string),
            }],
        };
        crate::managed_state::write_managed_state_atomic(&root, &state)
            .expect("seed managed state");
    }

    #[test]
    fn settings_without_marker_migrate_to_current_target_defaults_once() {
        with_temp_home(|dir| {
            std::env::remove_var("AGENT_WORKSPACE_PATH");
            write_settings_file(
                dir,
                &legacy_settings_json(&["codex_rules", "opencode_rules", "opencode_config"]),
            );

            let migrated = get_settings_snapshot().expect("snapshot").settings;
            assert_eq!(migrated.target_defaults_version, TARGET_DEFAULTS_VERSION);
            assert_eq!(
                migrated.enabled_target_ids,
                agent_targets::default_enabled_ids()
            );
            assert!(!migrated
                .enabled_target_ids
                .contains(&"codex_config".to_string()));
            assert_eq!(migrated.revision, 1, "migration is persisted");

            let again = get_settings_snapshot().expect("second snapshot").settings;
            assert_eq!(again, migrated, "migration must not run twice");
        });
    }

    #[test]
    fn migration_keeps_targets_whose_surfaces_are_already_managed() {
        use crate::setup_lifecycle::SetupSurfaceId;
        with_temp_home(|dir| {
            std::env::remove_var("AGENT_WORKSPACE_PATH");
            seed_managed_record(Some("codex_config"), "codex-config-record");
            write_settings_file(dir, &legacy_settings_json(&["codex_rules"]));

            let settings = load();
            assert!(settings
                .enabled_target_ids
                .contains(&"codex_config".to_string()));
            assert!(enabled_setup_surfaces(&settings).contains(&SetupSurfaceId::CodexConfig));
        });
    }

    #[test]
    fn migration_resolves_managed_surface_from_identity_without_surface_field() {
        with_temp_home(|dir| {
            std::env::remove_var("AGENT_WORKSPACE_PATH");
            let identity = crate::managed_state::artifact_identity(
                &crate::artifact_registry::ArtifactId::CodexConfig,
            );
            seed_managed_record(None, &identity);
            write_settings_file(dir, &legacy_settings_json(&[]));

            assert!(load()
                .enabled_target_ids
                .contains(&"codex_config".to_string()));
        });
    }

    #[test]
    fn migration_ignores_managed_skills_and_workspace_records() {
        with_temp_home(|dir| {
            std::env::remove_var("AGENT_WORKSPACE_PATH");
            seed_managed_record(Some("codex_skills"), "codex-skill-record");
            write_settings_file(dir, &legacy_settings_json(&[]));

            assert_eq!(
                load().enabled_target_ids,
                agent_targets::default_enabled_ids()
            );
        });
    }

    #[test]
    fn migration_keeps_targets_the_user_enabled() {
        with_temp_home(|dir| {
            std::env::remove_var("AGENT_WORKSPACE_PATH");
            write_settings_file(dir, &legacy_settings_json(&["codex_config"]));

            assert!(load()
                .enabled_target_ids
                .contains(&"codex_config".to_string()));
        });
    }

    #[test]
    fn settings_with_marker_are_not_migrated() {
        with_temp_home(|dir| {
            std::env::remove_var("AGENT_WORKSPACE_PATH");
            seed_managed_record(Some("codex_config"), "codex-config-record");
            let current = AppSettings {
                enabled_target_ids: vec!["codex_rules".into()],
                ..AppSettings::default()
            };
            write_settings_file(dir, &serde_json::to_string(&current).expect("serialize"));

            assert_eq!(load().enabled_target_ids, vec!["codex_rules".to_string()]);
        });
    }

    #[test]
    fn saving_stamps_the_marker_so_saved_toggles_are_not_re_migrated() {
        with_temp_home(|_| {
            std::env::remove_var("AGENT_WORKSPACE_PATH");
            let round_tripped = AppSettings {
                enabled_target_ids: vec!["codex_rules".into()],
                target_defaults_version: 0,
                ..AppSettings::default()
            };

            let saved = save_with_revision_check(round_tripped, None).expect("save");
            assert_eq!(saved.target_defaults_version, TARGET_DEFAULTS_VERSION);
            assert_eq!(load().enabled_target_ids, vec!["codex_rules".to_string()]);
        });
    }
}
