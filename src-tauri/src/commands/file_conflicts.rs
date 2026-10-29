//! Commands for conflicts on skill and agent files.
//!
//! A skill or agent file the user edited by hand is a conflict the regular update refuses to
//! overwrite. These commands let the user see what differs from the bundled file, keep their
//! version (or hand it back to the app), or replace their version by the bundled one. The diff is
//! read-only and keeping writes only `kept-files.json`. Replacing is the one command that writes a
//! skill or agent file: an ordinary setup transaction, so the user's file is backed up first and
//! the transaction can be rolled back.
//!
//! The UI names a surface and opaque unit keys, never a path or an identity. Each command plans
//! the surface again and acts on the files that plan holds.

use std::path::PathBuf;

use serde::Serialize;

use super::setup::{apply_planned_artifacts, SetupResult};
use super::workspace::{setup_workspace_target_path, workspace_target_for_write};
use crate::apply_progress::ProgressReporter;
use crate::artifact_registry::ArtifactId;
use crate::file_conflicts::{self, FileDiffView, TakeBundledFile};
use crate::kept_files::{self, Keep};
use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
use crate::setup_transaction::{self, PlannedArtifact};

/// Most units one `set_files_kept` call names.
const MAX_UNITS_PER_CALL: usize = 200;
/// Most units one take-bundled call names. A review shows every file it replaces, so it stays small.
const MAX_TAKE_BUNDLED_UNITS: usize = 10;

fn user_home() -> Result<PathBuf, String> {
    crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
}

/// The surface a command acts on: the skills surface or an agents surface, enabled.
fn files_surface(surface: &str) -> Result<SetupSurfaceId, String> {
    let id =
        serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(surface.to_string()))
            .map_err(|_| format!("Unknown surface ID: {surface}"))?;
    if !file_conflicts::is_files_surface(id) {
        return Err(format!("{surface} has no skill or agent files"));
    }
    let settings = crate::settings::load();
    if !crate::settings::surface_enabled(&settings, id) {
        return Err(format!("{} is disabled", id.label()));
    }
    Ok(id)
}

struct Planned {
    workspace_root: PathBuf,
    home: PathBuf,
    planned: Vec<PlannedArtifact>,
}

fn plan(surface: SetupSurfaceId) -> Result<Planned, String> {
    let workspace_root = setup_workspace_target_path()?;
    let home = user_home()?;
    let planned =
        setup_transaction::plan_artifacts_for_surfaces(&[surface], &workspace_root, &home)?;
    Ok(Planned {
        workspace_root,
        home,
        planned,
    })
}

const UNKNOWN_UNIT: &str = "this skill or agent has no conflicting or kept files right now";

// ── Diff ──

/// Read-only: a bounded diff of the installed files of one unit against the bundled ones.
#[tauri::command(async)]
pub fn preview_file_diff(surface: String, unit: String) -> Result<FileDiffView, String> {
    let surface = files_surface(&surface)?;
    let Planned {
        workspace_root,
        home,
        planned,
    } = plan(surface)?;
    let units = file_conflicts::units(&planned);
    let unit = units
        .iter()
        .find(|candidate| candidate.key == unit)
        .ok_or_else(|| UNKNOWN_UNIT.to_string())?;
    Ok(file_conflicts::diff_unit(unit, &workspace_root, &home))
}

// ── Keep ──

/// Keeps the user's version of the conflicting files of these units (`kept` true), or hands the
/// kept files back to the app (`kept` false). Writes only `kept-files.json`: a kept file is never
/// written by an update, and a file handed back is a conflict again.
///
/// Keeping is for files that are in conflict now. Handing back is allowed for any unit, and a
/// unit that is no longer listed has nothing to hand back.
#[tauri::command(async)]
pub fn set_files_kept(surface: String, units: Vec<String>, kept: bool) -> Result<(), String> {
    if units.is_empty() {
        return Err("name at least one skill or agent".to_string());
    }
    if units.len() > MAX_UNITS_PER_CALL {
        return Err(format!("at most {MAX_UNITS_PER_CALL} at a time"));
    }
    // Writes next to files an apply may also write: wait for a running mutation instead of
    // interleaving with it.
    let _mutation = crate::mutation_lock::acquire()?;
    let surface = files_surface(&surface)?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    workspace_target_for_write()?;
    let Planned {
        workspace_root,
        home,
        planned,
    } = plan(surface)?;
    let bundled_root = crate::skill_sources::SkillSources::for_workspace(&workspace_root)?;
    let all = file_conflicts::units(&planned);

    let mut keeps: Vec<Keep> = Vec::new();
    let mut releases: Vec<String> = Vec::new();
    for key in &units {
        let Some(unit) = all.iter().find(|candidate| &candidate.key == key) else {
            if kept {
                return Err(UNKNOWN_UNIT.to_string());
            }
            continue;
        };
        for operation in &unit.files {
            if kept && operation.kind == OperationKind::Conflict {
                keeps.push(Keep {
                    artifact: operation.artifact.clone(),
                    dest: kept_files::dest_label(&operation.artifact, &home, &workspace_root)?,
                    // A file nothing bundles here (a retired skill) has no digest to record.
                    bundle: bundle_digest(&operation.artifact, &bundled_root, &home),
                });
            } else if !kept && file_conflicts::is_kept(operation) {
                releases.push(crate::managed_state::artifact_identity(&operation.artifact));
            }
        }
    }
    if kept {
        kept_files::keep(&workspace_root, &keeps)
    } else {
        kept_files::release(&workspace_root, &releases)
    }
}

fn bundle_digest(
    artifact: &ArtifactId,
    bundled_root: &crate::skill_sources::SkillSources,
    home: &std::path::Path,
) -> Option<String> {
    crate::setup_fingerprint::artifact_source_digest(artifact, bundled_root, home).ok()
}

// ── Take bundled ──

/// One skill or agent a take-bundled review replaces.
#[derive(Debug, Clone, Serialize)]
pub struct TakeBundledUnit {
    pub key: String,
    pub name: String,
    /// The folder as people know it, `~/.claude/skills`.
    pub folder: String,
    /// The files that are replaced, with where each one is backed up.
    pub files: Vec<TakeBundledFile>,
    /// Files of the unit beyond the ones listed; they are replaced too.
    pub more_files: usize,
    /// Your files against the bundled ones: what the replacement changes.
    pub diff: FileDiffView,
    /// `pack:<name>` when the replacing files come from a skill pack; absent for the bundle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// What replacing the files of these units by the bundled ones would do, and the proof to apply it.
#[derive(Debug, Clone, Serialize)]
pub struct TakeBundledPreview {
    pub surface: SetupSurfaceId,
    pub units: Vec<TakeBundledUnit>,
    pub plan_fingerprint: String,
    pub preview_token: String,
}

fn check_take_bundled_units(units: &[String]) -> Result<(), String> {
    if units.is_empty() {
        return Err("name at least one skill or agent".to_string());
    }
    if units.len() > MAX_TAKE_BUNDLED_UNITS {
        return Err(format!("at most {MAX_TAKE_BUNDLED_UNITS} at a time"));
    }
    Ok(())
}

/// Read-only: the files that replacing these units by the bundled ones would write, the diff, and
/// the plan fingerprint and one-time token that apply needs. Only files in conflict (or kept) can
/// be replaced; a unit that is anything else is refused here and again at apply.
#[tauri::command(async)]
pub fn preview_take_bundled(
    surface: String,
    units: Vec<String>,
) -> Result<TakeBundledPreview, String> {
    check_take_bundled_units(&units)?;
    let surface = files_surface(&surface)?;
    let Planned {
        workspace_root,
        home,
        planned,
    } = plan(surface)?;
    let operations = setup_transaction::take_bundled_operations(
        &planned,
        surface,
        &units,
        &workspace_root,
        &home,
    )?;
    let fingerprint =
        setup_transaction::overwrite_fingerprint(&workspace_root, &home, &operations)?;
    let token = setup_transaction::issue_preview_token(
        &workspace_root,
        &fingerprint,
        setup_transaction::PreviewPurpose::Apply,
        &[surface],
    )?;
    let all = file_conflicts::units(&planned);
    let mut reviewed: Vec<TakeBundledUnit> = Vec::new();
    for key in &units {
        if reviewed.iter().any(|unit| &unit.key == key) {
            continue;
        }
        // `take_bundled_operations` found every key, so the unit is there.
        let unit = all
            .iter()
            .find(|candidate| &candidate.key == key)
            .ok_or_else(|| UNKNOWN_UNIT.to_string())?;
        let (files, more_files) =
            file_conflicts::take_bundled_files(unit, &operations, &workspace_root, &home);
        let source = (unit.kind == file_conflicts::UnitKind::Skill)
            .then(|| {
                crate::skill_sources::SkillSources::for_workspace(&workspace_root)
                    .ok()
                    .and_then(|sources| {
                        sources
                            .pack_of(&unit.name)
                            .map(|pack| format!("pack:{pack}"))
                    })
            })
            .flatten();
        reviewed.push(TakeBundledUnit {
            source,
            key: unit.key.clone(),
            name: unit.name.clone(),
            folder: file_conflicts::unit_folder(unit, &home, &workspace_root),
            files,
            more_files,
            diff: file_conflicts::diff_unit(unit, &workspace_root, &home),
        });
    }
    Ok(TakeBundledPreview {
        surface,
        units: reviewed,
        plan_fingerprint: fingerprint,
        preview_token: token,
    })
}

/// Replaces the files of these units by the bundled ones, as the preview showed them. A regular
/// setup transaction: every file is backed up first, the files are written one by one and checked,
/// and the transaction can be rolled back while the files are unchanged. Nothing else is applied:
/// the surface's other updates stay for the regular update.
///
/// The files are planned again from what is on disk now. If any of them (or the choice to keep it)
/// changed since the preview, the fingerprint no longer matches and nothing is touched.
#[tauri::command(async)]
pub fn apply_take_bundled(
    surface: String,
    units: Vec<String>,
    plan_fingerprint: Option<String>,
    preview_token: Option<String>,
) -> Result<SetupResult, String> {
    let _mutation = crate::mutation_lock::acquire()?;
    check_take_bundled_units(&units)?;
    let surface = files_surface(&surface)?;
    let workspace_root = workspace_target_for_write()?;
    let home = user_home()?;
    super::setup::reconcile_before_preview_check(&workspace_root, &home)?;

    let expected = plan_fingerprint
        .as_deref()
        .ok_or_else(|| "Plan fingerprint required. Re-run preview before applying.".to_string())?;
    if !setup_transaction::validate_fingerprint_format(expected) {
        return Err("Malformed plan fingerprint".to_string());
    }
    let token = preview_token
        .as_deref()
        .ok_or_else(|| "Preview token required. Re-run preview before applying.".to_string())?;

    let operations = setup_transaction::plan_take_bundled(surface, &units, &workspace_root, &home)?;
    let current = setup_transaction::overwrite_fingerprint(&workspace_root, &home, &operations)?;
    if current != expected {
        return Err(
            "Plan fingerprint mismatch: the files changed after preview. Re-run preview before applying."
                .to_string(),
        );
    }
    setup_transaction::validate_preview_token(
        token,
        &workspace_root,
        expected,
        setup_transaction::PreviewPurpose::Apply,
        &[surface],
    )?;

    Ok(apply_planned_artifacts(
        &operations,
        Vec::new(),
        Some(token),
        &mut ProgressReporter::for_task("apply_take_bundled"),
    ))
}
