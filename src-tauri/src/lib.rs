mod agent_skill_targets;
mod agent_targets;
mod codex_legacy_migration;
mod commands;
mod cursor_profile_ops;
mod cursor_profile_paths;
mod deprecated_skills;
mod executable_resolver;
mod path_utils;
mod platform_paths;
mod settings;
mod shell_runtime;
mod skill_duplicate_audit;
#[cfg_attr(not(windows), allow(dead_code))]
mod skills_install;

#[cfg(test)]
mod script_action_smoke;
#[cfg(test)]
mod smoke_runtime;
#[cfg(test)]
mod test_env;

use commands::{
    apply_workspace_repair, create_doc, discover_local_git_repos,
    generate_opencode_config_snapshot, get_agent_targets, get_backup_details,
    get_codex_runtime_health, get_cursor_profile_health, get_docs_health,
    get_opencode_runtime_health, get_repo_dashboard_snapshot, get_repo_prompt_context,
    get_settings, get_skills_sync_health, get_status, get_workspace_diagnostics,
    install_default_workspace, install_skills, list_agent_metadata, list_agent_sources,
    list_backups, list_docs, list_opencode_config_editor_sources, list_skills,
    migrate_codex_legacy_skills, open_agent_source, open_agent_template, open_backups_folder,
    open_config_template, open_default_workspace_folder, open_doc, open_install_skills_script,
    open_opencode_config_source, open_skill, plan_workspace_repair, preview_codex_legacy_migration,
    preview_remove_deprecated_skills, read_agent_source, read_agent_template,
    read_brain_setup_seed, read_config_template, read_doc, read_opencode_config_source, read_skill,
    remove_deprecated_skills, repair_default_workspace, rollback_deprecated_skills_removal,
    run_action, run_cursor_profile_action, save_agent_source, save_agent_template,
    save_config_template, save_doc, save_opencode_config_source, try_set_active_workspace_path,
    update_settings, validate_workspace_contract,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.maximize();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_workspace_diagnostics,
            install_default_workspace,
            repair_default_workspace,
            open_default_workspace_folder,
            try_set_active_workspace_path,
            run_action,
            get_codex_runtime_health,
            get_cursor_profile_health,
            run_cursor_profile_action,
            list_skills,
            get_skills_sync_health,
            preview_codex_legacy_migration,
            migrate_codex_legacy_skills,
            preview_remove_deprecated_skills,
            remove_deprecated_skills,
            rollback_deprecated_skills_removal,
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
            install_skills,
            open_install_skills_script,
            get_settings,
            update_settings,
            get_agent_targets,
            list_backups,
            open_backups_folder,
            get_backup_details,
            validate_workspace_contract,
            get_opencode_runtime_health,
            generate_opencode_config_snapshot,
            plan_workspace_repair,
            apply_workspace_repair,
            read_brain_setup_seed,
            get_repo_dashboard_snapshot,
            get_repo_prompt_context,
            discover_local_git_repos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
