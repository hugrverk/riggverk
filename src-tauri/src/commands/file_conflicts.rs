//! Commands for conflicts on skill and agent files.
//!
//! A skill or agent file the user edited by hand is a conflict the regular update refuses to
//! overwrite. These commands let the user see what differs from the bundled file and keep their
//! version (or hand it back to the app). Neither writes a skill or agent file: the diff is
//! read-only, and keeping writes only `kept-files.json`.
//!
//! The UI names a surface and opaque unit keys, never a path or an identity. Each command plans
//! the surface again and acts on the files that plan holds.

use std::path::PathBuf;

use super::workspace::setup_workspace_target_path;
use crate::artifact_registry::ArtifactId;
use crate::file_conflicts::{self, FileDiffView};
use crate::kept_files::{self, Keep};
use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
use crate::setup_transaction::{self, PlannedArtifact};

/// Most units one `set_files_kept` call names.
const MAX_UNITS_PER_CALL: usize = 200;

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
    let _mutation = crate::mutation_lock::acquire();
    let surface = files_surface(&surface)?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    let Planned {
        workspace_root,
        home,
        planned,
    } = plan(surface)?;
    let bundled_root = crate::setup_roots::bundled_root_for(&workspace_root)?;
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
    bundled_root: &std::path::Path,
    home: &std::path::Path,
) -> Option<String> {
    crate::setup_fingerprint::artifact_source_digest(artifact, bundled_root, home).ok()
}
