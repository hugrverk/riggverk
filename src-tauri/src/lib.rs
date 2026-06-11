mod agent_discovery;
mod agent_skill_targets;
mod agent_targets;
mod artifact_registry;
mod commands;
mod cursor_profile_ops;
mod cursor_profile_paths;
mod executable_resolver;
mod installation_status;
mod managed_bootstrap;
mod managed_state;
mod path_safety;
mod path_utils;
mod platform_paths;
mod safe_filesystem;
mod settings;
mod setup_fingerprint;
mod setup_lifecycle;
mod setup_mutation_guard;
mod setup_roots;
mod setup_transaction;
mod shell_runtime;
mod skill_discovery;
#[cfg_attr(not(windows), allow(dead_code))]
mod skills_install;
mod stable_digest;

#[cfg(test)]
mod managed_reconciliation_contract;
#[cfg(test)]
mod script_action_smoke;
#[cfg(test)]
mod smoke_runtime;
#[cfg(test)]
mod test_env;

use commands::{
    apply_setup, create_doc, discover_local_git_repos, generate_opencode_config_snapshot,
    get_agent_targets, get_backup_details, get_claude_runtime_health, get_codex_runtime_health,
    get_cursor_profile_health, get_docs_health, get_installation_status,
    get_opencode_runtime_health, get_repo_dashboard_snapshot, get_repo_prompt_context,
    get_settings, get_status, get_workspace_diagnostics, list_agent_metadata, list_agent_sources,
    list_backups, list_docs, list_opencode_config_editor_sources, list_skills, open_agent_source,
    open_agent_template, open_backups_folder, open_config_template, open_default_workspace_folder,
    open_doc, open_opencode_config_source, open_skill, preview_setup, read_agent_source,
    read_agent_template, read_brain_setup_seed, read_config_template, read_doc,
    read_opencode_config_source, read_skill, rollback_setup_transaction, run_action,
    save_agent_source, save_agent_template, save_config_template, save_doc,
    save_opencode_config_source, try_set_active_workspace_path, update_settings,
    validate_workspace_contract,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let bundled = app
                .path()
                .resolve("default-workspace", tauri::path::BaseDirectory::Resource)
                .map_err(|e| format!("resolve bundled workspace: {e}"))?;
            setup_roots::initialize(bundled)?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.maximize();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_workspace_diagnostics,
            open_default_workspace_folder,
            try_set_active_workspace_path,
            run_action,
            get_claude_runtime_health,
            get_codex_runtime_health,
            get_cursor_profile_health,
            list_skills,
            get_installation_status,
            open_skill,
            read_skill,
            list_docs,
            get_docs_health,
            read_doc,
            save_doc,
            create_doc,
            open_doc,
            read_agent_template,
            open_agent_template,
            save_agent_template,
            read_config_template,
            open_config_template,
            save_config_template,
            read_opencode_config_source,
            list_opencode_config_editor_sources,
            save_opencode_config_source,
            open_opencode_config_source,
            list_agent_sources,
            list_agent_metadata,
            read_agent_source,
            open_agent_source,
            save_agent_source,
            get_settings,
            update_settings,
            get_agent_targets,
            list_backups,
            open_backups_folder,
            get_backup_details,
            validate_workspace_contract,
            get_opencode_runtime_health,
            generate_opencode_config_snapshot,
            read_brain_setup_seed,
            get_repo_dashboard_snapshot,
            get_repo_prompt_context,
            discover_local_git_repos,
            preview_setup,
            apply_setup,
            rollback_setup_transaction,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
