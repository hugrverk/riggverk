//! Unified setup apply and rollback commands.
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

use crate::apply_progress::{artifact_display_path, ApplyPhase, ProgressReporter};
use crate::setup_lifecycle::{
    OperationKind, PlannedOperation, SetupPlan, SetupRequest, SetupSurfaceId,
};

use super::workspace::{setup_workspace_target_path, workspace_target_for_write};

// ── Transaction types ──

/// Unique transaction identifier (nanosecond timestamp).
pub type TransactionId = String;

use crate::setup_transaction::{
    self, ArtifactManifestOperation, ArtifactTransactionManifest, SetupReceipt, SetupReceiptItem,
    SetupReceiptReason, ARTIFACT_MANIFEST_SCHEMA_VERSION,
};

fn new_transaction_id() -> Result<TransactionId, String> {
    setup_transaction::new_transaction_id()
}

// ── Public result types ──

/// Result of an apply execution.
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
    // The backup root lives under the app-data dir, which may not exist yet
    // on a fresh install (or after an app identifier change).
    crate::safe_filesystem::create_private_root_directory_all_no_symlinks(&root)?;
    #[cfg(unix)]
    crate::commands::backups::tighten_legacy_backup_permissions(&root)?;
    crate::safe_filesystem::create_private_directory_all_no_symlinks(&dir, &root)?;
    Ok(dir)
}

fn write_synced_backup(path: &Path, raw: &[u8], backup_dir: &Path) -> Result<(), String> {
    crate::safe_filesystem::write_private_new_regular_file_synced(path, raw, backup_dir)
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

/// Rolls back transactions an interrupted apply left half-done. Returns notes for transactions
/// that stay unresolved on purpose (rollback-failed ones are never retried automatically).
fn reconcile_interrupted_setup_transactions(
    workspace_root: &Path,
    home: &Path,
) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    let setup_root = backup_root()?.join("setup");
    if !setup_root.exists() {
        return Ok(notes);
    }
    crate::path_safety::reject_symlink(&setup_root, "setup transaction root")?;
    let workspace_key = setup_transaction::workspace_key(workspace_root)?;
    let mut entries = fs::read_dir(&setup_root)
        .map_err(|e| format!("read setup transactions: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read setup transaction entry: {e}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let transaction_id = entry.file_name().to_string_lossy().into_owned();
        if !validate_transaction_id_format(&transaction_id) {
            continue;
        }
        let backup_dir = entry.path();
        crate::path_safety::reject_symlink(&backup_dir, "setup transaction")?;
        let manifest_path = backup_dir.join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }
        crate::path_safety::reject_symlink(&manifest_path, "setup manifest")?;
        let raw = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("read interrupted setup {transaction_id} manifest: {e}"))?;
        // Decide from the header alone whether this transaction can still need
        // reconciliation. Finished transactions (completed or rolled back) must
        // never block a new apply, even when their manifest is old-schema or
        // damaged, so they are skipped before any full validation.
        let header = setup_transaction::read_manifest_header(&raw)
            .map_err(|e| format!("read interrupted setup {transaction_id} manifest: {e}"))?;
        if !header.workspace_key.as_deref().is_some_and(|recorded| {
            setup_transaction::workspace_keys_match(recorded, &workspace_key)
        }) {
            continue;
        }
        if header.status == setup_transaction::TransactionStatus::RollbackFailed {
            notes.push(format!(
                "Setup transaction {transaction_id} was not fully rolled back and is left as is; review it and roll it back explicitly if needed"
            ));
            continue;
        }
        if !header.status.needs_reconciliation() {
            continue;
        }
        // Checked once the transaction is known to need a restore, so an odd folder that is
        // finished or belongs to another workspace never blocks setup.
        setup_transaction::check_transaction_folder_trusted(&backup_dir)
            .map_err(|e| format!("interrupted setup {transaction_id}: {e}"))?;
        let mut manifest: ArtifactTransactionManifest = serde_json::from_str(&raw)
            .map_err(|e| format!("parse interrupted setup {transaction_id} manifest: {e}"))?;
        setup_transaction::validate_manifest(&manifest, workspace_root)
            .map_err(|e| format!("validate interrupted setup {transaction_id}: {e}"))?;
        let run = run_persisted_rollback(
            &manifest_path,
            &mut manifest,
            &backup_dir,
            home,
            workspace_root,
            RollbackExecutionMode::Automatic,
            &mut ProgressReporter::silent(),
        );
        if let Some(error) = run.persist_error {
            return Err(format!(
                "resume interrupted setup {transaction_id}: {error}"
            ));
        }
        if !run.errors.is_empty() {
            return Err(format!(
                "interrupted setup {transaction_id} could not be restored: {}",
                run.errors.join("; ")
            ));
        }
        if manifest.transaction_status != setup_transaction::TransactionStatus::RolledBack {
            // Only artifacts the user changed after the interruption remain.
            // They are preserved on purpose; their edits must not block setup.
            eprintln!(
                "riggverk: interrupted setup {transaction_id} left user-changed artifacts untouched: {}",
                run.preserved.join("; ")
            );
        }
    }
    Ok(notes)
}

/// Rolls back the workspace's interrupted transactions before a mutating command checks its
/// preview. The reconcile changes files and managed state, so a plan approved before it no longer
/// describes the disk: the fingerprint then mismatches and the user previews again. Call under the
/// mutation lock, before the fingerprint and the token are checked.
pub(super) fn reconcile_before_preview_check(ws_root: &Path, home: &Path) -> Result<(), String> {
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    reconcile_interrupted_setup_transactions(ws_root, home)
        .map(|_| ())
        .map_err(|e| format!("Cannot reconcile interrupted setup: {e}"))
}

/// What newer completed transactions for the same workspace wrote. An older transaction must
/// not restore its backup over an artifact one of them wrote, because the current content
/// belongs to the newer transaction.
#[derive(Default)]
struct NewerCompletedWrites {
    /// (transaction id, artifact) for every operation a newer completed transaction applied.
    written: Vec<(String, crate::artifact_registry::ArtifactId)>,
    /// A newer completed manifest could not be read, so what it wrote is unknown and every
    /// artifact counts as written.
    unreadable: Option<String>,
}

impl NewerCompletedWrites {
    fn owner_of(&self, artifact: &crate::artifact_registry::ArtifactId) -> Option<&str> {
        if let Some(id) = &self.unreadable {
            return Some(id);
        }
        self.written
            .iter()
            .find(|(_, written)| written == artifact)
            .map(|(id, _)| id.as_str())
    }
}

fn newer_completed_writes(
    backup_dir: &Path,
    workspace_key: &str,
) -> Result<NewerCompletedWrites, String> {
    let mut writes = NewerCompletedWrites::default();
    let (Some(setup_root), Some(transaction_id)) = (
        backup_dir.parent(),
        backup_dir.file_name().and_then(|name| name.to_str()),
    ) else {
        return Ok(writes);
    };
    let entries = fs::read_dir(setup_root).map_err(|e| format!("read setup transactions: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read setup transaction entry: {e}"))?;
        let candidate = entry.file_name().to_string_lossy().into_owned();
        if !validate_transaction_id_format(&candidate)
            || !transaction_id_is_newer(&candidate, transaction_id)
            || !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
        {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if crate::path_safety::reject_symlink(&manifest_path, "setup manifest").is_err() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(header) = setup_transaction::read_manifest_header(&raw) else {
            continue;
        };
        if !header.workspace_key.as_deref().is_some_and(|recorded| {
            setup_transaction::workspace_keys_match(recorded, workspace_key)
        }) || header.status != setup_transaction::TransactionStatus::Completed
        {
            continue;
        }
        match serde_json::from_str::<ArtifactTransactionManifest>(&raw) {
            Ok(manifest) => writes.written.extend(
                manifest
                    .operations
                    .into_iter()
                    .filter(|op| {
                        setup_transaction::operation_may_have_been_modified(op.apply_status)
                    })
                    .map(|op| (candidate.clone(), op.artifact)),
            ),
            Err(_) => writes.unreadable = Some(candidate),
        }
    }
    Ok(writes)
}

/// Id of a newer completed transaction for the same workspace, if one exists.
///
/// A completed transaction owns the managed state written after it, so older
/// transactions must not restore their managed-state snapshot over it.
pub(super) fn newer_completed_transaction(
    backup_dir: &Path,
    workspace_key: &str,
) -> Result<Option<String>, String> {
    newest_newer_transaction(backup_dir, workspace_key, |status| {
        status == setup_transaction::TransactionStatus::Completed
    })
}

/// Id of a newer transaction for the same workspace that blocks an Undo of this one: any that was
/// not rolled back. A completed one owns the managed state; one whose rollback failed (or that is
/// still unfinished) left artifacts whose records the older snapshot would erase.
pub(super) fn newer_transaction_blocking_undo(
    backup_dir: &Path,
    workspace_key: &str,
) -> Result<Option<String>, String> {
    newest_newer_transaction(backup_dir, workspace_key, |status| {
        status != setup_transaction::TransactionStatus::RolledBack
    })
}

fn newest_newer_transaction(
    backup_dir: &Path,
    workspace_key: &str,
    counts: impl Fn(setup_transaction::TransactionStatus) -> bool,
) -> Result<Option<String>, String> {
    let (Some(setup_root), Some(transaction_id)) = (
        backup_dir.parent(),
        backup_dir.file_name().and_then(|name| name.to_str()),
    ) else {
        return Ok(None);
    };
    let entries = fs::read_dir(setup_root).map_err(|e| format!("read setup transactions: {e}"))?;
    let mut newest = None::<String>;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read setup transaction entry: {e}"))?;
        let candidate = entry.file_name().to_string_lossy().into_owned();
        if !validate_transaction_id_format(&candidate)
            || !transaction_id_is_newer(&candidate, transaction_id)
            || !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
        {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if crate::path_safety::reject_symlink(&manifest_path, "setup manifest").is_err() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(header) = setup_transaction::read_manifest_header(&raw) else {
            continue;
        };
        if header.workspace_key.as_deref().is_some_and(|recorded| {
            setup_transaction::workspace_keys_match(recorded, workspace_key)
        }) && counts(header.status)
            && newest
                .as_deref()
                .is_none_or(|current| transaction_id_is_newer(&candidate, current))
        {
            newest = Some(candidate);
        }
    }
    Ok(newest)
}

/// Transaction ids are decimal timestamps; compare them numerically.
pub(super) fn transaction_id_is_newer(candidate: &str, base: &str) -> bool {
    let candidate = candidate.trim_start_matches('0');
    let base = base.trim_start_matches('0');
    (candidate.len(), candidate) > (base.len(), base)
}

fn restore_previous_managed_state(
    manifest: &ArtifactTransactionManifest,
    backup_dir: &Path,
    workspace_root: &Path,
) -> Result<(), String> {
    let state_path = crate::managed_state::managed_state_path(workspace_root);
    if manifest.previous_managed_state_present {
        let relative = manifest
            .previous_managed_state_backup_rel
            .as_deref()
            .ok_or_else(|| "managed-state backup is missing from transaction".to_string())?;
        if relative.contains("..") || Path::new(relative).is_absolute() {
            return Err("unsafe managed-state backup path".to_string());
        }
        let backup = backup_dir.join(relative);
        crate::path_safety::reject_symlink(&backup, "managed-state backup")?;
        let raw = fs::read(&backup).map_err(|e| format!("read managed-state backup: {e}"))?;
        let digest = crate::stable_digest::bytes(&raw);
        if manifest.previous_managed_state_digest.as_deref() != Some(digest.as_str()) {
            return Err("managed-state backup digest mismatch".to_string());
        }
        crate::managed_state::restore_managed_state_raw_atomic(workspace_root, &raw)?;
        let restored =
            fs::read(&state_path).map_err(|e| format!("read restored managed state: {e}"))?;
        if crate::stable_digest::bytes(&restored) != digest {
            return Err("restored managed state digest mismatch".to_string());
        }
        if manifest.previous_managed_state_trusted
            && crate::managed_state::read_managed_state(workspace_root).is_none()
        {
            return Err("restored trusted managed state failed validation".to_string());
        }
    } else {
        crate::safe_filesystem::remove_regular_file_no_symlinks(&state_path, workspace_root)
            .map_err(|e| format!("remove managed state: {e}"))?;
    }
    Ok(())
}

/// Puts the managed state and `pack-skills.json` back as they were before the transaction. Both
/// writes replace the whole file, so a retry after a failure repeats them safely. A newer completed
/// transaction owns the managed state now; restoring this transaction's snapshot would erase its
/// ownership records.
fn restore_auxiliary_records(
    manifest: &ArtifactTransactionManifest,
    backup_dir: &Path,
    workspace_root: &Path,
) -> Result<(), String> {
    if newer_completed_transaction(backup_dir, &manifest.workspace_key)?.is_some() {
        return Ok(());
    }
    restore_previous_managed_state(manifest, backup_dir, workspace_root)?;
    crate::skill_sources::restore_record(workspace_root, backup_dir)
}

/// Outcome of one persisted rollback pass.
struct RollbackRun {
    rolled_back: Vec<String>,
    /// Failures that need attention (I/O, missing or invalid backups, ...).
    errors: Vec<String>,
    /// Artifacts the user changed after apply; left untouched on purpose.
    preserved: Vec<String>,
    persist_error: Option<String>,
}

impl RollbackRun {
    fn persist_failed(
        rolled_back: Vec<String>,
        errors: Vec<String>,
        preserved: Vec<String>,
        error: String,
    ) -> Self {
        Self {
            rolled_back,
            errors,
            preserved,
            persist_error: Some(error),
        }
    }
}

fn run_persisted_rollback(
    manifest_path: &Path,
    manifest: &mut ArtifactTransactionManifest,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
    mode: RollbackExecutionMode,
    progress: &mut ProgressReporter,
) -> RollbackRun {
    let indices = setup_transaction::rollback_eligible_indices(&manifest.operations);
    if let Err(e) = persist_setup_manifest(
        manifest_path,
        manifest,
        setup_transaction::TransactionStatus::RollingBack,
        backup_dir,
    ) {
        return RollbackRun::persist_failed(vec![], vec![], vec![], e);
    }

    let mut rolled_back = Vec::new();
    let mut errors = Vec::new();
    let mut preserved = Vec::new();
    // An explicit rollback is refused earlier when a newer completed transaction exists.
    let newer_writes = match mode {
        RollbackExecutionMode::Automatic => {
            match newer_completed_writes(backup_dir, &manifest.workspace_key) {
                Ok(writes) => writes,
                Err(e) => return RollbackRun::persist_failed(rolled_back, errors, preserved, e),
            }
        }
        RollbackExecutionMode::Explicit => NewerCompletedWrites::default(),
    };
    let total = indices.len();
    for (position, index) in indices.into_iter().rev().enumerate() {
        progress.report(ApplyPhase::Apply, position, Some(total), || {
            Some(artifact_display_path(
                &manifest.operations[index].artifact,
                home,
                workspace_root,
            ))
        });
        if let Some(owner) = newer_writes.owner_of(&manifest.operations[index].artifact) {
            manifest.operations[index].rollback_status = setup_transaction::RollbackStatus::Failed;
            preserved.push(format!(
                "{}: newer completed transaction {owner} wrote this artifact; current content kept",
                artifact_label(&manifest.operations[index].artifact)
            ));
            if let Err(e) = persist_setup_manifest(
                manifest_path,
                manifest,
                setup_transaction::TransactionStatus::RollingBack,
                backup_dir,
            ) {
                return RollbackRun::persist_failed(rolled_back, errors, preserved, e);
            }
            continue;
        }
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
                        return RollbackRun::persist_failed(rolled_back, errors, preserved, e);
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
                        return RollbackRun::persist_failed(rolled_back, errors, preserved, e);
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
                        return RollbackRun::persist_failed(rolled_back, errors, preserved, e);
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
            return RollbackRun::persist_failed(rolled_back, errors, preserved, e);
        }

        let op = &mut manifest.operations[index];
        let artifact = op.artifact.clone();
        let restore_result = match mode {
            RollbackExecutionMode::Automatic => setup_transaction::restore_artifact_from_backup(
                op,
                backup_dir,
                home,
                workspace_root,
            ),
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
            Err(e) if e == setup_transaction::CHANGED_SINCE_APPLY => {
                op.rollback_status = setup_transaction::RollbackStatus::Failed;
                preserved.push(format!(
                    "{}: {e}; current content kept",
                    artifact_label(&artifact)
                ));
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
            return RollbackRun::persist_failed(rolled_back, errors, preserved, e);
        }
    }
    progress.report(ApplyPhase::Apply, total, Some(total), || None);

    if let Err(error) = restore_auxiliary_records(manifest, backup_dir, workspace_root) {
        errors.push(error);
        manifest.transaction_status = setup_transaction::TransactionStatus::RollbackFailed;
        let _ = persist_setup_manifest(
            manifest_path,
            manifest,
            setup_transaction::TransactionStatus::RollbackFailed,
            backup_dir,
        );
        return RollbackRun {
            rolled_back,
            errors,
            preserved,
            persist_error: None,
        };
    }

    let persist_error = finalize_persisted_rollback(manifest_path, manifest, backup_dir);
    RollbackRun {
        rolled_back,
        errors,
        preserved,
        persist_error,
    }
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
    manifest.finished_at = match status {
        setup_transaction::TransactionStatus::Completed
        | setup_transaction::TransactionStatus::Failed
        | setup_transaction::TransactionStatus::RolledBack
        | setup_transaction::TransactionStatus::RollbackFailed => new_transaction_id().ok(),
        _ => None,
    };
    setup_transaction::persist_manifest_atomic(manifest_path, manifest, transaction_root)
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
    let root = artifact.allowlist_root(home, workspace_root)?;
    let root = root.as_path();

    if dest.is_dir() {
        crate::safe_filesystem::remove_dir_no_symlinks(&dest, root)
            .map_err(|e| format!("remove {}: {e}", dest.display()))?;
    } else if dest.is_file() {
        crate::safe_filesystem::remove_regular_file_no_symlinks(&dest, root)
            .map_err(|e| format!("remove {}: {e}", dest.display()))?;
    }
    setup_transaction::remove_empty_skill_directories(artifact, &dest, home, root)?;
    if matches!(
        artifact,
        crate::artifact_registry::ArtifactId::WorkspaceFile(_)
    ) {
        remove_empty_migration_parents(&dest, workspace_root)?;
    }
    Ok(())
}

/// Folders of the workspace folder that a removal emptied go too, bottom-up. Never the workspace
/// folder itself or anything above it, never the state folder or the personal docs folder, and
/// never a folder that still holds anything.
fn remove_empty_migration_parents(path: &Path, workspace_root: &Path) -> Result<(), String> {
    let mut current = path.parent();
    while let Some(directory) = current {
        let Ok(rel) = directory.strip_prefix(workspace_root) else {
            break;
        };
        if rel.as_os_str().is_empty()
            || rel.starts_with(crate::workspace_layout::STATE_DIR)
            || rel.starts_with(crate::workspace_layout::LEGACY_STATE_DIR)
            || rel.starts_with(super::content::CUSTOM_DOCS_DIR)
        {
            break;
        }
        let mut entries =
            fs::read_dir(directory).map_err(|e| format!("read {}: {e}", directory.display()))?;
        if entries.next().is_some() {
            break;
        }
        let parent = directory.parent();
        crate::safe_filesystem::remove_empty_directory_no_symlinks(directory, workspace_root)
            .map_err(|e| format!("remove empty {}: {e}", directory.display()))?;
        current = parent;
    }
    Ok(())
}

/// Write the managed base block into a rules file. The user's text before and
/// after the block is kept byte for byte; a pristine pre-block file is
/// replaced by a file holding only the block.
fn apply_rules_artifact(
    artifact: &crate::artifact_registry::ArtifactId,
    dest: &Path,
    workspace_root: &Path,
    home: &Path,
    sources: &crate::skill_sources::SkillSources,
    rewrite: Option<&setup_transaction::RulesRewrite>,
) -> Result<(), String> {
    let root = artifact.allowlist_root(home, workspace_root)?;
    if let Some(rewrite) = rewrite {
        // A file beside the rules file can keep its harness from reading it (Pi); it may have
        // appeared since the preview, which only compares the rules file itself.
        if let crate::artifact_registry::ArtifactId::HarnessRules(harness) = artifact {
            if let Some(conflict) = harness.rules().and_then(|rules| rules.preflight(dest)) {
                return Err(format!(
                    "refusing to change rules file: {}",
                    conflict.message()
                ));
            }
        }
        // An explicit conversion writes exactly the previewed content, and only
        // over the file the preview was computed from.
        let installed =
            fs::read(dest).map_err(|e| format!("read rules file {}: {e}", dest.display()))?;
        if crate::stable_digest::bytes(&installed) != rewrite.expected_installed_digest {
            return Err("rules file changed since preview; preview the conversion again".into());
        }
        return crate::safe_filesystem::write_regular_file_atomic(
            dest,
            rewrite.content.as_bytes(),
            &root,
        )
        .map_err(|e| format!("write rules file {}: {e}", dest.display()));
    }
    setup_transaction::ensure_rules_apply_allowed(artifact, workspace_root, home, sources)?;
    // A harness that keeps its folder owner-only (Pi makes its agent folder 0700) gets the
    // folders the app creates for the file the same way.
    if let crate::artifact_registry::ArtifactId::HarnessRules(harness) = artifact {
        if let (true, Some(folder)) = (
            harness.rules().is_some_and(|rules| rules.private_dir),
            dest.parent(),
        ) {
            crate::safe_filesystem::create_private_directory_all_no_symlinks(folder, &root)
                .map_err(|e| format!("create {}: {e}", folder.display()))?;
        }
    }
    // The bundled base with the packs' routing, from the same sources the plan was made from.
    let source_text = crate::pack_routing::rules_source_text(artifact, sources)?;
    let rendered = if dest.exists() {
        let installed =
            fs::read(dest).map_err(|e| format!("read rules file {}: {e}", dest.display()))?;
        match crate::rules_block::parse_bytes(&installed) {
            Ok(Some(file)) => file.render_with_body(&source_text),
            Ok(None) => crate::rules_block::render_new(&source_text),
            Err(reason) => {
                return Err(format!(
                    "refusing to change rules file {}: {}",
                    dest.display(),
                    reason.message()
                ));
            }
        }
    } else {
        crate::rules_block::render_new(&source_text)
    };
    crate::safe_filesystem::write_regular_file_atomic(dest, rendered.as_bytes(), &root)
        .map_err(|e| format!("write rules file {}: {e}", dest.display()))
}

/// Write the managed entry into the MCP file of a light harness. Only that entry changes: the
/// user's other servers keep their values and their order. A file the app does not edit (comments,
/// a trailing comma, ...) or an entry of the user's own is refused before anything is written. A
/// new file is owner-only (0600), and so are the folders created for it when the descriptor says
/// the harness keeps its folder that way.
fn apply_mcp_artifact(
    harness: crate::light_harness::LightHarnessId,
    workspace_root: &Path,
    home: &Path,
    dest: &Path,
    root: &Path,
) -> Result<(), String> {
    let artifact = crate::artifact_registry::ArtifactId::HarnessMcp(harness);
    setup_transaction::ensure_mcp_apply_allowed(&artifact, workspace_root, home)?;
    let spec = harness
        .mcp()
        .ok_or_else(|| "the light harness descriptor is unavailable".to_string())?;
    let entry = crate::light_mcp::expected_entry(
        spec,
        &crate::setup_roots::bundled_root_for(workspace_root)?,
        home,
    )?;
    let document = crate::light_mcp::read(dest, spec)
        .map_err(|refusal| format!("refusing to change the MCP file: {}", refusal.message()))?;
    let existed = document.is_some();
    let rendered = crate::light_mcp::render(spec, document, entry)?;
    if let Some(folder) = dest.parent() {
        let created = if spec.private_dir {
            crate::safe_filesystem::create_private_directory_all_no_symlinks(folder, root)
        } else {
            crate::safe_filesystem::create_directory_all_no_symlinks(folder, root)
        };
        created.map_err(|e| format!("create {}: {e}", folder.display()))?;
    }
    if existed {
        crate::safe_filesystem::write_regular_file_atomic(dest, rendered.as_bytes(), root)
    } else {
        crate::safe_filesystem::write_private_regular_file_atomic(dest, rendered.as_bytes(), root)
    }
    .map_err(|e| format!("write MCP file {}: {e}", dest.display()))
}

/// Write the planned content of Claude's `settings.json`: the attribution values and the
/// overrides added or removed, every other key with its value and its place. It is written only
/// over the file it was planned from; a moved config folder (`CLAUDE_CONFIG_DIR`) is refused
/// before anything is written. A new file is owner-only (0600).
fn apply_claude_settings(
    dest: &Path,
    root: &Path,
    rewrite: &setup_transaction::RulesRewrite,
) -> Result<(), String> {
    if crate::claude_settings::config_dir_override() {
        return Err(format!(
            "refusing to change settings.json: {}",
            crate::claude_settings::CONFIG_DIR_REASON
        ));
    }
    let exists = dest.exists();
    let installed = if exists {
        crate::stable_digest::file(dest)?
    } else {
        crate::setup_fingerprint::ABSENT_DIGEST.to_string()
    };
    if installed != rewrite.expected_installed_digest {
        return Err("settings.json changed since preview; preview again".to_string());
    }
    if exists {
        crate::safe_filesystem::write_regular_file_atomic(dest, rewrite.content.as_bytes(), root)
    } else {
        crate::safe_filesystem::write_private_regular_file_atomic(
            dest,
            rewrite.content.as_bytes(),
            root,
        )
    }
    .map_err(|e| format!("write settings.json {}: {e}", dest.display()))
}

/// A skill or agent file is replaced or removed only while it still holds what the backup holds
/// (or is still absent when nothing was backed up). Otherwise someone edited it after the backup,
/// and the write would lose that edit, since an undo restores the older backup. Other artifacts
/// merge into the user's file and are not checked. The few instructions between this check and
/// the write stay open to a racing writer.
fn ensure_unchanged_since_backup(
    artifact: &crate::artifact_registry::ArtifactId,
    backup_rel: Option<&str>,
    backup_dir: &Path,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    if !crate::kept_files::is_keepable(artifact) {
        return Ok(());
    }
    let backed_up = match backup_rel {
        Some(rel) => crate::stable_digest::file(&backup_dir.join(rel))?,
        None => crate::setup_fingerprint::ABSENT_DIGEST.to_string(),
    };
    let current =
        crate::setup_fingerprint::artifact_installed_full_digest(artifact, workspace_root, home)?;
    if current != backed_up {
        return Err(
            "file changed during apply; nothing was overwritten, preview again".to_string(),
        );
    }
    Ok(())
}

fn apply_single_artifact(
    artifact: &crate::artifact_registry::ArtifactId,
    workspace_root: &Path,
    home: &Path,
    sources: &crate::skill_sources::SkillSources,
    rules_rewrite: Option<&setup_transaction::RulesRewrite>,
    overwrite: Option<&setup_transaction::Overwrite>,
) -> Result<(), String> {
    // The values of Claude's settings.json are constants of the app: no bundled source. The plan
    // carries the content.
    if artifact == &crate::artifact_registry::ArtifactId::ClaudeSettings {
        let Some(rewrite) = rules_rewrite.filter(|_| overwrite.is_none()) else {
            return Err("settings.json is written only from its planned content".to_string());
        };
        let (dest, root) =
            setup_transaction::validate_artifact_dest(artifact, workspace_root, home)?;
        return apply_claude_settings(&dest, &root, rewrite);
    }
    let (source, dest) = setup_transaction::validate_artifact_source_dest_with(
        artifact,
        workspace_root,
        home,
        sources,
    )?;
    let root = artifact.allowlist_root(home, workspace_root)?;

    // A replacement the user asked for writes over their own file: only a skill or agent file, and
    // only while it is still the file they reviewed. Checked before any branch below can write.
    if let Some(overwrite) = overwrite {
        if rules_rewrite.is_some() {
            return Err("a file cannot be both converted and replaced".to_string());
        }
        setup_transaction::ensure_overwrite_allowed(artifact, workspace_root, home, overwrite)?;
    }

    if source.is_dir() {
        if dest.exists() {
            crate::safe_filesystem::remove_dir_no_symlinks(&dest, &root)
                .map_err(|e| format!("replace dir: {e}"))?;
        }
        crate::safe_filesystem::copy_dir_no_symlinks(&source, &dest, &root)
            .map_err(|e| format!("apply dir: {e}"))?;
        return Ok(());
    }

    if artifact.is_rules_block() {
        return apply_rules_artifact(
            artifact,
            &dest,
            workspace_root,
            home,
            sources,
            rules_rewrite,
        );
    }

    // Every Playwright entry starts `npx --prefix <npx prefix>` in the output folder: both exist
    // before the entry does.
    if matches!(
        artifact,
        crate::artifact_registry::ArtifactId::HarnessMcp(_)
            | crate::artifact_registry::ArtifactId::CursorMcp
            | crate::artifact_registry::ArtifactId::OpenCodeConfig
    ) {
        crate::commands::cursor_profile::ensure_npx_dirs(home)?;
    }

    if let crate::artifact_registry::ArtifactId::HarnessMcp(harness) = artifact {
        return apply_mcp_artifact(*harness, workspace_root, home, &dest, &root);
    }

    if artifact == &crate::artifact_registry::ArtifactId::CursorMcp {
        let cursor_paths = crate::cursor_profile_paths::resolve_cursor_profile_paths()
            .map_err(|e| format!("resolve Cursor profile: {e}"))?;
        let result = crate::cursor_profile_ops::run_global_mcp_only(
            &crate::setup_roots::bundled_root_for(workspace_root)?,
            &cursor_paths,
            true,
        );
        if !result.success {
            return Err(format!("Cursor MCP merge failed: {}", result.stderr));
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
        let content = if dest.is_file() {
            fs::read_to_string(&dest)
                .map_err(|e| format!("read opencode config {}: {e}", dest.display()))?
        } else {
            "{}".to_string()
        };
        let installed = serde_json::from_str(&content)
            .map_err(|_| "the OpenCode opencode.json is not valid JSON".to_string())?;
        // A role model the app cannot prove it wrote is the user's: kept as it is.
        let app = crate::commands::AppRoleModels::load(Some(workspace_root), home);
        let merged = crate::commands::merge_managed_opencode_config(
            &installed,
            &crate::commands::managed_opencode_install_projection(&installed, &rendered, &app),
        );
        crate::safe_filesystem::write_private_regular_file_atomic(
            &dest,
            crate::commands::serialize_opencode_preserving_models(&content, &merged)?.as_bytes(),
            &root,
        )
        .map_err(|e| format!("write opencode config {}: {e}", dest.display()))?;
        return Ok(());
    }

    // Only the managed keys of tui.json are the app's; a file that is not strict JSON is refused.
    if artifact == &crate::artifact_registry::ArtifactId::OpenCodeTui {
        let rendered = crate::opencode_tui::render_install(&source, &dest)?;
        return crate::safe_filesystem::write_regular_file_atomic(
            &dest,
            rendered.as_bytes(),
            &root,
        )
        .map_err(|e| format!("write tui.json {}: {e}", dest.display()));
    }

    if artifact == &crate::artifact_registry::ArtifactId::CodexConfig {
        // The reset to Riggverk's defaults writes exactly the content its preview rendered, and
        // only over the file the preview was computed from.
        if let Some(rewrite) = rules_rewrite {
            let installed = crate::codex_config_keep::read_config_bounded(&dest)?;
            if crate::stable_digest::bytes(&installed) != rewrite.expected_installed_digest {
                return Err(
                    "the Codex config.toml changed since preview; preview the reset again"
                        .to_string(),
                );
            }
            return crate::safe_filesystem::write_regular_file_atomic(
                &dest,
                rewrite.content.as_bytes(),
                &root,
            );
        }
        if dest.is_file() {
            // The keys the user keeps are rendered from their kept value, never from the template.
            let rendered = crate::commands::render_codex_config_for_apply(
                &crate::setup_roots::bundled_root_for(workspace_root)?,
                workspace_root,
                home,
                &dest,
                &source,
            )?;
            return crate::safe_filesystem::write_regular_file_atomic(
                &dest,
                rendered.as_bytes(),
                &root,
            );
        }
        crate::safe_filesystem::copy_private_regular_file_no_symlinks(&source, &dest, &root)
            .map_err(|e| format!("write codex config {}: {e}", dest.display()))?;
        crate::safe_filesystem::set_file_executable(&dest, false, true)?;
        return Ok(());
    }

    crate::safe_filesystem::copy_regular_file_no_symlinks(&source, &dest, &root)
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    if artifact.is_skill_file() {
        crate::safe_filesystem::set_file_executable(
            &dest,
            crate::safe_filesystem::file_is_executable(&source)?,
            false,
        )?;
    }
    Ok(())
}

fn cleanup_preflight_transaction_evidence(backup_dir: &Path) {
    let manifest_path = backup_dir.join("manifest.json");
    let _ = crate::safe_filesystem::remove_regular_file_no_symlinks(&manifest_path, backup_dir);
    let _ = crate::safe_filesystem::remove_empty_directory_no_symlinks(backup_dir, backup_dir);
}

fn run_persisted_automatic_rollback(
    manifest_path: &Path,
    manifest: &mut ArtifactTransactionManifest,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> RollbackRun {
    run_persisted_rollback(
        manifest_path,
        manifest,
        backup_dir,
        home,
        workspace_root,
        RollbackExecutionMode::Automatic,
        &mut ProgressReporter::silent(),
    )
}

/// The message of an apply undone because `pack-skills.json` could not be written.
pub(crate) const PACK_RECORD_NOT_SAVED: &str =
    "The list of installed pack skills could not be saved, so the changes were undone";

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
    let run = run_persisted_automatic_rollback(
        ctx.manifest_path,
        ctx.manifest,
        ctx.backup_dir,
        ctx.home,
        ctx.workspace_root,
    );
    if !run.errors.is_empty() {
        message.push_str(&format!(". Rollback errors: {}", run.errors.join("; ")));
    }
    if !run.preserved.is_empty() {
        message.push_str(&format!(
            ". Changed since apply, left as is: {}",
            run.preserved.join("; ")
        ));
    }
    if let Some(persist_err) = run.persist_error {
        failed.push(persist_err);
    }
    SetupResult {
        success: false,
        transaction_id: ctx.transaction_id,
        applied: ctx.applied,
        failed,
        rolled_back: run.rolled_back,
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

fn receipt_for_artifacts(selected: &[setup_transaction::PlannedArtifact]) -> SetupReceipt {
    let mut receipt = SetupReceipt::default();
    for planned in selected {
        if planned.kind == OperationKind::NoChange
            && selected
                .iter()
                .filter(|other| other.surface == planned.surface)
                .all(|other| other.kind == OperationKind::NoChange)
            && !receipt.synced.contains(&planned.surface)
        {
            receipt.synced.push(planned.surface);
        }
        record_receipt_item(&mut receipt, planned.surface, planned.kind);
    }
    receipt
}

fn record_receipt_item(receipt: &mut SetupReceipt, surface: SetupSurfaceId, kind: OperationKind) {
    let reason = match kind {
        OperationKind::Conflict => SetupReceiptReason::Conflict,
        OperationKind::Manual => SetupReceiptReason::Manual,
        _ => return,
    };
    let item = SetupReceiptItem { surface, reason };
    if !receipt.left_for_you.contains(&item) {
        receipt.left_for_you.push(item);
    }
}

/// Apply artifact-level operations using artifact-owned transactions, reporting progress as it goes.
pub(super) fn apply_planned_artifacts(
    selected: &[setup_transaction::PlannedArtifact],
    manual_steps: Vec<String>,
    preview_token: Option<&str>,
    progress: &mut ProgressReporter,
) -> SetupResult {
    let result = run_planned_artifacts(
        selected,
        manual_steps,
        preview_token,
        receipt_for_artifacts(selected),
        progress,
    );
    progress.finish();
    result
}

fn run_planned_artifacts(
    selected: &[setup_transaction::PlannedArtifact],
    mut manual_steps: Vec<String>,
    preview_token: Option<&str>,
    receipt: SetupReceipt,
    progress: &mut ProgressReporter,
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

    let pending: Vec<setup_transaction::PlannedArtifact> = selected
        .iter()
        .filter(|planned| planned.kind.needs_apply())
        .cloned()
        .collect();
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

    let ws_root = match workspace_target_for_write() {
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
    match reconcile_interrupted_setup_transactions(&ws_root, &home) {
        Ok(notes) => manual_steps.extend(notes),
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id,
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps,
                message: format!("Cannot reconcile interrupted setup: {e}"),
            };
        }
    }

    let mut surfaces: Vec<SetupSurfaceId> = pending.iter().map(|p| p.surface).collect();
    surfaces.sort_by_key(|s| format!("{s:?}"));
    surfaces.dedup();

    // The bundle and the packs are read once for the whole apply: preflight, every operation and
    // its validation use these sources.
    let sources = match crate::skill_sources::SkillSources::for_workspace(&ws_root) {
        Ok(sources) => sources,
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

    for p in &pending {
        if matches!(p.kind, OperationKind::Remove) {
            continue;
        }
        let checked = if p.artifact == crate::artifact_registry::ArtifactId::ClaudeSettings {
            setup_transaction::validate_artifact_dest(&p.artifact, &ws_root, &home).map(|_| ())
        } else {
            setup_transaction::validate_artifact_source_dest_with(
                &p.artifact,
                &ws_root,
                &home,
                &sources,
            )
            .map(|_| ())
        };
        if let Err(e) = checked {
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
    let roots = match crate::setup_roots::SetupRoots::resolve(
        ws_root.clone(),
        home.clone(),
        backup_dir.clone(),
        sources,
    ) {
        Ok(roots) => roots,
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
    let ws_root = roots.runtime_root.clone();
    let home = roots.home.clone();
    let backup_dir = roots.backup_root.clone();
    let previous_managed_state = crate::managed_state::read_managed_state(&ws_root);
    let previous_state_path = crate::managed_state::managed_state_path(&ws_root);
    let (previous_managed_state_present, previous_managed_state_digest, previous_backup_rel) =
        if previous_state_path.is_file() {
            let raw = match fs::read(&previous_state_path) {
                Ok(raw) => raw,
                Err(e) => {
                    return SetupResult {
                        success: false,
                        transaction_id,
                        applied: vec![],
                        failed: vec![format!("read managed state: {e}")],
                        rolled_back: vec![],
                        manual_steps,
                        message: "Cannot back up managed state".to_string(),
                    };
                }
            };
            let relative = "managed-state.previous.json".to_string();
            if let Err(e) = write_synced_backup(&backup_dir.join(&relative), &raw, &backup_dir) {
                return SetupResult {
                    success: false,
                    transaction_id,
                    applied: vec![],
                    failed: vec![format!("backup managed state: {e}")],
                    rolled_back: vec![],
                    manual_steps,
                    message: "Cannot back up managed state".to_string(),
                };
            }
            (
                true,
                Some(crate::stable_digest::bytes(&raw)),
                Some(relative),
            )
        } else {
            (false, None, None)
        };

    // `pack-skills.json` is not an artifact; a rollback puts it back from this copy.
    if let Err(error) = crate::skill_sources::snapshot_record(&ws_root, &backup_dir) {
        manual_steps.push(format!(
            "The list of installed pack skills could not be saved for a rollback: {error}"
        ));
    }

    let mut manifest_ops: Vec<ArtifactManifestOperation> = Vec::new();
    for (backed_up, p) in pending.iter().enumerate() {
        progress.report(ApplyPhase::Backup, backed_up, Some(pending.len()), || {
            Some(artifact_display_path(&p.artifact, &home, &ws_root))
        });
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
        finished_at: None,
        receipt: Some(receipt),
        surface_ids: surfaces.clone(),
        transaction_status: setup_transaction::TransactionStatus::Prepared,
        previous_managed_state_present,
        previous_managed_state_trusted: previous_managed_state.is_some(),
        previous_managed_state_digest,
        previous_managed_state_backup_rel: previous_backup_rel,
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

    // A fresh profile has no data folder: the first apply creates it, owner-only, before any
    // write below it.
    if let Err(e) = crate::managed_state::ensure_data_folder(&ws_root) {
        cleanup_preflight_transaction_evidence(&backup_dir);
        return SetupResult {
            success: false,
            transaction_id,
            applied: vec![],
            failed: vec![e.clone()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Cannot create the workspace folder; nothing was changed: {e}"),
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

    let apply_total = pending
        .iter()
        .filter(|p| {
            matches!(
                p.kind,
                OperationKind::Create | OperationKind::Update | OperationKind::Remove
            )
        })
        .count();

    // `manifest.operations` was built from `pending` in order.
    for (operation_index, p) in pending.iter().enumerate() {
        if !matches!(
            p.kind,
            OperationKind::Create | OperationKind::Update | OperationKind::Remove
        ) {
            continue;
        }
        progress.report(ApplyPhase::Apply, applied.len(), Some(apply_total), || {
            Some(artifact_display_path(&p.artifact, &home, &ws_root))
        });
        manifest.operations[operation_index].apply_status =
            setup_transaction::ApplyStatus::InFlight;
        // Durable before the write, so a crash before the post-apply digests are saved still
        // leaves proof of what the app wrote.
        manifest.operations[operation_index].expected_full_digest =
            setup_transaction::expected_apply_full_digest(p, &ws_root, &home, &roots.sources);
        if let Err(e) = persist_setup_manifest(
            &manifest_path,
            &mut manifest,
            setup_transaction::TransactionStatus::Applying,
            &backup_dir,
        ) {
            return finish_failed_apply_with_rollback(FailedApplyRollback {
                manifest_path: &manifest_path,
                manifest: &mut manifest,
                backup_dir: &backup_dir,
                home: &home,
                workspace_root: &ws_root,
                transaction_id,
                applied,
                failed: vec![e.clone()],
                manual_steps: manual_steps.clone(),
                message: format!("Cannot persist in-flight status: {e}"),
            });
        }

        let mutation = if let Err(e) = ensure_unchanged_since_backup(
            &p.artifact,
            manifest.operations[operation_index].backup_rel.as_deref(),
            &backup_dir,
            &ws_root,
            &home,
        ) {
            Err(e)
        } else if matches!(p.kind, OperationKind::Remove) {
            remove_single_artifact(&p.artifact, &ws_root, &home)
        } else {
            apply_single_artifact(
                &p.artifact,
                &ws_root,
                &home,
                &roots.sources,
                p.rules_rewrite.as_ref(),
                p.overwrite.as_ref(),
            )
        };
        if let Err(e) = mutation {
            manifest.operations[operation_index].apply_status =
                setup_transaction::ApplyStatus::Failed;
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
                message: format!("Artifact mutation failed: {err}"),
            });
        }

        let validation = if matches!(p.kind, OperationKind::Remove) {
            crate::setup_fingerprint::artifact_installed_full_digest(&p.artifact, &ws_root, &home)
                .and_then(|digest| {
                    if digest == crate::setup_fingerprint::ABSENT_DIGEST {
                        Ok(())
                    } else {
                        Err("removed artifact is still present".to_string())
                    }
                })
        } else if p.artifact == crate::artifact_registry::ArtifactId::ClaudeSettings {
            setup_transaction::validate_written_content(p, &ws_root, &home)
        } else {
            setup_transaction::validate_artifact_after_apply_with(
                &p.artifact,
                &ws_root,
                &home,
                &roots.sources,
            )
        }
        .and_then(|()| {
            let managed = crate::setup_fingerprint::artifact_installed_managed_digest(
                &p.artifact,
                &ws_root,
                &home,
            )
            .map_err(|e| format!("post-apply managed digest: {e}"))?;
            let full = crate::setup_fingerprint::artifact_installed_full_digest(
                &p.artifact,
                &ws_root,
                &home,
            )
            .map_err(|e| format!("post-apply full digest: {e}"))?;
            Ok((managed, full))
        });
        let (post_apply_digest, post_apply_full_digest) = match validation {
            Ok(digests) => digests,
            Err(e) => {
                manifest.operations[operation_index].apply_status =
                    setup_transaction::ApplyStatus::Failed;
                manifest.operations[operation_index].validation_status =
                    setup_transaction::ValidationStatus::Failed;
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
                    message: format!("Artifact validation failed: {err}"),
                });
            }
        };
        let operation = &mut manifest.operations[operation_index];
        operation.apply_status = setup_transaction::ApplyStatus::Applied;
        operation.validation_status = setup_transaction::ValidationStatus::Passed;
        operation.post_apply_digest = Some(post_apply_digest);
        operation.post_apply_full_digest = Some(post_apply_full_digest);
        // The Applied status and digests are not persisted here: the next
        // operation's in-flight persist (always before its mutation) and the
        // persist after the loop write the whole in-memory manifest, so they
        // are durable before anything else can change on disk. This halves
        // the number of fsynced manifest writes per apply.
        applied.push(if matches!(p.kind, OperationKind::Remove) {
            format!("removed {}", artifact_label(&p.artifact))
        } else {
            artifact_label(&p.artifact)
        });
    }
    progress.report(ApplyPhase::Apply, applied.len(), Some(apply_total), || None);

    if let Err(e) = persist_setup_manifest(
        &manifest_path,
        &mut manifest,
        setup_transaction::TransactionStatus::Applying,
        &backup_dir,
    ) {
        return finish_failed_apply_with_rollback(FailedApplyRollback {
            manifest_path: &manifest_path,
            manifest: &mut manifest,
            backup_dir: &backup_dir,
            home: &home,
            workspace_root: &ws_root,
            transaction_id,
            applied,
            failed: vec![e.clone()],
            manual_steps: manual_steps.clone(),
            message: format!("Cannot persist artifact progress: {e}"),
        });
    }

    match crate::managed_state::next_state_from_operations(
        previous_managed_state.as_ref(),
        &roots.sources,
        &roots.runtime_root,
        &roots.home,
        &manifest.operations,
        selected,
    ) {
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

    // Which installed skills came from a pack, so that a pack that later goes missing does not
    // retire them. Without that record a missing pack would read as a retirement, so an apply that
    // cannot save it is undone (the rollback puts the previous record back).
    if let Err(error) = crate::skill_sources::record_after_transaction(&ws_root, &roots.sources) {
        return finish_failed_apply_with_rollback(FailedApplyRollback {
            manifest_path: &manifest_path,
            manifest: &mut manifest,
            backup_dir: &backup_dir,
            home: &home,
            workspace_root: &ws_root,
            transaction_id,
            applied,
            failed: vec![error],
            manual_steps,
            message: PACK_RECORD_NOT_SAVED.to_string(),
        });
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

    // A file the app wrote or removed is the app's again, so a choice to keep the user's version of
    // it ends here: a later edit must be a new conflict, not silently covered by an old choice.
    // Cleared only once the transaction is complete, so a failed apply (rolled back) loses nothing.
    let mut rewritten: Vec<String> = manifest
        .operations
        .iter()
        .filter(|operation| {
            matches!(
                operation.kind,
                OperationKind::Create | OperationKind::Update | OperationKind::Remove
            )
        })
        .map(|operation| crate::managed_state::artifact_identity(&operation.artifact))
        .collect();
    // So is a kept file that became the bundled file without an app write (the user copied it in
    // by hand): its choice is inert, and would silently cover the next edit.
    rewritten.extend(crate::kept_files::matching_the_bundle(
        &ws_root,
        &home,
        |artifact| {
            setup_transaction::detect_artifact_state_with(artifact, &ws_root, &home, &roots.sources)
                .0
                == OperationKind::NoChange
        },
    ));
    if let Err(error) = crate::kept_files::release(&ws_root, &rewritten) {
        manual_steps.push(format!(
            "The files were applied, but a choice to keep your version of one of them could not be cleared: {error}"
        ));
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

// ── Rollback ──

/// Rollback a completed setup transaction.
///
/// Only validates the transaction ID and allows rollback if:
/// - The transaction manifest exists
/// - The backup files are present
/// - The destination paths are resolvable from the current registry
pub fn rollback_transaction(
    transaction_id: &str,
    dry_run: bool,
    progress: &mut ProgressReporter,
) -> SetupResult {
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
    if let Err(e) = setup_transaction::check_transaction_folder_trusted(&backup_dir) {
        return SetupResult {
            success: false,
            transaction_id: transaction_id.to_string(),
            applied: vec![],
            failed: vec![e.clone()],
            rolled_back: vec![],
            manual_steps: vec![],
            message: format!("Transaction backup refused: {e}"),
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
    let ws_root = match if dry_run {
        // A dry run writes nothing, so it does not take the first-mutation move either.
        setup_workspace_target_path()
    } else {
        workspace_target_for_write()
    } {
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
        | setup_transaction::TransactionStatus::Prepared
        | setup_transaction::TransactionStatus::Applying
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
    }

    match newer_transaction_blocking_undo(&backup_dir, &manifest.workspace_key) {
        Ok(None) => {}
        Ok(Some(newer)) => {
            let message = format!(
                "cannot roll back transaction {transaction_id}: newer transaction {newer} is not rolled back; roll that one back first"
            );
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec![message.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message,
            };
        }
        Err(e) => {
            return SetupResult {
                success: false,
                transaction_id: transaction_id.to_string(),
                applied: vec![],
                failed: vec![e.clone()],
                rolled_back: vec![],
                manual_steps: vec![],
                message: format!("Cannot check for newer transactions: {e}"),
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
            let _mutation_guard =
                match crate::setup_mutation_guard::try_acquire_setup_mutation_guard() {
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
            // Every artifact is back, but the records may not be: the pass that ended
            // rollback-failed may have failed only on them, so they are restored again first.
            if let Err(error) = restore_auxiliary_records(&manifest_mut, &backup_dir, &ws_root) {
                let mut failed = vec![error];
                if let Err(persist_err) = persist_setup_manifest(
                    &manifest_path,
                    &mut manifest_mut,
                    setup_transaction::TransactionStatus::RollbackFailed,
                    &backup_dir,
                ) {
                    failed.push(persist_err);
                }
                return SetupResult {
                    success: false,
                    transaction_id: transaction_id.to_string(),
                    applied: vec![],
                    failed,
                    rolled_back: plan.already_restored,
                    manual_steps: vec![],
                    message: "Rollback could not restore the managed state or the pack skills list"
                        .to_string(),
                };
            }
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
        // The folder the artifact is written inside: the workspace, a customised `CODEX_HOME` or
        // `XDG_CONFIG_HOME` outside home, else home.
        let allowlist = match op.artifact.allowlist_root(&home, &ws_root) {
            Ok(root) => root,
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
        if let Err(e) = setup_transaction::reject_symlink_parent_chain(
            &dest,
            &allowlist,
            "rollback destination",
        ) {
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
    let run = run_persisted_rollback(
        &manifest_path,
        &mut manifest_mut,
        &backup_dir,
        &home,
        &ws_root,
        RollbackExecutionMode::Explicit,
        progress,
    );
    let restored = run.rolled_back;
    let mut rollback_failures = run.errors;
    rollback_failures.extend(run.preserved);
    let restored_count = restored.len();
    let success = rollback_failures.is_empty();
    if let Some(persist_err) = run.persist_error {
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
#[cfg(test)]
pub fn detect_surface_state(
    surface: SetupSurfaceId,
    workspace_root: &Path,
    home: &Path,
) -> (SetupSurfaceId, OperationKind, String) {
    setup_transaction::detect_surface_state(surface, workspace_root, home)
}

/// Validate transaction ID format — must be only digits (nanosecond timestamp).
pub(super) fn validate_transaction_id_format(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    id.chars().all(|c| c.is_ascii_digit())
}

// ── Tauri commands ──

#[cfg(test)]
fn compute_plan_fingerprint_for_surfaces(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
) -> Result<String, String> {
    let sources = crate::skill_sources::SkillSources::for_workspace(workspace_root)?;
    compute_plan_fingerprint_for_surfaces_with(surfaces, workspace_root, home, &sources)
}

/// The fingerprint of the plan of `surfaces`, planned from `sources`.
fn compute_plan_fingerprint_for_surfaces_with(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
    sources: &crate::skill_sources::SkillSources,
) -> Result<String, String> {
    let scope = setup_transaction::scope_for_surfaces(surfaces, home)?;
    let planned = setup_transaction::plan_artifacts_for_surfaces_with(
        surfaces,
        workspace_root,
        home,
        &scope,
        sources,
    )?;
    setup_transaction::compute_plan_fingerprint_with(
        workspace_root,
        surfaces,
        &planned,
        home,
        sources,
    )
}

fn attach_plan_preview(
    plan: &mut SetupPlan,
    workspace_root: &Path,
    home: &Path,
    sources: &Result<crate::skill_sources::SkillSources, String>,
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
    let fingerprint = compute_plan_fingerprint_for_surfaces_with(
        &pending_surfaces,
        workspace_root,
        home,
        sources.as_ref().map_err(Clone::clone)?,
    )?;
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
///
/// Read-only and walks the installed tree, so it runs off the main thread.
#[tauri::command(async)]
pub fn get_installation_status(
    surfaces: Vec<String>,
) -> Result<crate::installation_status::InstallationStatus, String> {
    let settings = crate::settings::load();
    let parsed: Vec<SetupSurfaceId> = surfaces
        .iter()
        .map(|s| {
            serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(s.to_string()))
                .map_err(|_| format!("Unknown surface ID: {s}"))
        })
        .collect::<Result<_, _>>()?;
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;
    let surface_ids =
        requested_or_retiring_surfaces(canonical_surfaces(parsed), &settings, &ws_root, &home)?;
    crate::installation_status::status_for_surfaces(&surface_ids, &ws_root, &home)
}

fn reject_disabled_surfaces(
    surfaces: &[SetupSurfaceId],
    settings: &crate::settings::AppSettings,
) -> Result<(), String> {
    let disabled: Vec<&'static str> = surfaces
        .iter()
        .filter_map(|surface| {
            surface
                .harness()
                .filter(|harness| !crate::settings::harness_enabled(settings, *harness))
                .map(|harness| harness.as_str())
        })
        .collect();
    if disabled.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Harness disabled: {}",
            disabled
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }
}

/// The surfaces a request names, each once: a retired per-harness skill surface (a client that
/// still sends one) is the global `Skills` surface, and several of them are one.
fn canonical_surfaces(requested: Vec<SetupSurfaceId>) -> Vec<SetupSurfaceId> {
    let mut seen = std::collections::HashSet::new();
    requested
        .into_iter()
        .map(SetupSurfaceId::canonical)
        .filter(|surface| seen.insert(*surface))
        .collect()
}

/// Surfaces an explicit request may act on. Harness-disabled surfaces are
/// rejected; target-disabled surfaces are dropped silently. The result may be
/// empty, and an empty result must stay an empty plan, never "all surfaces".
fn gate_requested_surfaces(
    requested: Vec<SetupSurfaceId>,
    settings: &crate::settings::AppSettings,
) -> Result<Vec<SetupSurfaceId>, String> {
    reject_disabled_surfaces(&requested, settings)?;
    Ok(requested
        .into_iter()
        .filter(|surface| crate::settings::surface_enabled(settings, *surface))
        .collect())
}

/// The surfaces of `requested` the target gate drops that the next Update still has to clean up:
/// every target of the surface is off, its harness is on, and the app's values are still in the
/// file (see `setup_transaction::claude_settings_retiring`).
fn retiring_surfaces(
    requested: &[SetupSurfaceId],
    settings: &crate::settings::AppSettings,
    ws_root: &Path,
    home: &Path,
) -> Vec<SetupSurfaceId> {
    let surface = SetupSurfaceId::ClaudeConfig;
    if requested.contains(&surface)
        && !crate::settings::surface_enabled(settings, surface)
        && crate::settings::harness_enabled(settings, crate::agent_targets::HarnessId::Claude)
        && setup_transaction::claude_settings_retiring(ws_root, home)
    {
        vec![surface]
    } else {
        Vec::new()
    }
}

/// [`gate_requested_surfaces`] plus the surfaces it drops that are retiring; an empty request is
/// every enabled surface plus the retiring ones.
fn requested_or_retiring_surfaces(
    requested: Vec<SetupSurfaceId>,
    settings: &crate::settings::AppSettings,
    ws_root: &Path,
    home: &Path,
) -> Result<Vec<SetupSurfaceId>, String> {
    let (mut surfaces, candidates) = if requested.is_empty() {
        (
            crate::settings::enabled_setup_surfaces(settings),
            SetupSurfaceId::ALL.to_vec(),
        )
    } else {
        (
            gate_requested_surfaces(requested.clone(), settings)?,
            requested,
        )
    };
    for surface in retiring_surfaces(&candidates, settings, ws_root, home) {
        if !surfaces.contains(&surface) {
            surfaces.push(surface);
        }
    }
    Ok(surfaces)
}

/// Plans exactly `surface_ids`. `plan_setup` treats an empty list as "all
/// surfaces", so an empty list returns an explicit empty plan instead.
fn plan_surfaces(
    surface_ids: Vec<SetupSurfaceId>,
    ws_root: &Path,
    home: &Path,
) -> Result<SetupPlan, String> {
    if surface_ids.is_empty() {
        return Ok(crate::setup_lifecycle::empty_plan());
    }
    // The bundle and the packs are read once for the whole preview.
    let sources = crate::skill_sources::SkillSources::for_workspace(ws_root);
    let states = surface_states(&surface_ids, ws_root, home, &sources);
    let request = SetupRequest {
        surfaces: surface_ids,
        skip_manual: true,
    };
    let mut plan = crate::setup_lifecycle::plan_setup(&request, &states);
    attach_skill_details(&mut plan, ws_root, home, sources.as_ref().ok());
    attach_workspace_details(&mut plan, ws_root, home);
    attach_rules_details(&mut plan, home);
    attach_mcp_details(&mut plan, home);
    attach_claude_settings_details(&mut plan, ws_root, home);
    attach_opencode_details(&mut plan, ws_root, home, sources.as_ref().ok());
    attach_file_count_details(&mut plan, ws_root, home, sources.as_ref().ok());
    attach_codex_profile_detail(&mut plan, ws_root, home);
    attach_plan_preview(&mut plan, ws_root, home, &sources)?;
    Ok(plan)
}

fn attach_codex_profile_detail(plan: &mut SetupPlan, workspace_root: &Path, home: &Path) {
    let Some(op) = plan.operations.iter_mut().find(|op| {
        matches!(op.surface, SetupSurfaceId::CodexConfig) && op.kind == OperationKind::Update
    }) else {
        return;
    };
    let Some(profile) = crate::artifact_registry::ArtifactId::CodexConfig
        .resolve_dest(home, workspace_root)
        .ok()
        .and_then(|path| crate::codex_config_keep::read_config_bounded(&path).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| text.parse::<toml::Value>().ok())
        .and_then(|config| crate::codex_config_keep::permission_profile(&config))
    else {
        return;
    };
    op.details.push(format!(
        "sandbox_mode left out: your Codex permission profile ({profile}) sets the sandbox"
    ));
}

/// The state of each surface, detected from one read of the sources.
fn surface_states(
    surface_ids: &[SetupSurfaceId],
    ws_root: &Path,
    home: &Path,
    sources: &Result<crate::skill_sources::SkillSources, String>,
) -> Vec<(SetupSurfaceId, OperationKind, String)> {
    surface_ids
        .iter()
        .map(|surface| match sources {
            Ok(sources) => {
                setup_transaction::detect_surface_state_with(*surface, ws_root, home, sources)
            }
            Err(message) => (
                *surface,
                OperationKind::Unavailable,
                format!("{} unavailable: {message}", surface.label()),
            ),
        })
        .collect()
}

/// The review of an MCP entry names the file it goes into: a new file, or the entry in a file the
/// user keeps their other servers in.
fn attach_mcp_details(plan: &mut SetupPlan, home: &Path) {
    for op in plan
        .operations
        .iter_mut()
        .filter(|op| matches!(op.kind, OperationKind::Create | OperationKind::Update))
    {
        let Some(harness) = op
            .surface
            .harness()
            .and_then(crate::light_harness::descriptor)
            .filter(|harness| harness.mcp.surface == op.surface)
        else {
            continue;
        };
        let mcp = &harness.mcp;
        let path = mcp.display_path(home);
        op.details.push(if op.kind == OperationKind::Create {
            format!(
                "+ {path} (new file, owner-only; adds the {} entry)",
                mcp.entry_key
            )
        } else {
            format!(
                "~ {path} (adds or updates the {} entry; your other servers stay)",
                mcp.entry_key
            )
        });
    }
}

/// The review of Claude's `settings.json` names the file and what changes in it: the attribution
/// values, and one line per override added or removed.
fn attach_claude_settings_details(plan: &mut SetupPlan, workspace_root: &Path, home: &Path) {
    let writes = |op: &PlannedOperation| {
        matches!(op.surface, SetupSurfaceId::ClaudeConfig)
            && matches!(op.kind, OperationKind::Create | OperationKind::Update)
    };
    if !plan.operations.iter().any(writes) {
        return;
    }
    let leaves = setup_transaction::plan_artifacts_for_surfaces(
        &[SetupSurfaceId::ClaudeConfig],
        workspace_root,
        home,
    )
    .ok()
    .and_then(|planned| planned.into_iter().find_map(|p| p.settings))
    .unwrap_or_default();
    for op in plan.operations.iter_mut().filter(|op| writes(op)) {
        op.details = claude_settings_lines(op.kind, &leaves);
    }
}

fn claude_settings_lines(
    kind: OperationKind,
    leaves: &crate::claude_settings::Leaves,
) -> Vec<String> {
    let mut lines = Vec::new();
    match (kind, leaves.attribution) {
        (OperationKind::Create, true) => lines.push(
            "+ ~/.claude/settings.json (new file; hides commit and PR attribution)".to_string(),
        ),
        (OperationKind::Create, false) => {
            lines.push("+ ~/.claude/settings.json (new file)".to_string())
        }
        (_, true) => lines.push(
            "~ ~/.claude/settings.json (hides commit and PR attribution; other keys stay)"
                .to_string(),
        ),
        (_, false) => {}
    }
    for (paths, note) in [(&leaves.added, "added"), (&leaves.removed, "removed")] {
        lines.extend(
            paths
                .iter()
                .map(|path| format!("~ settings.json {path} ({note})")),
        );
    }
    lines
}

/// The review of an update of the OpenCode config names every managed key the merge changes in
/// the user's `opencode.json` and `tui.json`, with the value now and the one it becomes
/// (`opencode_review`), and each other file of the surface it writes.
fn attach_opencode_details(
    plan: &mut SetupPlan,
    workspace_root: &Path,
    home: &Path,
    sources: Option<&crate::skill_sources::SkillSources>,
) {
    let surface = SetupSurfaceId::OpenCodeConfig;
    if !plan.operations.iter().any(|op| {
        matches!(op.surface, SetupSurfaceId::OpenCodeConfig) && op.kind == OperationKind::Update
    }) {
        return;
    }
    let (Some(sources), Ok(scope)) = (
        sources,
        setup_transaction::scope_for_surfaces(&[surface], home),
    ) else {
        return;
    };
    let Ok(planned) = setup_transaction::plan_artifacts_for_surfaces_with(
        &[surface],
        workspace_root,
        home,
        &scope,
        sources,
    ) else {
        return;
    };
    let details: Vec<String> = planned
        .iter()
        .flat_map(|p| {
            match (
                p.artifact.resolve_dest(home, workspace_root),
                p.artifact.resolve_source(sources),
            ) {
                (Ok(dest), Some(source)) => crate::opencode_review::artifact_lines(
                    &p.artifact,
                    p.kind,
                    &dest,
                    &source,
                    workspace_root,
                    home,
                ),
                _ => Vec::new(),
            }
        })
        .collect();
    for op in plan.operations.iter_mut().filter(|op| {
        matches!(op.surface, SetupSurfaceId::OpenCodeConfig) && op.kind == OperationKind::Update
    }) {
        op.details = details.clone();
    }
}

/// A surface that writes several files and has no review lines of its own (an agents folder, a new
/// OpenCode config) would show as one row, and the review would count it as one file. It gets a
/// line per kind and folder with the number of files, so the review's file total is the number of
/// files the apply writes. Paths and counts only.
fn attach_file_count_details(
    plan: &mut SetupPlan,
    workspace_root: &Path,
    home: &Path,
    sources: Option<&crate::skill_sources::SkillSources>,
) {
    let writes = |kind: OperationKind| {
        matches!(
            kind,
            OperationKind::Create | OperationKind::Update | OperationKind::Remove
        )
    };
    // The skills and the workspace surface write their own lines, per folder.
    let surfaces: Vec<SetupSurfaceId> = plan
        .operations
        .iter()
        .filter(|op| op.details.is_empty() && writes(op.kind))
        .map(|op| op.surface)
        .filter(|surface| {
            surface.canonical() != SetupSurfaceId::Skills
                && *surface != SetupSurfaceId::WorkspaceBundle
        })
        .collect();
    let Some(sources) = sources else {
        return;
    };
    if surfaces.is_empty() {
        return;
    }
    let Ok(planned) = setup_transaction::plan_artifacts_for_surfaces_with(
        &surfaces,
        workspace_root,
        home,
        &crate::skill_roots::SkillScope::all(),
        sources,
    ) else {
        return;
    };
    for op in plan
        .operations
        .iter_mut()
        .filter(|op| surfaces.contains(&op.surface))
    {
        let written: Option<Vec<(OperationKind, PathBuf)>> = planned
            .iter()
            .filter(|p| p.surface == op.surface && writes(p.kind))
            .map(|p| {
                let dest = p.artifact.resolve_dest(home, workspace_root).ok()?;
                Some((p.kind, dest))
            })
            .collect();
        // One file is the row the surface already has, and a file without a path leaves it too.
        if let Some(written) = written.filter(|written| written.len() > 1) {
            op.details = file_count_lines(&written, home);
        }
    }
}

/// One line per kind and folder: the file itself when the folder gets one, else the folder and
/// how many files (`+ ~/.claude/agents (5 files)`).
fn file_count_lines(written: &[(OperationKind, PathBuf)], home: &Path) -> Vec<String> {
    let mut lines = Vec::new();
    for (sign, kind) in [
        ("+", OperationKind::Create),
        ("~", OperationKind::Update),
        ("-", OperationKind::Remove),
    ] {
        let mut folders: std::collections::BTreeMap<&Path, Vec<&Path>> =
            std::collections::BTreeMap::new();
        for (_, dest) in written.iter().filter(|(k, _)| *k == kind) {
            folders
                .entry(dest.parent().unwrap_or(dest))
                .or_default()
                .push(dest);
        }
        for (folder, files) in folders {
            lines.push(match files.as_slice() {
                [only] => format!("{sign} {}", crate::skill_loads::display_path(only, home)),
                _ => format!(
                    "{sign} {} ({} files)",
                    crate::skill_loads::display_path(folder, home),
                    files.len()
                ),
            });
        }
    }
    lines
}

/// A new rules file can shadow another file its harness reads (Kilo loads one global rules file,
/// this one first): the review says so beside the file it creates.
fn attach_rules_details(plan: &mut SetupPlan, home: &Path) {
    for op in plan
        .operations
        .iter_mut()
        .filter(|op| op.kind == OperationKind::Create)
    {
        let Some((harness, rules)) = op
            .surface
            .harness()
            .and_then(crate::light_harness::descriptor)
            .and_then(|harness| harness.rules.as_ref().map(|rules| (harness, rules)))
            .filter(|(_, rules)| rules.surface == op.surface)
        else {
            continue;
        };
        if let Some(shadowed) = &rules.shadows {
            op.details.push(format!(
                "+ {} ({} stops reading {shadowed} while this file exists)",
                rules.display_path(home),
                harness.label
            ));
        }
    }
}

/// Fills the review lines of the skills surface: what is created, updated and removed in each
/// folder, and what stays because it was edited. Without them the review shows one opaque row for
/// a surface that spans several folders.
fn attach_skill_details(
    plan: &mut SetupPlan,
    workspace_root: &Path,
    home: &Path,
    sources: Option<&crate::skill_sources::SkillSources>,
) {
    let mentions_skills = plan
        .operations
        .iter()
        .any(|op| matches!(op.surface, SetupSurfaceId::Skills));
    if !mentions_skills {
        return;
    }
    let skills = [SetupSurfaceId::Skills];
    let Ok(scope) = setup_transaction::scope_for_surfaces(&skills, home) else {
        return;
    };
    let Some(sources) = sources else {
        return;
    };
    let Ok(planned) = setup_transaction::plan_artifacts_for_surfaces_with(
        &skills,
        workspace_root,
        home,
        &scope,
        sources,
    ) else {
        return;
    };
    let flagged = setup_transaction::flagged_pack_skills(sources);
    let disabled = crate::skill_sources::SourceRoot::disabled(sources)
        .cloned()
        .unwrap_or_default();
    let mut packs = setup_transaction::pack_of_skills(sources);
    // A skill that left its pack is no longer in the catalog; its removal still names the pack the
    // record lists it under.
    let removed: std::collections::BTreeSet<String> = planned
        .iter()
        .filter(|operation| operation.kind == OperationKind::Remove)
        .filter_map(|operation| operation.artifact.as_skill_file())
        .map(|file| file.skill.as_str().to_string())
        .collect();
    packs.extend(
        sources
            .recorded_packs_outside_catalog()
            .into_iter()
            .filter(|(skill, _)| removed.contains(skill)),
    );
    let (details, pack_writes) =
        setup_transaction::skill_plan_details(&planned, &scope, &flagged, &disabled, &packs);
    for op in plan
        .operations
        .iter_mut()
        .chain(plan.conflicts.iter_mut())
        .chain(plan.manual_steps.iter_mut())
        .filter(|op| matches!(op.surface, SetupSurfaceId::Skills))
    {
        op.details = details.clone();
        op.pack_writes = pack_writes.clone();
    }
}

/// Fills the review lines of the workspace surface: the old copies of the bundle it removes, per
/// folder of the workspace folder, and each copy it leaves in place. Paths only, never contents.
fn attach_workspace_details(plan: &mut SetupPlan, workspace_root: &Path, home: &Path) {
    let surface = SetupSurfaceId::WorkspaceBundle;
    if !plan
        .operations
        .iter()
        .any(|planned| planned.surface == surface)
    {
        return;
    }
    let Ok(planned) = setup_transaction::plan_artifacts_for_surfaces_in(
        &[surface],
        workspace_root,
        home,
        &crate::skill_roots::SkillScope::all(),
    ) else {
        return;
    };
    let details = workspace_plan_details(&planned);
    for op in plan
        .operations
        .iter_mut()
        .chain(plan.conflicts.iter_mut())
        .chain(plan.manual_steps.iter_mut())
        .filter(|planned| planned.surface == surface)
    {
        op.details = details.clone();
    }
}

fn workspace_plan_details(planned: &[setup_transaction::PlannedArtifact]) -> Vec<String> {
    use crate::artifact_registry::ArtifactId;
    let rel_of = |kind: OperationKind| {
        planned
            .iter()
            .filter(move |op| op.kind == kind)
            .filter_map(|op| match &op.artifact {
                ArtifactId::WorkspaceFile(rel) => Some(rel.as_str()),
                _ => None,
            })
    };
    let mut removed: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for rel in rel_of(OperationKind::Remove) {
        let place = match rel.split_once('/') {
            Some((folder, _)) => format!("{folder}/"),
            None => rel.to_string(),
        };
        *removed.entry(place).or_default() += 1;
    }
    let mut lines: Vec<String> = removed
        .into_iter()
        .map(|(place, n)| {
            format!(
                "- {place} ({n} file{}, old cop{}; backed up, z restores them)",
                if n == 1 { "" } else { "s" },
                if n == 1 { "y" } else { "ies" }
            )
        })
        .collect();
    let mut left: Vec<&str> = rel_of(OperationKind::Manual).collect();
    left.sort_unstable();
    lines.extend(
        left.into_iter()
            .map(|rel| format!("= {rel} (edited or not the app's: left in place)")),
    );
    lines
}

/// Read-only preview: detect real state for requested surfaces.
///
/// Plans every requested surface and hashes artifacts, so it runs off the
/// main thread. It takes no mutation guard; apply re-validates the fingerprint.
#[tauri::command(async)]
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

    let requested_surface_ids: Vec<SetupSurfaceId> = canonical_surfaces(
        surfaces
            .iter()
            .filter_map(|s| {
                serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(s.to_string()))
                    .ok()
            })
            .collect(),
    );
    let settings = crate::settings::load();
    let ws_root = setup_workspace_target_path().map_err(|e| format!("workspace root: {e}"))?;
    let home = crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .map_err(|e| format!("user home: {e}"))?;
    let surface_ids =
        requested_or_retiring_surfaces(requested_surface_ids, &settings, &ws_root, &home)?;
    plan_surfaces(surface_ids, &ws_root, &home)
}

#[tauri::command(async)]
pub fn apply_setup(
    surfaces: Vec<String>,
    skip_manual: bool,
    plan_fingerprint: Option<String>,
    preview_token: Option<String>,
) -> Result<SetupResult, String> {
    let _mutation = crate::mutation_lock::acquire()?;
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
    let surface_ids: Vec<SetupSurfaceId> = canonical_surfaces(
        surfaces
            .iter()
            .filter_map(|s| {
                serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(s.to_string()))
                    .ok()
            })
            .collect(),
    );

    if surface_ids.is_empty() {
        return Err("At least one surface ID is required".to_string());
    }
    let settings = crate::settings::load();
    let surface_ids = requested_or_retiring_surfaces(
        surface_ids,
        &settings,
        &setup_workspace_target_path().map_err(|e| format!("workspace root: {e}"))?,
        &user_home()?,
    )?;
    if surface_ids.is_empty() {
        // Every reviewed surface was target-disabled after the preview. The fingerprint and token
        // cannot be verified for an empty scope, so no result may claim they were.
        return Err(
            "Plan changed: every reviewed target is now disabled. Re-run preview before applying."
                .to_string(),
        );
    }

    // The first mutation takes the layout migration step before anything is read for the apply.
    let ws_root = workspace_target_for_write().map_err(|e| format!("workspace root: {e}"))?;
    let home = crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .map_err(|e| format!("user home: {e}"))?;
    reconcile_before_preview_check(&ws_root, &home)?;

    let sources = crate::skill_sources::SkillSources::for_workspace(&ws_root);
    let states = surface_states(&surface_ids, &ws_root, &home, &sources);

    let expected_fingerprint = plan_fingerprint
        .as_deref()
        .ok_or_else(|| "Plan fingerprint required. Re-run preview before applying.".to_string())?;
    if !setup_transaction::validate_fingerprint_format(expected_fingerprint) {
        return Err("Malformed plan fingerprint".to_string());
    }
    let token = preview_token
        .as_deref()
        .ok_or_else(|| "Preview token required. Re-run preview before applying.".to_string())?;
    let current_fingerprint = compute_plan_fingerprint_for_surfaces_with(
        &surface_ids,
        &ws_root,
        &home,
        sources.as_ref().map_err(Clone::clone)?,
    )?;
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
    if plan.is_blocked && !plan.has_pending_changes {
        return Err(format!(
            "Setup blocked: {} conflict(s) require review",
            plan.conflicts.len()
        ));
    }

    Ok(apply_setup_plan_with_token(
        &plan,
        Some(token),
        &mut ProgressReporter::for_task("apply_setup"),
    ))
}

pub(crate) fn apply_setup_plan_with_token(
    plan: &SetupPlan,
    preview_token: Option<&str>,
    progress: &mut ProgressReporter,
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

    let ws_root = match setup_workspace_target_path() {
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

    let mut receipt = receipt_for_artifacts(&planned);
    for surface in &plan.synced {
        if !receipt.synced.contains(surface) {
            receipt.synced.push(*surface);
        }
    }
    for operation in plan.conflicts.iter().chain(&plan.manual_steps) {
        record_receipt_item(&mut receipt, operation.surface, operation.kind);
    }
    let result = run_planned_artifacts(&planned, manual_steps, preview_token, receipt, progress);
    progress.finish();
    result
}

/// One removable or preserved item in an uninstall plan, for display.
#[derive(serde::Serialize)]
pub struct UninstallItem {
    pub label: String,
    pub path: String,
}

/// Read-only uninstall preview across all managed surfaces.
#[derive(serde::Serialize)]
pub struct UninstallPlanView {
    pub removable: Vec<UninstallItem>,
    pub preserved: Vec<UninstallItem>,
    pub merged: Vec<UninstallItem>,
    pub summary: String,
    pub plan_fingerprint: Option<String>,
    pub preview_token: Option<String>,
}

fn uninstall_item(
    artifact: &crate::artifact_registry::ArtifactId,
    ws_root: &Path,
    home: &Path,
) -> UninstallItem {
    UninstallItem {
        label: crate::installation_status::artifact_label(artifact),
        path: artifact
            .resolve_dest(home, ws_root)
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    }
}

fn uninstall_fingerprint(
    ws_root: &Path,
    home: &Path,
    plan: &setup_transaction::UninstallArtifactPlan,
) -> Result<String, String> {
    setup_transaction::compute_plan_fingerprint(ws_root, SetupSurfaceId::ALL, &plan.removals, home)
}

/// Read-only preview of a full uninstall: which installed files are proven
/// app-owned (removable), which diverged copies are preserved, and which
/// merge-managed configs are left in place.
#[tauri::command(async)]
pub fn preview_uninstall() -> Result<UninstallPlanView, String> {
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;
    let plan = setup_transaction::plan_artifacts_for_uninstall(&ws_root, &home)?;

    let removable: Vec<UninstallItem> = plan
        .removals
        .iter()
        .map(|p| uninstall_item(&p.artifact, &ws_root, &home))
        .collect();
    let preserved: Vec<UninstallItem> = plan
        .preserved
        .iter()
        .map(|a| uninstall_item(a, &ws_root, &home))
        .collect();
    let merged: Vec<UninstallItem> = plan
        .merged
        .iter()
        .map(|a| uninstall_item(a, &ws_root, &home))
        .collect();

    let summary = format!(
        "{} app-owned file(s) will be removed; {} file(s) of yours kept; {} merged config(s) left in place",
        removable.len(),
        preserved.len(),
        merged.len()
    );

    let (plan_fingerprint, preview_token) = if plan.removals.is_empty() {
        (None, None)
    } else {
        let fingerprint = uninstall_fingerprint(&ws_root, &home, &plan)?;
        let token = setup_transaction::issue_preview_token(
            &ws_root,
            &fingerprint,
            setup_transaction::PreviewPurpose::Apply,
            SetupSurfaceId::ALL,
        )?;
        (Some(fingerprint), Some(token))
    };

    Ok(UninstallPlanView {
        removable,
        preserved,
        merged,
        summary,
        plan_fingerprint,
        preview_token,
    })
}

/// Apply a previously previewed uninstall. Every removed file is backed up
/// in the transaction backup folder and the transaction is rollback-capable.
#[tauri::command(async)]
pub fn apply_uninstall(
    plan_fingerprint: Option<String>,
    preview_token: Option<String>,
) -> Result<SetupResult, String> {
    let _mutation = crate::mutation_lock::acquire()?;
    let ws_root = workspace_target_for_write()?;
    let home = user_home()?;
    reconcile_before_preview_check(&ws_root, &home)?;
    let plan = setup_transaction::plan_artifacts_for_uninstall(&ws_root, &home)?;
    if plan.removals.is_empty() {
        return Err("nothing to uninstall: no app-owned installed files found".to_string());
    }

    let expected = uninstall_fingerprint(&ws_root, &home, &plan)?;
    let provided = plan_fingerprint
        .ok_or_else(|| "uninstall requires the plan fingerprint from preview".to_string())?;
    if provided != expected {
        return Err(
            "installed files changed since preview; run the uninstall preview again".to_string(),
        );
    }
    let token = preview_token
        .ok_or_else(|| "uninstall requires the preview token from preview".to_string())?;
    setup_transaction::validate_preview_token(
        &token,
        &ws_root,
        &expected,
        setup_transaction::PreviewPurpose::Apply,
        SetupSurfaceId::ALL,
    )?;

    Ok(apply_planned_artifacts(
        &plan.removals,
        vec![],
        Some(&token),
        &mut ProgressReporter::for_task("apply_uninstall"),
    ))
}

#[tauri::command(async)]
pub fn rollback_setup_transaction(
    transaction_id: String,
    dry_run: bool,
) -> Result<SetupResult, String> {
    let _mutation = crate::mutation_lock::acquire()?;
    if !validate_transaction_id_format(&transaction_id) {
        return Err("invalid transaction_id: must be a numeric timestamp".to_string());
    }
    let mut progress = ProgressReporter::for_task("rollback_setup_transaction");
    let result = rollback_transaction(&transaction_id, dry_run, &mut progress);
    progress.finish();
    Ok(result)
}

#[cfg(test)]
#[path = "setup_tests.rs"]
mod tests;
