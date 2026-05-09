mod actions;
mod backups;
mod content;
mod contract;
mod defaults;
mod design_md;
mod opencode_runtime;
mod process;
mod settings_commands;
mod skills;
mod status;
mod workspace;

pub use actions::run_action;
pub use backups::{get_backup_details, list_backups, open_backups_folder};
pub use content::{
    create_doc, list_agent_metadata, list_agent_sources, list_docs, open_agent_source,
    open_agent_template, open_config_template, open_doc, read_agent_source, read_agent_template,
    read_config_template, read_doc, save_agent_source, save_agent_template, save_config_template,
    save_doc,
};
pub use contract::validate_workspace_contract;
pub use defaults::get_default_workspace_summary;
pub use design_md::{
    get_design_md_catalog_status, list_design_md_entries, read_design_md_entry,
    sync_design_md_catalog,
};
pub use opencode_runtime::get_opencode_runtime_health;
pub use settings_commands::{
    get_agent_targets, get_settings, get_target_profiles, update_settings,
};
pub use skills::{install_skills, list_skills, open_install_skills_script, open_skill, read_skill};
pub use status::get_status;
pub use workspace::{
    create_workspace_from_defaults, get_workspace_diagnostics, plan_create_workspace,
};
