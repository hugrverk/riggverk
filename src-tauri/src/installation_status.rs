//! Product-level installation status for workspace and harness surfaces.

use std::path::Path;

use serde::Serialize;

use crate::file_conflicts::{self, FilesStatus};
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
    /// Skill and agent files the user keeps: not conflicts, never written by an update.
    pub kept_count: usize,
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
    /// Conflicting and kept files for the skills and agent surfaces; absent while there are none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<FilesStatus>,
    /// The enforced Codex config keys the user keeps or could keep; absent while there are none,
    /// and for every other surface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_config: Option<crate::codex_config_keep::CodexConfigStatus>,
    /// The data folder, for the workspace surface only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_folder: Option<DataFolderStatus>,
}

/// What the workspace row tells about the data folder. Counts and a flag, never file contents.
#[derive(Debug, Clone, Serialize)]
pub struct DataFolderStatus {
    /// Personal docs in `docs/context/`; the app never removes them.
    pub personal_docs: usize,
    /// Whether the ownership records (`.agent-workspace/managed-state.json`) exist yet.
    pub ownership_records: bool,
    /// Old copies of the bundle an update leaves in place: edited, or not provably the app's.
    pub left_in_place: usize,
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
        kept_count: 0,
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
            OperationKind::Manual if file_conflicts::is_kept(p) => counts.kept_count += 1,
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

/// The surfaces the ownership records hold anything for. Identities this version cannot read
/// count for none.
fn recorded_surfaces(
    records: Option<&crate::managed_state::ManagedState>,
) -> std::collections::HashSet<SetupSurfaceId> {
    records
        .into_iter()
        .flat_map(|state| state.artifacts.iter())
        .filter_map(|record| {
            crate::managed_bootstrap::artifact_from_identity(&record.identity).ok()
        })
        .map(|artifact| artifact.surface())
        .collect()
}

pub fn status_for_surfaces(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
) -> Result<InstallationStatus, String> {
    let planned = setup_transaction::plan_artifacts_for_surfaces(surfaces, workspace_root, home)?;
    let records = crate::managed_state::read_managed_state(workspace_root);
    let ownership_records = records.is_some();
    let recorded = recorded_surfaces(records.as_ref());
    // Records of another harness say nothing about this one: it is "not installed" until the
    // app has written something of its own.
    let has_trusted_state = surfaces.iter().any(|s| recorded.contains(s));
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
    // The folders each file's harnesses read, only worked out when there are files to report.
    let scope = if planned.iter().any(|p| p.file.is_some()) {
        setup_transaction::scope_for_surfaces(surfaces, home).ok()
    } else {
        None
    };
    let per_surface = surfaces
        .iter()
        .map(|surface| {
            surface_status(
                *surface,
                &planned,
                recorded.contains(surface),
                ownership_records,
                scope.as_ref(),
                workspace_root,
                home,
            )
        })
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
    ownership_records: bool,
    scope: Option<&crate::skill_roots::SkillScope>,
    workspace_root: &Path,
    home: &Path,
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
    let files = file_conflicts::files_status(surface, &own, scope, workspace_root, home);
    let detail = match &files {
        Some(files) => files_detail(detail, state, current_count, files.kept),
        None => detail,
    };
    let assessment = own.iter().find_map(|p| {
        p.rules
            .map(|rules| (rules, p.kind == OperationKind::Manual))
    });
    let detail = assessment
        .and_then(|(a, user_managed)| rules_detail(&a, user_managed))
        .unwrap_or(detail);
    let detail = own
        .iter()
        .find_map(|p| {
            p.mcp.and_then(|state| {
                mcp_detail(state, p.kind, setup_transaction::mcp_entry_key(&p.artifact))
            })
        })
        .unwrap_or(detail);
    let detail = own
        .iter()
        .find_map(|p| claude_settings_detail(p, workspace_root, home))
        .unwrap_or(detail);
    let codex_config = (surface == SetupSurfaceId::CodexConfig)
        .then(|| crate::codex_config_keep::status(workspace_root, home))
        .flatten();
    let detail = match &codex_config {
        Some(config) => codex_config_detail(
            detail,
            state,
            config,
            own.iter()
                .any(|p| p.kind == OperationKind::Conflict)
                .then(|| crate::codex_config_keep::conflict_reason(workspace_root, home))
                .flatten(),
        ),
        None => detail,
    };
    let data_folder = (surface == SetupSurfaceId::WorkspaceBundle).then(|| DataFolderStatus {
        personal_docs: crate::commands::personal_doc_count(workspace_root),
        ownership_records,
        left_in_place: own
            .iter()
            .filter(|p| p.kind == OperationKind::Manual)
            .count(),
    });
    let detail = match &data_folder {
        Some(folder) => workspace_detail(detail, state, counts.remove_count, folder.left_in_place),
        None => detail,
    };
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
        files,
        codex_config,
        data_folder,
    }
}

/// The status line of the workspace surface: the old copies of the bundle an update removes and
/// the ones it leaves in place. The surface wants no file, so "installed and current" says nothing.
fn workspace_detail(
    detail: String,
    state: InstallationState,
    remove_count: usize,
    left_in_place: usize,
) -> String {
    let left = (left_in_place > 0).then(|| format!("{left_in_place} left in place"));
    match state {
        InstallationState::UpdateAvailable => {
            let copies = if remove_count == 1 { "copy" } else { "copies" };
            [Some(format!("{remove_count} old {copies} to remove")), left]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(", ")
        }
        InstallationState::Current => left.unwrap_or_else(|| "none".to_string()),
        _ => detail,
    }
}

/// The status line of a skills or agents surface with files the user keeps. Counts only, never
/// the text of a file.
fn files_detail(
    detail: String,
    state: InstallationState,
    current_count: usize,
    kept: usize,
) -> String {
    if kept == 0 {
        return detail;
    }
    if state == InstallationState::Current && current_count == 0 {
        return format!("you manage {kept} file{}", if kept == 1 { "" } else { "s" });
    }
    format!("{detail}; you manage {kept}")
}

/// Status line for an MCP surface of a light harness; `None` where the generic one says it all.
/// Counts and fixed phrases only, never text of the file.
fn mcp_detail(
    state: crate::light_mcp::EntryState,
    kind: OperationKind,
    entry_key: &str,
) -> Option<String> {
    use crate::light_mcp::EntryState;
    match (state, kind) {
        (EntryState::EntryMissing, OperationKind::Update) => Some(format!(
            "the {entry_key} entry will be added; your other servers stay"
        )),
        (EntryState::Differs, OperationKind::Update) => {
            Some(format!("update available for the {entry_key} entry"))
        }
        (_, OperationKind::Conflict) => state.conflict_reason(entry_key),
        _ => None,
    }
}

/// Status line for Claude's attribution setting; `None` for every other artifact and for states
/// the generic line already covers. Fixed phrases only, never text of the file.
fn claude_settings_detail(
    planned: &setup_transaction::PlannedArtifact,
    workspace_root: &Path,
    home: &Path,
) -> Option<String> {
    if planned.artifact != crate::artifact_registry::ArtifactId::ClaudeSettings {
        return None;
    }
    match planned.kind {
        OperationKind::NoChange => Some(
            "attribution hidden by Riggverk · a project's .claude/settings.json or managed settings can override it"
                .to_string(),
        ),
        OperationKind::Create | OperationKind::Update => Some(
            "hides Claude Code's Co-Authored-By commit line and \"Generated with Claude Code\" PR line · sets attribution.commit and attribution.pr to \"\" in ~/.claude/settings.json · other settings stay"
                .to_string(),
        ),
        OperationKind::Manual => {
            Some("you set attribution yourself; Riggverk leaves it as is".to_string())
        }
        OperationKind::Conflict => {
            setup_transaction::claude_settings_conflict_reason(workspace_root, home)
        }
        OperationKind::Unavailable | OperationKind::Remove => None,
    }
}

/// "approvals_reviewer = auto_review, sandbox_mode = read-only": key names and the kept values of
/// the enforced approval and sandbox keys, nothing secret.
fn key_values(items: &[crate::codex_config_keep::KeyValue]) -> String {
    items
        .iter()
        .map(|item| format!("{} = {}", item.key, item.value))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Status line of the Codex config when the user keeps enforced keys or could keep some. The other
/// managed keys follow Riggverk, and the line says so, so "kept" is not read as "left alone".
fn codex_config_detail(
    detail: String,
    state: InstallationState,
    config: &crate::codex_config_keep::CodexConfigStatus,
    conflict_reason: Option<String>,
) -> String {
    if state == InstallationState::Conflict {
        if let Some(reason) = conflict_reason {
            return reason;
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if !(state == InstallationState::Current && !config.kept.is_empty()) {
        parts.push(detail);
    }
    if !config.kept.is_empty() {
        parts.push(format!(
            "you keep {}; other managed keys follow Riggverk",
            key_values(&config.kept)
        ));
    }
    if !config.differing.is_empty() {
        parts.push(format!(
            "{} differ{} from Riggverk's; m keeps your value{}",
            config
                .differing
                .iter()
                .map(|item| item.key.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            if config.differing.len() == 1 { "s" } else { "" },
            if config.differing.len() == 1 { "" } else { "s" },
        ));
    }
    parts.join("; ")
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
        RulesPlan::Conflict(RulesConflict::MaskedByOverride) => {
            Some("an override file in the same folder masks this file, left as is".to_string())
        }
        RulesPlan::Conflict(RulesConflict::PeerContextFile) => Some(
            "another context file in this folder would be hidden by a new one, nothing written"
                .to_string(),
        ),
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
        ArtifactId::ClaudeSettings => "Claude settings".into(),
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
        ArtifactId::HarnessRules(harness) => format!(
            "{} rules",
            crate::light_harness::display_name(harness.harness())
        ),
        ArtifactId::HarnessMcp(harness) => format!(
            "{} Playwright MCP entry",
            crate::light_harness::display_name(harness.harness())
        ),
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
            mcp: None,
            file: None,
            overwrite: None,
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
        let _env = crate::test_env::guard::default_xdg_config_home();
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
