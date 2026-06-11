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
use super::workspace::workspace_root;

// ── Transaction types ──

/// Unique transaction identifier (nanosecond timestamp).
pub type TransactionId = String;

use crate::setup_transaction::{
    self, ArtifactManifestOperation, ArtifactTransactionManifest, ARTIFACT_MANIFEST_SCHEMA_VERSION,
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
        _ => None,
    }
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
            let (ok, _stdout, stderr, _code) =
                run_cmd("bash", &[&script_str, "--quiet", "--apply"], workspace_root);
            if !ok {
                return Err(format!("Codex config apply failed: {stderr}"));
            }
            Ok(())
        }

        // Codex agents — use install-codex-agents.sh
        SetupSurfaceId::CodexAgents => {
            let script = workspace_root.join("scripts/install-codex-agents.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) =
                run_cmd("bash", &[&script_str, "--apply"], workspace_root);
            if !ok {
                return Err(format!("Codex agents apply failed: {stderr}"));
            }
            Ok(())
        }

        // Codex rules — use install-agent-rules.sh
        SetupSurfaceId::CodexRules => {
            let script = workspace_root.join("scripts/install-agent-rules.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let (ok, _stdout, stderr, _code) =
                run_cmd("bash", &[&script_str, "--codex", "--apply"], workspace_root);
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
            let result =
                crate::cursor_profile_ops::run_global_mcp_only(workspace_root, &cursor_paths, true);
            if !result.success {
                return Err(format!("Cursor MCP apply failed: {}", result.stderr));
            }
            Ok(())
        }

        // Skills — use install-skills.sh
        SetupSurfaceId::OpenCodeSkills
        | SetupSurfaceId::CodexSkills
        | SetupSurfaceId::ClaudeSkills => {
            let script = workspace_root.join("scripts/install-skills.sh");
            let script_str = super::workspace::path_arg(&script)?;
            let agent = surface_agent(op.surface).unwrap_or("opencode");
            let (ok, _stdout, stderr, _code) = run_cmd(
                "bash",
                &[&script_str, "--agent", agent, "--apply"],
                workspace_root,
            );
            if !ok {
                return Err(format!(
                    "{} skill install failed: {stderr}",
                    op.surface.label()
                ));
            }
            Ok(())
        }

        SetupSurfaceId::WorkspaceBundle => {
            Err("workspace bundle updates run at artifact granularity".to_string())
        }
    }
}

fn artifact_label(artifact: &crate::artifact_registry::ArtifactId) -> String {
    format!("{artifact:?}")
}

#[derive(Clone, Copy)]
enum RollbackExecutionMode {
    Automatic,
    Explicit,
}

fn finalize_persisted_rollback(
    manifest_path: &Path,
    manifest: &mut ArtifactTransactionManifest,
    backup_dir: &Path,
) -> Option<String> {
    let final_status = setup_transaction::compute_finalize_rollback_status(&manifest.operations);
    persist_setup_manifest(manifest_path, manifest, final_status, backup_dir).err()
}

fn run_persisted_rollback(
    manifest_path: &Path,
    manifest: &mut ArtifactTransactionManifest,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
    mode: RollbackExecutionMode,
) -> (Vec<String>, Vec<String>, Option<String>) {
    let indices = setup_transaction::rollback_eligible_indices(&manifest.operations);
    if indices.is_empty() {
        if matches!(
            manifest.transaction_status,
            setup_transaction::TransactionStatus::RollingBack
                | setup_transaction::TransactionStatus::RollbackFailed
        ) {
            return (
                vec![],
                vec![],
                finalize_persisted_rollback(manifest_path, manifest, backup_dir),
            );
        }
        return (vec![], vec![], None);
    }

    if let Err(e) = persist_setup_manifest(
        manifest_path,
        manifest,
        setup_transaction::TransactionStatus::RollingBack,
        backup_dir,
    ) {
        return (vec![], vec![], Some(e));
    }

    let mut rolled_back = Vec::new();
    let mut errors = Vec::new();
    for index in indices.into_iter().rev() {
        if matches!(
            manifest.operations[index].rollback_status,
            setup_transaction::RollbackStatus::InFlight
        ) {
            match setup_transaction::reconcile_in_flight_rollback_artifact(
                &manifest.operations[index],
                backup_dir,
                home,
                workspace_root,
            ) {
                Ok(setup_transaction::RollbackReconcileOutcome::AlreadyRestored) => {
                    manifest.operations[index].rollback_status =
                        setup_transaction::RollbackStatus::Restored;
                    if let Err(e) = persist_setup_manifest(
                        manifest_path,
                        manifest,
                        setup_transaction::TransactionStatus::RollingBack,
                        backup_dir,
                    ) {
                        return (rolled_back, errors, Some(e));
                    }
                    continue;
                }
                Ok(setup_transaction::RollbackReconcileOutcome::Conflicted) => {
                    manifest.operations[index].rollback_status =
                        setup_transaction::RollbackStatus::Failed;
                    errors.push(format!(
                        "{}: rollback conflict: artifact matches neither post-apply nor backup state",
                        artifact_label(&manifest.operations[index].artifact)
                    ));
                    if let Err(e) = persist_setup_manifest(
                        manifest_path,
                        manifest,
                        setup_transaction::TransactionStatus::RollingBack,
                        backup_dir,
                    ) {
                        return (rolled_back, errors, Some(e));
                    }
                    continue;
                }
                Ok(setup_transaction::RollbackReconcileOutcome::NeedsRollback) => {}
                Err(e) => {
                    manifest.operations[index].rollback_status =
                        setup_transaction::RollbackStatus::Failed;
                    errors.push(format!(
                        "{}: {e}",
                        artifact_label(&manifest.operations[index].artifact)
                    ));
                    if let Err(e) = persist_setup_manifest(
                        manifest_path,
                        manifest,
                        setup_transaction::TransactionStatus::RollingBack,
                        backup_dir,
                    ) {
                        return (rolled_back, errors, Some(e));
                    }
                    continue;
                }
            }
        }

        manifest.operations[index].rollback_status = setup_transaction::RollbackStatus::InFlight;
        if let Err(e) = persist_setup_manifest(
            manifest_path,
            manifest,
            setup_transaction::TransactionStatus::RollingBack,
            backup_dir,
        ) {
            return (rolled_back, errors, Some(e));
        }

        let op = &mut manifest.operations[index];
        let artifact = op.artifact.clone();
        let restore_result = match mode {
            RollbackExecutionMode::Automatic => {
                setup_transaction::restore_artifact_from_backup(op, backup_dir, home)
            }
            RollbackExecutionMode::Explicit => {
                setup_transaction::restore_artifact_from_backup_for_explicit_rollback(
                    op,
                    backup_dir,
                    home,
                    workspace_root,
                )
            }
        };
        match restore_result {
            Ok(()) => {
                if let Err(e) = setup_transaction::validate_artifact_matches_backup_after_rollback(
                    op,
                    backup_dir,
                    home,
                    workspace_root,
                ) {
                    op.rollback_status = setup_transaction::RollbackStatus::Failed;
                    errors.push(format!("{}: {e}", artifact_label(&artifact)));
                } else {
                    op.rollback_status = setup_transaction::RollbackStatus::Restored;
                    rolled_back.push(artifact_label(&artifact));
                }
            }
            Err(e) => {
                op.rollback_status = setup_transaction::RollbackStatus::Failed;
                errors.push(format!("{}: {e}", artifact_label(&artifact)));
            }
        }
        if let Err(e) = persist_setup_manifest(
            manifest_path,
            manifest,
            setup_transaction::TransactionStatus::RollingBack,
            backup_dir,
        ) {
            return (rolled_back, errors, Some(e));
        }
    }

    if let Some(e) = finalize_persisted_rollback(manifest_path, manifest, backup_dir) {
        return (rolled_back, errors, Some(e));
    }
    (rolled_back, errors, None)
}

struct RollbackDryRunPlan {
    already_restored: Vec<String>,
    requires_rollback: Vec<String>,
    conflicted: Vec<String>,
}

fn plan_rollback_dry_run(
    manifest: &ArtifactTransactionManifest,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> RollbackDryRunPlan {
    let mut plan = RollbackDryRunPlan {
        already_restored: Vec::new(),
        requires_rollback: Vec::new(),
        conflicted: Vec::new(),
    };
    for op in manifest
        .operations
        .iter()
        .filter(|op| setup_transaction::operation_may_have_been_modified(op.apply_status))
    {
        let label = artifact_label(&op.artifact);
        if matches!(
            op.rollback_status,
            setup_transaction::RollbackStatus::Restored
        ) {
            plan.already_restored.push(label);
            continue;
        }
        if matches!(
            op.rollback_status,
            setup_transaction::RollbackStatus::InFlight
        ) {
            match setup_transaction::reconcile_in_flight_rollback_artifact(
                op,
                backup_dir,
                home,
                workspace_root,
            ) {
                Ok(setup_transaction::RollbackReconcileOutcome::AlreadyRestored) => {
                    plan.already_restored.push(label);
                }
                Ok(setup_transaction::RollbackReconcileOutcome::NeedsRollback) => {
                    plan.requires_rollback.push(label);
                }
                Ok(setup_transaction::RollbackReconcileOutcome::Conflicted) => {
                    plan.conflicted.push(label);
                }
                Err(_) => plan.conflicted.push(label),
            }
            continue;
        }
        if setup_transaction::operation_eligible_for_rollback_mutation(op) {
            plan.requires_rollback.push(label);
        }
    }
    plan.requires_rollback.reverse();
    plan
}

fn persist_setup_manifest(
    manifest_path: &Path,
    manifest: &mut ArtifactTransactionManifest,
    status: setup_transaction::TransactionStatus,
    transaction_root: &Path,
) -> Result<(), String> {
    manifest.transaction_status = status;
    setup_transaction::persist_manifest_atomic(manifest_path, manifest, transaction_root)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApplyExecutionMode {
    SurfaceScripts,
    CreateOnlyArtifacts,
}

fn remove_single_artifact(
    artifact: &crate::artifact_registry::ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    let dest = artifact.resolve_dest(home, workspace_root)?;
    setup_transaction::reject_symlink(&dest, "remove destination")?;
    if !dest.exists() {
        return Ok(());
    }
    let root = if matches!(
        artifact,
        crate::artifact_registry::ArtifactId::WorkspaceFile(_)
    ) {
        workspace_root
    } else {
        home
    };
    if dest.is_dir() {
        crate::safe_filesystem::remove_dir_no_symlinks(&dest, root)
            .map_err(|e| format!("remove {}: {e}", dest.display()))?;
    } else if dest.is_file() {
        fs::remove_file(&dest).map_err(|e| format!("remove {}: {e}", dest.display()))?;
    }
    Ok(())
}

fn create_single_artifact(
    artifact: &crate::artifact_registry::ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    let (source, dest) =
        setup_transaction::validate_artifact_source_dest(artifact, workspace_root, home)?;
    if dest.exists() {
        return Err(format!(
            "refusing create: destination already exists: {}",
            dest.display()
        ));
    }

    if source.is_dir() {
        crate::safe_filesystem::copy_dir_no_symlinks(&source, &dest, home)
            .map_err(|e| format!("create skill dir: {e}"))?;
        return Ok(());
    }

    if artifact == &crate::artifact_registry::ArtifactId::CursorMcp {
        let cursor_paths = crate::cursor_profile_paths::resolve_cursor_profile_paths()
            .map_err(|e| format!("resolve Cursor profile: {e}"))?;
        let result =
            crate::cursor_profile_ops::run_global_mcp_only(workspace_root, &cursor_paths, true);
        if !result.success {
            return Err(format!("Cursor MCP create failed: {}", result.stderr));
        }
        return Ok(());
    }

    if artifact == &crate::artifact_registry::ArtifactId::OpenCodeConfig {
        let template_str = fs::read_to_string(&source)
            .map_err(|e| format!("read opencode template {}: {e}", source.display()))?;
        let template_json: serde_json::Value = serde_json::from_str(&template_str)
            .map_err(|e| format!("parse opencode template json: {e}"))?;
        let rendered = crate::commands::render_expected_opencode_config(&template_json, home)
            .ok_or_else(|| "cannot render opencode config".to_string())?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create parent {}: {e}", parent.display()))?;
        }
        fs::write(
            &dest,
            serde_json::to_string_pretty(&rendered)
                .map_err(|e| format!("serialize opencode config: {e}"))?
                + "\n",
        )
        .map_err(|e| format!("write opencode config {}: {e}", dest.display()))?;
        return Ok(());
    }

    if artifact == &crate::artifact_registry::ArtifactId::CodexConfig {
        let source_str = fs::read_to_string(&source)
            .map_err(|e| format!("read codex template {}: {e}", source.display()))?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create parent {}: {e}", parent.display()))?;
        }
        fs::write(&dest, source_str)
            .map_err(|e| format!("write codex config {}: {e}", dest.display()))?;
        return Ok(());
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create parent {}: {e}", parent.display()))?;
    }
    fs::copy(&source, &dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    Ok(())
}

fn cleanup_preflight_transaction_evidence(backup_dir: &Path) {
    let manifest_path = backup_dir.join("manifest.json");
    let _ = fs::remove_file(&manifest_path);
    let _ = fs::remove_dir(backup_dir);
}

fn run_persisted_automatic_rollback(
    manifest_path: &Path,
    manifest: &mut ArtifactTransactionManifest,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> (Vec<String>, Vec<String>, Option<String>) {
    run_persisted_rollback(
        manifest_path,
        manifest,
        backup_dir,
        home,
        workspace_root,
        RollbackExecutionMode::Automatic,
    )
}

struct FailedApplyRollback<'a> {
    manifest_path: &'a Path,
    manifest: &'a mut ArtifactTransactionManifest,
    backup_dir: &'a Path,
    home: &'a Path,
    workspace_root: &'a Path,
    transaction_id: String,
    applied: Vec<String>,
    failed: Vec<String>,
    manual_steps: Vec<String>,
    message: String,
}

fn finish_failed_apply_with_rollback(ctx: FailedApplyRollback<'_>) -> SetupResult {
    let mut failed = ctx.failed;
    let mut message = ctx.message;
    let (rolled_back, rb_errors, persist_err) = run_persisted_automatic_rollback(
        ctx.manifest_path,
        ctx.manifest,
        ctx.backup_dir,
        ctx.home,
        ctx.workspace_root,
    );
    if !rb_errors.is_empty() {
        message.push_str(&format!(". Rollback errors: {}", rb_errors.join("; ")));
    }
    if let Some(persist_err) = persist_err {
        failed.push(persist_err);
    }
    SetupResult {
        success: false,
        transaction_id: ctx.transaction_id,
        applied: ctx.applied,
        failed,
        rolled_back,
        manual_steps: ctx.manual_steps,
        message,
    }
}

fn user_home() -> Result<PathBuf, String> {
    crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
}

// ── Apply ──

/// Apply artifact-level operations using artifact-owned transactions.
fn apply_planned_artifacts(
    pending: &[setup_transaction::PlannedArtifact],
    manual_steps: Vec<String>,
    execution_mode: ApplyExecutionMode,
    preview_token: Option<&str>,
) -> SetupResult {
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

    let _mutation_guard = match crate::setup_mutation_guard::try_acquire_setup_mutation_guard() {
        Ok(guard) => guard,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps,
                message: e,
            };
        }
    };

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

    let mut surfaces: Vec<SetupSurfaceId> = pending.iter().map(|p| p.surface).collect();
    surfaces.sort_by_key(|s| format!("{s:?}"));
    surfaces.dedup();

    for p in pending {
        if matches!(p.kind, OperationKind::Remove) {
            continue;
        }
        if let Err(e) =
            setup_transaction::validate_artifact_source_dest(&p.artifact, &ws_root, &home)
        {
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
    for p in pending {
        let backup_rel =
            match setup_transaction::backup_artifact(&p.artifact, &backup_dir, &home, &ws_root) {
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

    let workspace_key = match setup_transaction::workspace_key(&ws_root) {
        Ok(key) => key,
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

    let mut manifest = ArtifactTransactionManifest {
        schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
        workspace_key,
        created_at: transaction_id.clone(),
        surface_ids: surfaces.clone(),
        transaction_status: setup_transaction::TransactionStatus::Prepared,
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
    if let Err(e) = persist_setup_manifest(
        &manifest_path,
        &mut manifest,
        setup_transaction::TransactionStatus::Prepared,
        &backup_dir,
    ) {
        return SetupResult {
            success: false,
            transaction_id,
            applied: vec![],
            failed: vec![e.clone()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Cannot write transaction manifest: {e}"),
        };
    }
    if let Err(e) = setup_transaction::validate_manifest(&manifest, &ws_root) {
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

    if let Some(token) = preview_token {
        if let Err(e) = setup_transaction::consume_preview_token(token) {
            cleanup_preflight_transaction_evidence(&backup_dir);
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!(
                    "Preview token consumption failed after preflight; no mutations performed: {e}"
                ),
            };
        }
    }

    let surfaces_to_execute = setup_transaction::surfaces_needing_apply(pending);
    let mut applied: Vec<String> = Vec::new();

    if let Err(e) = persist_setup_manifest(
        &manifest_path,
        &mut manifest,
        setup_transaction::TransactionStatus::Applying,
        &backup_dir,
    ) {
        return SetupResult {
            success: false,
            transaction_id,
            applied: vec![],
            failed: vec![e.clone()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Cannot persist applying status: {e}"),
        };
    }

    for p in pending
        .iter()
        .filter(|p| matches!(p.kind, OperationKind::Remove))
    {
        if let Err(e) = remove_single_artifact(&p.artifact, &ws_root, &home) {
            let err = format!("{}: {e}", artifact_label(&p.artifact));
            let mut failed = vec![err.clone()];
            if let Err(persist_err) = persist_setup_manifest(
                &manifest_path,
                &mut manifest,
                setup_transaction::TransactionStatus::Failed,
                &backup_dir,
            ) {
                failed.push(persist_err);
            }
            return finish_failed_apply_with_rollback(FailedApplyRollback {
                manifest_path: &manifest_path,
                manifest: &mut manifest,
                backup_dir: &backup_dir,
                home: &home,
                workspace_root: &ws_root,
                transaction_id,
                applied,
                failed,
                manual_steps: manual_steps.clone(),
                message: format!("Remove failed: {err}"),
            });
        }
        applied.push(format!("removed {}", artifact_label(&p.artifact)));
        if let Some(op) = manifest
            .operations
            .iter_mut()
            .find(|o| o.artifact == p.artifact)
        {
            op.apply_status = setup_transaction::ApplyStatus::Applied;
            op.validation_status = setup_transaction::ValidationStatus::Passed;
        }
    }

    for surface in &surfaces_to_execute {
        setup_transaction::mark_surface_group_in_flight(&mut manifest.operations, *surface);
        if let Err(e) = persist_setup_manifest(
            &manifest_path,
            &mut manifest,
            setup_transaction::TransactionStatus::Applying,
            &backup_dir,
        ) {
            let message = format!("Cannot persist in-flight status: {e}");
            return finish_failed_apply_with_rollback(FailedApplyRollback {
                manifest_path: &manifest_path,
                manifest: &mut manifest,
                backup_dir: &backup_dir,
                home: &home,
                workspace_root: &ws_root,
                transaction_id,
                applied,
                failed: vec![e],
                manual_steps: manual_steps.clone(),
                message,
            });
        }

        let apply_error = match execution_mode {
            ApplyExecutionMode::SurfaceScripts => {
                let surface_op = PlannedOperation {
                    surface: *surface,
                    kind: OperationKind::Update,
                    summary: surface.label().to_string(),
                    details: vec![],
                    conflict_description: None,
                    manual_step: None,
                };
                execute_operation_and_validate(&surface_op, &ws_root)
                    .err()
                    .map(|e| format!("{}: {e}", surface.label()))
            }
            ApplyExecutionMode::CreateOnlyArtifacts => {
                let surface_artifacts: Vec<_> =
                    pending.iter().filter(|p| p.surface == *surface).collect();
                let mut first_error = None;
                for p in &surface_artifacts {
                    if !matches!(p.kind, OperationKind::Create) {
                        continue;
                    }
                    if let Err(e) = create_single_artifact(&p.artifact, &ws_root, &home) {
                        first_error = Some(format!("{}: {e}", artifact_label(&p.artifact)));
                        break;
                    }
                }
                first_error
            }
        };

        if let Some(err) = apply_error {
            for op in manifest.operations.iter_mut() {
                if op.surface == *surface {
                    op.apply_status = setup_transaction::ApplyStatus::Failed;
                }
            }
            let mut failed = vec![err.clone()];
            if let Err(persist_err) = persist_setup_manifest(
                &manifest_path,
                &mut manifest,
                setup_transaction::TransactionStatus::Failed,
                &backup_dir,
            ) {
                failed.push(persist_err);
            }
            return finish_failed_apply_with_rollback(FailedApplyRollback {
                manifest_path: &manifest_path,
                manifest: &mut manifest,
                backup_dir: &backup_dir,
                home: &home,
                workspace_root: &ws_root,
                transaction_id,
                applied,
                failed,
                manual_steps: manual_steps.clone(),
                message: format!("Apply failed: {err}"),
            });
        }

        let surface_artifacts: Vec<_> = pending.iter().filter(|p| p.surface == *surface).collect();
        let mut validation_failed = false;
        let mut validation_error = String::new();
        for p in &surface_artifacts {
            if let Err(e) =
                setup_transaction::validate_artifact_after_apply(&p.artifact, &ws_root, &home)
            {
                validation_failed = true;
                validation_error = format!("{}: {e}", artifact_label(&p.artifact));
                break;
            }
            applied.push(artifact_label(&p.artifact));
            let post_apply_digest = crate::setup_fingerprint::artifact_installed_managed_digest(
                &p.artifact,
                &ws_root,
                &home,
            )
            .ok();
            let post_apply_full_digest = crate::setup_fingerprint::artifact_installed_full_digest(
                &p.artifact,
                &ws_root,
                &home,
            )
            .ok();
            if let Some(op) = manifest
                .operations
                .iter_mut()
                .find(|o| o.artifact == p.artifact)
            {
                op.apply_status = setup_transaction::ApplyStatus::Applied;
                op.validation_status = setup_transaction::ValidationStatus::Passed;
                op.post_apply_digest = post_apply_digest;
                op.post_apply_full_digest = post_apply_full_digest;
            }
        }

        if validation_failed {
            for op in manifest.operations.iter_mut() {
                if op.surface == *surface
                    && op.apply_status == setup_transaction::ApplyStatus::InFlight
                {
                    op.apply_status = setup_transaction::ApplyStatus::Failed;
                    op.validation_status = setup_transaction::ValidationStatus::Failed;
                }
            }
            let mut failed = vec![validation_error.clone()];
            if let Err(persist_err) = persist_setup_manifest(
                &manifest_path,
                &mut manifest,
                setup_transaction::TransactionStatus::Failed,
                &backup_dir,
            ) {
                failed.push(persist_err);
            }
            return finish_failed_apply_with_rollback(FailedApplyRollback {
                manifest_path: &manifest_path,
                manifest: &mut manifest,
                backup_dir: &backup_dir,
                home: &home,
                workspace_root: &ws_root,
                transaction_id,
                applied,
                failed,
                manual_steps: manual_steps.clone(),
                message: format!("Validation failed: {validation_error}"),
            });
        }

        if let Err(e) = persist_setup_manifest(
            &manifest_path,
            &mut manifest,
            setup_transaction::TransactionStatus::Applying,
            &backup_dir,
        ) {
            let message = format!("Cannot persist apply progress: {e}");
            return finish_failed_apply_with_rollback(FailedApplyRollback {
                manifest_path: &manifest_path,
                manifest: &mut manifest,
                backup_dir: &backup_dir,
                home: &home,
                workspace_root: &ws_root,
                transaction_id,
                applied,
                failed: vec![e],
                manual_steps: manual_steps.clone(),
                message,
            });
        }
    }

    if let Err(e) = persist_setup_manifest(
        &manifest_path,
        &mut manifest,
        setup_transaction::TransactionStatus::Completed,
        &backup_dir,
    ) {
        let message = format!("Cannot persist completed status: {e}");
        return finish_failed_apply_with_rollback(FailedApplyRollback {
            manifest_path: &manifest_path,
            manifest: &mut manifest,
            backup_dir: &backup_dir,
            home: &home,
            workspace_root: &ws_root,
            transaction_id,
            applied,
            failed: vec![e],
            manual_steps,
            message,
        });
    }

    match crate::managed_state::build_managed_state_from_installed(&ws_root, &home, &ws_root) {
        Ok(state) => {
            if let Err(e) = crate::managed_state::write_managed_state_atomic(&ws_root, &state) {
                let message = format!("Apply succeeded but managed state was not published: {e}");
                return finish_failed_apply_with_rollback(FailedApplyRollback {
                    manifest_path: &manifest_path,
                    manifest: &mut manifest,
                    backup_dir: &backup_dir,
                    home: &home,
                    workspace_root: &ws_root,
                    transaction_id,
                    applied,
                    failed: vec![e],
                    manual_steps,
                    message,
                });
            }
        }
        Err(e) => {
            let message = format!("Apply succeeded but managed state build failed: {e}");
            return finish_failed_apply_with_rollback(FailedApplyRollback {
                manifest_path: &manifest_path,
                manifest: &mut manifest,
                backup_dir: &backup_dir,
                home: &home,
                workspace_root: &ws_root,
                transaction_id,
                applied,
                failed: vec![e],
                manual_steps,
                message,
            });
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

/// Read-only repair preview with integrity fingerprint.
#[derive(Debug, Clone, Serialize)]
pub struct RepairPreview {
    pub missing_artifacts: Vec<String>,
    pub skipped_updates: usize,
    pub skipped_conflicts: usize,
    pub skipped_unavailable: usize,
    pub repair_fingerprint: Option<String>,
    pub repair_preview_token: Option<String>,
    pub message: String,
}

fn compute_repair_fingerprint(
    workspace_root: &Path,
    home: &Path,
    create_pending: &[setup_transaction::PlannedArtifact],
) -> Result<Option<String>, String> {
    if create_pending.is_empty() {
        return Ok(None);
    }
    let mut surfaces: Vec<SetupSurfaceId> = create_pending.iter().map(|p| p.surface).collect();
    surfaces.sort_by_key(|s| format!("{s:?}"));
    surfaces.dedup();
    Ok(Some(setup_transaction::compute_plan_fingerprint(
        workspace_root,
        &surfaces,
        create_pending,
        home,
    )?))
}

/// Read-only repair preview listing create-only artifacts.
#[tauri::command]
pub fn preview_repair_setup() -> Result<RepairPreview, String> {
    let ws_root = workspace_root()?;
    let home = user_home()?;
    let surfaces: Vec<SetupSurfaceId> = SetupSurfaceId::ALL.to_vec();
    let planned = setup_transaction::plan_artifacts_for_surfaces(&surfaces, &ws_root, &home)?;
    let create_pending: Vec<_> = planned
        .iter()
        .filter(|p| matches!(p.kind, OperationKind::Create))
        .cloned()
        .collect();
    let skipped_updates = planned
        .iter()
        .filter(|p| matches!(p.kind, OperationKind::Update))
        .count();
    let skipped_conflicts = planned
        .iter()
        .filter(|p| matches!(p.kind, OperationKind::Conflict))
        .count();
    let skipped_unavailable = planned
        .iter()
        .filter(|p| matches!(p.kind, OperationKind::Unavailable))
        .count();
    let missing_artifacts: Vec<String> = create_pending
        .iter()
        .map(|p| artifact_label(&p.artifact))
        .collect();
    let repair_fingerprint = compute_repair_fingerprint(&ws_root, &home, &create_pending)?;
    let mut repair_surfaces: Vec<SetupSurfaceId> =
        create_pending.iter().map(|p| p.surface).collect();
    repair_surfaces.sort_by_key(|s| format!("{s:?}"));
    repair_surfaces.dedup();
    let repair_preview_token = match repair_fingerprint.as_deref() {
        Some(fp) => Some(setup_transaction::issue_preview_token(
            &ws_root,
            fp,
            setup_transaction::PreviewPurpose::Repair,
            &repair_surfaces,
        )?),
        None => None,
    };
    let message = if create_pending.is_empty() {
        format!(
            "No missing artifacts ({skipped_updates} updates skipped, {skipped_conflicts} conflicts, {skipped_unavailable} unavailable)"
        )
    } else {
        format!(
            "{} missing artifact(s) can be repaired",
            create_pending.len()
        )
    };
    Ok(RepairPreview {
        missing_artifacts,
        skipped_updates,
        skipped_conflicts,
        skipped_unavailable,
        repair_fingerprint,
        repair_preview_token,
        message,
    })
}

/// Repair managed artifacts — only creates safely absent resources.
///
/// Uses fresh artifact detection. Does not overwrite diverged content, update
/// configs, or remove unknown user artifacts.
pub fn repair_setup_artifacts(
    repair_fingerprint: Option<&str>,
    repair_preview_token: Option<&str>,
) -> SetupResult {
    let ws_root = match workspace_root() {
        Ok(r) => r,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id: String::new(),
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
                transaction_id: String::new(),
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: e,
            };
        }
    };

    let surfaces: Vec<SetupSurfaceId> = SetupSurfaceId::ALL.to_vec();

    let planned = match setup_transaction::plan_artifacts_for_surfaces(&surfaces, &ws_root, &home) {
        Ok(p) => p,
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

    let synced_count = planned
        .iter()
        .filter(|p| matches!(p.kind, OperationKind::NoChange))
        .count();
    let conflict_count = planned
        .iter()
        .filter(|p| matches!(p.kind, OperationKind::Update | OperationKind::Conflict))
        .count();
    let unavailable_count = planned
        .iter()
        .filter(|p| matches!(p.kind, OperationKind::Unavailable))
        .count();

    let create_pending: Vec<setup_transaction::PlannedArtifact> = planned
        .into_iter()
        .filter(|p| matches!(p.kind, OperationKind::Create))
        .collect();

    let expected = match repair_fingerprint {
        Some(fp) => fp,
        None => {
            return SetupResult {
                success: false,
                transaction_id: String::new(),
                applied: vec![],
                failed: vec!["repair fingerprint required".to_string()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: "Repair fingerprint required. Run repair preview before applying."
                    .to_string(),
            };
        }
    };
    if !setup_transaction::validate_fingerprint_format(expected) {
        return SetupResult {
            success: false,
            transaction_id: String::new(),
            applied: vec![],
            failed: vec!["malformed repair fingerprint".to_string()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: "Malformed repair fingerprint".to_string(),
        };
    }
    let token = match repair_preview_token {
        Some(t) => t,
        None => {
            return SetupResult {
                success: false,
                transaction_id: String::new(),
                applied: vec![],
                failed: vec!["repair preview token required".to_string()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: "Repair preview token required. Run repair preview before applying."
                    .to_string(),
            };
        }
    };
    let current = compute_repair_fingerprint(&ws_root, &home, &create_pending)
        .ok()
        .flatten()
        .unwrap_or_default();
    if current != expected {
        return SetupResult {
            success: false,
            transaction_id: String::new(),
            applied: vec![],
            failed: vec!["stale repair preview".to_string()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: "Repair preview mismatch: state changed. Re-run repair preview.".to_string(),
        };
    }
    let mut repair_surfaces: Vec<SetupSurfaceId> =
        create_pending.iter().map(|p| p.surface).collect();
    repair_surfaces.sort_by_key(|s| format!("{s:?}"));
    repair_surfaces.dedup();
    if let Err(e) = setup_transaction::validate_preview_token(
        token,
        &ws_root,
        expected,
        setup_transaction::PreviewPurpose::Repair,
        &repair_surfaces,
    ) {
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

    if create_pending.is_empty() {
        return SetupResult {
            success: true,
            transaction_id: new_transaction_id().unwrap_or_default(),
            applied: vec![],
            failed: vec![],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!(
                "No missing artifacts to repair ({synced_count} synced, {conflict_count} conflicts, {unavailable_count} unavailable)"
            ),
        };
    }

    let mut result = apply_planned_artifacts(
        &create_pending,
        vec![],
        ApplyExecutionMode::CreateOnlyArtifacts,
        Some(token),
    );
    if result.success {
        result.message = format!(
            "Repaired {} artifact(s); {synced_count} synced; {conflict_count} conflicts skipped; {unavailable_count} unavailable",
            result.applied.len()
        );
    }
    result
}

// ── Rollback ──

/// Rollback a completed setup transaction.
///
/// Only validates the transaction ID and allows rollback if:
/// - The transaction manifest exists
/// - The backup files are present
/// - The destination paths are resolvable from the current registry
pub fn rollback_transaction(transaction_id: &str, dry_run: bool) -> SetupResult {
    if !validate_transaction_id_format(transaction_id) {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec!["invalid transaction_id format".to_string()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: "invalid transaction_id: must be a numeric timestamp".to_string(),
        };
    }

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

    if let Err(e) = setup_transaction::reject_symlink(&backup_dir, "backup directory") {
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
    if let Err(e) = setup_transaction::reject_symlink_parent_chain(
        &backup_dir,
        &backup_root,
        "transaction root",
    ) {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![e.clone()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Transaction root safety failed: {e}"),
        };
    }

    let manifest_path = backup_dir.join("manifest.json");
    if let Err(e) = setup_transaction::reject_symlink(&manifest_path, "manifest") {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![e.clone()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Manifest symlink rejected: {e}"),
        };
    }
    if let Err(e) =
        setup_transaction::reject_symlink_parent_chain(&manifest_path, &backup_dir, "manifest path")
    {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![e.clone()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Manifest path safety failed: {e}"),
        };
    }
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

    match manifest.transaction_status {
        setup_transaction::TransactionStatus::Completed
        | setup_transaction::TransactionStatus::Failed
        | setup_transaction::TransactionStatus::RollingBack
        | setup_transaction::TransactionStatus::RollbackFailed => {}
        setup_transaction::TransactionStatus::RolledBack => {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec!["transaction already rolled back".to_string()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: "Transaction already rolled back".to_string(),
            };
        }
        _ => {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec!["transaction not eligible for rollback".to_string()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: "Transaction status does not allow rollback".to_string(),
            };
        }
    }

    let eligible: Vec<ArtifactManifestOperation> = manifest
        .operations
        .iter()
        .filter(|op| setup_transaction::operation_eligible_for_rollback_mutation(op))
        .cloned()
        .collect();

    if eligible.is_empty() {
        if matches!(
            manifest.transaction_status,
            setup_transaction::TransactionStatus::RollingBack
                | setup_transaction::TransactionStatus::RollbackFailed
        ) {
            let plan = plan_rollback_dry_run(&manifest, &backup_dir, &home, &ws_root);
            if dry_run {
                let finalize_status =
                    setup_transaction::compute_finalize_rollback_status(&manifest.operations);
                let already_count = plan.already_restored.len();
                let conflict_count = plan.conflicted.len();
                return SetupResult {
                    success: conflict_count == 0,
                    transaction_id: transaction_id.to_string(),
                    applied: plan.requires_rollback,
                    failed: plan.conflicted,
                    rolled_back: plan.already_restored,
                    manual_steps: vec![],
                    message: format!(
                        "Dry run: {already_count} already restored, {conflict_count} conflicted; would finalize to {:?}",
                        finalize_status
                    ),
                };
            }
            let mut manifest_mut = manifest;
            if let Some(persist_err) =
                finalize_persisted_rollback(&manifest_path, &mut manifest_mut, &backup_dir)
            {
                return SetupResult {
                    success: false,
                    transaction_id: transaction_id.to_string(),
                    applied: vec![],
                    failed: vec![persist_err],
                    rolled_back: vec![],
                    manual_steps: vec![],
                    message: "Rollback finalization persist failed".to_string(),
                };
            }
            let final_status = manifest_mut.transaction_status;
            return SetupResult {
                success: matches!(
                    final_status,
                    setup_transaction::TransactionStatus::RolledBack
                ),
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: if matches!(
                    final_status,
                    setup_transaction::TransactionStatus::RollbackFailed
                ) {
                    vec!["rollback artifacts remain unresolved".to_string()]
                } else {
                    vec![]
                },
                rolled_back: plan.already_restored,
                manual_steps: vec![],
                message: format!("Finalized rollback transaction as {:?}", final_status),
            };
        }
        return SetupResult {
            success: true,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![],
            rolled_back: vec![],
            manual_steps: vec![],
            message: "No applied artifacts to roll back".to_string(),
        };
    }

    for op in &eligible {
        let in_flight = matches!(
            op.rollback_status,
            setup_transaction::RollbackStatus::InFlight
        );
        if let Err(e) = setup_transaction::validate_backup_for_rollback(op, &backup_dir) {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec![format!("{}: {e}", artifact_label(&op.artifact))],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Rollback preflight failed: {e}"),
            };
        }
        if !in_flight {
            if let Err(e) = setup_transaction::validate_create_target_unchanged(op, &ws_root, &home)
            {
                return SetupResult {
                    success: false,
                    transaction_id: transaction_id.to_string(),
                    applied: vec![],
                    failed: vec![format!("{}: {e}", artifact_label(&op.artifact))],
                    rolled_back: vec![],
                    manual_steps: vec![],
                    message: format!(
                        "Rollback preflight failed: artifact changed since apply: {e}"
                    ),
                };
            }
            if let Err(e) = setup_transaction::validate_update_target_unchanged(op, &ws_root, &home)
            {
                return SetupResult {
                    success: false,
                    transaction_id: transaction_id.to_string(),
                    applied: vec![],
                    failed: vec![format!("{}: {e}", artifact_label(&op.artifact))],
                    rolled_back: vec![],
                    manual_steps: vec![],
                    message: format!(
                        "Rollback preflight failed: artifact changed since apply: {e}"
                    ),
                };
            }
        }
        let dest = match op.artifact.resolve_dest(&home, &ws_root) {
            Ok(d) => d,
            Err(e) => {
                return SetupResult {
                    success: false,
                    transaction_id: transaction_id.to_string(),
                    applied: vec![],
                    failed: vec![e],
                    rolled_back: vec![],
                    manual_steps: vec![],
                    message: "Rollback preflight failed: cannot resolve destination".to_string(),
                };
            }
        };
        if let Err(e) = setup_transaction::reject_symlink(&dest, "rollback destination") {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Rollback preflight failed: symlinked destination: {e}"),
            };
        }
        if let Err(e) =
            setup_transaction::reject_symlink_parent_chain(&dest, &home, "rollback destination")
        {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Rollback preflight failed: unsafe destination path: {e}"),
            };
        }
    }

    if dry_run {
        let plan = plan_rollback_dry_run(&manifest, &backup_dir, &home, &ws_root);
        let restore_count = plan.requires_rollback.len();
        let already_count = plan.already_restored.len();
        let conflict_count = plan.conflicted.len();
        return SetupResult {
            success: conflict_count == 0,
            transaction_id: transaction_id.to_string(),
            applied: plan.requires_rollback,
            failed: plan.conflicted,
            rolled_back: plan.already_restored,
            manual_steps: vec![],
            message: format!(
                "Dry run: would restore {restore_count} artifact(s); {already_count} already restored; {conflict_count} conflicted"
            ),
        };
    }

    let _mutation_guard = match crate::setup_mutation_guard::try_acquire_setup_mutation_guard() {
        Ok(guard) => guard,
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

    let mut manifest_mut = manifest;
    let (restored, rollback_failures, persist_err) = run_persisted_rollback(
        &manifest_path,
        &mut manifest_mut,
        &backup_dir,
        &home,
        &ws_root,
        RollbackExecutionMode::Explicit,
    );
    let restored_count = restored.len();
    let success = rollback_failures.is_empty();
    if let Some(persist_err) = persist_err {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![persist_err],
            rolled_back: restored,
            manual_steps: vec![],
            message: "Rollback completed but manifest persist failed".to_string(),
        };
    }
    SetupResult {
        success,
        transaction_id: transaction_id.to_string(),
        applied: manifest_mut
            .operations
            .iter()
            .filter(|op| setup_transaction::operation_eligible_for_rollback_mutation(op))
            .map(|op| artifact_label(&op.artifact))
            .collect(),
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

/// Detect surface state via artifact-level aggregation (canonical owner in setup_transaction).
pub fn detect_surface_state(
    surface: SetupSurfaceId,
    workspace_root: &Path,
    home: &Path,
) -> (SetupSurfaceId, OperationKind, String) {
    setup_transaction::detect_surface_state(surface, workspace_root, home)
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

fn attach_plan_preview(
    plan: &mut SetupPlan,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    let mut pending_surfaces: Vec<SetupSurfaceId> = plan
        .operations
        .iter()
        .filter(|op| op.kind.needs_apply())
        .map(|op| op.surface)
        .collect();
    pending_surfaces.sort_by_key(|s| format!("{s:?}"));
    pending_surfaces.dedup();
    if pending_surfaces.is_empty() {
        plan.plan_fingerprint = None;
        plan.preview_token = None;
        return Ok(());
    }
    let fingerprint =
        compute_plan_fingerprint_for_surfaces(&pending_surfaces, workspace_root, home)?;
    plan.plan_fingerprint = Some(fingerprint.clone());
    plan.preview_token = Some(setup_transaction::issue_preview_token(
        workspace_root,
        &fingerprint,
        setup_transaction::PreviewPurpose::Apply,
        &pending_surfaces,
    )?);
    Ok(())
}

/// Product-level installation status for workspace or harness surfaces.
#[tauri::command]
pub fn get_installation_status(
    surfaces: Vec<String>,
) -> Result<crate::installation_status::InstallationStatus, String> {
    let surface_ids: Vec<SetupSurfaceId> = if surfaces.is_empty() {
        SetupSurfaceId::ALL.to_vec()
    } else {
        surfaces
            .iter()
            .filter_map(|s| {
                serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(s.to_string()))
                    .ok()
            })
            .collect()
    };
    let ws_root = workspace_root()?;
    let home = user_home()?;
    crate::installation_status::status_for_surfaces(&surface_ids, &ws_root, &home)
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
            .map(|s| detect_surface_state(*s, &ws_root, &home))
            .collect();

        let request = SetupRequest {
            surfaces: vec![],
            skip_manual: true,
        };

        let mut plan = crate::setup_lifecycle::plan_setup(&request, &states);
        attach_plan_preview(&mut plan, &ws_root, &home)?;
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

        let request = SetupRequest {
            surfaces: surface_ids,
            skip_manual: true,
        };

        let mut plan = crate::setup_lifecycle::plan_setup(&request, &states);
        attach_plan_preview(&mut plan, &ws_root, &home)?;
        Ok(plan)
    }
}

#[tauri::command]
pub fn apply_setup(
    surfaces: Vec<String>,
    skip_manual: bool,
    plan_fingerprint: Option<String>,
    preview_token: Option<String>,
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
    let token = preview_token
        .as_deref()
        .ok_or_else(|| "Preview token required. Re-run preview before applying.".to_string())?;
    let current_fingerprint = compute_plan_fingerprint_for_surfaces(&surface_ids, &ws_root, &home)?;
    if current_fingerprint != expected_fingerprint {
        return Err(
            "Plan fingerprint mismatch: state changed after preview. Re-run preview before applying."
                .to_string(),
        );
    }
    setup_transaction::validate_preview_token(
        token,
        &ws_root,
        expected_fingerprint,
        setup_transaction::PreviewPurpose::Apply,
        &surface_ids,
    )?;

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

    Ok(apply_setup_plan_with_token(&plan, Some(token)))
}

pub(crate) fn apply_setup_plan_with_token(
    plan: &SetupPlan,
    preview_token: Option<&str>,
) -> SetupResult {
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
        let transaction_id = new_transaction_id().unwrap_or_default();
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
            let transaction_id = new_transaction_id().unwrap_or_default();
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
            let transaction_id = new_transaction_id().unwrap_or_default();
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
    let planned = match setup_transaction::plan_artifacts_for_surfaces(&surfaces, &ws_root, &home) {
        Ok(p) => p,
        Err(e) => {
            let transaction_id = new_transaction_id().unwrap_or_default();
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

    let pending: Vec<setup_transaction::PlannedArtifact> = planned
        .into_iter()
        .filter(|p| p.kind.needs_apply())
        .collect();
    apply_planned_artifacts(
        &pending,
        manual_steps,
        ApplyExecutionMode::SurfaceScripts,
        preview_token,
    )
}

#[tauri::command]
pub fn repair_setup_command(
    _skip_manual: bool,
    repair_fingerprint: Option<String>,
    repair_preview_token: Option<String>,
) -> Result<SetupResult, String> {
    Ok(repair_setup_artifacts(
        repair_fingerprint.as_deref(),
        repair_preview_token.as_deref(),
    ))
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
        let result = apply_setup_plan_with_token(&plan, None);
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
        let result = apply_setup_plan_with_token(&plan, None);
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
            setup_transaction::reject_symlink(&real, "file").is_ok(),
            "real file should pass"
        );
        let err = setup_transaction::reject_symlink(&link, "link").unwrap_err();
        assert!(err.contains("symlink"), "should mention symlink: {err}");

        // reject_symlink on nonexistent path should pass
        let missing = home.join("nonexistent");
        assert!(setup_transaction::reject_symlink(&missing, "missing").is_ok());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn rollback_rejects_empty_transaction_id() {
        let result = rollback_transaction("", false);
        assert!(!result.success);
    }

    #[test]
    fn rollback_nonexistent_transaction() {
        let result = rollback_transaction("1234567890123456789", false);
        assert!(!result.success);
        assert!(
            result.message.contains("not found") || result.message.contains("Transaction backup")
        );
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
    fn repair_only_applies_create_artifacts() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let home = std::env::temp_dir().join("aw-repair-filter-home");
        let ws = std::env::temp_dir().join("aw-repair-filter-ws");
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(&home).expect("create home");
        set_test_user_dirs(&home);
        fs::create_dir_all(ws.join("templates/sync")).expect("sync dir");
        fs::write(ws.join("templates/sync/opencode-rules.md"), "rules").expect("source");
        fs::create_dir_all(home.join(".config/opencode")).expect("opencode dir");
        fs::write(home.join(".config/opencode/AGENTS.md"), "rules").expect("installed");
        unsafe {
            std::env::set_var("AGENT_WORKSPACE_PATH", ws.to_string_lossy().as_ref());
        }

        let surfaces = vec![SetupSurfaceId::OpenCodeRules];
        let planned = setup_transaction::plan_artifacts_for_surfaces(&surfaces, &ws, &home)
            .expect("plan artifacts");
        assert_eq!(planned.len(), 1);
        assert!(
            matches!(planned[0].kind, OperationKind::NoChange),
            "synced rules artifact should be NoChange, got {:?}",
            planned[0].kind
        );
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
        let result = apply_setup(vec!["totally_fake_surface".to_string()], false, None, None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Unknown surface"), "error: {err}");
    }

    #[test]
    fn apply_setup_command_rejects_empty_surfaces() {
        let result = apply_setup(vec![], false, None, None);
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
        fs::write(home.join(".config/opencode/tui.json"), "{}").unwrap();
        fs::write(ws.join("templates/tui.json"), "{}").unwrap();
        fs::create_dir_all(home.join(".config/playwright-mcp")).unwrap();
        fs::write(home.join(".config/playwright-mcp/config.json"), "{}").unwrap();
        fs::write(ws.join("templates/playwright-mcp.config.json"), "{}").unwrap();

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

        let ws = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");

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
        setup_transaction::clear_preview_tokens_for_test();
        let ws = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let home = std::env::temp_dir();
        let surfaces = vec![SetupSurfaceId::OpenCodeRules, SetupSurfaceId::CodexRules];
        let fp1 = compute_plan_fingerprint_for_surfaces(&surfaces, &ws, &home).expect("fp1");
        let fp2 = compute_plan_fingerprint_for_surfaces(&surfaces, &ws, &home).expect("fp2");
        assert_eq!(fp1, fp2);
        assert!(setup_transaction::validate_fingerprint_format(&fp1));
    }

    #[test]
    fn plan_fingerprint_changes_when_surfaces_differ() {
        let ws = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let home = std::env::temp_dir();
        let fp1 =
            compute_plan_fingerprint_for_surfaces(&[SetupSurfaceId::OpenCodeRules], &ws, &home)
                .expect("fp1");
        let fp2 = compute_plan_fingerprint_for_surfaces(&[SetupSurfaceId::CodexRules], &ws, &home)
            .expect("fp2");
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn apply_rejects_missing_preview_token() {
        let result = apply_setup(
            vec!["open_code_rules".to_string()],
            false,
            Some("abc123".to_string()),
            None,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Preview token required"));
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
            transaction_status: setup_transaction::TransactionStatus::Prepared,
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
        let result = apply_setup_plan_with_token(&plan, None);
        assert!(result.success);
        assert!(!result.transaction_id.is_empty());
        assert!(result.transaction_id.chars().all(|c| c.is_ascii_digit()));
    }

    // ── Explicit rollback persistence and resume ──

    fn rollback_test_fixture() -> (PathBuf, PathBuf, PathBuf, String) {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("aw-rollback-test-{n}"));
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        let ws = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        fs::create_dir_all(&home).unwrap();
        set_test_user_dirs(&home);
        let resolved_home = user_home().expect("resolved home for rollback fixture");
        fs::create_dir_all(resolved_home.join(".codex")).unwrap();
        fs::create_dir_all(resolved_home.join(".config/opencode")).unwrap();
        fs::write(resolved_home.join(".codex/AGENTS.md"), "codex-applied").unwrap();
        fs::write(
            resolved_home.join(".config/opencode/AGENTS.md"),
            "opencode-applied",
        )
        .unwrap();
        let backup_root = base.join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        let ws_canon = ws.canonicalize().unwrap_or_else(|_| ws.clone());
        unsafe {
            std::env::set_var("AGENT_WORKSPACE_PATH", ws_canon.to_string_lossy().as_ref());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                backup_root.to_string_lossy().as_ref(),
            );
        }
        let txn_id = "9876543210987654321".to_string();
        (base, resolved_home, ws_canon, txn_id)
    }

    fn seed_two_artifact_transaction(txn_id: &str) -> PathBuf {
        let home = user_home().expect("home for rollback seed");
        let ws_root = workspace_root().expect("workspace for rollback seed");
        let backup_dir = backup_root().unwrap().join("setup").join(txn_id);
        fs::create_dir_all(backup_dir.join("artifacts")).unwrap();
        fs::write(
            backup_dir.join("artifacts/codex-rules"),
            "codex-rules-backup",
        )
        .unwrap();
        fs::write(
            backup_dir.join("artifacts/opencode-rules"),
            "opencode-rules-backup",
        )
        .unwrap();
        let codex_digest = crate::setup_fingerprint::artifact_installed_managed_digest(
            &ArtifactId::CodexRules,
            &ws_root,
            &home,
        )
        .unwrap();
        let codex_full = crate::setup_fingerprint::artifact_installed_full_digest(
            &ArtifactId::CodexRules,
            &ws_root,
            &home,
        )
        .unwrap();
        let opencode_digest = crate::setup_fingerprint::artifact_installed_managed_digest(
            &ArtifactId::OpenCodeRules,
            &ws_root,
            &home,
        )
        .unwrap();
        let opencode_full = crate::setup_fingerprint::artifact_installed_full_digest(
            &ArtifactId::OpenCodeRules,
            &ws_root,
            &home,
        )
        .unwrap();
        let manifest = ArtifactTransactionManifest {
            schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
            workspace_key: setup_transaction::workspace_key(&ws_root).unwrap(),
            created_at: txn_id.to_string(),
            surface_ids: vec![SetupSurfaceId::CodexRules, SetupSurfaceId::OpenCodeRules],
            transaction_status: setup_transaction::TransactionStatus::Failed,
            operations: vec![
                ArtifactManifestOperation {
                    artifact: ArtifactId::CodexRules,
                    surface: SetupSurfaceId::CodexRules,
                    kind: OperationKind::Update,
                    previous_state: setup_transaction::PreviousState::ManagedFile,
                    rollback_action: setup_transaction::RollbackAction::RestoreFile,
                    backup_rel: Some("artifacts/codex-rules".into()),
                    apply_status: setup_transaction::ApplyStatus::Applied,
                    validation_status: setup_transaction::ValidationStatus::Passed,
                    post_apply_digest: Some(codex_digest),
                    post_apply_full_digest: Some(codex_full),
                    ..Default::default()
                },
                ArtifactManifestOperation {
                    artifact: ArtifactId::OpenCodeRules,
                    surface: SetupSurfaceId::OpenCodeRules,
                    kind: OperationKind::Update,
                    previous_state: setup_transaction::PreviousState::ManagedFile,
                    rollback_action: setup_transaction::RollbackAction::RestoreFile,
                    backup_rel: Some("artifacts/opencode-rules".into()),
                    apply_status: setup_transaction::ApplyStatus::Applied,
                    validation_status: setup_transaction::ValidationStatus::Passed,
                    post_apply_digest: Some(opencode_digest),
                    post_apply_full_digest: Some(opencode_full),
                    ..Default::default()
                },
            ],
        };
        let manifest_path = backup_dir.join("manifest.json");
        setup_transaction::persist_manifest_atomic(&manifest_path, &manifest, &backup_dir).unwrap();
        backup_dir
    }

    fn read_manifest(txn_id: &str) -> ArtifactTransactionManifest {
        let backup_dir = backup_root().unwrap().join("setup").join(txn_id);
        let raw = fs::read_to_string(backup_dir.join("manifest.json")).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[test]
    fn explicit_rollback_persists_each_artifact_and_finishes_rolled_back() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, _home, _ws, txn_id) = rollback_test_fixture();
        seed_two_artifact_transaction(&txn_id);
        let result = rollback_transaction(&txn_id, false);
        assert!(result.success, "{}", result.message);
        assert_eq!(result.rolled_back.len(), 2);
        let manifest = read_manifest(&txn_id);
        assert_eq!(
            manifest.transaction_status,
            setup_transaction::TransactionStatus::RolledBack
        );
        assert!(manifest
            .operations
            .iter()
            .all(|op| op.rollback_status == setup_transaction::RollbackStatus::Restored));
        let home = user_home().unwrap();
        let ws = workspace_root().unwrap();
        let codex_dest = ArtifactId::CodexRules.resolve_dest(&home, &ws).unwrap();
        let opencode_dest = ArtifactId::OpenCodeRules.resolve_dest(&home, &ws).unwrap();
        assert_eq!(
            fs::read_to_string(&codex_dest).unwrap(),
            "codex-rules-backup"
        );
        assert_eq!(
            fs::read_to_string(&opencode_dest).unwrap(),
            "opencode-rules-backup"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn explicit_rollback_resume_skips_restored_artifact() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        let manifest_path = backup_dir.join("manifest.json");
        let mut manifest = read_manifest(&txn_id);
        manifest.operations[0].rollback_status = setup_transaction::RollbackStatus::Restored;
        manifest.transaction_status = setup_transaction::TransactionStatus::RollingBack;
        setup_transaction::persist_manifest_atomic(&manifest_path, &manifest, &backup_dir).unwrap();
        fs::write(home.join(".codex/AGENTS.md"), "codex-rules-backup").unwrap(); // home == user_home()

        let dry = rollback_transaction(&txn_id, true);
        assert!(dry.success);
        assert_eq!(dry.applied.len(), 1);
        assert!(dry.applied[0].contains("OpenCodeRules"));
        assert!(dry.rolled_back.iter().any(|l| l.contains("CodexRules")));

        let result = rollback_transaction(&txn_id, false);
        assert!(result.success, "{}", result.message);
        assert_eq!(result.rolled_back.len(), 1);
        let final_manifest = read_manifest(&txn_id);
        assert_eq!(
            final_manifest.transaction_status,
            setup_transaction::TransactionStatus::RolledBack
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rolling_back_transaction_is_resumable() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, _home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        let mut manifest = read_manifest(&txn_id);
        manifest.transaction_status = setup_transaction::TransactionStatus::RollingBack;
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();
        let result = rollback_transaction(&txn_id, false);
        assert!(result.success, "{}", result.message);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rollback_failed_transaction_is_retryable() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, _home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        let mut manifest = read_manifest(&txn_id);
        manifest.transaction_status = setup_transaction::TransactionStatus::RollbackFailed;
        manifest.operations[0].rollback_status = setup_transaction::RollbackStatus::Failed;
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();

        let result = rollback_transaction(&txn_id, false);
        assert!(result.success, "{}", result.message);
        assert!(!result.rolled_back.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn fully_rolled_back_transaction_is_rejected() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, _home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        let mut manifest = read_manifest(&txn_id);
        manifest.transaction_status = setup_transaction::TransactionStatus::RolledBack;
        for op in manifest.operations.iter_mut() {
            op.rollback_status = setup_transaction::RollbackStatus::Restored;
        }
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();
        let result = rollback_transaction(&txn_id, false);
        assert!(!result.success);
        assert!(result.message.contains("already rolled back"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn dry_run_after_partial_rollback_lists_only_remaining() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, _home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        let mut manifest = read_manifest(&txn_id);
        manifest.operations[0].rollback_status = setup_transaction::RollbackStatus::Restored;
        manifest.transaction_status = setup_transaction::TransactionStatus::RollingBack;
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();
        let dry = rollback_transaction(&txn_id, true);
        assert!(dry.success);
        assert_eq!(dry.rolled_back.len(), 1);
        let after = read_manifest(&txn_id);
        assert_eq!(
            after.transaction_status,
            setup_transaction::TransactionStatus::RollingBack
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn restored_artifact_excluded_from_rollback_eligibility() {
        let op = ArtifactManifestOperation {
            apply_status: setup_transaction::ApplyStatus::Applied,
            rollback_status: setup_transaction::RollbackStatus::Restored,
            ..Default::default()
        };
        assert!(!setup_transaction::operation_eligible_for_rollback_mutation(&op));
    }

    #[test]
    fn in_flight_interruption_already_restored_reconciles_without_double_restore() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        fs::write(home.join(".codex/AGENTS.md"), "codex-rules-backup").unwrap();
        let mut manifest = read_manifest(&txn_id);
        manifest.operations[0].rollback_status = setup_transaction::RollbackStatus::InFlight;
        manifest.transaction_status = setup_transaction::TransactionStatus::RollingBack;
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();

        let dry = rollback_transaction(&txn_id, true);
        assert!(dry.success);
        assert!(dry.rolled_back.iter().any(|l| l.contains("CodexRules")));
        assert_eq!(dry.applied.len(), 1);

        let result = rollback_transaction(&txn_id, false);
        assert!(result.success, "{}", result.message);
        assert_eq!(result.rolled_back.len(), 1);
        assert!(!result.rolled_back.iter().any(|l| l.contains("CodexRules")));
        let final_manifest = read_manifest(&txn_id);
        assert_eq!(
            final_manifest.transaction_status,
            setup_transaction::TransactionStatus::RolledBack
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn in_flight_still_post_apply_retries_rollback() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, _home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        let mut manifest = read_manifest(&txn_id);
        manifest.operations[0].rollback_status = setup_transaction::RollbackStatus::InFlight;
        manifest.transaction_status = setup_transaction::TransactionStatus::RollingBack;
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();

        let result = rollback_transaction(&txn_id, false);
        assert!(result.success, "{}", result.message);
        assert_eq!(result.rolled_back.len(), 2);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn in_flight_neither_state_marks_conflict_and_finalize_failed() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        fs::write(home.join(".codex/AGENTS.md"), "user-edited-after-apply").unwrap();
        let mut manifest = read_manifest(&txn_id);
        manifest.operations[0].rollback_status = setup_transaction::RollbackStatus::InFlight;
        manifest.operations[1].rollback_status = setup_transaction::RollbackStatus::Restored;
        manifest.transaction_status = setup_transaction::TransactionStatus::RollingBack;
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();

        let result = rollback_transaction(&txn_id, false);
        assert!(!result.success);
        let final_manifest = read_manifest(&txn_id);
        assert_eq!(
            final_manifest.operations[0].rollback_status,
            setup_transaction::RollbackStatus::Failed
        );
        assert_eq!(
            final_manifest.transaction_status,
            setup_transaction::TransactionStatus::RollbackFailed
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rolling_back_all_restored_finalizes_without_filesystem_mutation() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        fs::write(home.join(".codex/AGENTS.md"), "codex-rules-backup").unwrap();
        fs::write(
            home.join(".config/opencode/AGENTS.md"),
            "opencode-rules-backup",
        )
        .unwrap();
        let mut manifest = read_manifest(&txn_id);
        for op in manifest.operations.iter_mut() {
            op.rollback_status = setup_transaction::RollbackStatus::Restored;
        }
        manifest.transaction_status = setup_transaction::TransactionStatus::RollingBack;
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();

        let result = rollback_transaction(&txn_id, false);
        assert!(result.success, "{}", result.message);
        assert_eq!(result.rolled_back.len(), 2);
        let final_manifest = read_manifest(&txn_id);
        assert_eq!(
            final_manifest.transaction_status,
            setup_transaction::TransactionStatus::RolledBack
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rollback_failed_all_later_restored_finalizes_rolled_back() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        fs::write(home.join(".codex/AGENTS.md"), "codex-rules-backup").unwrap();
        fs::write(
            home.join(".config/opencode/AGENTS.md"),
            "opencode-rules-backup",
        )
        .unwrap();
        let mut manifest = read_manifest(&txn_id);
        manifest.transaction_status = setup_transaction::TransactionStatus::RollbackFailed;
        for op in manifest.operations.iter_mut() {
            op.rollback_status = setup_transaction::RollbackStatus::Restored;
        }
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();

        let result = rollback_transaction(&txn_id, false);
        assert!(result.success, "{}", result.message);
        let final_manifest = read_manifest(&txn_id);
        assert_eq!(
            final_manifest.transaction_status,
            setup_transaction::TransactionStatus::RolledBack
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn dry_run_in_flight_performs_zero_manifest_writes() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, _ws, txn_id) = rollback_test_fixture();
        let backup_dir = seed_two_artifact_transaction(&txn_id);
        fs::write(home.join(".codex/AGENTS.md"), "codex-rules-backup").unwrap();
        let mut manifest = read_manifest(&txn_id);
        manifest.operations[0].rollback_status = setup_transaction::RollbackStatus::InFlight;
        manifest.transaction_status = setup_transaction::TransactionStatus::RollingBack;
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();
        let before_raw = fs::read_to_string(backup_dir.join("manifest.json")).unwrap();

        let dry = rollback_transaction(&txn_id, true);
        assert!(dry.success);
        assert!(dry.rolled_back.iter().any(|l| l.contains("CodexRules")));
        let after_raw = fs::read_to_string(backup_dir.join("manifest.json")).unwrap();
        assert_eq!(before_raw, after_raw);
        let _ = fs::remove_dir_all(&base);
    }
}
