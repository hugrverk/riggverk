//! "Keep mine" for the enforced keys of the Codex config.
//!
//! The one command here writes `config-preferences.json` and nothing else: never `config.toml`.
//! See [`crate::codex_config_keep`] for what a kept key means.

use super::rules::user_home;
use super::workspace::setup_workspace_target_path;
use crate::setup_lifecycle::SetupSurfaceId;

/// Keeps (`kept = true`) the enforced keys whose installed value differs from the bundled config,
/// or hands every key back to Riggverk (`kept = false`).
#[tauri::command(async)]
pub fn set_codex_config_kept(kept: bool) -> Result<(), String> {
    // Writes next to files an apply may also write: wait for a running mutation instead of
    // interleaving with it.
    let _mutation = crate::mutation_lock::acquire();
    let workspace_root = setup_workspace_target_path()?;
    let home = user_home()?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    if kept {
        let settings = crate::settings::load();
        if !crate::settings::surface_enabled(&settings, SetupSurfaceId::CodexConfig) {
            return Err(format!(
                "{} is disabled",
                SetupSurfaceId::CodexConfig.label()
            ));
        }
        crate::codex_config_keep::keep(&workspace_root, &home).map(|_| ())
    } else {
        crate::codex_config_keep::hand_back(&workspace_root)
    }
}
