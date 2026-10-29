use crate::agent_targets;
use crate::commands::workspace;
use crate::settings::{self, AppSettings, GetSettingsResponse, MutationOutcome};

#[tauri::command]
pub fn get_settings() -> Result<GetSettingsResponse, String> {
    settings::get_settings_snapshot_with_mutate(|current| {
        if workspace::scrub_stale_workspace_path(current) {
            Ok(MutationOutcome::Changed)
        } else {
            Ok(MutationOutcome::Unchanged)
        }
    })
}

// Async: the mutation lock waits for a running apply, which must not block the main thread.
#[tauri::command(async)]
pub fn update_settings(
    settings: AppSettings,
    expected_revision: Option<u64>,
) -> Result<AppSettings, String> {
    // Which harnesses and targets are on decides what an apply does: never changed under one.
    let _mutation = crate::mutation_lock::acquire()?;
    settings::save_with_revision_check(settings, expected_revision)
}

#[tauri::command]
pub fn get_agent_targets() -> Result<Vec<agent_targets::AgentTargetMeta>, String> {
    let home = agent_targets::home_dir().ok();
    Ok(agent_targets::targets()
        .into_iter()
        .map(|t| agent_targets::AgentTargetMeta {
            id: t.id.to_string(),
            label: t.label.to_string(),
            harness: t.harness,
            kind: t.kind,
            target_rel: t.display_rel(home.as_deref()),
            source_rel: t.source_rel.to_string(),
        })
        .collect())
}
