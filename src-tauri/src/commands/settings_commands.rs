use crate::agent_targets;
use crate::settings::{self, AppSettings};

#[tauri::command]
pub fn get_settings() -> Result<AppSettings, String> {
    Ok(settings::load())
}

#[tauri::command]
pub fn update_settings(settings: AppSettings) -> Result<AppSettings, String> {
    settings::save(settings)
}

#[tauri::command]
pub fn get_agent_targets() -> Result<Vec<agent_targets::AgentTargetMeta>, String> {
    Ok(agent_targets::targets()
        .into_iter()
        .map(|t| agent_targets::AgentTargetMeta {
            id: t.id.to_string(),
            label: t.label.to_string(),
            kind: t.kind.clone(),
            target_rel: t.target_rel.to_string(),
            source_rel: t.source_rel.to_string(),
        })
        .collect())
}

#[tauri::command]
pub fn get_target_profiles() -> Result<Vec<agent_targets::TargetProfileMeta>, String> {
    Ok(agent_targets::target_profiles())
}
