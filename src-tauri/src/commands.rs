mod actions;
pub(crate) mod backups;
mod claude_runtime;
mod codex_runtime;
mod content;
mod contract;
pub(crate) mod cursor_profile;
mod defaults;
mod opencode_runtime;
mod process;
pub(crate) mod setup;
pub(crate) use codex_runtime::{extract_managed_codex_config, managed_codex_keys_match};
pub(crate) use opencode_runtime::{extract_managed_opencode_config, managed_opencode_keys_match};
pub(crate) use process::ActionResult;
pub(crate) use status::file_eq;
mod repo_dashboard;
mod repo_dashboard_commands;
mod repo_dashboard_history;
mod settings_commands;
mod skills;
mod status;
mod workspace;

pub use actions::run_action;
pub use backups::{get_backup_details, list_backups, open_backups_folder};
pub use claude_runtime::get_claude_runtime_health;
pub use codex_runtime::get_codex_runtime_health;
pub use content::{
    create_doc, get_docs_health, list_agent_metadata, list_agent_sources, list_docs,
    list_opencode_config_editor_sources, open_agent_source, open_agent_template,
    open_config_template, open_doc, open_opencode_config_source, read_agent_source,
    read_agent_template, read_config_template, read_doc, read_opencode_config_source,
    save_agent_source, save_agent_template, save_config_template, save_doc,
    save_opencode_config_source,
};
pub use contract::validate_workspace_contract;
pub use cursor_profile::{get_cursor_profile_health, run_cursor_profile_action};
pub use opencode_runtime::{generate_opencode_config_snapshot, get_opencode_runtime_health};
pub use repo_dashboard_commands::{
    discover_local_git_repos, get_repo_dashboard_snapshot, get_repo_prompt_context,
};
pub use settings_commands::{get_agent_targets, get_settings, update_settings};
pub use setup::{apply_setup, preview_setup, repair_setup_command, rollback_setup_transaction};
pub use skills::{
    get_skills_sync_health, install_skills, list_skills, migrate_codex_legacy_skills,
    open_install_skills_script, open_skill, preview_codex_legacy_migration,
    preview_remove_deprecated_skills, read_skill, remove_deprecated_skills,
    rollback_deprecated_skills_removal,
};
pub use status::get_status;
pub use workspace::{
    apply_workspace_repair, get_workspace_diagnostics, install_default_workspace,
    open_default_workspace_folder, plan_workspace_repair, read_brain_setup_seed,
    repair_default_workspace, try_set_active_workspace_path,
};
