//! Product-level installation status for workspace and harness surfaces.

use std::path::Path;

use serde::Serialize;

use crate::rules_block::{MalformedReason, RulesConflict, RulesLayout, RulesPlan};
use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
use crate::setup_transaction;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
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
    pub surfaces: Vec<SurfaceInstallationStatus>,
}

/// Per-surface state so the UI can show what is installed and current
/// instead of one opaque aggregate.
#[derive(Debug, Clone, Serialize)]
pub struct SurfaceInstallationStatus {
    pub surface: SetupSurfaceId,
    pub label: String,
    pub state: InstallationState,
    pub detail: String,
    /// Block details for rules surfaces; absent for every other surface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<RulesStatus>,
}

/// How a rules file relates to the managed base block.
#[derive(Debug, Clone, Serialize)]
pub struct RulesStatus {
    /// `absent`, `block`, `legacy` (no markers), or `malformed`.
    pub layout: RulesLayout,
    /// Non-blank user lines around the block; kept on every base update.
    pub refinement_lines: usize,
    /// Why the file is left alone, when it is a conflict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_reason: Option<RulesConflict>,
    /// Which marker rule failed, for `malformed_markers`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub malformed_reason: Option<MalformedReason>,
    /// The user chose to manage this hand-edited file themselves: it is not
    /// reported as a conflict and Riggverk leaves it alone.
    pub user_managed: bool,
}

fn aggregate_state(
    planned: &[setup_transaction::PlannedArtifact],
    has_trusted_state: bool,
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
    let mut has_present = false;

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
                conflicts.push(artifact_label(&p.artifact));
            }
            OperationKind::Unavailable => has_unavailable = true,
            OperationKind::NoChange => has_present = true,
            _ => {}
        }
    }

    let state = if has_apply {
        if !has_trusted_state
            && counts.create_count > 0
            && counts.update_count == 0
            && counts.remove_count == 0
            && counts.conflict_count == 0
            && !has_present
        {
            InstallationState::NotInstalled
        } else {
            InstallationState::UpdateAvailable
        }
    } else if counts.conflict_count > 0 {
        InstallationState::Conflict
    } else if has_unavailable && !has_apply {
        InstallationState::Unavailable
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
    let has_trusted_state = crate::managed_state::read_managed_state(workspace_root).is_some();
    let (state, counts, conflict_details) = aggregate_state(&planned, has_trusted_state);
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
    let per_surface = surfaces
        .iter()
        .map(|surface| surface_status(*surface, &planned, has_trusted_state))
        .collect();
    Ok(InstallationStatus {
        state,
        summary,
        counts,
        conflict_details,
        surfaces: per_surface,
    })
}

fn surface_status(
    surface: SetupSurfaceId,
    planned: &[setup_transaction::PlannedArtifact],
    has_trusted_state: bool,
) -> SurfaceInstallationStatus {
    let own: Vec<setup_transaction::PlannedArtifact> = planned
        .iter()
        .filter(|p| p.surface == surface)
        .cloned()
        .collect();
    let (state, counts, _) = aggregate_state(&own, has_trusted_state);
    let current_count = own
        .iter()
        .filter(|p| p.kind == OperationKind::NoChange)
        .count();
    let detail = match state {
        InstallationState::Current => {
            if current_count == 1 {
                "installed and current".to_string()
            } else {
                format!("{current_count} installed and current")
            }
        }
        InstallationState::NotInstalled => format!("{} to install", counts.create_count),
        InstallationState::UpdateAvailable => {
            let mut parts: Vec<String> = Vec::new();
            if current_count > 0 {
                parts.push(format!("{current_count} current"));
            }
            if counts.create_count > 0 {
                parts.push(format!("{} to create", counts.create_count));
            }
            if counts.update_count > 0 {
                parts.push(format!("{} to update", counts.update_count));
            }
            if counts.remove_count > 0 {
                parts.push(format!("{} old to remove", counts.remove_count));
            }
            if counts.conflict_count > 0 {
                parts.push(format!("{} conflicts", counts.conflict_count));
            }
            parts.join(", ")
        }
        InstallationState::Conflict => format!("{} conflicts preserved", counts.conflict_count),
        InstallationState::Unavailable => "unavailable".to_string(),
    };
    let assessment = own.iter().find_map(|p| {
        p.rules
            .map(|rules| (rules, p.kind == OperationKind::Manual))
    });
    let detail = assessment
        .and_then(|(a, user_managed)| rules_detail(&a, user_managed))
        .unwrap_or(detail);
    let rules = assessment.map(|(a, user_managed)| RulesStatus {
        layout: a.layout,
        refinement_lines: a.refinement_lines,
        conflict_reason: match a.plan {
            RulesPlan::Conflict(reason) => Some(reason),
            _ => None,
        },
        malformed_reason: a.malformed,
        user_managed,
    });
    SurfaceInstallationStatus {
        surface,
        label: surface.label().to_string(),
        state,
        detail,
        rules,
    }
}

/// Status line for a rules surface. A base update that keeps the user's text
/// is an update, never a conflict; only edits the app cannot merge are.
fn rules_detail(
    assessment: &crate::rules_block::RulesAssessment,
    user_managed: bool,
) -> Option<String> {
    if user_managed {
        return Some(
            "base updates available; you manage this file, so none are applied".to_string(),
        );
    }
    let kept = match assessment.refinement_lines {
        0 => String::new(),
        1 => "; refinements: 1 line preserved".to_string(),
        lines => format!("; refinements: {lines} lines preserved"),
    };
    match assessment.plan {
        RulesPlan::Create => None,
        RulesPlan::NoChange => Some(format!("installed and current{kept}")),
        RulesPlan::UpdateBlock => Some(format!("base update available{kept}")),
        RulesPlan::WrapLegacy => {
            Some("unmodified file will move into the managed base block".to_string())
        }
        RulesPlan::Conflict(RulesConflict::BaseBlockEdited) => {
            Some(format!("base block was edited, left as is{kept}"))
        }
        RulesPlan::Conflict(RulesConflict::LegacyDiverged) => {
            Some("file differs from every shipped base, left as is".to_string())
        }
        RulesPlan::Conflict(RulesConflict::MalformedMarkers) => Some(format!(
            "base block markers are malformed ({}), left as is",
            assessment
                .malformed
                .map(MalformedReason::message)
                .unwrap_or("unreadable")
        )),
    }
}

pub(crate) fn artifact_label(artifact: &crate::artifact_registry::ArtifactId) -> String {
    use crate::artifact_registry::ArtifactId;
    match artifact {
        ArtifactId::OpenCodeConfig => "OpenCode configuration".into(),
        ArtifactId::OpenCodeTui => "OpenCode terminal configuration".into(),
        ArtifactId::OpenCodePlaywrightMcp => "OpenCode Playwright configuration".into(),
        ArtifactId::OpenCodeRules => "OpenCode rules".into(),
        ArtifactId::OpenCodeAgent(name) => format!("OpenCode agent {}", name.as_str()),
        ArtifactId::OpenCodeSkill(name) => format!("OpenCode skill {}", name.as_str()),
        ArtifactId::CodexConfig => "Codex configuration".into(),
        ArtifactId::CodexRules => "Codex rules".into(),
        ArtifactId::CodexAgent(name) => format!("Codex agent {}", name.as_str()),
        ArtifactId::CodexSkill(name) => format!("Codex skill {}", name.as_str()),
        ArtifactId::ClaudeRules => "Claude rules".into(),
        ArtifactId::ClaudeAgent(name) => format!("Claude agent {}", name.as_str()),
        ArtifactId::ClaudeSkill(name) => format!("Claude skill {}", name.as_str()),
        ArtifactId::CursorAgent(name) => format!("Cursor agent {}", name.as_str()),
        ArtifactId::CursorSkill(name) => format!("Cursor skill {}", name.as_str()),
        ArtifactId::CursorMcp => "Cursor Playwright configuration".into(),
        ArtifactId::CodexLegacySkill(name) => format!("Legacy Codex skill {}", name.as_str()),
        ArtifactId::SkillFile(file) => format!(
            "Skill {}/{} in {}",
            file.skill.as_str(),
            file.rel.as_str(),
            file.root.display()
        ),
        ArtifactId::WorkspaceFile(path) => format!("Workspace file {}", path.as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_registry::{ArtifactId, SkillName};
    use crate::setup_transaction::{PlannedArtifact, PreviousState, RollbackAction};

    fn planned(kind: OperationKind, artifact: ArtifactId) -> PlannedArtifact {
        PlannedArtifact {
            surface: artifact.surface(),
            artifact,
            kind,
            previous_state: PreviousState::Absent,
            rollback_action: RollbackAction::NoAction,
            rules: None,
            rules_rewrite: None,
        }
    }

    #[test]
    fn empty_unmanaged_profile_is_not_installed() {
        let artifacts = vec![planned(OperationKind::Create, ArtifactId::OpenCodeRules)];
        assert_eq!(
            aggregate_state(&artifacts, false).0,
            InstallationState::NotInstalled
        );
    }

    #[test]
    fn partial_exact_profile_is_update_available() {
        let artifacts = vec![
            planned(OperationKind::NoChange, ArtifactId::OpenCodeRules),
            planned(
                OperationKind::Create,
                ArtifactId::OpenCodeSkill(SkillName::new("browser-qa").unwrap()),
            ),
        ];
        assert_eq!(
            aggregate_state(&artifacts, false).0,
            InstallationState::UpdateAvailable
        );
    }

    #[test]
    fn safe_updates_remain_available_beside_conflicts() {
        let artifacts = vec![
            planned(OperationKind::Create, ArtifactId::OpenCodeRules),
            planned(
                OperationKind::Conflict,
                ArtifactId::OpenCodeSkill(SkillName::new("browser-qa").unwrap()),
            ),
        ];
        let (state, counts, conflicts) = aggregate_state(&artifacts, false);
        assert_eq!(state, InstallationState::UpdateAvailable);
        assert_eq!(counts.create_count, 1);
        assert_eq!(counts.conflict_count, 1);
        assert_eq!(conflicts, vec!["OpenCode skill browser-qa"]);
    }

    #[test]
    fn skill_file_labels_name_the_skill_file_and_its_folder() {
        use crate::artifact_registry::SkillRelPath;
        use crate::skill_roots::SkillRoot;
        let label = |root, rel: &str| {
            artifact_label(&ArtifactId::skill_file(
                root,
                SkillName::new("tdd").unwrap(),
                SkillRelPath::new(rel).unwrap(),
            ))
        };
        assert_eq!(
            label(SkillRoot::Claude, "SKILL.md"),
            "Skill tdd/SKILL.md in ~/.claude/skills"
        );
        assert_eq!(
            label(SkillRoot::CodexHome, "assets/a.html"),
            "Skill tdd/assets/a.html in $CODEX_HOME/skills"
        );
        assert_eq!(
            label(SkillRoot::OpenCode, "LICENSE"),
            "Skill tdd/LICENSE in ~/.config/opencode/skills"
        );
        let conflicts = vec![planned(
            OperationKind::Conflict,
            ArtifactId::skill_file(
                SkillRoot::Claude,
                SkillName::new("security-audit").unwrap(),
                SkillRelPath::new("HUNTING.md").unwrap(),
            ),
        )];
        assert_eq!(
            aggregate_state(&conflicts, true).2,
            vec!["Skill security-audit/HUNTING.md in ~/.claude/skills"]
        );
    }

    #[test]
    fn conflicts_without_safe_work_require_review() {
        let artifacts = vec![planned(OperationKind::Conflict, ArtifactId::OpenCodeRules)];
        assert_eq!(
            aggregate_state(&artifacts, true).0,
            InstallationState::Conflict
        );
    }
}
