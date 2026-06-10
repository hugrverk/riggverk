//! Unified setup lifecycle types and planner.
//!
//! Models the detect → compare → preview → apply → validate → repair → rollback
//! lifecycle for all Agent Workspace managed surfaces.
//!
//! Phase ownership:
//! - detect / compare  → runtime health commands (opencode_runtime, codex_runtime, etc.)
//! - preview            → this planner
//! - apply / repair     → workspace / actions commands (Item 7)
//! - rollback           → workspace / backups commands (Item 8)
//!
//! This module defines narrow serializable types and the preview planner only.
//! No write execution is included.

use serde::{Deserialize, Serialize};

// ── Surface identity ──

/// Identifies a managed setup surface that can be detected, compared,
/// created, updated, repaired, or rolled back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupSurfaceId {
    /// OpenCode runtime configuration (opencode.json managed keys)
    OpenCodeConfig,
    /// OpenCode agent files
    OpenCodeAgents,
    /// OpenCode rules (.config/opencode/AGENTS.md)
    OpenCodeRules,
    /// Codex runtime configuration (config.toml managed sections)
    CodexConfig,
    /// Codex agent files
    CodexAgents,
    /// Codex rules (.codex/AGENTS.md)
    CodexRules,
    /// Claude rules (.claude/CLAUDE.md)
    ClaudeRules,
    /// Claude native agent files (templates/claude/agents)
    ClaudeAgents,
    /// Claude skills (.claude/skills)
    ClaudeSkills,
    /// Cursor workspace setup (agents, rules, profile)
    CursorSetup,
    /// OpenCode skills (.config/opencode/skills)
    OpenCodeSkills,
    /// Codex skills (.agents/skills)
    CodexSkills,
    /// Bundled deprecated skill removal
    DeprecatedSkillCleanup,
}

impl SetupSurfaceId {
    /// All known surface IDs for validation.
    pub const ALL: &'static [SetupSurfaceId] = &[
        SetupSurfaceId::OpenCodeConfig,
        SetupSurfaceId::OpenCodeAgents,
        SetupSurfaceId::OpenCodeRules,
        SetupSurfaceId::CodexConfig,
        SetupSurfaceId::CodexAgents,
        SetupSurfaceId::CodexRules,
        SetupSurfaceId::ClaudeRules,
        SetupSurfaceId::ClaudeAgents,
        SetupSurfaceId::ClaudeSkills,
        SetupSurfaceId::CursorSetup,
        SetupSurfaceId::OpenCodeSkills,
        SetupSurfaceId::CodexSkills,
        SetupSurfaceId::DeprecatedSkillCleanup,
    ];

    /// Human-readable label.
    pub fn label(&self) -> &'static str {
        match self {
            SetupSurfaceId::OpenCodeConfig => "OpenCode Config",
            SetupSurfaceId::OpenCodeAgents => "OpenCode Agents",
            SetupSurfaceId::OpenCodeRules => "OpenCode Rules",
            SetupSurfaceId::CodexConfig => "Codex Config",
            SetupSurfaceId::CodexAgents => "Codex Agents",
            SetupSurfaceId::CodexRules => "Codex Rules",
            SetupSurfaceId::ClaudeRules => "Claude Rules",
            SetupSurfaceId::ClaudeAgents => "Claude Agents",
            SetupSurfaceId::ClaudeSkills => "Claude Skills",
            SetupSurfaceId::CursorSetup => "Cursor Setup",
            SetupSurfaceId::OpenCodeSkills => "OpenCode Skills",
            SetupSurfaceId::CodexSkills => "Codex Skills",
            SetupSurfaceId::DeprecatedSkillCleanup => "Deprecated Skills",
        }
    }

    /// Returns true if this surface is read-only in the app (managed externally).
    pub fn is_manual_only(&self) -> bool {
        matches!(self, SetupSurfaceId::ClaudeSkills)
    }
}

// ── Operation state ──

/// Classification for a planned operation on a surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    /// Surface already matches workspace state.
    NoChange,
    /// Surface needs to be created (no existing state).
    Create,
    /// Surface exists but differs from workspace state.
    Update,
    /// Surface state conflicts with workspace (cannot auto-resolve).
    Conflict,
    /// Surface requires manual user action.
    Manual,
    /// Surface is unavailable (tool not installed or workspace not found).
    Unavailable,
}

impl OperationKind {
    pub fn needs_apply(&self) -> bool {
        matches!(self, OperationKind::Create | OperationKind::Update)
    }

    pub fn is_blocking(&self) -> bool {
        matches!(self, OperationKind::Conflict | OperationKind::Unavailable)
    }
}

// ── Plan types ──

/// A single planned operation for one surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedOperation {
    /// The surface this operation applies to.
    pub surface: SetupSurfaceId,
    /// Classified operation kind.
    pub kind: OperationKind,
    /// Human-readable summary of what changed or why.
    pub summary: String,
    /// Optional detail lines for display.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
    /// If this is a conflict, describes what the user must resolve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_description: Option<String>,
    /// If this is manual, describes what the user must do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_step: Option<String>,
}

/// Summary of validation results after an apply or repair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub surface: SetupSurfaceId,
    pub passed: bool,
    pub message: String,
}

/// Summary of a completed or planned transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionSummary {
    pub transaction_id: String,
    pub surface_count: usize,
    pub applied: Vec<String>,
    pub failed: Vec<String>,
    pub rolled_back: Vec<String>,
    pub manual_steps: Vec<String>,
}

// ── Plan result ──

/// The result of planning a setup operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupPlan {
    /// All operations, in apply order.
    pub operations: Vec<PlannedOperation>,
    /// Surfaces that have no pending changes.
    pub synced: Vec<SetupSurfaceId>,
    /// Surfaces blocked by conflicts.
    pub conflicts: Vec<PlannedOperation>,
    /// Surfaces requiring manual intervention.
    pub manual_steps: Vec<PlannedOperation>,
    /// Overall summary.
    pub summary: String,
    /// Whether any operation requires apply.
    pub has_pending_changes: bool,
    /// Whether any conflict blocks apply.
    pub is_blocked: bool,
}

// ── Planner ──

/// Frontend-safe input for requesting a setup plan or apply.
///
/// Contains only allowlisted surface IDs and bounded options.
/// Never contains commands, shell fragments, absolute paths, or file paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupRequest {
    /// Which surfaces to include.  Empty = all available.
    #[serde(default)]
    pub surfaces: Vec<SetupSurfaceId>,
    /// If true, skip surfaces that are in manual-only mode.
    #[serde(default)]
    pub skip_manual: bool,
}

/// Creates a setup plan by classifying each requested surface.
///
/// This is the core planning function.  It does not inspect actual filesystem
/// state — callers pass in the detected status for each surface and the planner
/// classifies it.
///
/// The caller (a runtime health command or the unified setup orchestrator)
/// is responsible for:
/// 1. Detecting the current state of each surface
/// 2. Comparing it with the desired workspace state
/// 3. Passing the comparison results here
/// 4. Executing the plan via the apply/repair/rollback commands
pub fn plan_setup(
    request: &SetupRequest,
    surface_states: &[(SetupSurfaceId, OperationKind, String)],
) -> SetupPlan {
    let mut operations: Vec<PlannedOperation> = Vec::new();
    let mut synced: Vec<SetupSurfaceId> = Vec::new();
    let mut conflicts: Vec<PlannedOperation> = Vec::new();
    let mut manual_steps: Vec<PlannedOperation> = Vec::new();
    let mut has_pending_changes = false;
    let mut is_blocked = false;

    let requested: Vec<SetupSurfaceId> = if request.surfaces.is_empty() {
        SetupSurfaceId::ALL.to_vec()
    } else {
        // Validate and deduplicate request
        let mut seen = std::collections::HashSet::new();
        request
            .surfaces
            .iter()
            .filter(|s| SetupSurfaceId::ALL.contains(s) && seen.insert(*s))
            .copied()
            .collect()
    };

    for surface in &requested {
        if *surface == SetupSurfaceId::ClaudeSkills && request.skip_manual {
            synced.push(*surface);
            continue;
        }

        let state = surface_states.iter().find(|(s, _, _)| s == surface);
        let (kind, summary) = match state {
            Some((_, kind, summary)) => (*kind, summary.clone()),
            None => {
                // Surface not reported — treat as unavailable
                let op = PlannedOperation {
                    surface: *surface,
                    kind: OperationKind::Unavailable,
                    summary: "State not reported".to_string(),
                    details: Vec::new(),
                    conflict_description: None,
                    manual_step: None,
                };
                operations.push(op);
                is_blocked = true;
                continue;
            }
        };

        let detail_lines: Vec<String> = Vec::new();

        match kind {
            OperationKind::NoChange => {
                synced.push(*surface);
            }
            OperationKind::Create | OperationKind::Update => {
                has_pending_changes = true;
                let op = PlannedOperation {
                    surface: *surface,
                    kind,
                    summary,
                    details: detail_lines,
                    conflict_description: None,
                    manual_step: None,
                };
                operations.push(op);
            }
            OperationKind::Conflict => {
                is_blocked = true;
                let op = PlannedOperation {
                    surface: *surface,
                    kind,
                    summary: summary.clone(),
                    details: detail_lines,
                    conflict_description: Some(summary),
                    manual_step: None,
                };
                operations.push(op.clone());
                conflicts.push(op);
            }
            OperationKind::Manual => {
                let step = format!("{} requires manual setup. See docs.", surface.label());
                let op = PlannedOperation {
                    surface: *surface,
                    kind,
                    summary: summary.clone(),
                    details: detail_lines,
                    conflict_description: None,
                    manual_step: Some(step.clone()),
                };
                operations.push(op.clone());
                manual_steps.push(op);
            }
            OperationKind::Unavailable => {
                is_blocked = true;
                let op = PlannedOperation {
                    surface: *surface,
                    kind,
                    summary,
                    details: detail_lines,
                    conflict_description: None,
                    manual_step: None,
                };
                operations.push(op);
            }
        }
    }

    // Sort: changes first (create/update), then manual/unavailable, then synced
    operations.sort_by_key(|op| match op.kind {
        OperationKind::Create => 0u8,
        OperationKind::Update => 1,
        OperationKind::Manual => 2,
        OperationKind::Conflict => 3,
        OperationKind::Unavailable => 4,
        OperationKind::NoChange => 5,
    });

    let change_count = operations
        .iter()
        .filter(|op| op.kind.needs_apply())
        .count();
    let summary = if is_blocked {
        format!(
            "Blocked: {} conflict(s) prevent apply",
            conflicts.len()
        )
    } else if has_pending_changes {
        format!("{} surface(s) need update", change_count)
    } else {
        "All surfaces synced".to_string()
    };

    SetupPlan {
        operations,
        synced,
        conflicts,
        manual_steps,
        summary,
        has_pending_changes,
        is_blocked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_change(surface: SetupSurfaceId) -> (SetupSurfaceId, OperationKind, String) {
        (surface, OperationKind::NoChange, "synced".to_string())
    }

    fn create(surface: SetupSurfaceId) -> (SetupSurfaceId, OperationKind, String) {
        (surface, OperationKind::Create, "not installed".to_string())
    }

    fn update(surface: SetupSurfaceId) -> (SetupSurfaceId, OperationKind, String) {
        (surface, OperationKind::Update, "version differs".to_string())
    }

    fn conflict(surface: SetupSurfaceId) -> (SetupSurfaceId, OperationKind, String) {
        (
            surface,
            OperationKind::Conflict,
            "user file has diverged".to_string(),
        )
    }

    fn manual(surface: SetupSurfaceId) -> (SetupSurfaceId, OperationKind, String) {
        (
            surface,
            OperationKind::Manual,
            "requires manual config".to_string(),
        )
    }

    fn unavailable(surface: SetupSurfaceId) -> (SetupSurfaceId, OperationKind, String) {
        (
            surface,
            OperationKind::Unavailable,
            "tool not found".to_string(),
        )
    }

    // ── Tests ──

    #[test]
    fn empty_request_plans_all_surfaces() {
        let request = SetupRequest {
            surfaces: vec![],
            skip_manual: false,
        };
        let states: Vec<_> = SetupSurfaceId::ALL
            .iter()
            .map(|s| no_change(*s))
            .collect();
        let plan = plan_setup(&request, &states);
        assert!(!plan.has_pending_changes);
        assert!(!plan.is_blocked);
        assert!(plan.conflicts.is_empty());
        assert_eq!(plan.synced.len(), SetupSurfaceId::ALL.len());
    }

    #[test]
    fn create_and_update_produce_pending_changes() {
        let request = SetupRequest {
            surfaces: vec![
                SetupSurfaceId::OpenCodeConfig,
                SetupSurfaceId::OpenCodeAgents,
            ],
            skip_manual: false,
        };
        let states = vec![
            create(SetupSurfaceId::OpenCodeConfig),
            update(SetupSurfaceId::OpenCodeAgents),
        ];
        let plan = plan_setup(&request, &states);
        assert!(plan.has_pending_changes);
        assert!(!plan.is_blocked);
        assert_eq!(
            plan.operations.len(),
            2,
            "both surfaces should have operations"
        );
        assert_eq!(
            plan.operations[0].kind,
            OperationKind::Create,
            "create before update"
        );
        assert_eq!(
            plan.operations[1].kind,
            OperationKind::Update,
            "update after create"
        );
    }

    #[test]
    fn conflict_blocks_plan() {
        let request = SetupRequest {
            surfaces: vec![
                SetupSurfaceId::OpenCodeConfig,
                SetupSurfaceId::CodexRules,
            ],
            skip_manual: false,
        };
        let states = vec![
            conflict(SetupSurfaceId::OpenCodeConfig),
            no_change(SetupSurfaceId::CodexRules),
        ];
        let plan = plan_setup(&request, &states);
        assert!(plan.is_blocked);
        assert!(!plan.has_pending_changes);
        assert_eq!(plan.conflicts.len(), 1);
    }

    #[test]
    fn unavailable_blocks_plan() {
        let request = SetupRequest {
            surfaces: vec![SetupSurfaceId::CursorSetup],
            skip_manual: false,
        };
        let states = vec![unavailable(SetupSurfaceId::CursorSetup)];
        let plan = plan_setup(&request, &states);
        assert!(plan.is_blocked);
        assert!(!plan.has_pending_changes);
    }

    #[test]
    fn manual_surfaces_dont_block() {
        let request = SetupRequest {
            surfaces: vec![SetupSurfaceId::ClaudeSkills],
            skip_manual: false,
        };
        let states = vec![manual(SetupSurfaceId::ClaudeSkills)];
        let plan = plan_setup(&request, &states);
        assert!(!plan.is_blocked, "manual steps should not block apply");
        assert!(!plan.has_pending_changes);
        assert_eq!(plan.manual_steps.len(), 1);
    }

    #[test]
    fn skip_manual_excludes_manual_surfaces() {
        let request = SetupRequest {
            surfaces: vec![SetupSurfaceId::ClaudeSkills],
            skip_manual: true,
        };
        let states = vec![manual(SetupSurfaceId::ClaudeSkills)];
        let plan = plan_setup(&request, &states);
        assert!(
            plan.operations.is_empty(),
            "manual surface excluded by skip_manual"
        );
        assert!(plan.synced.contains(&SetupSurfaceId::ClaudeSkills));
    }

    #[test]
    fn all_mixed_states_produce_correct_plan() {
        let request = SetupRequest {
            surfaces: vec![],
            skip_manual: false,
        };
        let states = vec![
            create(SetupSurfaceId::OpenCodeConfig),
            update(SetupSurfaceId::CodexRules),
            no_change(SetupSurfaceId::ClaudeRules),
            conflict(SetupSurfaceId::CursorSetup),
            manual(SetupSurfaceId::ClaudeSkills),
            unavailable(SetupSurfaceId::CodexAgents),
        ];
        let plan = plan_setup(&request, &states);
        assert!(plan.is_blocked);
        assert!(plan.has_pending_changes);
        // Should have operations for create, update, conflict, manual, unavailable
        let needs_apply: Vec<_> = plan
            .operations
            .iter()
            .filter(|op| op.kind.needs_apply())
            .collect();
        assert_eq!(needs_apply.len(), 2, "create + update");
        assert_eq!(plan.conflicts.len(), 1, "one conflict");
        assert_eq!(plan.manual_steps.len(), 1, "one manual");
    }

    #[test]
    fn surface_id_labels_are_non_empty() {
        for surface in SetupSurfaceId::ALL {
            assert!(!surface.label().is_empty(), "{:?} must have a label", surface);
        }
    }

    #[test]
    fn claude_skills_is_manual_only() {
        assert!(SetupSurfaceId::ClaudeSkills.is_manual_only());
        assert!(!SetupSurfaceId::OpenCodeConfig.is_manual_only());
    }

    #[test]
    fn frontend_request_is_serializable() {
        let req = SetupRequest {
            surfaces: vec![SetupSurfaceId::OpenCodeConfig],
            skip_manual: true,
        };
        let json = serde_json::to_string(&req).expect("serialize");
        let deserialized: SetupRequest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized.surfaces.len(), 1);
        assert!(deserialized.skip_manual);
    }

    #[test]
    fn setup_plan_is_serializable() {
        let plan = SetupPlan {
            operations: vec![PlannedOperation {
                surface: SetupSurfaceId::OpenCodeConfig,
                kind: OperationKind::Create,
                summary: "not installed".to_string(),
                details: vec![],
                conflict_description: None,
                manual_step: None,
            }],
            synced: vec![],
            conflicts: vec![],
            manual_steps: vec![],
            summary: "1 surface(s) need update".to_string(),
            has_pending_changes: true,
            is_blocked: false,
        };
        let json = serde_json::to_string(&plan).expect("serialize plan");
        let deserialized: SetupPlan = serde_json::from_str(&json).expect("deserialize plan");
        // Verify key fields round-trip
        assert_eq!(deserialized.operations.len(), 1);
        assert_eq!(
            deserialized.operations[0].surface,
            SetupSurfaceId::OpenCodeConfig
        );
        assert_eq!(deserialized.operations[0].kind, OperationKind::Create);
    }

    #[test]
    fn surface_not_reported_is_unavailable() {
        let request = SetupRequest {
            surfaces: vec![SetupSurfaceId::OpenCodeConfig],
            skip_manual: false,
        };
        // Empty states — no state reported for the requested surface
        let plan = plan_setup(&request, &[]);
        assert!(plan.is_blocked);
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(plan.operations[0].kind, OperationKind::Unavailable);
    }

    #[test]
    fn duplicate_surface_in_request_is_deduplicated() {
        let request = SetupRequest {
            surfaces: vec![
                SetupSurfaceId::OpenCodeConfig,
                SetupSurfaceId::OpenCodeConfig,
            ],
            skip_manual: false,
        };
        let states = vec![create(SetupSurfaceId::OpenCodeConfig)];
        let plan = plan_setup(&request, &states);
        assert_eq!(plan.operations.len(), 1);
    }

    #[test]
    fn no_conflicts_when_all_synced() {
        let request = SetupRequest {
            surfaces: vec![],
            skip_manual: false,
        };
        let states: Vec<_> = SetupSurfaceId::ALL
            .iter()
            .map(|s| no_change(*s))
            .collect();
        let plan = plan_setup(&request, &states);
        assert!(!plan.has_pending_changes);
        assert!(!plan.is_blocked);
        assert_eq!(plan.summary, "All surfaces synced");
    }

    #[test]
    fn operation_kind_methods() {
        assert!(OperationKind::Create.needs_apply());
        assert!(OperationKind::Update.needs_apply());
        assert!(!OperationKind::NoChange.needs_apply());
        assert!(!OperationKind::Conflict.needs_apply());

        assert!(OperationKind::Conflict.is_blocking());
        assert!(OperationKind::Unavailable.is_blocking());
        assert!(!OperationKind::Create.is_blocking());
        assert!(!OperationKind::Update.is_blocking());
        assert!(!OperationKind::NoChange.is_blocking());
    }
}
