//! Unified setup lifecycle types and planner.
//!
//! Models the detect → compare → preview → apply → validate → repair → rollback
//! lifecycle for all Riggverk managed surfaces.
//!
//! Phase ownership:
//! - detect / compare  → setup_transaction (artifact aggregation)
//! - preview            → this planner
//! - apply / repair     → commands/setup.rs (execute through existing owners)
//! - rollback           → commands/setup.rs
//!
//! This module defines narrow serializable types, the preview planner,
//! and real detection helpers. No write execution is included.

use crate::agent_targets::HarnessId;
use serde::{Deserialize, Serialize};

// ── Surface identity ──

/// Identifies a managed setup surface that can be detected, compared,
/// created, updated, repaired, or rolled back.
///
/// Each variant maps to a concrete write set with one canonical owner.
/// Manual-only surfaces are explicit — those the app cannot automate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupSurfaceId {
    /// OpenCode runtime configuration (opencode.json managed keys)
    OpenCodeConfig,
    /// OpenCode agent files
    OpenCodeAgents,
    /// OpenCode rules (AGENTS.md in `~/.config/opencode`, or `$XDG_CONFIG_HOME/opencode`)
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
    /// Skills, installed into the folders the enabled harnesses read (`skill_roots`). One surface
    /// for every harness: the same files are shared by the harnesses that read a folder.
    Skills,
    /// Retired per-harness skill surfaces. They only exist so manifests and managed records
    /// written by older versions still parse; they are never planned. See [`Self::canonical`].
    ClaudeSkills,
    OpenCodeSkills,
    CodexSkills,
    /// Cursor global agents (~/.cursor/agents — individual files, not whole dir)
    CursorAgents,
    CursorSkills,
    /// Cursor Playwright MCP state (mcp.json merge)
    CursorMcp,
    /// GitHub Copilot instructions (`~/.copilot/copilot-instructions.md`)
    CopilotRules,
    /// Pi context file (`~/.pi/agent/AGENTS.md`)
    PiRules,
    /// Kilo Code global rules (`$XDG_CONFIG_HOME/kilo/AGENTS.md`, `~/.config/kilo/AGENTS.md`)
    KiloRules,
    /// The Playwright entry of GitHub Copilot's MCP file (`~/.copilot/mcp-config.json`)
    CopilotMcp,
    /// The Playwright entry of Pi's MCP file (`~/.pi/agent/mcp.json`)
    PiMcp,
    /// The Playwright entry of Kilo's config (`kilo.jsonc`, else `kilo.json`, in the config folder)
    KiloMcp,
    /// Installed runtime workspace bundled files
    WorkspaceBundle,
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
        SetupSurfaceId::Skills,
        SetupSurfaceId::CursorAgents,
        SetupSurfaceId::CursorMcp,
        SetupSurfaceId::CopilotRules,
        SetupSurfaceId::PiRules,
        SetupSurfaceId::KiloRules,
        SetupSurfaceId::CopilotMcp,
        SetupSurfaceId::PiMcp,
        SetupSurfaceId::KiloMcp,
        SetupSurfaceId::WorkspaceBundle,
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
            SetupSurfaceId::Skills => "Skills",
            SetupSurfaceId::ClaudeSkills => "Claude Skills",
            SetupSurfaceId::OpenCodeSkills => "OpenCode Skills",
            SetupSurfaceId::CodexSkills => "Codex Skills",
            SetupSurfaceId::CursorAgents => "Cursor Agents",
            SetupSurfaceId::CursorSkills => "Cursor Skills",
            SetupSurfaceId::CursorMcp => "Cursor MCP",
            SetupSurfaceId::CopilotRules => "Copilot Rules",
            SetupSurfaceId::PiRules => "Pi Rules",
            SetupSurfaceId::KiloRules => "Kilo Rules",
            SetupSurfaceId::CopilotMcp => "Copilot MCP",
            SetupSurfaceId::PiMcp => "Pi MCP",
            SetupSurfaceId::KiloMcp => "Kilo MCP",
            SetupSurfaceId::WorkspaceBundle => "Workspace Resources",
        }
    }

    /// Whether this is one of the retired per-harness skill surfaces.
    pub fn is_retired_skill_surface(self) -> bool {
        matches!(
            self,
            SetupSurfaceId::ClaudeSkills
                | SetupSurfaceId::OpenCodeSkills
                | SetupSurfaceId::CodexSkills
                | SetupSurfaceId::CursorSkills
        )
    }

    /// The surface a request for `self` is served by: a retired per-harness skill surface is
    /// the global `Skills` surface, every other surface is itself.
    pub fn canonical(self) -> SetupSurfaceId {
        if self.is_retired_skill_surface() {
            SetupSurfaceId::Skills
        } else {
            self
        }
    }

    /// The rules surface of a light harness; `None` for a central harness (their rules surfaces
    /// are named by the variants above).
    pub fn light_rules(harness: HarnessId) -> Option<SetupSurfaceId> {
        match harness {
            HarnessId::Copilot => Some(SetupSurfaceId::CopilotRules),
            HarnessId::Pi => Some(SetupSurfaceId::PiRules),
            HarnessId::Kilo => Some(SetupSurfaceId::KiloRules),
            HarnessId::Codex | HarnessId::OpenCode | HarnessId::Claude | HarnessId::Cursor => None,
        }
    }

    /// The MCP surface of a light harness; `None` for a central harness.
    pub fn light_mcp(harness: HarnessId) -> Option<SetupSurfaceId> {
        match harness {
            HarnessId::Copilot => Some(SetupSurfaceId::CopilotMcp),
            HarnessId::Pi => Some(SetupSurfaceId::PiMcp),
            HarnessId::Kilo => Some(SetupSurfaceId::KiloMcp),
            HarnessId::Codex | HarnessId::OpenCode | HarnessId::Claude | HarnessId::Cursor => None,
        }
    }

    /// The harness a surface belongs to. `Skills` serves every harness, so it belongs to none.
    pub fn harness(self) -> Option<HarnessId> {
        match self {
            SetupSurfaceId::OpenCodeConfig
            | SetupSurfaceId::OpenCodeAgents
            | SetupSurfaceId::OpenCodeRules => Some(HarnessId::OpenCode),
            SetupSurfaceId::CodexConfig
            | SetupSurfaceId::CodexAgents
            | SetupSurfaceId::CodexRules => Some(HarnessId::Codex),
            SetupSurfaceId::ClaudeRules | SetupSurfaceId::ClaudeAgents => Some(HarnessId::Claude),
            SetupSurfaceId::CursorAgents | SetupSurfaceId::CursorMcp => Some(HarnessId::Cursor),
            SetupSurfaceId::CopilotRules | SetupSurfaceId::CopilotMcp => Some(HarnessId::Copilot),
            SetupSurfaceId::PiRules | SetupSurfaceId::PiMcp => Some(HarnessId::Pi),
            SetupSurfaceId::KiloRules | SetupSurfaceId::KiloMcp => Some(HarnessId::Kilo),
            SetupSurfaceId::Skills
            | SetupSurfaceId::ClaudeSkills
            | SetupSurfaceId::OpenCodeSkills
            | SetupSurfaceId::CodexSkills
            | SetupSurfaceId::CursorSkills
            | SetupSurfaceId::WorkspaceBundle => None,
        }
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
    /// Retire a stale app-owned artifact that matches the last managed hash.
    Remove,
}

impl OperationKind {
    pub fn needs_apply(&self) -> bool {
        matches!(
            self,
            OperationKind::Create | OperationKind::Update | OperationKind::Remove
        )
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
    /// Plan integrity fingerprint.
    ///
    /// Derived from bounded non-sensitive managed state at preview time.
    /// The backend re-detects before apply and rejects the request if the
    /// fingerprint does not match (stale preview).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_fingerprint: Option<String>,
    /// One-time preview token scoped to workspace, pending surfaces, and fingerprint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_token: Option<String>,
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
            OperationKind::Create | OperationKind::Update | OperationKind::Remove => {
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
                let step = if crate::file_conflicts::is_files_surface(*surface) {
                    format!(
                        "{} has files you manage, so bundled updates are not applied to them. Review the diff or hand them back from the harness page.",
                        surface.label()
                    )
                } else {
                    format!(
                        "{} is managed by you, so base updates are not applied. Review the diff or hand it back from the harness page.",
                        surface.label()
                    )
                };
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
        OperationKind::Remove => 2,
        OperationKind::Manual => 3,
        OperationKind::Conflict => 4,
        OperationKind::Unavailable => 5,
        OperationKind::NoChange => 6,
    });

    let change_count = operations.iter().filter(|op| op.kind.needs_apply()).count();
    let summary = if is_blocked {
        format!("Blocked: {} conflict(s) prevent apply", conflicts.len())
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
        plan_fingerprint: None,
        preview_token: None,
    }
}

/// A plan over zero surfaces. `plan_setup` reads an empty request as "all
/// surfaces", so callers whose surface list was gated down to nothing use
/// this instead.
pub fn empty_plan() -> SetupPlan {
    SetupPlan {
        operations: Vec::new(),
        synced: Vec::new(),
        conflicts: Vec::new(),
        manual_steps: Vec::new(),
        summary: "No enabled surfaces requested".to_string(),
        has_pending_changes: false,
        is_blocked: false,
        plan_fingerprint: None,
        preview_token: None,
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
        (
            surface,
            OperationKind::Update,
            "version differs".to_string(),
        )
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
        let states: Vec<_> = SetupSurfaceId::ALL.iter().map(|s| no_change(*s)).collect();
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
            surfaces: vec![SetupSurfaceId::OpenCodeConfig, SetupSurfaceId::CodexRules],
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
            surfaces: vec![SetupSurfaceId::CursorAgents],
            skip_manual: false,
        };
        let states = vec![unavailable(SetupSurfaceId::CursorAgents)];
        let plan = plan_setup(&request, &states);
        assert!(plan.is_blocked);
        assert!(!plan.has_pending_changes);
    }

    #[test]
    fn manual_surfaces_dont_block() {
        let request = SetupRequest {
            surfaces: vec![SetupSurfaceId::Skills],
            skip_manual: false,
        };
        let states = vec![manual(SetupSurfaceId::Skills)];
        let plan = plan_setup(&request, &states);
        assert!(!plan.is_blocked, "manual steps should not block apply");
        assert!(!plan.has_pending_changes);
        assert_eq!(plan.manual_steps.len(), 1);
    }

    #[test]
    fn manual_surface_in_plan_when_skip_manual_enabled() {
        // skip_manual has no effect when no surfaces are manual_only.
        // The planner still includes manual-status surfaces in the plan.
        let request = SetupRequest {
            surfaces: vec![SetupSurfaceId::OpenCodeConfig],
            skip_manual: true,
        };
        let states = vec![manual(SetupSurfaceId::OpenCodeConfig)];
        let plan = plan_setup(&request, &states);
        assert_eq!(plan.manual_steps.len(), 1, "manual step present");
        assert!(!plan.is_blocked, "manual steps should not block");
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
            conflict(SetupSurfaceId::CursorAgents),
            manual(SetupSurfaceId::Skills),
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
            assert!(
                !surface.label().is_empty(),
                "{:?} must have a label",
                surface
            );
        }
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
            plan_fingerprint: None,
            preview_token: None,
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
        let states: Vec<_> = SetupSurfaceId::ALL.iter().map(|s| no_change(*s)).collect();
        let plan = plan_setup(&request, &states);
        assert!(!plan.has_pending_changes);
        assert!(!plan.is_blocked);
        assert_eq!(plan.summary, "All surfaces synced");
    }

    #[test]
    fn retired_skill_surfaces_still_parse_and_are_served_by_skills() {
        for (name, surface) in [
            ("claude_skills", SetupSurfaceId::ClaudeSkills),
            ("open_code_skills", SetupSurfaceId::OpenCodeSkills),
            ("codex_skills", SetupSurfaceId::CodexSkills),
            ("cursor_skills", SetupSurfaceId::CursorSkills),
        ] {
            let parsed: SetupSurfaceId =
                serde_json::from_value(serde_json::Value::String(name.into())).expect("parse");
            assert_eq!(parsed, surface);
            assert!(surface.is_retired_skill_surface());
            assert_eq!(surface.canonical(), SetupSurfaceId::Skills);
            assert_eq!(surface.harness(), None);
            assert!(
                !SetupSurfaceId::ALL.contains(&surface),
                "{name} is not planned any more"
            );
        }
        assert_eq!(
            serde_json::to_string(&SetupSurfaceId::Skills).unwrap(),
            "\"skills\""
        );
        assert!(!SetupSurfaceId::Skills.is_retired_skill_surface());
        assert_eq!(SetupSurfaceId::Skills.canonical(), SetupSurfaceId::Skills);
        assert_eq!(SetupSurfaceId::Skills.harness(), None);
        assert_eq!(
            SetupSurfaceId::CursorMcp.canonical(),
            SetupSurfaceId::CursorMcp
        );
        assert!(SetupSurfaceId::ALL.contains(&SetupSurfaceId::Skills));
    }

    #[test]
    fn operation_kind_methods() {
        assert!(OperationKind::Create.needs_apply());
        assert!(OperationKind::Update.needs_apply());
        assert!(!OperationKind::NoChange.needs_apply());
        assert!(!OperationKind::Conflict.needs_apply());
    }
}
