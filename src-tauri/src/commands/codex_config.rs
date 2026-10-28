//! "Keep mine" and "use Riggverk's defaults" for the enforced keys of the Codex config.
//!
//! `set_codex_config_kept` writes `config-preferences.json` and nothing else: never `config.toml`.
//! See [`crate::codex_config_keep`] for what a kept key means.
//!
//! `apply_codex_config_defaults` is the one command that writes `config.toml` over a value the
//! user set: an ordinary setup transaction, so the file is backed up first and the transaction can
//! be rolled back. `preview_codex_config_defaults` shows exactly what it would do.

use serde::Serialize;

use super::rules::user_home;
use super::setup::{apply_planned_artifacts, SetupResult};
use super::workspace::{setup_workspace_target_path, workspace_target_for_write};
use crate::apply_progress::ProgressReporter;
use crate::codex_config_keep::DefaultKey;
use crate::setup_lifecycle::SetupSurfaceId;
use crate::setup_transaction;

/// The Codex config target must be on for a command to act on it.
fn ensure_surface_enabled() -> Result<(), String> {
    let settings = crate::settings::load();
    if crate::settings::surface_enabled(&settings, SetupSurfaceId::CodexConfig) {
        Ok(())
    } else {
        Err(format!(
            "{} is disabled",
            SetupSurfaceId::CodexConfig.label()
        ))
    }
}

/// Keeps (`kept = true`) the enforced keys whose installed value differs from the bundled config,
/// or hands every key back to Riggverk (`kept = false`).
#[tauri::command(async)]
pub fn set_codex_config_kept(kept: bool) -> Result<(), String> {
    // Writes next to files an apply may also write: wait for a running mutation instead of
    // interleaving with it.
    let _mutation = crate::mutation_lock::acquire();
    let workspace_root = workspace_target_for_write()?;
    let home = user_home()?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    if kept {
        ensure_surface_enabled()?;
        crate::codex_config_keep::keep(&workspace_root, &home).map(|_| ())
    } else {
        crate::codex_config_keep::hand_back(&workspace_root)
    }
}

// ── Use Riggverk's defaults ──

/// What resetting the differing enforced keys to Riggverk's values would do, and the proof to
/// apply it. Key names and the values of the enforced approval and sandbox keys only.
#[derive(Debug, Clone, Serialize)]
pub struct CodexConfigDefaultsPreview {
    pub keys: Vec<DefaultKey>,
    /// A removed and an added line per key; never other text of the file.
    pub diff: String,
    pub plan_fingerprint: String,
    pub preview_token: String,
}

/// Read-only: the enforced Codex config keys that differ from Riggverk's value, the value each
/// would get, and the plan fingerprint and one-time token that apply needs. Refuses when nothing
/// differs, or when the config is unreadable, not valid TOML or a link.
#[tauri::command(async)]
pub fn preview_codex_config_defaults() -> Result<CodexConfigDefaultsPreview, String> {
    ensure_surface_enabled()?;
    let workspace_root = setup_workspace_target_path()?;
    let home = user_home()?;
    let plan = crate::codex_config_keep::plan_defaults(&workspace_root, &home)?;
    let fingerprint =
        crate::codex_config_keep::defaults_fingerprint(&workspace_root, &home, &plan)?;
    let token = setup_transaction::issue_preview_token(
        &workspace_root,
        &fingerprint,
        setup_transaction::PreviewPurpose::Apply,
        &[SetupSurfaceId::CodexConfig],
    )?;
    Ok(CodexConfigDefaultsPreview {
        diff: crate::codex_config_keep::defaults_diff(&plan.keys),
        keys: plan.keys,
        plan_fingerprint: fingerprint,
        preview_token: token,
    })
}

/// Sets the enforced keys that differ to Riggverk's values, as the preview showed them. A regular
/// setup transaction: `config.toml` is backed up first, the planned content is written and
/// checked, and the transaction can be rolled back while the file is unchanged. Comments, other
/// keys and the create-only keys stay as they are, and the choices to keep those keys end.
///
/// The reset is planned again from what is on disk now. If the config (or what a kept key means)
/// changed since the preview, the fingerprint no longer matches and nothing is touched.
#[tauri::command(async)]
pub fn apply_codex_config_defaults(
    plan_fingerprint: Option<String>,
    preview_token: Option<String>,
) -> Result<SetupResult, String> {
    let _mutation = crate::mutation_lock::acquire();
    ensure_surface_enabled()?;
    let workspace_root = workspace_target_for_write()?;
    let home = user_home()?;

    let expected = plan_fingerprint
        .as_deref()
        .ok_or_else(|| "Plan fingerprint required. Re-run preview before applying.".to_string())?;
    if !setup_transaction::validate_fingerprint_format(expected) {
        return Err("Malformed plan fingerprint".to_string());
    }
    let token = preview_token
        .as_deref()
        .ok_or_else(|| "Preview token required. Re-run preview before applying.".to_string())?;

    let plan = crate::codex_config_keep::plan_defaults(&workspace_root, &home)?;
    let current = crate::codex_config_keep::defaults_fingerprint(&workspace_root, &home, &plan)?;
    if current != expected {
        return Err(
            "Plan fingerprint mismatch: the config changed after preview. Re-run preview before applying."
                .to_string(),
        );
    }
    setup_transaction::validate_preview_token(
        token,
        &workspace_root,
        expected,
        setup_transaction::PreviewPurpose::Apply,
        &[SetupSurfaceId::CodexConfig],
    )?;

    let keys = plan.keys;
    let mut result = apply_planned_artifacts(
        &[plan.operation],
        Vec::new(),
        Some(token),
        &mut ProgressReporter::for_task("apply_codex_config_defaults"),
    );
    if result.success {
        // Runs after the apply released the setup mutation guard, so it takes the guard like
        // `set_codex_config_kept`. A failure is reported: the old entry is inert now, but it would
        // come back to life if the value were ever edited back.
        let cleared = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()
            .and_then(|_guard| crate::codex_config_keep::clear_kept(&workspace_root, &home, &keys));
        if let Err(error) = cleared {
            result.manual_steps.push(format!(
                "The keys were reset, but the choice to keep your old values could not be cleared: {error}"
            ));
        }
    }
    Ok(result)
}
