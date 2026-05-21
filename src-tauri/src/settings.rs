use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::agent_targets;
use crate::path_utils::{normalize_user_workspace_path, normalize_user_workspace_path_for_save};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    pub appearance: String,
    pub workspace_path: Option<String>,
    #[serde(default = "agent_targets::default_enabled_ids")]
    pub enabled_target_ids: Vec<String>,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub background_color: Option<String>,
    #[serde(default)]
    pub foreground_color: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: "dark".into(),
            workspace_path: None,
            enabled_target_ids: agent_targets::default_enabled_ids(),
            accent_color: None,
            background_color: None,
            foreground_color: None,
        }
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

    if let Some(ref val) = settings.workspace_path {
        settings.workspace_path = normalize_user_workspace_path(val);
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
}

fn normalize_for_save(settings: &mut AppSettings) -> Result<(), String> {
    match settings.appearance.as_str() {
        "dark" | "light" | "system" => {}
        _ => settings.appearance = "dark".into(),
    }

    if let Some(ref val) = settings.workspace_path {
        settings.workspace_path = normalize_user_workspace_path_for_save(val)?;
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

    Ok(())
}

fn settings_file() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    if home.is_empty() {
        return Err("HOME is empty".to_string());
    }
    Ok(PathBuf::from(home).join("Library/Application Support/ai.agentworkspace.app/settings.json"))
}

pub fn load() -> AppSettings {
    let path = match settings_file() {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };
    let mut settings = match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    };
    normalize(&mut settings);
    settings
}

pub fn save(mut settings: AppSettings) -> Result<AppSettings, String> {
    normalize_for_save(&mut settings)?;

    let path = settings_file()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create settings dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| format!("serialize: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("write settings: {}", e))?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::{normalize, normalize_for_save, validate_hex_color, AppSettings};

    fn settings_with_path(path: Option<&str>) -> AppSettings {
        AppSettings {
            appearance: "dark".into(),
            workspace_path: path.map(|s| s.to_string()),
            enabled_target_ids: vec![],
            accent_color: None,
            background_color: None,
            foreground_color: None,
        }
    }

    #[test]
    fn saved_workspace_path_expands_tilde_home() {
        let home = std::env::var("HOME").expect("HOME required for test");
        let mut settings = settings_with_path(Some("~"));

        normalize_for_save(&mut settings).expect("save normalization should succeed");

        assert_eq!(settings.workspace_path, Some(home));
    }

    #[test]
    fn saved_workspace_path_expands_tilde_child() {
        let home = std::env::var("HOME").expect("HOME required for test");
        let expected = std::path::PathBuf::from(home)
            .join("Desktop/test")
            .to_string_lossy()
            .into_owned();
        let mut settings = settings_with_path(Some("~/Desktop/test"));

        normalize_for_save(&mut settings).expect("save normalization should succeed");

        assert_eq!(settings.workspace_path, Some(expected));
    }

    #[test]
    fn saved_workspace_path_accepts_trimmed_absolute_path() {
        let mut settings = settings_with_path(Some("  /tmp/workspace  "));

        normalize_for_save(&mut settings).expect("save normalization should succeed");

        assert_eq!(settings.workspace_path, Some("/tmp/workspace".into()));
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
    fn loaded_legacy_relative_workspace_path_becomes_none() {
        let mut settings = settings_with_path(Some("workspace/local"));

        normalize(&mut settings);

        assert_eq!(settings.workspace_path, None);
    }

    #[test]
    fn loaded_stale_enabled_target_ids_drop_unknown_values() {
        let mut settings = AppSettings {
            appearance: "dark".into(),
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
        };

        normalize(&mut settings);

        assert_eq!(
            settings.enabled_target_ids,
            vec!["codex_rules".to_string(), "opencode_config".to_string()]
        );
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
            workspace_path: None,
            enabled_target_ids: vec![],
            accent_color: Some("#FFAA00".into()),
            background_color: None,
            foreground_color: None,
        };
        normalize(&mut s);
        assert_eq!(s.accent_color, Some("#ffaa00".into()));
    }

    #[test]
    fn accent_color_invalid_becomes_none_in_settings() {
        let mut s = AppSettings {
            appearance: "dark".into(),
            workspace_path: None,
            enabled_target_ids: vec![],
            accent_color: Some("bad".into()),
            background_color: None,
            foreground_color: None,
        };
        normalize(&mut s);
        assert_eq!(s.accent_color, None);
    }
}
