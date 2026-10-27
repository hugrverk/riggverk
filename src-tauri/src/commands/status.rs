use serde::Serialize;
use std::path::Path;

use crate::agent_targets;
use crate::settings;

use super::workspace::workspace_root;

pub(crate) fn file_eq(a: &Path, b: &Path) -> bool {
    if !a.exists() || !b.exists() {
        return false;
    }
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(ac), Ok(bc)) => ac == bc,
        _ => false,
    }
}

/// The data folder and which targets are switched on. Fails like every workspace-bound command
/// when the folder is unusable. What is installed lives in the installation status, not here.
#[derive(Serialize)]
pub struct StatusData {
    repo_path: String,
    enabled_rule_target_ids: Vec<String>,
    enabled_config_target_ids: Vec<String>,
    enabled_agent_target_ids: Vec<String>,
    enabled_target_ids: Vec<String>,
}

#[tauri::command(async)]
pub fn get_status() -> Result<StatusData, String> {
    let root = workspace_root()?;

    let settings = settings::load();
    let enabled = settings::effective_enabled_target_ids(&settings);

    let rule_ids: Vec<String> = agent_targets::rule_targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .map(|t| t.id.to_string())
        .collect();

    let config_ids: Vec<String> = agent_targets::config_targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .map(|t| t.id.to_string())
        .collect();

    let agent_target_ids: Vec<String> = agent_targets::runtime_agent_targets()
        .iter()
        .chain(
            agent_targets::targets()
                .iter()
                .filter(|t| t.id == "cursor_setup"),
        )
        .filter(|t| enabled.contains(&t.id.to_string()))
        .map(|t| t.id.to_string())
        .collect();

    Ok(StatusData {
        repo_path: root.to_string_lossy().into_owned(),
        enabled_rule_target_ids: rule_ids,
        enabled_config_target_ids: config_ids,
        enabled_agent_target_ids: agent_target_ids,
        enabled_target_ids: enabled,
    })
}
