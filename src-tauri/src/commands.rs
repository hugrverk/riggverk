mod actions;
pub(crate) mod backups;
mod claude_runtime;
mod codex_runtime;
mod content;
pub(crate) mod cursor_profile;
mod defaults;
pub(crate) use defaults::default_workspace_files;
mod opencode_runtime;
mod process;
pub(crate) mod setup;
pub(crate) use codex_runtime::{
    extract_managed_codex_config, managed_codex_keys_match, render_codex_config_managed_projection,
};
pub(crate) use opencode_runtime::{
    extract_managed_opencode_config, managed_opencode_keys_match, merge_managed_opencode_config,
    render_expected_opencode_config,
};
pub(crate) use status::file_eq;
pub(crate) use workspace::configured_workspace_path;
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
    create_doc, get_docs_health, list_agent_metadata, list_docs,
    list_opencode_config_editor_sources, open_agent_source, open_agent_template,
    open_config_template, open_doc, open_opencode_config_source, read_agent_source,
    read_agent_template, read_config_template, read_doc, read_opencode_config_source,
    save_agent_source, save_agent_template, save_doc, save_opencode_config_source,
};
pub use cursor_profile::get_cursor_profile_health;
pub use opencode_runtime::{
    get_opencode_runtime_health, list_available_opencode_models, read_opencode_model_selection,
    update_opencode_model_selection,
};
pub use repo_dashboard_commands::{
    discover_local_git_repos, get_repo_dashboard_snapshot, get_repo_prompt_context,
};
pub use settings_commands::{get_agent_targets, get_settings, update_settings};
pub use setup::{
    apply_setup, apply_uninstall, get_installation_status, preview_setup, preview_uninstall,
    rollback_setup_transaction,
};
pub use skills::{list_skills, open_skill, read_skill};
pub use status::get_status;
pub use workspace::{
    get_workspace_diagnostics, open_default_workspace_folder, read_brain_setup_seed,
    try_set_active_workspace_path,
};
