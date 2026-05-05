mod agent_targets;
mod commands;
mod path_utils;
mod settings;

use commands::{
    create_doc, create_workspace_from_defaults, get_agent_targets, get_backup_details,
    get_default_workspace_summary, get_routing_profiles, get_settings, get_status,
    get_target_profiles,
    get_workspace_diagnostics, install_skills, list_agent_sources, list_backups, list_docs,
    list_skills, open_agent_source, open_agent_template, open_backups_folder, open_config_template,
    open_doc, open_install_skills_script, open_skill, plan_create_workspace, read_agent_source,
    read_agent_template, read_config_template, read_doc, read_skill, run_action, save_agent_source,
    save_agent_template, save_config_template, save_doc, update_settings,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_workspace_diagnostics,
            get_default_workspace_summary,
            plan_create_workspace,
            create_workspace_from_defaults,
            run_action,
            list_skills,
            open_skill,
            read_skill,
            list_docs,
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
            list_agent_sources,
            read_agent_source,
            open_agent_source,
            save_agent_source,
            install_skills,
            open_install_skills_script,
            get_settings,
            update_settings,
            get_agent_targets,
            get_target_profiles,
            list_backups,
            open_backups_folder,
            get_backup_details,
            get_routing_profiles,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
