mod agent_discovery;
mod agent_skill_targets;
mod agent_targets;
mod app_data_migration;
mod apply_progress;
mod artifact_registry;
mod commands;
mod cursor_profile_ops;
mod cursor_profile_paths;
mod executable_resolver;
mod file_conflicts;
mod installation_status;
mod kept_files;
mod light_harness;
mod light_mcp;
mod managed_bootstrap;
mod managed_state;
mod mutation_lock;
mod path_safety;
mod path_utils;
mod platform_paths;
mod rules_block;
mod rules_convert;
mod rules_diff;
mod rules_preferences;
mod safe_filesystem;
mod settings;
mod setup_fingerprint;
mod setup_lifecycle;
mod setup_mutation_guard;
mod setup_roots;
mod setup_transaction;
mod shell_runtime;
mod shipped_digests;
mod skill_discovery;
mod skill_health;
mod skill_loads;
mod skill_roots;
#[cfg(test)]
mod skills_install;
mod stable_digest;

#[cfg(test)]
mod app_data_migration_contract;
#[cfg(test)]
mod file_conflicts_contract;
#[cfg(test)]
mod identity_contract;
#[cfg(test)]
mod library_scope_contract;
#[cfg(test)]
mod light_harness_contract;
#[cfg(test)]
mod managed_reconciliation_contract;
#[cfg(test)]
mod opencode_model_override_contract;
#[cfg(test)]
mod rules_block_contract;
#[cfg(test)]
mod shipped_ownership_contract;
#[cfg(test)]
mod skill_files_contract;
#[cfg(test)]
mod skill_folders_contract;
#[cfg(test)]
mod smoke_runtime;
#[cfg(test)]
mod test_env;

use commands::{
    apply_rules_conversion, apply_setup, apply_take_bundled, apply_uninstall, create_doc,
    get_agent_targets, get_backup_details, get_claude_runtime_health, get_codex_runtime_health,
    get_cursor_profile_health, get_docs_health, get_effective_skill_loads, get_installation_status,
    get_light_runtime_health, get_opencode_runtime_health, get_settings, get_status,
    get_workspace_diagnostics, list_agent_metadata, list_available_opencode_models, list_backups,
    list_docs, list_opencode_config_editor_sources, list_rules_files, list_skills,
    open_backups_folder, open_default_workspace_folder, open_doc, open_rules_file,
    preview_file_diff, preview_rules_conversion, preview_rules_diff, preview_setup,
    preview_take_bundled, preview_uninstall, read_agent_source, read_agent_template,
    read_config_template, read_doc, read_opencode_config_source, read_opencode_model_selection,
    read_rules_file, read_skill, reset_active_workspace_path, reset_opencode_model_selection,
    rollback_setup_transaction, save_doc, save_rules_refinements, set_files_kept,
    set_rules_user_managed, try_set_active_workspace_path, update_opencode_model_selection,
    update_settings,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    executable_resolver::extend_path_with_tool_dirs();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // First: nothing may read or write the data directory before this.
            app_data_migration::run_at_startup()?;
            let bundled = app
                .path()
                .resolve("default-workspace", tauri::path::BaseDirectory::Resource)
                .map_err(|e| format!("resolve bundled workspace: {e}"))?;
            setup_roots::initialize(bundled)?;
            apply_progress::install(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_workspace_diagnostics,
            open_default_workspace_folder,
            try_set_active_workspace_path,
            reset_active_workspace_path,
            get_claude_runtime_health,
            get_codex_runtime_health,
            get_cursor_profile_health,
            get_light_runtime_health,
            list_skills,
            get_installation_status,
            get_effective_skill_loads,
            read_skill,
            list_docs,
            get_docs_health,
            read_doc,
            save_doc,
            create_doc,
            open_doc,
            list_rules_files,
            read_rules_file,
            save_rules_refinements,
            open_rules_file,
            read_agent_template,
            read_config_template,
            list_available_opencode_models,
            read_opencode_config_source,
            list_opencode_config_editor_sources,
            list_agent_metadata,
            read_opencode_model_selection,
            update_opencode_model_selection,
            reset_opencode_model_selection,
            read_agent_source,
            get_settings,
            update_settings,
            get_agent_targets,
            list_backups,
            open_backups_folder,
            get_backup_details,
            get_opencode_runtime_health,
            preview_setup,
            apply_setup,
            preview_uninstall,
            apply_uninstall,
            rollback_setup_transaction,
            preview_rules_diff,
            preview_rules_conversion,
            apply_rules_conversion,
            set_rules_user_managed,
            preview_file_diff,
            set_files_kept,
            preview_take_bundled,
            apply_take_bundled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
