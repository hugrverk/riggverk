//! Product-level installation status for workspace and harness surfaces.

use std::path::Path;

use serde::Serialize;

use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
use crate::setup_transaction;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum InstallationState {
    NotInstalled,
    UpdateAvailable,
    Current,
    Conflict,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallationCounts {
    pub create_count: usize,
    pub update_count: usize,
    pub remove_count: usize,
    pub conflict_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallationStatus {
    pub state: InstallationState,
    pub summary: String,
    pub counts: InstallationCounts,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflict_details: Vec<String>,
}

fn aggregate_state(
    planned: &[setup_transaction::PlannedArtifact],
) -> (InstallationState, InstallationCounts, Vec<String>) {
    let mut counts = InstallationCounts {
        create_count: 0,
        update_count: 0,
        remove_count: 0,
        conflict_count: 0,
    };
    let mut conflicts = Vec::new();
    let mut has_apply = false;
    let mut has_unavailable = false;

    for p in planned {
        match p.kind {
            OperationKind::Create => {
                counts.create_count += 1;
                has_apply = true;
            }
            OperationKind::Update => {
                counts.update_count += 1;
                has_apply = true;
            }
            OperationKind::Remove => {
                counts.remove_count += 1;
                has_apply = true;
            }
            OperationKind::Conflict => {
                counts.conflict_count += 1;
                conflicts.push(format!("{:?}", p.artifact));
            }
            OperationKind::Unavailable => has_unavailable = true,
            _ => {}
        }
    }

    let state = if counts.conflict_count > 0 {
        InstallationState::Conflict
    } else if has_unavailable && !has_apply {
        InstallationState::Unavailable
    } else if has_apply {
        InstallationState::UpdateAvailable
    } else {
        InstallationState::Current
    };
    (state, counts, conflicts)
}

pub fn status_for_surfaces(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
) -> Result<InstallationStatus, String> {
    let planned = setup_transaction::plan_artifacts_for_surfaces(surfaces, workspace_root, home)?;
    let (state, counts, conflict_details) = aggregate_state(&planned);
    let summary = match state {
        InstallationState::NotInstalled => "Not installed".into(),
        InstallationState::UpdateAvailable => {
            format!(
                "Update available: {} to create, {} to update, {} to remove",
                counts.create_count, counts.update_count, counts.remove_count
            )
        }
        InstallationState::Current => "Current".into(),
        InstallationState::Conflict => {
            format!("{} conflict(s) require review", counts.conflict_count)
        }
        InstallationState::Unavailable => "Unavailable on this system".into(),
    };
    Ok(InstallationStatus {
        state,
        summary,
        counts,
        conflict_details,
    })
}
