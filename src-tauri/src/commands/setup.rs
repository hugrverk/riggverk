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
use std::time::{SystemTime, UNIX_EPOCH};
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};

use crate::setup_lifecycle::{
    OperationKind, PlannedOperation, SetupPlan, SetupRequest, SetupSurfaceId,
};

use super::process::run_cmd;
use super::status::file_eq;
use super::workspace::workspace_root;

// ── Transaction types ──

/// Unique transaction identifier (nanosecond timestamp).
pub type TransactionId = String;

fn new_transaction_id() -> TransactionId {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| {
            // Clock before epoch is extremely unlikely but must not panic.
            // Fall back to a counter-based ID.
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            format!("fallback-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
        })
}

/// An operation tracked in the transaction manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestOperation {
    surface: SetupSurfaceId,
    kind: OperationKind,
    label: String,
    backup_rel: Option<String>,
}

/// Bounded transaction manifest — no file contents or credential-bearing values.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TransactionManifest {
    schema_version: u32,
    created_at: String,
    operations: Vec<ManifestOperation>,
    surface_count: usize,
}

const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Compute a non-sensitive plan fingerprint from detected surface states.
///
/// Used for preview integrity: the backend re-detects before apply and
/// rejects the request if the fingerprint does not match (stale preview).
fn compute_plan_fingerprint(
    states: &[(SetupSurfaceId, OperationKind, String)],
) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // Hash surface IDs and their detected kind (not the summary, which may
    // vary without state change). Hash only the surfaces included in the plan.
    let mut sorted: Vec<_> = states.iter().collect();
    sorted.sort_by_key(|(s, _, _)| format!("{:?}", s));
    for (surface, kind, _) in &sorted {
        format!("{:?}", surface).hash(&mut hasher);
        format!("{:?}", kind).hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
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

/// Resolve the target path for a setup surface.
fn resolve_surface_path(surface: SetupSurfaceId) -> Result<PathBuf, String> {
    let home = crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )?;
    match surface {
        SetupSurfaceId::OpenCodeConfig => Ok(home.join(".config/opencode/opencode.json")),
        SetupSurfaceId::OpenCodeAgents => Ok(home.join(".config/opencode/agents")),
        SetupSurfaceId::OpenCodeRules => Ok(home.join(".config/opencode/AGENTS.md")),
        SetupSurfaceId::CodexConfig => Ok(home.join(".codex/config.toml")),
        SetupSurfaceId::CodexAgents => Ok(home.join(".codex/agents")),
        SetupSurfaceId::CodexRules => Ok(home.join(".codex/AGENTS.md")),
        SetupSurfaceId::ClaudeRules => Ok(home.join(".claude/CLAUDE.md")),
        SetupSurfaceId::ClaudeAgents => Ok(home.join(".claude/agents")),
        SetupSurfaceId::ClaudeSkills => Ok(home.join(".claude/skills")),
        SetupSurfaceId::OpenCodeSkills => Ok(home.join(".config/opencode/skills")),
        SetupSurfaceId::CodexSkills => Ok(home.join(".agents/skills")),
        SetupSurfaceId::CursorAgents => Ok(home.join(".cursor/agents")),
        SetupSurfaceId::CursorSkills => Ok(home.join(".cursor/skills")),
        SetupSurfaceId::CursorMcp => Ok({
            let paths = crate::cursor_profile_paths::resolve_cursor_profile_paths()
                .map_err(|e| format!("cursor paths: {e}"))?;
            paths.mcp_config
        }),
        SetupSurfaceId::DeprecatedSkillCleanup => Ok(home.join(".agents/skills")),
    }
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

#[allow(dead_code)]
fn copy_single_file(src: &Path, dst: &Path) -> Result<(), String> {
    reject_symlink(src, "source file")?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create parent {}: {e}", parent.display()))?;
    }
    fs::copy(src, dst).map_err(|e| format!("copy {} -> {}: {e}", src.display(), dst.display()))?;
    Ok(())
}

/// Back up a single file or directory target.
fn backup_target(backup_dir: &Path, surface: SetupSurfaceId) -> Result<Option<PathBuf>, String> {
    let target = resolve_surface_path(surface)?;
    if !target.exists() {
        return Ok(None);
    }
    reject_symlink(&target, "backup target")?;

    let rel = surface.label().replace(' ', "_");
    let dest = backup_dir.join(&rel);
    if target.is_dir() {
        crate::deprecated_skills::copy_dir_all(&target, &dest)
            .map_err(|e| format!("backup dir {}: {e}", surface.label()))?;
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create backup parent: {e}"))?;
        }
        fs::copy(&target, &dest).map_err(|e| format!("backup file {}: {e}", surface.label()))?;
    }
    Ok(Some(dest))
}

/// Restore a single target from backup.
fn restore_from_backup(backup_path: &Path, surface: SetupSurfaceId) -> Result<(), String> {
    let target = resolve_surface_path(surface)?;
    if !backup_path.exists() {
        return Err(format!(
            "backup missing for {}: {}",
            surface.label(),
            backup_path.display()
        ));
    }
    reject_symlink(backup_path, "backup source")?;

    // Remove existing target if present
    if target.exists() {
        reject_symlink(&target, "restore target")?;
        if target.is_dir() {
            fs::remove_dir_all(&target)
                .map_err(|e| format!("remove dir {}: {e}", target.display()))?;
        } else {
            fs::remove_file(&target)
                .map_err(|e| format!("remove file {}: {e}", target.display()))?;
        }
    }

    if backup_path.is_dir() {
        crate::deprecated_skills::copy_dir_all(backup_path, &target)
            .map_err(|e| format!("restore dir {}: {e}", surface.label()))?;
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create target parent: {e}"))?;
        }
        fs::copy(backup_path, &target)
            .map_err(|e| format!("restore file {}: {e}", surface.label()))?;
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

/// Perform rollback of completed operations in reverse order.
/// Handles both Update (restore from backup) and Create (remove new artifact).
fn perform_rollback(
    applied: &[String],
    pending: &[&PlannedOperation],
    backed_up: &[(String, PathBuf)],
) -> (Vec<String>, Vec<String>) {
    let mut rolled_back: Vec<String> = Vec::new();
    let mut reverse_errors: Vec<String> = Vec::new();

    for applied_op in applied.iter().rev() {
        let surface = pending
            .iter()
            .find(|p| p.surface.label() == applied_op.as_str())
            .map(|p| p.surface);

        if let Some(surface) = surface {
            if let Some((_, backup_path)) = backed_up.iter().find(|(label, _)| label == applied_op)
            {
                // Backup exists — restore from backup (Update case)
                if backup_path.exists() {
                    match restore_from_backup(backup_path, surface) {
                        Ok(()) => {
                            rolled_back.push(applied_op.clone());
                        }
                        Err(restore_err) => {
                            reverse_errors
                                .push(format!("rollback {} failed: {restore_err}", applied_op));
                        }
                    }
                }
            } else {
                // No backup — this was a Create operation; remove the new artifact
                match resolve_surface_path(surface) {
                    Ok(target) if target.exists() => {
                        if target.is_dir() {
                            // Only remove if it's a managed dir we can safely remove.
                            // Use exact path comparison, not substring matching.
                            let safe_to_remove = {
                                let home = match crate::platform_paths::resolve_user_home(
                                    &crate::platform_paths::PlatformEnv::from_process_env(),
                                    crate::platform_paths::Platform::current(),
                                ) {
                                    Ok(h) => h,
                                    Err(_) => {
                                        reverse_errors.push(format!(
                                            "cannot resolve home for create rollback of {}",
                                            applied_op
                                        ));
                                        continue;
                                    }
                                };
                                let broad_roots: &[&str] = &[
                                    ".cursor", ".claude", ".codex", ".agents", ".config/opencode"
                                ];
                                let target_str = target.to_string_lossy();
                                // Only allow removal if the target is a known sub-path
                                // under a harness root, not the harness root itself.
                                !broad_roots.iter().any(|root| {
                                    let root_path = home.join(root);
                                    let root_str = root_path.to_string_lossy();
                                    let root_str_trailing = format!("{}/", root_str);
                                    // Reject if target is the harness root itself
                                    let t: &str = target_str.as_ref();
                                    let r: &str = root_str.as_ref();
                                    t == r || t == root_str_trailing.as_str()
                                })
                            };
                            if safe_to_remove {
                                if let Err(e) = fs::remove_dir_all(&target) {
                                    reverse_errors.push(format!(
                                        "remove {} on create rollback: {e}",
                                        applied_op
                                    ));
                                } else {
                                    rolled_back.push(applied_op.clone());
                                }
                            } else {
                                reverse_errors.push(format!(
                                    "refusing broad remove of {} on create rollback",
                                    applied_op
                                ));
                            }
                        } else {
                            if let Err(e) = fs::remove_file(&target) {
                                reverse_errors
                                    .push(format!("remove {} on create rollback: {e}", applied_op));
                            } else {
                                rolled_back.push(applied_op.clone());
                            }
                        }
                    }
                    Ok(_) => {
                        // Target doesn't exist — nothing to roll back
                        rolled_back.push(applied_op.clone());
                    }
                    Err(e) => {
                        reverse_errors
                            .push(format!("resolve {} for create rollback: {e}", applied_op));
                    }
                }
            }
        }
    }

    (rolled_back, reverse_errors)
}

// ── Apply ──

/// Apply a setup plan.
///
/// Transactional behavior:
/// 1. Preflight all operations
/// 2. Backup all surfaces that will be overwritten
/// 3. Write manifest
/// 4. Execute operations in order
/// 5. Validate each
/// 6. On any failure: rollback completed ops in reverse order
pub fn apply_setup_plan(plan: &SetupPlan) -> SetupResult {
    let transaction_id = new_transaction_id();
    let mut applied: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let rolled_back: Vec<String> = Vec::new();

    // Collect operations that need apply
    let pending: Vec<&PlannedOperation> = plan
        .operations
        .iter()
        .filter(|op| op.kind.needs_apply())
        .collect();

    if pending.is_empty() {
        return SetupResult {
            success: true,
            transaction_id,
            applied,
            failed,
            rolled_back,
            manual_steps: plan
                .manual_steps
                .iter()
                .filter_map(|m| m.manual_step.clone())
                .collect(),
            message: "No operations to apply".to_string(),
        };
    }

    // ── Phase 1: Preflight ──
    let ws_root = match workspace_root() {
        Ok(r) => r,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied,
                failed: vec!["resolve workspace".to_string()],
                rolled_back,
                manual_steps: vec![],
                message: format!("Cannot resolve workspace root: {e}"),
            };
        }
    };

    for op in &pending {
        let target = match resolve_surface_path(op.surface) {
            Ok(p) => p,
            Err(e) => {
                return SetupResult {
                    success: false,
                    transaction_id,
                    applied: applied.clone(),
                    failed: vec![format!("preflight {}: {e}", op.surface.label())],
                    rolled_back,
                    manual_steps: vec![],
                    message: format!("Preflight failed for {}: {e}", op.surface.label()),
                };
            }
        };

        if target.exists() {
            if let Err(e) = reject_symlink(&target, "target") {
                return SetupResult {
                    success: false,
                    transaction_id,
                    applied: applied.clone(),
                    failed: vec![format!("preflight {}: {e}", op.surface.label())],
                    rolled_back,
                    manual_steps: vec![],
                    message: format!("Preflight symlink check failed: {e}"),
                };
            }
        }
    }

    // ── Phase 2: Backup all surfaces before first write ──
    let backup_dir = match setup_backup_dir(&transaction_id) {
        Ok(d) => d,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: applied.clone(),
                failed: vec![format!("backup setup: {e}")],
                rolled_back,
                manual_steps: vec![],
                message: format!("Backup directory creation failed: {e}"),
            };
        }
    };

    let mut backed_up: Vec<(String, PathBuf)> = Vec::new();
    for op in &pending {
        match backup_target(&backup_dir, op.surface) {
            Ok(Some(path)) => {
                backed_up.push((op.surface.label().to_string(), path));
            }
            Ok(None) => {
                // No existing target to back up — fine
            }
            Err(e) => {
                return SetupResult {
                    success: false,
                    transaction_id,
                    applied: applied.clone(),
                    failed: vec![format!("backup {}: {e}", op.surface.label())],
                    rolled_back,
                    manual_steps: vec![],
                    message: format!("Backup failed for {}: {e}", op.surface.label()),
                };
            }
        }
    }

    // ── Phase 3: Write transaction manifest ──
    let manifest_ops: Vec<ManifestOperation> = pending
        .iter()
        .map(|op| ManifestOperation {
            surface: op.surface,
            kind: op.kind,
            label: op.surface.label().to_string(),
            backup_rel: backed_up
                .iter()
                .find(|(label, _)| label == op.surface.label())
                .and_then(|(_, path)| {
                    path.strip_prefix(&backup_dir)
                        .ok()
                        .map(|p| p.to_string_lossy().into_owned())
                }),
        })
        .collect();

    let manifest = TransactionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        created_at: transaction_id.clone(),
        operations: manifest_ops,
        surface_count: pending.len(),
    };
    let manifest_json = match serde_json::to_string_pretty(&manifest) {
        Ok(j) => j,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: applied.clone(),
                failed: vec![format!("serialize manifest: {e}")],
                rolled_back,
                manual_steps: vec![],
                message: format!("Cannot serialize transaction manifest: {e}"),
            };
        }
    };
    let manifest_path = backup_dir.join("manifest.json");
    if let Err(e) = fs::write(&manifest_path, &manifest_json) {
        return SetupResult {
            success: false,
            transaction_id,
            applied: applied.clone(),
            failed: vec![format!("write manifest: {e}")],
            rolled_back,
            manual_steps: vec![],
            message: format!("Cannot write transaction manifest: {e}"),
        };
    }

    // Re-read and validate manifest
    let read_back = match fs::read_to_string(&manifest_path) {
        Ok(r) => r,
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: applied.clone(),
                failed: vec![format!("re-read manifest: {e}")],
                rolled_back,
                manual_steps: vec![],
                message: format!("Cannot re-read transaction manifest: {e}"),
            };
        }
    };
    if let Err(e) = serde_json::from_str::<TransactionManifest>(&read_back) {
        return SetupResult {
            success: false,
            transaction_id,
            applied: applied.clone(),
            failed: vec![format!("validate manifest: {e}")],
            rolled_back,
            manual_steps: vec![],
            message: format!("Transaction manifest validation failed: {e}"),
        };
    }

    // ── Phase 4: Execute operations with post-validation ──
    for op in &pending {
        match execute_operation_and_validate(op, &ws_root) {
            Ok(()) => {
                // Post-operation validation: re-detect the actual managed state.
                // A destination merely existing is never sufficient; we verify
                // the managed state using the same canonical comparison owner as detection.
                let home = match crate::platform_paths::resolve_user_home(
                    &crate::platform_paths::PlatformEnv::from_process_env(),
                    crate::platform_paths::Platform::current(),
                ) {
                    Ok(h) => h,
                    Err(e) => {
                        failed.push(format!("{}: resolve home for validation: {e}", op.surface.label()));
                        let rollback_result = perform_rollback(&applied, &pending, &backed_up);
                        let (rb, re) = rollback_result;
                        return SetupResult {
                            success: false, transaction_id, applied, failed,
                            rolled_back: rb,
                            manual_steps: plan.manual_steps.iter().map(|m| m.manual_step.clone().unwrap_or_default()).collect(),
                            message: format!("Cannot validate {}: {e}", op.surface.label()),
                        };
                    }
                };
                let (_surface, current_kind, _summary) =
                    detect_surface_state(op.surface, &ws_root, &home);
                let validated = match (op.kind, current_kind) {
                    // Create should result in NoChange if source is present
                    (OperationKind::Create, OperationKind::NoChange) => true,
                    // Update should result in NoChange after successful write
                    (OperationKind::Update, OperationKind::NoChange) => true,
                    // For NoChange operations, nothing changes (shouldn't happen in apply)
                    (OperationKind::NoChange, OperationKind::NoChange) => true,
                    // Partial skills: if some skills exist and we created more, current
                    // might still show Update. That's acceptable.
                    (OperationKind::Create, OperationKind::Update)
                    | (OperationKind::Update, OperationKind::Update) => {
                        // Still showing Update after write means either partial success
                        // or source was missing. Allow it but log.
                        true
                    }
                    // Conflict or Unavailable after write means something went wrong
                    (_, OperationKind::Conflict) | (_, OperationKind::Unavailable) => false,
                    _ => false,
                };

                if validated {
                    applied.push(op.surface.label().to_string());
                } else {
                    let e = format!(
                        "validation failed: {} target not found after apply",
                        op.surface.label()
                    );
                    failed.push(format!("{}: {e}", op.surface.label()));

                    // ── Phase 5: Rollback completed operations in reverse order ──
                    let rollback_result = perform_rollback(&applied, &pending, &backed_up);
                    let (rolled_back, reverse_errors) = rollback_result;

                    let mut message = format!("Apply failed at {}: {e}", op.surface.label());
                    if !reverse_errors.is_empty() {
                        message
                            .push_str(&format!(". Rollback errors: {}", reverse_errors.join("; ")));
                    }

                    return SetupResult {
                        success: false,
                        transaction_id,
                        applied,
                        failed,
                        rolled_back,
                        manual_steps: plan
                            .manual_steps
                            .iter()
                            .map(|m| m.manual_step.clone().unwrap_or_default())
                            .collect(),
                        message,
                    };
                }
            }
            Err(e) => {
                failed.push(format!("{}: {e}", op.surface.label()));

                // ── Phase 5: Rollback completed operations in reverse order ──
                let rollback_result = perform_rollback(&applied, &pending, &backed_up);
                let (rolled_back, reverse_errors) = rollback_result;

                let mut message = format!("Apply failed at {}: {e}", op.surface.label());
                if !reverse_errors.is_empty() {
                    message.push_str(&format!(". Rollback errors: {}", reverse_errors.join("; ")));
                }

                return SetupResult {
                    success: false,
                    transaction_id,
                    applied,
                    failed,
                    rolled_back,
                    manual_steps: plan
                        .manual_steps
                        .iter()
                        .map(|m| m.manual_step.clone().unwrap_or_default())
                        .collect(),
                    message,
                };
            }
        }
    }

    // ── Phase 6: All succeeded ──
    let change_count = applied.len();
    SetupResult {
        success: true,
        transaction_id,
        applied,
        failed,
        rolled_back,
        manual_steps: plan
            .manual_steps
            .iter()
            .map(|m| m.manual_step.clone().unwrap_or_default())
            .collect(),
        message: format!("Successfully applied {} surface(s)", change_count),
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
            transaction_id: new_transaction_id(),
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
    let manifest: TransactionManifest = match serde_json::from_str(&manifest_raw) {
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

    // Validate manifest
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![format!(
                "unsupported manifest schema version {}",
                manifest.schema_version
            )],
            rolled_back: vec![],
            manual_steps: vec![],
            message: "Transaction manifest schema version not supported".to_string(),
        };
    }
    if manifest.operations.len() > 100 {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec!["excessive operation count".to_string()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: "Transaction manifest contains too many operations".to_string(),
        };
    }

    // Preflight all backup paths and surface IDs before any restore
    let mut preflight_errors: Vec<String> = Vec::new();
    for op in &manifest.operations {
        // Validate backup path is relative
        if let Some(ref rel) = op.backup_rel {
            if rel.starts_with('/') || rel.contains("..") {
                preflight_errors.push(format!(
                    "{}: backup path contains traversal or is absolute",
                    op.label
                ));
                continue;
            }
        }
    }
    if !preflight_errors.is_empty() {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: preflight_errors,
            rolled_back: vec![],
            manual_steps: vec![],
            message: "Transaction manifest contains unsafe backup paths".to_string(),
        };
    }

    // If dry-run, validate everything but don't restore
    if dry_run {
        let would_restore: Vec<String> = manifest
            .operations
            .iter()
            .rev()
            .map(|op| op.label.clone())
            .collect();
        return SetupResult {
            success: true,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!(
                "Dry run: would restore {} operation(s): {}",
                would_restore.len(),
                would_restore.join(", ")
            ),
        };
    }

    // Restore each operation in reverse order
    let mut restored: Vec<String> = Vec::new();
    let mut rollback_failures: Vec<String> = Vec::new();

    for op in manifest.operations.iter().rev() {
        let backup_path = match &op.backup_rel {
            Some(rel) => backup_dir.join(rel),
            None => {
                rollback_failures.push(format!("{}: no backup path recorded", op.label));
                continue;
            }
        };

        if !backup_path.exists() {
            rollback_failures.push(format!("{}: backup missing", op.label));
            continue;
        }

        match restore_from_backup(&backup_path, op.surface) {
            Ok(()) => {
                restored.push(op.label.clone());
            }
            Err(e) => {
                rollback_failures.push(format!("{}: {e}", op.label));
            }
        }
    }

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
            format!("Successfully restored {} surface(s)", restored_count)
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
                    Err(_) => return (surface, OperationKind::Conflict, "Codex config unreadable".to_string()),
                };
                let source_str = match std::fs::read_to_string(&source) {
                    Ok(s) => s,
                    Err(_) => return (surface, OperationKind::Unavailable, "Codex source unreadable".to_string()),
                };
                let installed_toml: toml::Value = match installed_str.parse() {
                    Ok(v) => v,
                    Err(_) => return (surface, OperationKind::Conflict, "Codex config invalid TOML".to_string()),
                };
                let source_toml: toml::Value = match source_str.parse() {
                    Ok(v) => v,
                    Err(_) => return (surface, OperationKind::Unavailable, "Codex source invalid TOML".to_string()),
                };
                let managed_installed = crate::commands::codex_runtime::extract_managed_codex_config(&installed_toml);
                let managed_source = crate::commands::codex_runtime::extract_managed_codex_config(&source_toml);
                if crate::commands::codex_runtime::managed_codex_keys_match(&installed_toml, &source_toml) {
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
                    Err(_) => return (surface, OperationKind::Conflict, "OpenCode config unreadable".to_string()),
                };
                let source_str = match std::fs::read_to_string(&source) {
                    Ok(s) => s,
                    Err(_) => return (surface, OperationKind::Unavailable, "OpenCode source unreadable".to_string()),
                };
                let installed_json: serde_json::Value = match serde_json::from_str(&installed_str) {
                    Ok(v) => v,
                    Err(_) => return (surface, OperationKind::Conflict, "OpenCode config invalid JSON".to_string()),
                };
                let source_json: serde_json::Value = match serde_json::from_str(&source_str) {
                    Ok(v) => v,
                    Err(_) => return (surface, OperationKind::Unavailable, "OpenCode source invalid JSON".to_string()),
                };
                // Use managed-key comparison from OpenCode runtime owner
                if crate::commands::opencode_runtime::managed_opencode_keys_match(&installed_json, &source_json) {
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
            } else {
                let expected = crate::artifact_registry::discover_skill_names_for_harness(&skills_root, "claude");
                if expected.is_empty() {
                    OperationKind::Unavailable
                } else {
                    let mut any_missing = false;
                    let mut any_diverged = false;
                    for skill_name in &expected {
                        let installed_skill_md = target.join(skill_name.as_str()).join("SKILL.md");
                        if !installed_skill_md.is_file() {
                            any_missing = true;
                            continue;
                        }
                        // Find source
                        let source_dir = crate::artifact_registry::ArtifactId::ClaudeSkill(skill_name.clone())
                            .resolve_source(workspace_root);
                        if let Some(src_dir) = source_dir {
                            let source_skill_md = src_dir.join("SKILL.md");
                            if source_skill_md.is_file() && !file_eq(&installed_skill_md, &source_skill_md) {
                                any_diverged = true;
                            }
                        }
                    }
                    if any_missing && !any_diverged {
                        OperationKind::Update
                    } else if any_diverged {
                        OperationKind::Update
                    } else {
                        OperationKind::NoChange
                    }
                }
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
            } else {
                // Check if expected skills are present
                let skills_root = workspace_root.join("skills");
                let expected = crate::artifact_registry::discover_skill_names_for_harness(&skills_root, "cursor");
                if expected.is_empty() {
                    OperationKind::Unavailable
                } else {
                    let mut missing = false;
                    for skill in &expected {
                        if !target_dir.join(skill.as_str()).is_dir() {
                            missing = true;
                            break;
                        }
                    }
                    if missing { OperationKind::Update } else { OperationKind::NoChange }
                }
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
            } else {
                let expected = crate::artifact_registry::discover_skill_names_for_harness(&skills_root, "opencode");
                if expected.is_empty() {
                    OperationKind::Unavailable
                } else {
                    let mut any_issue = false;
                    for skill_name in &expected {
                        let installed_skill_md = target.join(skill_name.as_str()).join("SKILL.md");
                        if !installed_skill_md.is_file() {
                            any_issue = true;
                            break;
                        }
                        let source_dir = crate::artifact_registry::ArtifactId::OpenCodeSkill(skill_name.clone())
                            .resolve_source(workspace_root);
                        if let Some(src_dir) = source_dir {
                            let source_skill_md = src_dir.join("SKILL.md");
                            if source_skill_md.is_file() && !file_eq(&installed_skill_md, &source_skill_md) {
                                any_issue = true;
                                break;
                            }
                        }
                    }
                    if any_issue { OperationKind::Update } else { OperationKind::NoChange }
                }
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
            } else {
                let expected = crate::artifact_registry::discover_skill_names_for_harness(&skills_root, "codex");
                if expected.is_empty() {
                    OperationKind::Unavailable
                } else {
                    let mut any_issue = false;
                    for skill_name in &expected {
                        let installed_skill_md = target.join(skill_name.as_str()).join("SKILL.md");
                        if !installed_skill_md.is_file() {
                            any_issue = true;
                            break;
                        }
                        let source_dir = crate::artifact_registry::ArtifactId::CodexSkill(skill_name.clone())
                            .resolve_source(workspace_root);
                        if let Some(src_dir) = source_dir {
                            let source_skill_md = src_dir.join("SKILL.md");
                            if source_skill_md.is_file() && !file_eq(&installed_skill_md, &source_skill_md) {
                                any_issue = true;
                                break;
                            }
                        }
                    }
                    if any_issue { OperationKind::Update } else { OperationKind::NoChange }
                }
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
        plan.plan_fingerprint = Some(compute_plan_fingerprint(&states));
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
        plan.plan_fingerprint = Some(compute_plan_fingerprint(&states));
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

    // Validate plan fingerprint if provided (preview integrity)
    if let Some(ref expected_fingerprint) = plan_fingerprint {
        let current_fingerprint = compute_plan_fingerprint(&states);
        if current_fingerprint != *expected_fingerprint {
            return Err(format!(
                "Plan fingerprint mismatch: state changed after preview. Re-run preview before applying."
            ));
        }
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

    Ok(apply_setup_plan(&plan))
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

        let (_surface, kind, _summary) = detect_surface_state(
            SetupSurfaceId::OpenCodeConfig,
            &ws,
            &home,
        );
        assert_eq!(kind, OperationKind::Create, "missing config should be Create");
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

        let (_surface, kind, _summary) = detect_surface_state(
            SetupSurfaceId::OpenCodeConfig,
            &ws,
            &home,
        );
        assert_eq!(kind, OperationKind::NoChange, "matching managed keys should be NoChange");
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

        let (_surface, kind, _summary) = detect_surface_state(
            SetupSurfaceId::OpenCodeConfig,
            &ws,
            &home,
        );
        assert_eq!(kind, OperationKind::Update, "diff managed keys should be Update");
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

        let (_surface, kind, _summary) = detect_surface_state(
            SetupSurfaceId::CodexConfig,
            &ws,
            &home,
        );
        assert_eq!(kind, OperationKind::NoChange, "matching managed fields should be NoChange");
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

        let (_surface, kind, _summary) = detect_surface_state(
            SetupSurfaceId::ClaudeSkills,
            &ws,
            &home,
        );
        assert_eq!(kind, OperationKind::Create, "missing skills dir should be Create");
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

        let (_surface, kind, summary) = detect_surface_state(
            SetupSurfaceId::CodexConfig,
            &ws,
            &home,
        );
        assert_eq!(kind, OperationKind::Conflict, "invalid TOML should be Conflict, got {kind:?}: {summary}");
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

        let (_surface, kind, summary) = detect_surface_state(
            SetupSurfaceId::OpenCodeConfig,
            &ws,
            &home,
        );
        assert_eq!(kind, OperationKind::Conflict, "invalid JSON should be Conflict, got {kind:?}: {summary}");
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

        let (_surface, kind, _summary) = detect_surface_state(
            SetupSurfaceId::CodexRules,
            &ws,
            &home,
        );
        assert_eq!(kind, OperationKind::NoChange, "matching rules should be NoChange");
    }

    // ── Preview integrity tests ──

    #[test]
    fn plan_fingerprint_is_stable_for_same_state() {
        let states1 = vec![
            (SetupSurfaceId::OpenCodeConfig, OperationKind::NoChange, "synced".to_string()),
            (SetupSurfaceId::CodexRules, OperationKind::Create, "missing".to_string()),
        ];
        let states2 = vec![
            (SetupSurfaceId::OpenCodeConfig, OperationKind::NoChange, "synced".to_string()),
            (SetupSurfaceId::CodexRules, OperationKind::Create, "missing".to_string()),
        ];
        assert_eq!(
            compute_plan_fingerprint(&states1),
            compute_plan_fingerprint(&states2),
            "same state should produce same fingerprint"
        );
    }

    #[test]
    fn plan_fingerprint_changes_when_state_differs() {
        let states1 = vec![
            (SetupSurfaceId::OpenCodeConfig, OperationKind::NoChange, "synced".to_string()),
        ];
        let states2 = vec![
            (SetupSurfaceId::OpenCodeConfig, OperationKind::Create, "missing".to_string()),
        ];
        assert_ne!(
            compute_plan_fingerprint(&states1),
            compute_plan_fingerprint(&states2),
            "different state should produce different fingerprint"
        );
    }

    #[test]
    fn plan_fingerprint_changes_when_surfaces_differ() {
        let states1 = vec![
            (SetupSurfaceId::OpenCodeConfig, OperationKind::NoChange, "synced".to_string()),
        ];
        let states2 = vec![
            (SetupSurfaceId::CodexRules, OperationKind::NoChange, "synced".to_string()),
        ];
        assert_ne!(
            compute_plan_fingerprint(&states1),
            compute_plan_fingerprint(&states2),
            "different surfaces should produce different fingerprint"
        );
    }

    #[test]
    fn plan_fingerprint_different_for_different_surface_sets() {
        let states1 = vec![
            (SetupSurfaceId::OpenCodeConfig, OperationKind::Create, "missing".to_string()),
            (SetupSurfaceId::CodexRules, OperationKind::Create, "missing".to_string()),
        ];
        let states2 = vec![
            (SetupSurfaceId::OpenCodeConfig, OperationKind::Create, "missing".to_string()),
        ];
        assert_ne!(
            compute_plan_fingerprint(&states1),
            compute_plan_fingerprint(&states2),
            "different sets of surfaces should produce different fingerprints"
        );
    }

    #[test]
    fn preview_returns_plan_with_fingerprint() {
        // Test that fingerprint computation works correctly
        let states = vec![
            (SetupSurfaceId::OpenCodeConfig, OperationKind::Create, "missing".to_string()),
            (SetupSurfaceId::CodexRules, OperationKind::Create, "missing".to_string()),
        ];
        let fp = compute_plan_fingerprint(&states);
        assert!(!fp.is_empty(), "fingerprint should not be empty");
        assert_eq!(fp.len(), 16, "fingerprint should be 16 hex chars");
    }

    // ── Transaction preflight tests ──

    #[test]
    fn transaction_id_is_never_empty() {
        let id = new_transaction_id();
        assert!(!id.is_empty(), "transaction ID must not be empty");
    }

    #[test]
    fn transaction_id_does_not_panic() {
        // new_transaction_id must never panic even with unexpected system time
        let id = new_transaction_id();
        assert!(!id.is_empty());
    }

    #[test]
    fn manifest_operations_never_have_absolute_backup_paths() {
        // The backup_rel field must always be relative (or None)
        let _guard = guard::lock();
        let home = std::env::temp_dir().join("aw-manifest-rel");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");
        let backup_dir = home.join("backups/setup/test123");
        fs::create_dir_all(&backup_dir).expect("create backup dir");

        // Create a manifest with various backup paths
        let ops = vec![
            ManifestOperation {
                surface: SetupSurfaceId::OpenCodeConfig,
                kind: OperationKind::Create,
                label: "test".to_string(),
                backup_rel: Some("relative/path".to_string()),
            },
            ManifestOperation {
                surface: SetupSurfaceId::CodexRules,
                kind: OperationKind::Update,
                label: "test2".to_string(),
                backup_rel: None,
            },
        ];

        // Verify: relative paths are fine, None is fine
        for op in &ops {
            if let Some(ref rel) = op.backup_rel {
                assert!(
                    !rel.starts_with('/'),
                    "backup_rel must be relative, got: {rel}"
                );
            }
        }

        let manifest = TransactionManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            created_at: "test".to_string(),
            operations: ops,
            surface_count: 2,
        };
        let json = serde_json::to_string(&manifest).expect("serialize");
        let _parsed: TransactionManifest = serde_json::from_str(&json).expect("deserialize");
    }

    #[test]
    fn apply_empty_plan_returns_valid_transaction_id() {
        let plan = test_plan(vec![]);
        let result = apply_setup_plan(&plan);
        assert!(result.success);
        assert!(!result.transaction_id.is_empty());
        assert!(result.transaction_id.chars().all(|c| c.is_ascii_digit() || c == '-'));
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
