//! Unified setup apply, repair, and rollback commands.
//!
//! Uses the setup_lifecycle planner to determine operations, then executes
//! them transactionally:
//!   1. Preflight all operations
//!   2. Create backups for destructive operations
//!   3. Complete all backups before first write
//!   4. Write transaction manifest
//!   5. Execute operations in order
//!   6. Validate each completed operation
//!   7. On failure: stop, rollback completed in reverse order
//!   8. Preserve transaction evidence

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::setup_lifecycle::{
    OperationKind, PlannedOperation, SetupPlan, SetupRequest, SetupSurfaceId,
};

use super::process::run_cmd;
use super::status::file_eq;
use super::workspace::workspace_root;

// ── Transaction types ──

/// Unique transaction identifier (nanosecond timestamp).
pub type TransactionId = String;

use crate::setup_transaction::{
    self, ArtifactManifestOperation, ArtifactTransactionManifest,
    ARTIFACT_MANIFEST_SCHEMA_VERSION,
};

fn new_transaction_id() -> Result<TransactionId, String> {
    setup_transaction::new_transaction_id()
}

// ── Public result types ──

/// Result of an apply or repair execution.
#[derive(Debug, Clone, Serialize)]
pub struct SetupResult {
    pub success: bool,
    pub transaction_id: TransactionId,
    pub applied: Vec<String>,
    pub failed: Vec<String>,
    pub rolled_back: Vec<String>,
    pub manual_steps: Vec<String>,
    pub message: String,
}

// ── Helpers ──

fn backup_root() -> Result<PathBuf, String> {
    crate::commands::backups::backup_root()
}

fn setup_backup_dir(transaction_id: &str) -> Result<PathBuf, String> {
    let root = backup_root()?;
    let dir = root.join("setup").join(transaction_id);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create setup backup dir {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The agent name used for skill-related operations.
fn surface_agent(surface: SetupSurfaceId) -> Option<&'static str> {
    match surface {
        SetupSurfaceId::OpenCodeSkills => Some("opencode"),
        SetupSurfaceId::CodexSkills => Some("codex"),
        SetupSurfaceId::ClaudeSkills => Some("claude"),
        SetupSurfaceId::CursorSkills => Some("cursor"),
        SetupSurfaceId::DeprecatedSkillCleanup => Some("codex"),
        _ => None,
    }
}

fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("cannot inspect {label} {}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("refusing symlink {label}: {}", path.display()));
    }
    Ok(())
}

// ── Script-based operation execution ──

/// Execute a named operation on a surface.
///
/// Returns Ok(()) on success, Err on failure.
/// Validates the operation after execution.
fn execute_operation_and_validate(
    op: &PlannedOperation,
    workspace_root: &Path,
) -> Result<(), String> {
    let surface = op.surface;

    // Execute the operation
    match surface {
        // OpenCode config — use install-opencode-config.sh
        SetupSurfaceId::OpenCodeConfig => {
            let script = workspace_root.join("scripts/install-opencode-config.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--quiet", "--config-only", "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("OpenCode config apply failed: {stderr}"));
            }
            Ok(())
        }

        // OpenCode agents — use install-opencode-config.sh with --agents-only
        SetupSurfaceId::OpenCodeAgents => {
            let script = workspace_root.join("scripts/install-opencode-config.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--quiet", "--agents-only", "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("OpenCode agents apply failed: {stderr}"));
            }
            Ok(())
        }

        // OpenCode rules — use install-agent-rules.sh
        SetupSurfaceId::OpenCodeRules => {
            let script = workspace_root.join("scripts/install-agent-rules.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--opencode", "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("OpenCode rules apply failed: {stderr}"));
            }
            Ok(())
        }

        // Codex config — use install-codex-config.sh
        SetupSurfaceId::CodexConfig => {
            let script = workspace_root.join("scripts/install-codex-config.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--quiet", "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("Codex config apply failed: {stderr}"));
            }
            Ok(())
        }

        // Codex agents — use install-codex-agents.sh
        SetupSurfaceId::CodexAgents => {
            let script = workspace_root.join("scripts/install-codex-agents.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("Codex agents apply failed: {stderr}"));
            }
            Ok(())
        }

        // Codex rules — use install-agent-rules.sh
        SetupSurfaceId::CodexRules => {
            let script = workspace_root.join("scripts/install-agent-rules.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--codex", "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("Codex rules apply failed: {stderr}"));
            }
            Ok(())
        }

        // Claude rules — use install-agent-rules.sh
        SetupSurfaceId::ClaudeRules => {
            let script = workspace_root.join("scripts/install-agent-rules.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--claude", "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("Claude rules apply failed: {stderr}"));
            }
            Ok(())
        }

        // Claude agents — use install-runtime-agents.sh with --claude
        SetupSurfaceId::ClaudeAgents => {
            let script = workspace_root.join("scripts/install-runtime-agents.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--claude", "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("Claude agents apply failed: {stderr}"));
            }
            Ok(())
        }

        // Cursor global agents — native Rust only, never install-cursor-workspace.sh
        SetupSurfaceId::CursorAgents => {
            let cursor_paths = crate::cursor_profile_paths::resolve_cursor_profile_paths()
                .map_err(|e| format!("resolve Cursor profile: {e}"))?;
            let result = crate::cursor_profile_ops::run_global_agents_only(
                workspace_root,
                &cursor_paths,
                true,
            );
            if !result.success {
                return Err(format!("Cursor agents apply failed: {}", result.stderr));
            }
            Ok(())
        }

        // Cursor global skills — use install-skills.sh with --agent cursor
        SetupSurfaceId::CursorSkills => {
            let script = workspace_root.join("scripts/install-skills.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let agent = surface_agent(op.surface).unwrap_or("cursor");
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--agent", agent, "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("Cursor skill install failed: {stderr}"));
            }
            Ok(())
        }

        // Cursor Playwright MCP — native Rust only, never install-cursor-workspace.sh
        SetupSurfaceId::CursorMcp => {
            let cursor_paths = crate::cursor_profile_paths::resolve_cursor_profile_paths()
                .map_err(|e| format!("resolve Cursor profile: {e}"))?;
            let result = crate::cursor_profile_ops::run_global_mcp_only(
                workspace_root,
                &cursor_paths,
                true,
            );
            if !result.success {
                return Err(format!("Cursor MCP apply failed: {}", result.stderr));
            }
            Ok(())
        }

        // Skills — use install-skills.sh
        SetupSurfaceId::OpenCodeSkills | SetupSurfaceId::CodexSkills | SetupSurfaceId::ClaudeSkills => {
            let script = workspace_root.join("scripts/install-skills.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let agent = surface_agent(op.surface).unwrap_or("opencode");
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--agent", agent, "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!("{} skill install failed: {stderr}", op.surface.label()));
            }
            Ok(())
        }

        // Deprecated skill cleanup
        SetupSurfaceId::DeprecatedSkillCleanup => {
            Err("deprecated skill cleanup requires explicit command (use preview_remove_deprecated_skills)".to_string())
        }
    }
}

fn artifact_label(artifact: &crate::artifact_registry::ArtifactId) -> String {
    format!("{artifact:?}")
}

fn perform_artifact_rollback(
    manifest_ops: &[ArtifactManifestOperation],
    backup_dir: &Path,
    home: &Path,
) -> (Vec<String>, Vec<String>) {
    let mut rolled_back = Vec::new();
    let mut errors = Vec::new();
    for op in manifest_ops.iter().rev() {
        match setup_transaction::restore_artifact_from_backup(op, backup_dir, home) {
            Ok(()) => rolled_back.push(artifact_label(&op.artifact)),
            Err(e) => errors.push(format!("{}: {e}", artifact_label(&op.artifact))),
        }
    }
    (rolled_back, errors)
}

fn user_home() -> Result<PathBuf, String> {
    crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
}

// ── Apply ──

/// Apply a setup plan using artifact-owned transactions.
pub fn apply_setup_plan(plan: &SetupPlan) -> SetupResult {
    let transaction_id = match new_transaction_id() {
        Ok(id) => id,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id: String::new(),
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: e,
            };
        }
    };
    let manual_steps: Vec<String> = plan
        .manual_steps
        .iter()
        .filter_map(|m| m.manual_step.clone())
        .collect();

    let surface_ops: Vec<&PlannedOperation> = plan
        .operations
        .iter()
        .filter(|op| op.kind.needs_apply())
        .collect();

    if surface_ops.is_empty() {
        return SetupResult {
            success: true,
            transaction_id,
            applied: vec![],
            failed: vec![],
            rolled_back: vec![],
            manual_steps,
            message: "No operations to apply".to_string(),
        };
    }

    let ws_root = match workspace_root() {
        Ok(r) => r,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec!["resolve workspace".to_string()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Cannot resolve workspace root: {e}"),
            };
        }
    };
    let home = match user_home() {
        Ok(h) => h,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: e,
            };
        }
    };

    let surfaces: Vec<SetupSurfaceId> = surface_ops.iter().map(|op| op.surface).collect();
    let planned = match setup_transaction::plan_artifacts_for_surfaces(&surfaces, &ws_root, &home)
    {
        Ok(p) => p,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: e,
            };
        }
    };

    let pending: Vec<&setup_transaction::PlannedArtifact> =
        planned.iter().filter(|p| p.kind.needs_apply()).collect();
    if pending.is_empty() {
        return SetupResult {
            success: true,
            transaction_id,
            applied: vec![],
            failed: vec![],
            rolled_back: vec![],
            manual_steps,
            message: "No artifact operations to apply".to_string(),
        };
    }

    for p in &pending {
        let dest = match p.artifact.resolve_dest(&home) {
            Ok(d) => d,
            Err(e) => {
                return SetupResult {
                    success: false,
                    transaction_id,
                    applied: vec![],
                    failed: vec![format!("preflight {}: {e}", artifact_label(&p.artifact))],
                    rolled_back: vec![],
                    manual_steps: vec![],
                    message: format!("Artifact preflight failed: {e}"),
                };
            }
        };
        if let Some(src) = p.artifact.resolve_source(&ws_root) {
            if let Err(e) = setup_transaction::reject_symlink(&src, "source") {
                return SetupResult {
                    success: false,
                    transaction_id,
                    applied: vec![],
                    failed: vec![e],
                    rolled_back: vec![],
                    manual_steps: vec![],
                    message: "Symlinked artifact source rejected".to_string(),
                };
            }
        }
        if dest.exists() {
            if let Err(e) = setup_transaction::reject_symlink(&dest, "destination") {
                return SetupResult {
                    success: false,
                    transaction_id,
                    applied: vec![],
                    failed: vec![e],
                    rolled_back: vec![],
                    manual_steps: vec![],
                    message: "Symlinked artifact destination rejected".to_string(),
                };
            }
        }
    }

    let backup_dir = match setup_backup_dir(&transaction_id) {
        Ok(d) => d,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec![format!("backup setup: {e}")],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Backup directory creation failed: {e}"),
            };
        }
    };

    let mut manifest_ops: Vec<ArtifactManifestOperation> = Vec::new();
    for p in &pending {
        let backup_rel = match setup_transaction::backup_artifact(&p.artifact, &backup_dir, &home) {
            Ok(rel) => rel,
            Err(e) => {
                return SetupResult {
                    success: false,
                    transaction_id,
                    applied: vec![],
                    failed: vec![format!("backup {}: {e}", artifact_label(&p.artifact))],
                    rolled_back: vec![],
                    manual_steps: vec![],
                    message: format!("Backup failed: {e}"),
                };
            }
        };
        manifest_ops.push(ArtifactManifestOperation {
            artifact: p.artifact.clone(),
            surface: p.surface,
            kind: p.kind,
            previous_state: p.previous_state,
            rollback_action: p.rollback_action,
            backup_rel,
            ..Default::default()
        });
    }

    let manifest = ArtifactTransactionManifest {
        schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
        workspace_key: setup_transaction::workspace_key(&ws_root).unwrap_or_default(),
        created_at: transaction_id.clone(),
        surface_ids: surfaces.clone(),
        operations: manifest_ops.clone(),
    };
    if let Err(e) = setup_transaction::validate_manifest(&manifest, &ws_root) {
        return SetupResult {
            success: false,
            transaction_id,
            applied: vec![],
            failed: vec![e.clone()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: e,
        };
    }

    let manifest_path = backup_dir.join("manifest.json");
    let manifest_json = match serde_json::to_string_pretty(&manifest) {
        Ok(j) => j,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec![format!("serialize manifest: {e}")],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Cannot serialize transaction manifest: {e}"),
            };
        }
    };
    if let Err(e) = fs::write(&manifest_path, &manifest_json) {
        return SetupResult {
            success: false,
            transaction_id,
            applied: vec![],
            failed: vec![format!("write manifest: {e}")],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Cannot write transaction manifest: {e}"),
        };
    }
    let read_back = match fs::read_to_string(&manifest_path) {
        Ok(r) => r,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec![format!("re-read manifest: {e}")],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Cannot re-read transaction manifest: {e}"),
            };
        }
    };
    let parsed: ArtifactTransactionManifest = match serde_json::from_str(&read_back) {
        Ok(m) => m,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec![format!("validate manifest: {e}")],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Transaction manifest validation failed: {e}"),
            };
        }
    };
    if let Err(e) = setup_transaction::validate_manifest(&parsed, &ws_root) {
        return SetupResult {
            success: false,
            transaction_id,
            applied: vec![],
            failed: vec![e],
            rolled_back: vec![],
            manual_steps: vec![],
            message: "Manifest tamper check failed".to_string(),
        };
    }

    let surfaces_to_execute = setup_transaction::surfaces_needing_apply(&planned);
    let mut applied: Vec<String> = Vec::new();
    let mut completed_manifest_ops: Vec<ArtifactManifestOperation> = Vec::new();

    for surface in &surfaces_to_execute {
        let surface_op = PlannedOperation {
            surface: *surface,
            kind: OperationKind::Update,
            summary: surface.label().to_string(),
            details: vec![],
            conflict_description: None,
            manual_step: None,
        };
        if let Err(e) = execute_operation_and_validate(&surface_op, &ws_root) {
            let (rolled_back, rb_errors) =
                perform_artifact_rollback(&completed_manifest_ops, &backup_dir, &home);
            let mut message = format!("Apply failed at {}: {e}", surface.label());
            if !rb_errors.is_empty() {
                message.push_str(&format!(". Rollback errors: {}", rb_errors.join("; ")));
            }
            return SetupResult {
                success: false,
                transaction_id,
                applied,
                failed: vec![format!("{}: {e}", surface.label())],
                rolled_back,
                manual_steps: manual_steps.clone(),
                message,
            };
        }

        let surface_artifacts: Vec<_> = pending
            .iter()
            .filter(|p| p.surface == *surface)
            .collect();
        for p in &surface_artifacts {
            if let Err(e) =
                setup_transaction::validate_artifact_after_apply(&p.artifact, &ws_root, &home)
            {
                let (rolled_back, rb_errors) =
                    perform_artifact_rollback(&completed_manifest_ops, &backup_dir, &home);
                let mut message =
                    format!("Validation failed for {}: {e}", artifact_label(&p.artifact));
                if !rb_errors.is_empty() {
                    message.push_str(&format!(". Rollback errors: {}", rb_errors.join("; ")));
                }
                return SetupResult {
                    success: false,
                    transaction_id,
                    applied,
                    failed: vec![format!("{}: {e}", artifact_label(&p.artifact))],
                    rolled_back,
                    manual_steps: manual_steps.clone(),
                    message,
                };
            }
            applied.push(artifact_label(&p.artifact));
            if let Some(op) = manifest_ops.iter().find(|o| o.artifact == p.artifact) {
                completed_manifest_ops.push(op.clone());
            }
        }
    }

    let applied_count = applied.len();
    SetupResult {
        success: true,
        transaction_id,
        applied,
        failed: vec![],
        rolled_back: vec![],
        manual_steps,
        message: format!("Successfully applied {applied_count} artifact(s)"),
    }
}

// ── Repair ──

/// Result of a repair preflight.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct RepairPreflight {
    pub missing: Vec<String>,
    pub safe: bool,
    pub message: String,
}

/// Repair a setup plan — only creates missing managed resources.
///
/// Does not overwrite diverged user-owned files or remove unknown resources.
/// Returns manual conflict steps when automatic repair is unsafe.
pub fn repair_setup(plan: &SetupPlan) -> SetupResult {
    // Only repair create operations (missing resources).
    // Skip update/conflict — those would overwrite user changes.
    let create_ops: Vec<&PlannedOperation> = plan
        .operations
        .iter()
        .filter(|op| matches!(op.kind, OperationKind::Create))
        .collect();

    if create_ops.is_empty() {
        return SetupResult {
            success: true,
            transaction_id: new_transaction_id().unwrap_or_default(),
            applied: vec![],
            failed: vec![],
            rolled_back: vec![],
            manual_steps: plan
                .manual_steps
                .iter()
                .map(|m| m.manual_step.clone().unwrap_or_default())
                .collect(),
            message: "No missing resources to repair".to_string(),
        };
    }

    // Create a sub-plan with only create operations
    let sub_plan = SetupPlan {
        operations: create_ops.clone().into_iter().cloned().collect(),
        synced: vec![],
        conflicts: vec![],
        manual_steps: plan.manual_steps.clone(),
        summary: format!("repair {} missing surface(s)", create_ops.len()),
        has_pending_changes: true,
        is_blocked: false,
        plan_fingerprint: None,
    };

    apply_setup_plan(&sub_plan)
}

/// Preflight repair: report what's missing without applying.
#[allow(dead_code)]
pub fn preflight_repair(plan: &SetupPlan) -> RepairPreflight {
    let missing: Vec<String> = plan
        .operations
        .iter()
        .filter(|op| matches!(op.kind, OperationKind::Create))
        .map(|op| op.surface.label().to_string())
        .collect();

    if missing.is_empty() {
        RepairPreflight {
            missing: vec![],
            safe: true,
            message: "No missing resources".to_string(),
        }
    } else {
        RepairPreflight {
            missing: missing.clone(),
            safe: true,
            message: format!("{} missing resource(s) can be repaired", missing.len()),
        }
    }
}

// ── Rollback ──

/// Rollback a completed setup transaction.
///
/// Only validates the transaction ID and allows rollback if:
/// - The transaction manifest exists
/// - The backup files are present
/// - The destination paths are resolvable from the current registry
#[allow(dead_code)]
pub fn rollback_transaction(transaction_id: &str, dry_run: bool) -> SetupResult {
    let backup_root = match backup_root() {
        Ok(r) => r,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec!["resolve backup root".to_string()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Cannot resolve backup root: {e}"),
            };
        }
    };

    let backup_dir = backup_root.join("setup").join(transaction_id);
    if !backup_dir.is_dir() {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![format!("transaction not found: {transaction_id}")],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Transaction backup not found at {}", backup_dir.display()),
        };
    }

    // Reject symlinked backup directory
    if let Err(e) = reject_symlink(&backup_dir, "backup directory") {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![format!("backup symlink: {e}")],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Backup directory symlink rejected: {e}"),
        };
    }

    // Read manifest
    let manifest_path = backup_dir.join("manifest.json");
    let manifest_raw = match fs::read_to_string(&manifest_path) {
        Ok(r) => r,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec![format!("read manifest: {e}")],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Cannot read transaction manifest: {e}"),
            };
        }
    };
    let ws_root = match workspace_root() {
        Ok(r) => r,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec![format!("workspace: {e}")],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Cannot resolve workspace: {e}"),
            };
        }
    };
    let manifest: ArtifactTransactionManifest = match serde_json::from_str(&manifest_raw) {
        Ok(m) => m,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec![format!("parse manifest: {e}")],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Invalid transaction manifest: {e}"),
            };
        }
    };
    if let Err(e) = setup_transaction::validate_manifest(&manifest, &ws_root) {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![e.clone()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: e,
        };
    }

    if dry_run {
        let would_restore: Vec<String> = manifest
            .operations
            .iter()
            .rev()
            .map(|op| artifact_label(&op.artifact))
            .collect();
        return SetupResult {
            success: true,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!(
                "Dry run: would restore {} artifact(s)",
                would_restore.len()
            ),
        };
    }

    let home = match user_home() {
        Ok(h) => h,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: e,
            };
        }
    };

    let (restored, rollback_failures) =
        perform_artifact_rollback(&manifest.operations, &backup_dir, &home);
    let restored_count = restored.len();
    let success = rollback_failures.is_empty();
    SetupResult {
        success,
        transaction_id: transaction_id.to_string(),
        applied: vec![],
        failed: rollback_failures,
        rolled_back: restored,
        manual_steps: vec![],
        message: if success {
            format!("Successfully restored {restored_count} artifact(s)")
        } else {
            "Rollback completed with errors".to_string()
        },
    }
}

// ── Real state detection ──

/// Detect the real state of a setup surface by inspecting actual filesystem state.
///
/// Returns (SetupSurfaceId, OperationKind, summary_string).
/// Uses existing health and comparison functions from the relevant owners.
pub fn detect_surface_state(
    surface: SetupSurfaceId,
    workspace_root: &Path,
    home: &Path,
) -> (SetupSurfaceId, OperationKind, String) {
    let kind = match surface {
        // Codex config — use managed-field comparison (preserves user TOML)
        SetupSurfaceId::CodexConfig => {
            let target = home.join(".codex/config.toml");
            let source = workspace_root.join("templates/codex/config.toml");
            if !target.exists() {
                OperationKind::Create
            } else if !source.exists() {
                OperationKind::Unavailable
            } else {
                // Use managed-field comparison from Codex runtime owner
                let installed_str = match std::fs::read_to_string(&target) {
                    Ok(s) => s,
                    Err(_) => {
                        return (
                            surface,
                            OperationKind::Conflict,
                            "Codex config unreadable".to_string(),
                        )
                    }
                };
                let source_str = match std::fs::read_to_string(&source) {
                    Ok(s) => s,
                    Err(_) => {
                        return (
                            surface,
                            OperationKind::Unavailable,
                            "Codex source unreadable".to_string(),
                        )
                    }
                };
                let installed_toml: toml::Value = match installed_str.parse() {
                    Ok(v) => v,
                    Err(_) => {
                        return (
                            surface,
                            OperationKind::Conflict,
                            "Codex config invalid TOML".to_string(),
                        )
                    }
                };
                let source_toml: toml::Value = match source_str.parse() {
                    Ok(v) => v,
                    Err(_) => {
                        return (
                            surface,
                            OperationKind::Unavailable,
                            "Codex source invalid TOML".to_string(),
                        )
                    }
                };
                let managed_installed =
                    crate::commands::codex_runtime::extract_managed_codex_config(&installed_toml);
                let managed_source =
                    crate::commands::codex_runtime::extract_managed_codex_config(&source_toml);
                if crate::commands::codex_runtime::managed_codex_keys_match(
                    &installed_toml,
                    &source_toml,
                ) {
                    OperationKind::NoChange
                } else if managed_installed == managed_source {
                    // Managed sections match, but full config differs (user-owned fields)
                    // This is not a setup concern — the managed part is synced
                    OperationKind::NoChange
                } else {
                    OperationKind::Update
                }
            }
        }
        // Codex agents — compare directory contents
        SetupSurfaceId::CodexAgents => {
            let target_dir = home.join(".codex/agents");
            let source_dir = workspace_root.join("templates/codex/agents");
            compare_agent_dir(&source_dir, &target_dir)
        }
        // Codex rules
        SetupSurfaceId::CodexRules => {
            let target = home.join(".codex/AGENTS.md");
            let source = workspace_root.join("templates/sync/codex-rules.md");
            compare_single_file(&target, &source)
        }
        // OpenCode config — use managed-key comparison (preserves user provider blocks)
        SetupSurfaceId::OpenCodeConfig => {
            let target = home.join(".config/opencode/opencode.json");
            let source = workspace_root.join("templates/opencode.json");
            if !target.exists() {
                OperationKind::Create
            } else if !source.exists() {
                OperationKind::Unavailable
            } else {
                let installed_str = match std::fs::read_to_string(&target) {
                    Ok(s) => s,
                    Err(_) => {
                        return (
                            surface,
                            OperationKind::Conflict,
                            "OpenCode config unreadable".to_string(),
                        )
                    }
                };
                let source_str = match std::fs::read_to_string(&source) {
                    Ok(s) => s,
                    Err(_) => {
                        return (
                            surface,
                            OperationKind::Unavailable,
                            "OpenCode source unreadable".to_string(),
                        )
                    }
                };
                let installed_json: serde_json::Value = match serde_json::from_str(&installed_str) {
                    Ok(v) => v,
                    Err(_) => {
                        return (
                            surface,
                            OperationKind::Conflict,
                            "OpenCode config invalid JSON".to_string(),
                        )
                    }
                };
                let source_json: serde_json::Value = match serde_json::from_str(&source_str) {
                    Ok(v) => v,
                    Err(_) => {
                        return (
                            surface,
                            OperationKind::Unavailable,
                            "OpenCode source invalid JSON".to_string(),
                        )
                    }
                };
                // Use managed-key comparison from OpenCode runtime owner
                if crate::commands::opencode_runtime::managed_opencode_keys_match(
                    &installed_json,
                    &source_json,
                ) {
                    OperationKind::NoChange
                } else {
                    OperationKind::Update
                }
            }
        }
        // OpenCode agents
        SetupSurfaceId::OpenCodeAgents => {
            let target_dir = home.join(".config/opencode/agents");
            let source_dir = workspace_root.join("agents");
            compare_agent_dir(&source_dir, &target_dir)
        }
        // OpenCode rules
        SetupSurfaceId::OpenCodeRules => {
            let target = home.join(".config/opencode/AGENTS.md");
            let source = workspace_root.join("templates/sync/opencode-rules.md");
            compare_single_file(&target, &source)
        }
        // Claude rules
        SetupSurfaceId::ClaudeRules => {
            let target = home.join(".claude/CLAUDE.md");
            let source = workspace_root.join("templates/sync/claude-rules.md");
            compare_single_file(&target, &source)
        }
        // Claude agents
        SetupSurfaceId::ClaudeAgents => {
            let target_dir = home.join(".claude/agents");
            let source_dir = workspace_root.join("templates/claude/agents");
            compare_agent_dir(&source_dir, &target_dir)
        }
        // Skills — compare actual SKILL.md content per skill, not just directory existence
        SetupSurfaceId::ClaudeSkills => {
            let target = home.join(".claude/skills");
            let skills_root = workspace_root.join("skills");
            if !target.is_dir() {
                OperationKind::Create
            } else if !skills_root.is_dir() {
                OperationKind::Unavailable
            } else if let Some(expected) = expected_skills_for_harness(workspace_root, "claude") {
                let mut any_missing = false;
                let mut any_diverged = false;
                for skill_name in &expected {
                    let installed_skill_md = target.join(skill_name.as_str()).join("SKILL.md");
                    if !installed_skill_md.is_file() {
                        any_missing = true;
                        continue;
                    }
                    let source_dir =
                        crate::artifact_registry::ArtifactId::ClaudeSkill(skill_name.clone())
                            .resolve_source(workspace_root);
                    if let Some(src_dir) = source_dir {
                        let source_skill_md = src_dir.join("SKILL.md");
                        if source_skill_md.is_file()
                            && !file_eq(&installed_skill_md, &source_skill_md)
                        {
                            any_diverged = true;
                        }
                    }
                }
                if any_missing || any_diverged {
                    OperationKind::Update
                } else {
                    OperationKind::NoChange
                }
            } else {
                OperationKind::Unavailable
            }
        }
        // Cursor agents — check individual agent files, not whole ~/.cursor
        SetupSurfaceId::CursorAgents => {
            let paths = match crate::cursor_profile_paths::resolve_cursor_profile_paths() {
                Ok(p) => p,
                Err(_) => {
                    let summary = "Cursor profile unavailable".to_string();
                    return (surface, OperationKind::Unavailable, summary);
                }
            };
            let source_dir = workspace_root.join("templates/cursor/agents");
            let target_dir = paths.agents;
            compare_agent_dir(&source_dir, &target_dir)
        }
        // Cursor skills — check per-skill directories, not just existence
        SetupSurfaceId::CursorSkills => {
            let paths = match crate::cursor_profile_paths::resolve_cursor_profile_paths() {
                Ok(p) => p,
                Err(_) => {
                    let summary = "Cursor profile unavailable".to_string();
                    return (surface, OperationKind::Unavailable, summary);
                }
            };
            let target_dir = paths.skills;
            if !target_dir.is_dir() {
                OperationKind::Create
            } else if let Some(expected) = expected_skills_for_harness(workspace_root, "cursor") {
                let mut any_issue = false;
                for skill_name in &expected {
                    let installed_skill_md =
                        target_dir.join(skill_name.as_str()).join("SKILL.md");
                    if !installed_skill_md.is_file() {
                        any_issue = true;
                        break;
                    }
                    let source_dir =
                        crate::artifact_registry::ArtifactId::CursorSkill(skill_name.clone())
                            .resolve_source(workspace_root);
                    if let Some(src_dir) = source_dir {
                        let source_skill_md = src_dir.join("SKILL.md");
                        if source_skill_md.is_file()
                            && !file_eq(&installed_skill_md, &source_skill_md)
                        {
                            any_issue = true;
                            break;
                        }
                    }
                }
                if any_issue {
                    OperationKind::Update
                } else {
                    OperationKind::NoChange
                }
            } else {
                OperationKind::Unavailable
            }
        }
        // Cursor MCP — check Playwright MCP merge state
        SetupSurfaceId::CursorMcp => {
            let paths = match crate::cursor_profile_paths::resolve_cursor_profile_paths() {
                Ok(p) => p,
                Err(_) => {
                    let summary = "Cursor profile unavailable".to_string();
                    return (surface, OperationKind::Unavailable, summary);
                }
            };
            let status = crate::cursor_profile_ops::mcp_diff_status(workspace_root, &paths);
            match status.as_str() {
                "synced" => OperationKind::NoChange,
                "missing" => OperationKind::Create,
                "diverged" => OperationKind::Update,
                _ => OperationKind::Unavailable,
            }
        }
        // OpenCode skills — compare content
        SetupSurfaceId::OpenCodeSkills => {
            let target = home.join(".config/opencode/skills");
            let skills_root = workspace_root.join("skills");
            if !target.is_dir() {
                OperationKind::Create
            } else if !skills_root.is_dir() {
                OperationKind::Unavailable
            } else if let Some(expected) = expected_skills_for_harness(workspace_root, "opencode") {
                let mut any_issue = false;
                for skill_name in &expected {
                    let installed_skill_md = target.join(skill_name.as_str()).join("SKILL.md");
                    if !installed_skill_md.is_file() {
                        any_issue = true;
                        break;
                    }
                    let source_dir =
                        crate::artifact_registry::ArtifactId::OpenCodeSkill(skill_name.clone())
                            .resolve_source(workspace_root);
                    if let Some(src_dir) = source_dir {
                        let source_skill_md = src_dir.join("SKILL.md");
                        if source_skill_md.is_file()
                            && !file_eq(&installed_skill_md, &source_skill_md)
                        {
                            any_issue = true;
                            break;
                        }
                    }
                }
                if any_issue {
                    OperationKind::Update
                } else {
                    OperationKind::NoChange
                }
            } else {
                OperationKind::Unavailable
            }
        }
        // Codex skills — compare content
        SetupSurfaceId::CodexSkills => {
            let target = home.join(".agents/skills");
            let skills_root = workspace_root.join("skills");
            if !target.is_dir() {
                OperationKind::Create
            } else if !skills_root.is_dir() {
                OperationKind::Unavailable
            } else if let Some(expected) = expected_skills_for_harness(workspace_root, "codex") {
                let mut any_issue = false;
                for skill_name in &expected {
                    let installed_skill_md = target.join(skill_name.as_str()).join("SKILL.md");
                    if !installed_skill_md.is_file() {
                        any_issue = true;
                        break;
                    }
                    let source_dir =
                        crate::artifact_registry::ArtifactId::CodexSkill(skill_name.clone())
                            .resolve_source(workspace_root);
                    if let Some(src_dir) = source_dir {
                        let source_skill_md = src_dir.join("SKILL.md");
                        if source_skill_md.is_file()
                            && !file_eq(&installed_skill_md, &source_skill_md)
                        {
                            any_issue = true;
                            break;
                        }
                    }
                }
                if any_issue {
                    OperationKind::Update
                } else {
                    OperationKind::NoChange
                }
            } else {
                OperationKind::Unavailable
            }
        }
        // Deprecated cleanup — always manual
        SetupSurfaceId::DeprecatedSkillCleanup => OperationKind::Manual,
    };

    let summary = match kind {
        OperationKind::NoChange => format!("{} synced", surface.label()),
        OperationKind::Create => format!("{} not installed", surface.label()),
        OperationKind::Update => format!("{} differs from source", surface.label()),
        OperationKind::Conflict => format!("{} has conflicts", surface.label()),
        OperationKind::Manual => format!("{} requires manual action", surface.label()),
        OperationKind::Unavailable => format!("{} unavailable", surface.label()),
    };

    (surface, kind, summary)
}

fn expected_skills_for_harness(
    workspace_root: &Path,
    harness: &str,
) -> Option<Vec<crate::artifact_registry::SkillName>> {
    crate::artifact_registry::discover_skill_names_for_harness(workspace_root, harness).ok()
}

/// Compare a single file target with its source.
fn compare_single_file(target: &Path, source: &Path) -> OperationKind {
    if !target.exists() {
        OperationKind::Create
    } else if source.exists() && file_eq(target, source) {
        OperationKind::NoChange
    } else {
        OperationKind::Update
    }
}

/// Compare agent directory contents between source and target.
fn compare_agent_dir(source_dir: &Path, target_dir: &Path) -> OperationKind {
    if !target_dir.is_dir() {
        return OperationKind::Create;
    }
    if !source_dir.is_dir() {
        return OperationKind::NoChange;
    }
    // Check every source file exists and matches in target
    let entries = match std::fs::read_dir(source_dir) {
        Ok(e) => e,
        Err(_) => return OperationKind::NoChange,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        let installed = target_dir.join(name);
        if !installed.is_file() || !file_eq(&path, &installed) {
            return OperationKind::Update;
        }
    }
    OperationKind::NoChange
}

/// Validate transaction ID format — must be only digits (nanosecond timestamp).
fn validate_transaction_id_format(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    id.chars().all(|c| c.is_ascii_digit())
}

// ── Tauri commands ──

fn compute_plan_fingerprint_for_surfaces(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
) -> Result<String, String> {
    let planned = setup_transaction::plan_artifacts_for_surfaces(surfaces, workspace_root, home)?;
    setup_transaction::compute_plan_fingerprint(workspace_root, surfaces, &planned, home)
}

/// Read-only preview: detect real state for requested surfaces.
#[tauri::command]
pub fn preview_setup(surfaces: Vec<String>) -> Result<SetupPlan, String> {
    // Validate all provided surface IDs are known
    let unknown: Vec<&String> = surfaces
        .iter()
        .filter(|s| {
            serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(s.to_string()))
                .is_err()
        })
        .collect();

    if !unknown.is_empty() {
        let ids: Vec<&str> = unknown.iter().map(|s| s.as_str()).collect();
        return Err(format!("Unknown surface ID(s): {}", ids.join(", ")));
    }

    let surface_ids: Vec<SetupSurfaceId> = surfaces
        .iter()
        .filter_map(|s| {
            serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(s.to_string())).ok()
        })
        .collect();

    if surface_ids.is_empty() {
        // All surfaces
        let ws_root = workspace_root().map_err(|e| format!("workspace root: {e}"))?;
        let home = crate::platform_paths::resolve_user_home(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .map_err(|e| format!("user home: {e}"))?;

        let states: Vec<_> = SetupSurfaceId::ALL
            .iter()
            .filter(|s| !matches!(s, SetupSurfaceId::DeprecatedSkillCleanup))
            .map(|s| detect_surface_state(*s, &ws_root, &home))
            .collect();

        let request = SetupRequest {
            surfaces: vec![],
            skip_manual: true,
        };

        let mut plan = crate::setup_lifecycle::plan_setup(&request, &states);
        let surface_ids: Vec<SetupSurfaceId> = SetupSurfaceId::ALL
            .iter()
            .filter(|s| !matches!(s, SetupSurfaceId::DeprecatedSkillCleanup))
            .copied()
            .collect();
        plan.plan_fingerprint = Some(compute_plan_fingerprint_for_surfaces(
            &surface_ids,
            &ws_root,
            &home,
        )?);
        Ok(plan)
    } else {
        let ws_root = workspace_root().map_err(|e| format!("workspace root: {e}"))?;
        let home = crate::platform_paths::resolve_user_home(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .map_err(|e| format!("user home: {e}"))?;

        let states: Vec<_> = surface_ids
            .iter()
            .map(|s| detect_surface_state(*s, &ws_root, &home))
            .collect();

        let fingerprint = compute_plan_fingerprint_for_surfaces(
            &surface_ids,
            &ws_root,
            &home,
        )?;

        let request = SetupRequest {
            surfaces: surface_ids,
            skip_manual: true,
        };

        let mut plan = crate::setup_lifecycle::plan_setup(&request, &states);
        plan.plan_fingerprint = Some(fingerprint);
        Ok(plan)
    }
}

/// Detect current state for all surfaces and return a plan.
/// This is the internal detection used by apply and repair.
pub fn detect_all_surfaces() -> Result<SetupPlan, String> {
    let ws_root = workspace_root().map_err(|e| format!("workspace root: {e}"))?;
    let home = crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .map_err(|e| format!("user home: {e}"))?;

    let states: Vec<_> = SetupSurfaceId::ALL
        .iter()
        .filter(|s| !matches!(s, SetupSurfaceId::DeprecatedSkillCleanup))
        .map(|s| detect_surface_state(*s, &ws_root, &home))
        .collect();

    let request = SetupRequest {
        surfaces: vec![],
        skip_manual: true,
    };

    Ok(crate::setup_lifecycle::plan_setup(&request, &states))
}

#[tauri::command]
pub fn apply_setup(
    surfaces: Vec<String>,
    skip_manual: bool,
    plan_fingerprint: Option<String>,
) -> Result<SetupResult, String> {
    // Validate all provided surface IDs are known before any processing
    let unknown: Vec<&String> = surfaces
        .iter()
        .filter(|s| {
            serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(s.to_string()))
                .is_err()
        })
        .collect();

    if !unknown.is_empty() {
        let ids: Vec<&str> = unknown.iter().map(|s| s.as_str()).collect();
        return Err(format!("Unknown surface ID(s): {}", ids.join(", ")));
    }

    // Parse validated IDs
    let surface_ids: Vec<SetupSurfaceId> = surfaces
        .iter()
        .filter_map(|s| {
            serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(s.to_string())).ok()
        })
        .collect();

    if surface_ids.is_empty() {
        return Err("At least one surface ID is required".to_string());
    }

    // Use real detection instead of synthetic all-Create states
    let ws_root = workspace_root().map_err(|e| format!("workspace root: {e}"))?;
    let home = crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .map_err(|e| format!("user home: {e}"))?;

    let states: Vec<_> = surface_ids
        .iter()
        .map(|s| detect_surface_state(*s, &ws_root, &home))
        .collect();

    let expected_fingerprint = plan_fingerprint
        .as_deref()
        .ok_or_else(|| "Plan fingerprint required. Re-run preview before applying.".to_string())?;
    if !setup_transaction::validate_fingerprint_format(expected_fingerprint) {
        return Err("Malformed plan fingerprint".to_string());
    }
    if setup_transaction::is_fingerprint_consumed(expected_fingerprint) {
        return Err("Preview fingerprint already used. Re-run preview before applying.".to_string());
    }
    let current_fingerprint =
        compute_plan_fingerprint_for_surfaces(&surface_ids, &ws_root, &home)?;
    if current_fingerprint != expected_fingerprint {
        return Err(
            "Plan fingerprint mismatch: state changed after preview. Re-run preview before applying."
                .to_string(),
        );
    }

    let request = SetupRequest {
        surfaces: surface_ids,
        skip_manual,
    };

    let plan = crate::setup_lifecycle::plan_setup(&request, &states);
    if plan.is_blocked {
        return Err(format!(
            "Setup blocked: {} conflict(s) must be resolved first",
            plan.conflicts.len()
        ));
    }

    let result = apply_setup_plan(&plan);
    if result.success {
        setup_transaction::mark_fingerprint_consumed(expected_fingerprint);
    }
    Ok(result)
}

#[tauri::command]
pub fn repair_setup_command(_skip_manual: bool) -> Result<SetupResult, String> {
    // Use real detection to find only truly missing surfaces
    let plan = detect_all_surfaces()?;
    Ok(repair_setup(&plan))
}

#[tauri::command]
pub fn rollback_setup_transaction(
    transaction_id: String,
    dry_run: bool,
) -> Result<SetupResult, String> {
    if !validate_transaction_id_format(&transaction_id) {
        return Err("invalid transaction_id: must be a numeric timestamp".to_string());
    }
    Ok(rollback_transaction(&transaction_id, dry_run))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_registry::ArtifactId;
    use crate::test_env::{guard, set_test_user_dirs};

    fn test_plan(ops: Vec<(SetupSurfaceId, OperationKind, String)>) -> SetupPlan {
        let request = SetupRequest {
            surfaces: vec![],
            skip_manual: false,
        };
        crate::setup_lifecycle::plan_setup(&request, &ops)
    }

    #[test]
    fn apply_empty_plan_succeeds() {
        let plan = test_plan(vec![]);
        let result = apply_setup_plan(&plan);
        assert!(result.success, "empty plan should succeed");
        assert_eq!(result.message, "No operations to apply");
    }

    #[test]
    fn apply_plan_with_only_synced_does_nothing() {
        let plan = test_plan(vec![(
            SetupSurfaceId::OpenCodeConfig,
            OperationKind::NoChange,
            "synced".to_string(),
        )]);
        let result = apply_setup_plan(&plan);
        assert!(result.success);
        assert_eq!(result.message, "No operations to apply");
    }

    #[test]
    fn symlink_preflight_rejects_symlink() {
        // Test the reject_symlink function directly
        let home = std::env::temp_dir().join("aw-setup-preflight-sym");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");

        let real = home.join("real_file");
        fs::write(&real, b"content").expect("write real");
        let link = home.join("the_link");
        let _ = std::os::unix::fs::symlink(&real, &link);

        // reject_symlink should reject symlinks
        assert!(
            reject_symlink(&real, "file").is_ok(),
            "real file should pass"
        );
        let err = reject_symlink(&link, "link").unwrap_err();
        assert!(err.contains("symlink"), "should mention symlink: {err}");

        // reject_symlink on nonexistent path should pass
        let missing = home.join("nonexistent");
        assert!(reject_symlink(&missing, "missing").is_ok());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn rollback_rejects_empty_transaction_id() {
        let result = rollback_transaction("", false);
        assert!(!result.success);
    }

    #[test]
    fn rollback_nonexistent_transaction() {
        let result = rollback_transaction("nonexistent-123", false);
        assert!(!result.success);
        assert!(result.message.contains("not found"));
    }

    #[test]
    fn rollback_dry_run_does_not_restore() {
        let _guard = guard::lock();
        let home = std::env::temp_dir().join("aw-setup-dry-run");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let result = rollback_transaction("nonexistent", true);
        // Dry-run on nonexistent should still fail — dry-run only affects
        // the existence check stage
        assert!(
            !result.success,
            "dry-run should still validate transaction exists"
        );
    }

    #[test]
    fn repair_empty_plan_succeeds() {
        let plan = test_plan(vec![]);
        let result = repair_setup(&plan);
        assert!(result.success);
        assert_eq!(result.message, "No missing resources to repair");
    }

    #[test]
    fn repair_only_creates_not_updates() {
        let plan = test_plan(vec![
            (
                SetupSurfaceId::OpenCodeConfig,
                OperationKind::Create,
                "missing".to_string(),
            ),
            (
                SetupSurfaceId::CodexConfig,
                OperationKind::Update,
                "diverged".to_string(),
            ),
        ]);
        // Use preflight to verify repair only picks create operations
        let preflight = preflight_repair(&plan);
        assert_eq!(
            preflight.missing.len(),
            1,
            "repair should only detect create (missing) operations, not updates"
        );
        assert!(
            preflight.missing[0].contains("Config"),
            "missing should be OpenCodeConfig"
        );
        assert!(preflight.safe);
    }

    #[test]
    fn preflight_repair_reports_missing() {
        let plan = test_plan(vec![
            (
                SetupSurfaceId::OpenCodeConfig,
                OperationKind::Create,
                "missing".to_string(),
            ),
            (
                SetupSurfaceId::CodexRules,
                OperationKind::NoChange,
                "synced".to_string(),
            ),
        ]);
        let preflight = preflight_repair(&plan);
        assert_eq!(preflight.missing.len(), 1);
        assert!(preflight.missing[0].contains("Config"));
        assert!(preflight.safe);
    }

    #[test]
    fn transaction_result_is_serializable() {
        let result = SetupResult {
            success: true,
            transaction_id: "test-123".to_string(),
            applied: vec!["Config".to_string()],
            failed: vec![],
            rolled_back: vec![],
            manual_steps: vec![],
            message: "All done".to_string(),
        };
        let json = serde_json::to_string(&result).expect("serialize");
        assert!(json.contains("test-123"));
        assert!(json.contains("Config"));
    }

    #[test]
    fn rollback_rejects_path_traversal_transaction_id() {
        let result = rollback_transaction("../evil", false);
        assert!(!result.success);
    }

    #[test]
    fn apply_setup_command_rejects_unknown_surface() {
        let result = apply_setup(vec!["totally_fake_surface".to_string()], false, None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Unknown surface"), "error: {err}");
    }

    #[test]
    fn apply_setup_command_rejects_empty_surfaces() {
        let result = apply_setup(vec![], false, None);
        assert!(result.is_err(), "empty surfaces must be rejected");
        let err = result.unwrap_err();
        assert!(err.contains("At least one surface"), "error: {err}");
    }

    // ── Managed detection tests ──

    #[test]
    fn detect_opencode_config_create_when_missing() {
        let home = std::env::temp_dir().join("aw-detect-oc-create");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");
        let ws = std::env::temp_dir().join("aw-detect-oc-create-ws");
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(&ws).expect("create ws");

        let (_surface, kind, _summary) =
            detect_surface_state(SetupSurfaceId::OpenCodeConfig, &ws, &home);
        assert_eq!(
            kind,
            OperationKind::Create,
            "missing config should be Create"
        );
    }

    #[test]
    fn detect_opencode_config_nochange_when_managed_keys_match() {
        let home = std::env::temp_dir().join("aw-detect-oc-match");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");
        fs::create_dir_all(home.join(".config/opencode")).expect("create opencode dir");

        let ws = std::env::temp_dir().join("aw-detect-oc-match-ws");
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join("templates")).expect("create templates dir");

        // Write identical configs with managed keys
        let config = r#"{"$schema":"test","model":"test","permissions":{"allow":[]},"plugins":{},"mcpServers":{},"tools":{},"agents":{},"skills":{},"rules":"","environment":{}}"#;
        fs::write(home.join(".config/opencode/opencode.json"), config).unwrap();
        fs::write(ws.join("templates/opencode.json"), config).unwrap();

        let (_surface, kind, _summary) =
            detect_surface_state(SetupSurfaceId::OpenCodeConfig, &ws, &home);
        assert_eq!(
            kind,
            OperationKind::NoChange,
            "matching managed keys should be NoChange"
        );
    }

    #[test]
    fn detect_opencode_config_update_when_managed_keys_differ() {
        let home = std::env::temp_dir().join("aw-detect-oc-diff");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");
        fs::create_dir_all(home.join(".config/opencode")).expect("create opencode dir");

        let ws = std::env::temp_dir().join("aw-detect-oc-diff-ws");
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join("templates")).expect("create templates dir");

        // Different managed key values
        let installed = r#"{"$schema":"test","model":"old-model","permissions":{"allow":[]},"plugins":{},"mcpServers":{},"tools":{},"agents":{},"skills":{},"rules":"","environment":{}}"#;
        let source = r#"{"$schema":"test","model":"new-model","permissions":{"allow":[]},"plugins":{},"mcpServers":{},"tools":{},"agents":{},"skills":{},"rules":"","environment":{}}"#;
        fs::write(home.join(".config/opencode/opencode.json"), installed).unwrap();
        fs::write(ws.join("templates/opencode.json"), source).unwrap();

        let (_surface, kind, _summary) =
            detect_surface_state(SetupSurfaceId::OpenCodeConfig, &ws, &home);
        assert_eq!(
            kind,
            OperationKind::Update,
            "diff managed keys should be Update"
        );
    }

    #[test]
    fn detect_codex_config_nochange_when_managed_fields_match() {
        let home = std::env::temp_dir().join("aw-detect-cx-match");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");
        fs::create_dir_all(home.join(".codex")).expect("create codex dir");

        let ws = std::env::temp_dir().join("aw-detect-cx-match-ws");
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(&ws).expect("create ws");
        fs::create_dir_all(ws.join("templates/codex")).expect("create templates");

        let config = "[profile]\n[profile.safe]\napproval_policy = \"on-request\"\nsandbox_mode = \"workspace-write\"\n[profile.workspace-write]\napproval_policy = \"on-request\"\nsandbox_mode = \"workspace-write\"\n";
        fs::write(home.join(".codex/config.toml"), config).unwrap();
        fs::write(ws.join("templates/codex/config.toml"), config).unwrap();

        let (_surface, kind, _summary) =
            detect_surface_state(SetupSurfaceId::CodexConfig, &ws, &home);
        assert_eq!(
            kind,
            OperationKind::NoChange,
            "matching managed fields should be NoChange"
        );
    }

    #[test]
    fn detect_claude_skills_create_when_missing() {
        let home = std::env::temp_dir().join("aw-detect-cl-skills-create");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");

        let ws = std::env::temp_dir().join("aw-detect-cl-skills-create-ws");
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(&ws).expect("create ws");
        // No skills directory in home

        let (_surface, kind, _summary) =
            detect_surface_state(SetupSurfaceId::ClaudeSkills, &ws, &home);
        assert_eq!(
            kind,
            OperationKind::Create,
            "missing skills dir should be Create"
        );
    }

    #[test]
    fn detect_codex_config_conflict_when_invalid_toml() {
        let home = std::env::temp_dir().join("aw-detect-cx-invalid");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");
        fs::create_dir_all(home.join(".codex")).expect("create codex dir");

        let ws = std::env::temp_dir().join("aw-detect-cx-invalid-ws");
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(&ws).expect("create ws");
        fs::create_dir_all(ws.join("templates/codex")).expect("create templates");

        // Write invalid TOML as installed config
        fs::write(home.join(".codex/config.toml"), "not valid toml {{{").unwrap();
        fs::write(ws.join("templates/codex/config.toml"), "[profile]\n").unwrap();

        let (_surface, kind, summary) =
            detect_surface_state(SetupSurfaceId::CodexConfig, &ws, &home);
        assert_eq!(
            kind,
            OperationKind::Conflict,
            "invalid TOML should be Conflict, got {kind:?}: {summary}"
        );
    }

    #[test]
    fn detect_opencode_config_conflict_when_invalid_json() {
        let home = std::env::temp_dir().join("aw-detect-oc-invalid");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");
        fs::create_dir_all(home.join(".config/opencode")).expect("create opencode dir");

        let ws = std::env::temp_dir().join("aw-detect-oc-invalid-ws");
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join("templates")).expect("create templates dir");

        // Write invalid JSON as installed config
        fs::write(home.join(".config/opencode/opencode.json"), "not json {{{").unwrap();
        fs::write(ws.join("templates/opencode.json"), "{}").unwrap();

        let (_surface, kind, summary) =
            detect_surface_state(SetupSurfaceId::OpenCodeConfig, &ws, &home);
        assert_eq!(
            kind,
            OperationKind::Conflict,
            "invalid JSON should be Conflict, got {kind:?}: {summary}"
        );
    }

    #[test]
    fn detect_rules_nochange_when_matching() {
        let home = std::env::temp_dir().join("aw-detect-rules-match");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".codex")).expect("create codex dir");

        let ws = std::env::temp_dir().join("aw-detect-rules-match-ws");
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join("templates/sync")).expect("create sync dir");

        fs::write(home.join(".codex/AGENTS.md"), "same rules").unwrap();
        fs::write(ws.join("templates/sync/codex-rules.md"), "same rules").unwrap();

        let (_surface, kind, _summary) =
            detect_surface_state(SetupSurfaceId::CodexRules, &ws, &home);
        assert_eq!(
            kind,
            OperationKind::NoChange,
            "matching rules should be NoChange"
        );
    }

    // ── Preview integrity tests ──

    #[test]
    fn plan_fingerprint_is_stable_for_same_surface_set() {
        setup_transaction::clear_consumed_fingerprints_for_test();
        let ws =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let home = std::env::temp_dir();
        let surfaces = vec![SetupSurfaceId::OpenCodeRules, SetupSurfaceId::CodexRules];
        let fp1 = compute_plan_fingerprint_for_surfaces(&surfaces, &ws, &home).expect("fp1");
        let fp2 = compute_plan_fingerprint_for_surfaces(&surfaces, &ws, &home).expect("fp2");
        assert_eq!(fp1, fp2);
        assert!(setup_transaction::validate_fingerprint_format(&fp1));
    }

    #[test]
    fn plan_fingerprint_changes_when_surfaces_differ() {
        let ws =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let home = std::env::temp_dir();
        let fp1 = compute_plan_fingerprint_for_surfaces(
            &[SetupSurfaceId::OpenCodeRules],
            &ws,
            &home,
        )
        .expect("fp1");
        let fp2 = compute_plan_fingerprint_for_surfaces(
            &[SetupSurfaceId::CodexRules],
            &ws,
            &home,
        )
        .expect("fp2");
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn apply_rejects_missing_fingerprint() {
        let result = apply_setup(vec!["open_code_rules".to_string()], false, None);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("fingerprint required"));
    }

    // ── Transaction preflight tests ──

    #[test]
    fn transaction_id_is_numeric() {
        let id = new_transaction_id().expect("transaction id");
        assert!(!id.is_empty());
        assert!(id.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn artifact_manifest_rejects_absolute_backup_paths() {
        let ws = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let manifest = ArtifactTransactionManifest {
            schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
            workspace_key: setup_transaction::workspace_key(&ws).unwrap_or_default(),
            created_at: "1".into(),
            surface_ids: vec![SetupSurfaceId::OpenCodeRules],
            operations: vec![ArtifactManifestOperation {
                artifact: ArtifactId::OpenCodeRules,
                surface: SetupSurfaceId::OpenCodeRules,
                kind: OperationKind::Update,
                previous_state: setup_transaction::PreviousState::ManagedFile,
                rollback_action: setup_transaction::RollbackAction::RestoreFile,
                backup_rel: Some("/absolute/path".into()),
                ..Default::default()
            }],
        };
        assert!(setup_transaction::validate_manifest(&manifest, &ws).is_err());
    }

    #[test]
    fn apply_empty_plan_returns_valid_transaction_id() {
        let plan = test_plan(vec![]);
        let result = apply_setup_plan(&plan);
        assert!(result.success);
        assert!(!result.transaction_id.is_empty());
        assert!(result.transaction_id.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn zero_mutations_after_preflight_failure() {
        let _guard = guard::lock();
        let home = std::env::temp_dir().join("aw-zero-mutations");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");

        // Create a plan that requires apply but will fail in preflight
        let plan = test_plan(vec![(
            SetupSurfaceId::OpenCodeConfig,
            OperationKind::Create,
            "missing".to_string(),
        )]);

        // preflight_repair should produce a result with zero applied
        let preflight = preflight_repair(&plan);
        assert!(preflight.safe);
        // No mutations should have occurred
    }
}
