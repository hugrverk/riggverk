use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::agent_targets;

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
        let trimmed = val.trim();
        settings.workspace_path = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
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
