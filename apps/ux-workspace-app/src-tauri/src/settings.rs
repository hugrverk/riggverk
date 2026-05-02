use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::agent_targets;
use crate::path_utils::normalize_user_workspace_path;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    pub appearance: String,
    pub workspace_path: Option<String>,
    #[serde(default = "agent_targets::default_enabled_ids")]
    pub enabled_target_ids: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: "dark".into(),
            workspace_path: None,
            enabled_target_ids: agent_targets::default_enabled_ids(),
        }
    }
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
}

fn settings_file() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    if home.is_empty() {
        return Err("HOME is empty".to_string());
    }
    Ok(PathBuf::from(home)
        .join("Library/Application Support/ai.openworkspace.ux-workspace/settings.json"))
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
    normalize(&mut settings);

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
    use super::{normalize, AppSettings};

    fn settings_with_path(path: Option<&str>) -> AppSettings {
        AppSettings {
            appearance: "dark".into(),
            workspace_path: path.map(|s| s.to_string()),
            enabled_target_ids: vec![],
        }
    }

    #[test]
    fn saved_workspace_path_expands_tilde_home() {
        let home = std::env::var("HOME").expect("HOME required for test");
        let mut settings = settings_with_path(Some("~"));

        normalize(&mut settings);

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

        normalize(&mut settings);

        assert_eq!(settings.workspace_path, Some(expected));
    }

    #[test]
    fn saved_workspace_path_trims_whitespace() {
        let mut settings = settings_with_path(Some("  /tmp/workspace  "));

        normalize(&mut settings);

        assert_eq!(settings.workspace_path, Some("/tmp/workspace".into()));
    }

    #[test]
    fn saved_empty_workspace_path_becomes_none() {
        let mut settings = settings_with_path(Some(" \n\t "));

        normalize(&mut settings);

        assert_eq!(settings.workspace_path, None);
    }
}
