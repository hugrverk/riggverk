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
    self, ArtifactManifestOperation, ArtifactTransactionManifest, ARTIFACT_MANIFEST_SCHEMA_VERSION,
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
fn newer_completed_transaction(
    backup_dir: &Path,
    workspace_key: &str,
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
        }) && header.status == setup_transaction::TransactionStatus::Completed
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
fn transaction_id_is_newer(candidate: &str, base: &str) -> bool {
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

    // A newer completed transaction owns the managed state now; restoring this
    // transaction's snapshot would erase its ownership records.
    let managed_state_restore =
        match newer_completed_transaction(backup_dir, &manifest.workspace_key) {
            Ok(Some(_)) => Ok(()),
            Ok(None) => restore_previous_managed_state(manifest, backup_dir, workspace_root),
            Err(e) => Err(e),
        };
    if let Err(error) = managed_state_restore {
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
    source: &Path,
    dest: &Path,
    workspace_root: &Path,
    home: &Path,
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
    setup_transaction::ensure_rules_apply_allowed(artifact, workspace_root, home)?;
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
    let source_text = fs::read_to_string(source)
        .map_err(|e| format!("read rules source {}: {e}", source.display()))?;
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

/// Write the two attribution values into Claude's `settings.json`. Every other key keeps its
/// value and its place. A file the app does not edit (comments, a trailing comma, ...), one that
/// already says how attribution is shown, or a moved config folder (`CLAUDE_CONFIG_DIR`) is
/// refused before anything is written. A new file is owner-only (0600).
fn apply_claude_settings(dest: &Path, root: &Path) -> Result<(), String> {
    if crate::claude_settings::config_dir_override() {
        return Err(format!(
            "refusing to change settings.json: {}",
            crate::claude_settings::CONFIG_DIR_REASON
        ));
    }
    let rendered = crate::claude_settings::render_install(dest)?;
    if dest.exists() {
        crate::safe_filesystem::write_regular_file_atomic(dest, rendered.as_bytes(), root)
    } else {
        crate::safe_filesystem::write_private_regular_file_atomic(dest, rendered.as_bytes(), root)
    }
    .map_err(|e| format!("write settings.json {}: {e}", dest.display()))
}

fn apply_single_artifact(
    artifact: &crate::artifact_registry::ArtifactId,
    workspace_root: &Path,
    home: &Path,
    rules_rewrite: Option<&setup_transaction::RulesRewrite>,
    overwrite: Option<&setup_transaction::Overwrite>,
) -> Result<(), String> {
    // The attribution values of Claude's settings.json are constants of the app: no bundled source.
    if artifact == &crate::artifact_registry::ArtifactId::ClaudeSettings {
        if overwrite.is_some() || rules_rewrite.is_some() {
            return Err("settings.json is never replaced or converted".to_string());
        }
        let (dest, root) =
            setup_transaction::validate_artifact_dest(artifact, workspace_root, home)?;
        return apply_claude_settings(&dest, &root);
    }
    let (source, dest) =
        setup_transaction::validate_artifact_source_dest(artifact, workspace_root, home)?;
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
            &source,
            &dest,
            workspace_root,
            home,
            rules_rewrite,
        );
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
        let installed = if dest.is_file() {
            let content = fs::read_to_string(&dest)
                .map_err(|e| format!("read opencode config {}: {e}", dest.display()))?;
            serde_json::from_str(&content)
                .map_err(|e| format!("parse opencode config json: {e}"))?
        } else {
            serde_json::Value::Object(serde_json::Map::new())
        };
        let merged = crate::commands::merge_managed_opencode_config(
            &installed,
            &crate::commands::extract_managed_opencode_config(&rendered),
        );
        crate::safe_filesystem::write_regular_file_atomic(
            &dest,
            (serde_json::to_string_pretty(&merged)
                .map_err(|e| format!("serialize opencode config: {e}"))?
                + "\n")
                .as_bytes(),
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
        crate::safe_filesystem::copy_regular_file_no_symlinks(&source, &dest, &root)
            .map_err(|e| format!("write codex config {}: {e}", dest.display()))?;
        return Ok(());
    }

    crate::safe_filesystem::copy_regular_file_no_symlinks(&source, &dest, &root)
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
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

/// Apply artifact-level operations using artifact-owned transactions, reporting progress as it goes.
pub(super) fn apply_planned_artifacts(
    selected: &[setup_transaction::PlannedArtifact],
    manual_steps: Vec<String>,
    preview_token: Option<&str>,
    progress: &mut ProgressReporter,
) -> SetupResult {
    let result = run_planned_artifacts(selected, manual_steps, preview_token, progress);
    progress.finish();
    result
}

fn run_planned_artifacts(
    selected: &[setup_transaction::PlannedArtifact],
    mut manual_steps: Vec<String>,
    preview_token: Option<&str>,
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

    for p in &pending {
        if matches!(p.kind, OperationKind::Remove) {
            continue;
        }
        let checked = if p.artifact == crate::artifact_registry::ArtifactId::ClaudeSettings {
            setup_transaction::validate_artifact_dest(&p.artifact, &ws_root, &home).map(|_| ())
        } else {
            setup_transaction::validate_artifact_source_dest(&p.artifact, &ws_root, &home)
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

        let mutation = if matches!(p.kind, OperationKind::Remove) {
            remove_single_artifact(&p.artifact, &ws_root, &home)
        } else {
            apply_single_artifact(
                &p.artifact,
                &ws_root,
                &home,
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
        } else {
            setup_transaction::validate_artifact_after_apply(&p.artifact, &ws_root, &home)
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
        &roots.bundled_root,
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
            setup_transaction::detect_artifact_state(artifact, &ws_root, &home).0
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

    match newer_completed_transaction(&backup_dir, &manifest.workspace_key) {
        Ok(None) => {}
        Ok(Some(newer)) => {
            let message = format!(
                "cannot roll back transaction {transaction_id}: newer completed transaction {newer} exists; roll that one back first"
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
///
/// Read-only and walks the installed tree, so it runs off the main thread.
#[tauri::command(async)]
pub fn get_installation_status(
    surfaces: Vec<String>,
) -> Result<crate::installation_status::InstallationStatus, String> {
    let settings = crate::settings::load();
    let surface_ids = if surfaces.is_empty() {
        crate::settings::enabled_setup_surfaces(&settings)
    } else {
        let parsed: Vec<SetupSurfaceId> = surfaces
            .iter()
            .map(|s| {
                serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(s.to_string()))
                    .map_err(|_| format!("Unknown surface ID: {s}"))
            })
            .collect::<Result<_, _>>()?;
        gate_requested_surfaces(canonical_surfaces(parsed), &settings)?
    };
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;
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
    let states: Vec<_> = surface_ids
        .iter()
        .map(|s| detect_surface_state(*s, ws_root, home))
        .collect();
    let request = SetupRequest {
        surfaces: surface_ids,
        skip_manual: true,
    };
    let mut plan = crate::setup_lifecycle::plan_setup(&request, &states);
    attach_skill_details(&mut plan, ws_root, home);
    attach_workspace_details(&mut plan, ws_root, home);
    attach_rules_details(&mut plan, home);
    attach_mcp_details(&mut plan, home);
    attach_claude_settings_details(&mut plan);
    attach_plan_preview(&mut plan, ws_root, home)?;
    Ok(plan)
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

/// The review of Claude's attribution setting names the file and what changes in it.
fn attach_claude_settings_details(plan: &mut SetupPlan) {
    for op in plan.operations.iter_mut().filter(|op| {
        matches!(op.surface, SetupSurfaceId::ClaudeConfig)
            && matches!(op.kind, OperationKind::Create | OperationKind::Update)
    }) {
        op.details.push(if op.kind == OperationKind::Create {
            "+ ~/.claude/settings.json (new file; hides commit and PR attribution)".to_string()
        } else {
            "~ ~/.claude/settings.json (hides commit and PR attribution; other keys stay)"
                .to_string()
        });
    }
}

/// A new rules file can shadow another file its harness reads (Kilo loads one global rules file,
/// this one first): the review says so beside the file it creates.
fn attach_rules_details(plan: &mut SetupPlan, home: &Path) {
    for op in plan
        .operations
        .iter_mut()
        .filter(|op| op.kind == OperationKind::Create)
    {
        let Some(harness) = op
            .surface
            .harness()
            .and_then(crate::light_harness::descriptor)
            .filter(|harness| harness.rules.surface == op.surface)
        else {
            continue;
        };
        if let Some(shadowed) = &harness.rules.shadows {
            op.details.push(format!(
                "+ {} ({} stops reading {shadowed} while this file exists)",
                harness.rules.display_path(home),
                harness.label
            ));
        }
    }
}

/// Fills the review lines of the skills surface: what is created, updated and removed in each
/// folder, and what stays because it was edited. Without them the review shows one opaque row for
/// a surface that spans several folders.
fn attach_skill_details(plan: &mut SetupPlan, workspace_root: &Path, home: &Path) {
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
    let Ok(planned) =
        setup_transaction::plan_artifacts_for_surfaces_in(&skills, workspace_root, home, &scope)
    else {
        return;
    };
    let details = setup_transaction::skill_plan_details(&planned, &scope);
    for op in plan
        .operations
        .iter_mut()
        .chain(plan.conflicts.iter_mut())
        .chain(plan.manual_steps.iter_mut())
        .filter(|op| matches!(op.surface, SetupSurfaceId::Skills))
    {
        op.details = details.clone();
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
                "- {place} ({n} old cop{}; backed up, z restores them)",
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
    let surface_ids = if requested_surface_ids.is_empty() {
        crate::settings::enabled_setup_surfaces(&settings)
    } else {
        gate_requested_surfaces(requested_surface_ids, &settings)?
    };

    let ws_root = setup_workspace_target_path().map_err(|e| format!("workspace root: {e}"))?;
    let home = crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .map_err(|e| format!("user home: {e}"))?;
    plan_surfaces(surface_ids, &ws_root, &home)
}

#[tauri::command(async)]
pub fn apply_setup(
    surfaces: Vec<String>,
    skip_manual: bool,
    plan_fingerprint: Option<String>,
    preview_token: Option<String>,
) -> Result<SetupResult, String> {
    let _mutation = crate::mutation_lock::acquire();
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
    let surface_ids = gate_requested_surfaces(surface_ids, &settings)?;
    if surface_ids.is_empty() {
        // Every requested surface is target-disabled: nothing to apply.
        let plan = crate::setup_lifecycle::empty_plan();
        return Ok(apply_setup_plan_with_token(
            &plan,
            None,
            &mut ProgressReporter::silent(),
        ));
    }

    // The first mutation takes the layout migration step before anything is read for the apply.
    let ws_root = workspace_target_for_write().map_err(|e| format!("workspace root: {e}"))?;
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

    apply_planned_artifacts(&planned, manual_steps, preview_token, progress)
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
        "{} app-owned file(s) will be removed; {} modified file(s) preserved; {} merged config(s) left in place",
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
    let _mutation = crate::mutation_lock::acquire();
    let ws_root = workspace_target_for_write()?;
    let home = user_home()?;
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
    let _mutation = crate::mutation_lock::acquire();
    if !validate_transaction_id_format(&transaction_id) {
        return Err("invalid transaction_id: must be a numeric timestamp".to_string());
    }
    let mut progress = ProgressReporter::for_task("rollback_setup_transaction");
    let result = rollback_transaction(&transaction_id, dry_run, &mut progress);
    progress.finish();
    Ok(result)
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
        let result = apply_setup_plan_with_token(&plan, None, &mut ProgressReporter::silent());
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
        let result = apply_setup_plan_with_token(&plan, None, &mut ProgressReporter::silent());
        assert!(result.success);
        assert_eq!(result.message, "No operations to apply");
    }

    #[cfg(unix)]
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
    fn skill_update_preserves_unknown_sibling_files() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let base = std::env::temp_dir().join(format!(
            "aw-setup-skill-sibling-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("base");
        let home = base.join("home");
        let ws = base.join("workspace");
        fs::create_dir_all(&home).expect("home");
        copy_dir_all(&bundled_workspace_src(), &ws).expect("copy workspace");
        set_test_user_dirs(&home);
        let resolved_home = crate::platform_paths::resolve_user_home(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .expect("home");
        let dest = resolved_home.join(".config/opencode/skills/frontend-design/SKILL.md");
        fs::create_dir_all(dest.parent().unwrap()).expect("dest parent");
        fs::write(&dest, "managed old").expect("managed skill");
        fs::write(
            resolved_home.join(".config/opencode/skills/frontend-design/user-notes.md"),
            "keep me",
        )
        .expect("unknown sibling");
        let artifact = ArtifactId::skill_md(
            crate::skill_roots::SkillRoot::OpenCode,
            crate::artifact_registry::SkillName::new("frontend-design").unwrap(),
        );
        apply_single_artifact(&artifact, &ws, &resolved_home, None, None).expect("apply skill");
        let source = artifact
            .resolve_source(&crate::setup_roots::bundled_root().expect("bundled root"))
            .expect("skill source");
        assert_eq!(
            fs::read(&dest).unwrap(),
            fs::read(source).unwrap(),
            "managed SKILL.md must be updated to the bundled source"
        );
        assert_eq!(
            fs::read_to_string(
                resolved_home.join(".config/opencode/skills/frontend-design/user-notes.md")
            )
            .unwrap(),
            "keep me"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// A temp home and a copy of the bundled workspace. The caller holds the environment guards.
    fn overwrite_env(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "aw-setup-overwrite-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        let ws = base.join("workspace");
        fs::create_dir_all(&home).expect("home");
        copy_dir_all(&bundled_workspace_src(), &ws).expect("copy workspace");
        set_test_user_dirs(&home);
        let resolved_home = crate::platform_paths::resolve_user_home(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .expect("home");
        (base, resolved_home, ws)
    }

    fn tdd_skill() -> ArtifactId {
        ArtifactId::skill_md(
            crate::skill_roots::SkillRoot::Claude,
            crate::artifact_registry::SkillName::new("tdd").unwrap(),
        )
    }

    #[test]
    fn an_overwrite_replaces_only_the_file_the_user_reviewed() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, ws) = overwrite_env("reviewed");
        let artifact = tdd_skill();
        let dest = artifact.resolve_dest(&home, &ws).expect("dest");
        fs::create_dir_all(dest.parent().unwrap()).expect("dest parent");
        fs::write(&dest, "my own tdd\n").expect("user file");
        let reviewed = setup_transaction::Overwrite {
            expected_installed_digest: crate::stable_digest::bytes(b"my own tdd\n"),
        };

        // Edited after the preview: refused, and the edit is still there.
        fs::write(&dest, "edited after the preview\n").expect("edit");
        let error = apply_single_artifact(&artifact, &ws, &home, None, Some(&reviewed))
            .expect_err("the file changed");
        assert!(error.contains("changed since preview"), "{error}");
        assert_eq!(fs::read(&dest).unwrap(), b"edited after the preview\n");

        // As reviewed: replaced by the bundled file.
        fs::write(&dest, "my own tdd\n").expect("restore");
        apply_single_artifact(&artifact, &ws, &home, None, Some(&reviewed)).expect("overwrite");
        let source = artifact
            .resolve_source(&crate::setup_roots::bundled_root().expect("bundled root"))
            .expect("source");
        assert_eq!(fs::read(&dest).unwrap(), fs::read(source).unwrap());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn an_overwrite_refuses_a_link_and_anything_that_is_not_a_skill_or_agent_file() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, ws) = overwrite_env("refused");
        let artifact = tdd_skill();
        let dest = artifact.resolve_dest(&home, &ws).expect("dest");
        fs::create_dir_all(dest.parent().unwrap()).expect("dest parent");
        let target = base.join("precious.md");
        fs::write(&target, "my own tdd\n").expect("target");
        std::os::unix::fs::symlink(&target, &dest).expect("symlink");
        let reviewed = setup_transaction::Overwrite {
            expected_installed_digest: crate::stable_digest::bytes(b"my own tdd\n"),
        };

        // The digest matches the file behind the link; the link itself is refused all the same.
        assert!(apply_single_artifact(&artifact, &ws, &home, None, Some(&reviewed)).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"my own tdd\n");
        assert!(fs::symlink_metadata(&dest)
            .unwrap()
            .file_type()
            .is_symlink());

        // Only skill and agent files can be replaced this way, whatever the digest says.
        let rules = ArtifactId::ClaudeRules;
        let rules_dest = rules.resolve_dest(&home, &ws).expect("rules dest");
        fs::create_dir_all(rules_dest.parent().unwrap()).expect("rules parent");
        fs::write(&rules_dest, "my own rules\n").expect("rules file");
        let rules_reviewed = setup_transaction::Overwrite {
            expected_installed_digest: crate::stable_digest::bytes(b"my own rules\n"),
        };
        let error = apply_single_artifact(&rules, &ws, &home, None, Some(&rules_reviewed))
            .expect_err("not a skill or agent file");
        assert!(error.contains("only a skill or agent file"), "{error}");
        assert_eq!(fs::read(&rules_dest).unwrap(), b"my own rules\n");

        // And never together with a conversion.
        let rewrite = setup_transaction::RulesRewrite {
            content: "converted\n".to_string(),
            expected_installed_digest: crate::stable_digest::bytes(b"my own rules\n"),
        };
        assert!(
            apply_single_artifact(&rules, &ws, &home, Some(&rewrite), Some(&rules_reviewed))
                .is_err()
        );
        assert_eq!(fs::read(&rules_dest).unwrap(), b"my own rules\n");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn codex_artifacts_apply_and_remove_under_codex_home_outside_home() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let base = std::env::temp_dir().join(format!(
            "aw-setup-codex-home-outside-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        let ws = base.join("workspace");
        let codex = base.join("elsewhere/codex");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&codex).expect("codex home");
        copy_dir_all(&bundled_workspace_src(), &ws).expect("copy workspace");
        set_test_user_dirs(&home);
        std::env::remove_var("CODEX_SKILLS_PATH");
        std::env::set_var("CODEX_HOME", &codex);

        let agent = crate::artifact_registry::AgentName::new("inspector").unwrap();
        let cases = [
            (ArtifactId::CodexRules, "AGENTS.md"),
            (ArtifactId::CodexConfig, "config.toml"),
            (ArtifactId::CodexAgent(agent), "agents/inspector.toml"),
        ];
        let planned = setup_transaction::plan_artifacts_for_surfaces(
            &[
                SetupSurfaceId::CodexRules,
                SetupSurfaceId::CodexConfig,
                SetupSurfaceId::CodexAgents,
            ],
            &ws,
            &home,
        )
        .expect("preview under CODEX_HOME outside home");
        assert!(
            planned
                .iter()
                .all(|p| p.kind == crate::setup_lifecycle::OperationKind::Create),
            "{:?}",
            planned
                .iter()
                .map(|p| (&p.artifact, p.kind))
                .collect::<Vec<_>>()
        );
        for (artifact, rel) in &cases {
            apply_single_artifact(artifact, &ws, &home, None, None)
                .unwrap_or_else(|e| panic!("apply {artifact:?}: {e}"));
            assert!(codex.join(rel).is_file(), "{artifact:?} not written");
            // A second apply replaces the installed file.
            apply_single_artifact(artifact, &ws, &home, None, None)
                .unwrap_or_else(|e| panic!("re-apply {artifact:?}: {e}"));
        }
        assert!(!home.join(".codex").exists());
        for (artifact, rel) in &cases {
            remove_single_artifact(artifact, &ws, &home)
                .unwrap_or_else(|e| panic!("remove {artifact:?}: {e}"));
            assert!(!codex.join(rel).exists(), "{artifact:?} not removed");
        }
        let _ = fs::remove_dir_all(&base);
    }

    fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
        if !dst.exists() {
            fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
        }
        for entry in fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
            let entry = entry.map_err(|e| format!("entry: {e}"))?;
            let ft = entry.file_type().map_err(|e| format!("type: {e}"))?;
            if ft.is_symlink() {
                return Err(format!("refusing symlink {}", entry.path().display()));
            }
            let target = dst.join(entry.file_name());
            if ft.is_dir() {
                copy_dir_all(&entry.path(), &target)?;
            } else if ft.is_file() {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
                }
                fs::copy(entry.path(), &target)
                    .map_err(|e| format!("copy {}: {e}", entry.path().display()))?;
            }
        }
        Ok(())
    }

    fn bundled_workspace_src() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
    }

    #[test]
    fn rollback_rejects_empty_transaction_id() {
        let result = rollback_transaction("", false, &mut ProgressReporter::silent());
        assert!(!result.success);
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_remove_rejects_symlinked_parent() {
        let _env = crate::test_env::guard::default_xdg_config_home();
        // Remove rejects when the destination's parent chain contains a symlink.
        // Test with a non-workspace artifact (home-based).
        let base = std::env::temp_dir().join(format!(
            "aw-setup-remove-sym-parent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("base");
        let real_config = base.join("real-config");
        fs::create_dir_all(real_config.join("opencode")).unwrap();
        fs::write(real_config.join("opencode/AGENTS.md"), "managed").unwrap();
        // Home/.config is a symlink so the dest path goes through it
        let config_link = base.join(".config");
        std::os::unix::fs::symlink(&real_config, &config_link).unwrap();
        let artifact = ArtifactId::OpenCodeRules;
        // home = base, so dest = base/.config/opencode/AGENTS.md
        let err = remove_single_artifact(&artifact, &base, &base)
            .expect_err("symlinked parent removal must be rejected");
        assert!(err.contains("symlink") || err.contains("parent"), "{err}");
        assert!(real_config.join("opencode/AGENTS.md").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_apply_rejects_symlinked_parent() {
        let _env = crate::test_env::guard::default_xdg_config_home();
        // Apply rejects when the destination's parent chain contains a symlink.
        let base = std::env::temp_dir().join(format!(
            "aw-setup-apply-sym-parent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("base");
        let real_config = base.join("real-config");
        fs::create_dir_all(real_config.join("opencode")).unwrap();
        // Home/.config is a symlink so the dest path goes through it
        let config_link = base.join(".config");
        std::os::unix::fs::symlink(&real_config, &config_link).unwrap();
        // No need to create source - validate_artifact_source_dest will reject first
        let artifact = ArtifactId::OpenCodeRules;
        let err = apply_single_artifact(&artifact, &base, &base, None, None)
            .expect_err("symlinked parent apply must be rejected");
        assert!(err.contains("symlink") || err.contains("parent"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_apply_rejects_dangling_destination_symlink() {
        let _env = crate::test_env::guard::default_xdg_config_home();
        let base = std::env::temp_dir().join(format!(
            "aw-setup-apply-dangling-dest-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("base");
        fs::create_dir_all(base.join("templates").join("sync")).unwrap();
        fs::write(base.join("templates/sync/opencode-rules.md"), "source").unwrap();
        fs::create_dir_all(base.join(".config").join("opencode")).unwrap();
        std::os::unix::fs::symlink(
            base.join("missing"),
            base.join(".config/opencode/AGENTS.md"),
        )
        .unwrap();
        let artifact = ArtifactId::OpenCodeRules;
        let err = apply_single_artifact(&artifact, &base, &base, None, None)
            .expect_err("dangling destination must be rejected");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rollback_nonexistent_transaction() {
        let result = rollback_transaction(
            "1234567890123456789",
            false,
            &mut ProgressReporter::silent(),
        );
        assert!(!result.success);
        assert!(
            result.message.contains("not found") || result.message.contains("Transaction backup")
        );
    }

    #[test]
    fn setup_backup_dir_creates_missing_parent_chain() {
        let _guard = guard::lock();
        let home = std::env::temp_dir().join("aw-setup-backup-chain");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            // Several missing levels below an existing root, like a fresh
            // install where the app-data dir has never been created.
            std::env::set_var(
                "RIGGVERK_BACKUP_DIR",
                home.join("Library/Application Support/se.hugrverk.riggverk/backups")
                    .to_string_lossy()
                    .as_ref(),
            );
        }

        let dir = setup_backup_dir("txn-chain-test").expect("backup dir despite missing parents");
        assert!(dir.is_dir(), "transaction backup dir should exist");
        assert!(dir.ends_with("setup/txn-chain-test"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn rollback_dry_run_leaves_a_real_transaction_untouched() {
        let env = TempSetupEnv::new("dry-run-real");
        let applied = apply_planned_artifacts(
            &env.plan(&[SetupSurfaceId::CodexRules]),
            vec![],
            None,
            &mut ProgressReporter::silent(),
        );
        assert!(applied.success, "{}", applied.message);
        let codex = env.home.join(".codex/AGENTS.md");
        assert!(codex.is_file());
        let manifest_path = env
            .setup_root()
            .join(&applied.transaction_id)
            .join("manifest.json");
        let manifest_before = fs::read(&manifest_path).unwrap();

        let dry = rollback_transaction(
            &applied.transaction_id,
            true,
            &mut ProgressReporter::silent(),
        );
        assert!(dry.success, "{}", dry.message);
        assert_eq!(dry.applied.len(), 1, "dry run lists what would be restored");
        assert!(dry.applied[0].contains("CodexRules"), "{:?}", dry.applied);
        assert!(codex.is_file(), "dry run must not remove the created file");
        assert_eq!(
            fs::read(&manifest_path).unwrap(),
            manifest_before,
            "dry run must not write the manifest"
        );

        let real = rollback_transaction(
            &applied.transaction_id,
            false,
            &mut ProgressReporter::silent(),
        );
        assert!(real.success, "{}", real.message);
        assert!(!codex.exists(), "real rollback removes the created file");
    }

    #[test]
    fn apply_and_rollback_report_progress_without_changing_the_result() {
        use crate::apply_progress::{ApplyPhase, ApplyProgress};
        let env = TempSetupEnv::new("progress");
        let surfaces = [SetupSurfaceId::CodexRules, SetupSurfaceId::OpenCodeRules];
        let (mut progress, events) = ProgressReporter::collecting("apply_setup");

        let applied = apply_planned_artifacts(&env.plan(&surfaces), vec![], None, &mut progress);

        assert!(applied.success, "{}", applied.message);
        assert_eq!(applied.applied.len(), 2);
        let events = events.snapshot();
        let first = events.first().expect("events");
        assert_eq!(
            (first.phase, first.done, first.total),
            (ApplyPhase::Backup, 0, Some(2))
        );
        let last = events.last().unwrap();
        assert_eq!(
            (last.phase, last.done, last.total, last.file.as_deref()),
            (ApplyPhase::Done, 2, Some(2), None)
        );
        let before_done = &events[events.len() - 2];
        assert_eq!(
            (before_done.phase, before_done.done, before_done.total),
            (ApplyPhase::Apply, 2, Some(2))
        );
        assert!(events
            .iter()
            .any(|e| e.phase == ApplyPhase::Apply && e.done == 0));
        // Phases only move forward and counts never go back within one.
        let rank = |e: &ApplyProgress| e.phase as u8;
        assert!(events
            .windows(2)
            .all(|pair| rank(&pair[0]) <= rank(&pair[1])
                && (pair[0].phase != pair[1].phase || pair[0].done <= pair[1].done)));
        // Only `~/...` display paths, never an absolute or temp path.
        let base = env.base.to_string_lossy().into_owned();
        for event in &events {
            assert_eq!(event.task, "apply_setup");
            if let Some(file) = &event.file {
                assert!(file.starts_with("~/"), "{file}");
                assert!(!file.contains(&base), "{file}");
            }
        }

        let (mut rollback_progress, rollback_events) =
            ProgressReporter::collecting("rollback_setup_transaction");
        let rolled = rollback_transaction(&applied.transaction_id, false, &mut rollback_progress);
        rollback_progress.finish();
        assert!(rolled.success, "{}", rolled.message);
        let rollback_events = rollback_events.snapshot();
        assert!(rollback_events
            .iter()
            .all(|e| e.phase != ApplyPhase::Backup));
        let first = rollback_events.first().expect("rollback events");
        assert_eq!(
            (first.phase, first.done, first.total),
            (ApplyPhase::Apply, 0, Some(2))
        );
        let last = rollback_events.last().unwrap();
        assert_eq!(
            (last.phase, last.done, last.total),
            (ApplyPhase::Done, 2, Some(2))
        );
    }

    #[test]
    fn apply_works_when_nobody_listens() {
        // No app handle is registered under test, like a webview that never subscribed.
        let env = TempSetupEnv::new("progress-no-listener");
        let applied = apply_planned_artifacts(
            &env.plan(&[SetupSurfaceId::CodexRules]),
            vec![],
            None,
            &mut ProgressReporter::for_task("apply_setup"),
        );
        assert!(applied.success, "{}", applied.message);
        assert!(env.home.join(".codex/AGENTS.md").is_file());
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
        let result = rollback_transaction("../evil", false, &mut ProgressReporter::silent());
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
    fn detect_skills_create_when_missing() {
        let home = std::env::temp_dir().join("aw-detect-cl-skills-create");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create dir");

        let ws = std::env::temp_dir().join("aw-detect-cl-skills-runtime");
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(&ws).expect("create runtime");

        let (_surface, kind, _summary) = detect_surface_state(SetupSurfaceId::Skills, &ws, &home);
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

    // ── Preview integrity tests ──

    #[test]
    fn plan_fingerprint_is_stable_for_same_surface_set() {
        setup_transaction::clear_preview_tokens_for_test();
        let ws = std::env::temp_dir().join("aw-fingerprint-stable-runtime");
        let home = std::env::temp_dir().join("aw-fingerprint-stable-home");
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&ws).expect("runtime");
        fs::create_dir_all(&home).expect("home");
        let surfaces = vec![SetupSurfaceId::OpenCodeRules, SetupSurfaceId::CodexRules];
        let fp1 = compute_plan_fingerprint_for_surfaces(&surfaces, &ws, &home).expect("fp1");
        let fp2 = compute_plan_fingerprint_for_surfaces(&surfaces, &ws, &home).expect("fp2");
        assert_eq!(fp1, fp2);
        assert!(setup_transaction::validate_fingerprint_format(&fp1));
    }

    #[test]
    fn plan_fingerprint_changes_when_surfaces_differ() {
        let ws = std::env::temp_dir().join("aw-fingerprint-different-runtime");
        let home = std::env::temp_dir().join("aw-fingerprint-different-home");
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&ws).expect("runtime");
        fs::create_dir_all(&home).expect("home");
        let fp1 =
            compute_plan_fingerprint_for_surfaces(&[SetupSurfaceId::OpenCodeRules], &ws, &home)
                .expect("fp1");
        let fp2 = compute_plan_fingerprint_for_surfaces(&[SetupSurfaceId::CodexRules], &ws, &home)
            .expect("fp2");
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn apply_rejects_missing_preview_token() {
        // Hermetic user dirs: operator settings must not decide surface enablement here.
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let home = std::env::temp_dir().join("aw-apply-token-home");
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("home");
        set_test_user_dirs(&home);
        let result = apply_setup(
            vec!["open_code_rules".to_string()],
            false,
            Some("abc123".to_string()),
            None,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Preview token required"));
        let _ = fs::remove_dir_all(&home);
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
            previous_managed_state_present: false,
            previous_managed_state_trusted: false,
            previous_managed_state_digest: None,
            previous_managed_state_backup_rel: None,
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
        let result = apply_setup_plan_with_token(&plan, None, &mut ProgressReporter::silent());
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
        // A workspace folder of its own: the rollback writes state into it, and the bundle is
        // read-only source.
        let ws = base.join("workspace");
        fs::create_dir_all(&ws).unwrap();
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
            std::env::set_var(
                "RIGGVERK_WORKSPACE_PATH",
                ws_canon.to_string_lossy().as_ref(),
            );
            std::env::set_var(
                "RIGGVERK_BACKUP_DIR",
                backup_root.to_string_lossy().as_ref(),
            );
        }
        let txn_id = "9876543210987654321".to_string();
        (base, resolved_home, ws_canon, txn_id)
    }

    fn seed_two_artifact_transaction(txn_id: &str) -> PathBuf {
        let home = user_home().expect("home for rollback seed");
        let ws_root = setup_workspace_target_path().expect("workspace for rollback seed");
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
            previous_managed_state_present: false,
            previous_managed_state_trusted: false,
            previous_managed_state_digest: None,
            previous_managed_state_backup_rel: None,
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
        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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
        let ws = setup_workspace_target_path().unwrap();
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
    fn interrupted_failed_transaction_is_reconciled_before_next_apply() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, ws, txn_id) = rollback_test_fixture();
        seed_two_artifact_transaction(&txn_id);

        reconcile_interrupted_setup_transactions(&ws, &home).expect("reconcile transaction");

        let manifest = read_manifest(&txn_id);
        assert_eq!(
            manifest.transaction_status,
            setup_transaction::TransactionStatus::RolledBack
        );
        assert!(manifest
            .operations
            .iter()
            .all(|op| op.rollback_status == setup_transaction::RollbackStatus::Restored));
        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            "codex-rules-backup"
        );
        assert_eq!(
            fs::read_to_string(home.join(".config/opencode/AGENTS.md")).unwrap(),
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

        let dry = rollback_transaction(&txn_id, true, &mut ProgressReporter::silent());
        assert!(dry.success);
        assert_eq!(dry.applied.len(), 1);
        assert!(dry.applied[0].contains("OpenCodeRules"));
        assert!(dry.rolled_back.iter().any(|l| l.contains("CodexRules")));

        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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
        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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

        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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
        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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
        let dry = rollback_transaction(&txn_id, true, &mut ProgressReporter::silent());
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

        let dry = rollback_transaction(&txn_id, true, &mut ProgressReporter::silent());
        assert!(dry.success);
        assert!(dry.rolled_back.iter().any(|l| l.contains("CodexRules")));
        assert_eq!(dry.applied.len(), 1);

        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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

        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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

        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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

        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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

        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
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

        let dry = rollback_transaction(&txn_id, true, &mut ProgressReporter::silent());
        assert!(dry.success);
        assert!(dry.rolled_back.iter().any(|l| l.contains("CodexRules")));
        let after_raw = fs::read_to_string(backup_dir.join("manifest.json")).unwrap();
        assert_eq!(before_raw, after_raw);
        let _ = fs::remove_dir_all(&base);
    }

    // ── Reconciliation safety ──

    /// Hermetic HOME, runtime workspace, and backup root for tests that run
    /// real transactions. Holds the process-wide env lock for its lifetime.
    struct TempSetupEnv {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        _restore: guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl TempSetupEnv {
        fn new(label: &str) -> Self {
            let lock = guard::lock();
            let restore = guard::EnvRestore::capture();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-setup-{label}-{nanos}"));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(base.join("home")).expect("home");
            set_test_user_dirs(&base.join("home"));
            unsafe {
                std::env::set_var(
                    "RIGGVERK_WORKSPACE_PATH",
                    base.join("workspace").to_string_lossy().as_ref(),
                );
                std::env::set_var(
                    "RIGGVERK_BACKUP_DIR",
                    base.join("backups").to_string_lossy().as_ref(),
                );
            }
            let home = user_home().expect("resolved home");
            let ws = setup_workspace_target_path().expect("workspace target");
            Self {
                base,
                home,
                ws,
                _restore: restore,
                _lock: lock,
            }
        }

        fn setup_root(&self) -> PathBuf {
            backup_root().expect("backup root").join("setup")
        }

        fn plan(&self, surfaces: &[SetupSurfaceId]) -> Vec<setup_transaction::PlannedArtifact> {
            setup_transaction::plan_artifacts_for_surfaces(surfaces, &self.ws, &self.home)
                .expect("plan")
        }
    }

    impl Drop for TempSetupEnv {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn write_raw_manifest(setup_root: &Path, transaction_id: &str, manifest: serde_json::Value) {
        let dir = setup_root.join(transaction_id);
        fs::create_dir_all(&dir).expect("transaction dir");
        fs::write(dir.join("manifest.json"), manifest.to_string()).expect("raw manifest");
    }

    #[test]
    fn reconcile_skips_unreadable_terminal_manifests_and_apply_still_succeeds() {
        let env = TempSetupEnv::new("reconcile-terminal");
        let setup_root = env.setup_root();
        let key = env.ws.to_string_lossy().into_owned();
        // An old-schema completed manifest and a rolled-back one with damaged
        // operations: both are finished transactions.
        write_raw_manifest(
            &setup_root,
            "1000",
            serde_json::json!({
                "schema_version": 1, "workspace_key": key,
                "transaction_status": "completed", "operations": []
            }),
        );
        write_raw_manifest(
            &setup_root,
            "1001",
            serde_json::json!({
                "schema_version": 5, "workspace_key": key,
                "transaction_status": "rolled_back", "operations": [{"bogus": true}]
            }),
        );
        reconcile_interrupted_setup_transactions(&env.ws, &env.home)
            .expect("finished transactions must not block reconciliation");

        // An unreadable transaction that may be half-applied still blocks, and
        // the error names it.
        write_raw_manifest(
            &setup_root,
            "1002",
            serde_json::json!({
                "schema_version": 1, "workspace_key": key,
                "transaction_status": "failed", "operations": []
            }),
        );
        let err = reconcile_interrupted_setup_transactions(&env.ws, &env.home)
            .expect_err("unreadable interrupted transaction must block");
        assert!(
            err.contains("1002"),
            "error must name the transaction: {err}"
        );
        fs::remove_dir_all(setup_root.join("1002")).expect("remove blocking transaction");

        let planned = env.plan(&[SetupSurfaceId::CodexRules]);
        let result =
            apply_planned_artifacts(&planned, vec![], None, &mut ProgressReporter::silent());
        assert!(result.success, "apply: {}", result.message);
        assert!(env.home.join(".codex/AGENTS.md").is_file());
    }

    #[test]
    fn reconcile_preserves_user_edit_made_after_interrupted_apply() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, ws, txn_id) = rollback_test_fixture();
        seed_two_artifact_transaction(&txn_id);
        // The user edits one applied artifact before the next app launch.
        fs::write(home.join(".codex/AGENTS.md"), "user-edit-after-crash").unwrap();

        reconcile_interrupted_setup_transactions(&ws, &home)
            .expect("a preserved user edit must not block setup");
        // A second pass stays non-blocking and still preserves the edit.
        reconcile_interrupted_setup_transactions(&ws, &home).expect("second reconcile");

        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            "user-edit-after-crash"
        );
        assert_eq!(
            fs::read_to_string(home.join(".config/opencode/AGENTS.md")).unwrap(),
            "opencode-rules-backup",
            "untouched artifact is still restored"
        );
        let manifest = read_manifest(&txn_id);
        assert_eq!(
            manifest.operations[0].rollback_status,
            setup_transaction::RollbackStatus::Failed
        );
        assert_eq!(
            manifest.operations[1].rollback_status,
            setup_transaction::RollbackStatus::Restored
        );
        assert_eq!(
            manifest.transaction_status,
            setup_transaction::TransactionStatus::RollbackFailed
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// Marks a seeded transaction as completed, keeping only operations on `artifacts`.
    fn complete_seeded_transaction_for(txn_id: &str, artifacts: &[ArtifactId]) {
        let backup_dir = backup_root().unwrap().join("setup").join(txn_id);
        let mut manifest = read_manifest(txn_id);
        manifest.transaction_status = setup_transaction::TransactionStatus::Completed;
        manifest
            .operations
            .retain(|op| artifacts.contains(&op.artifact));
        manifest.surface_ids = manifest.operations.iter().map(|op| op.surface).collect();
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();
    }

    #[test]
    fn reconcile_does_not_rerun_a_rollback_failed_transaction_over_newer_state() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, ws, older) = rollback_test_fixture();
        let newer = "9876543210987654322";
        seed_two_artifact_transaction(&older);
        // The interrupted transaction keeps the user's edit and ends rollback-failed.
        fs::write(home.join(".codex/AGENTS.md"), "user-edit-after-crash").unwrap();
        reconcile_interrupted_setup_transactions(&ws, &home).expect("first reconcile");
        assert_eq!(
            read_manifest(&older).transaction_status,
            setup_transaction::TransactionStatus::RollbackFailed
        );

        // A newer apply installs the same managed content over it and completes.
        fs::write(home.join(".codex/AGENTS.md"), "codex-applied").unwrap();
        seed_two_artifact_transaction(newer);
        complete_seeded_transaction_for(newer, &[ArtifactId::CodexRules]);

        let notes = reconcile_interrupted_setup_transactions(&ws, &home).expect("second reconcile");

        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            "codex-applied",
            "the older backup must not be restored over the newer install"
        );
        assert_eq!(
            read_manifest(&older).transaction_status,
            setup_transaction::TransactionStatus::RollbackFailed
        );
        assert!(
            notes.iter().any(|note| note.contains(&older)),
            "the unresolved transaction must be surfaced: {notes:?}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn reconcile_skips_artifacts_a_newer_completed_transaction_wrote() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, ws, older) = rollback_test_fixture();
        let newer = "9876543210987654322";
        seed_two_artifact_transaction(&older);
        seed_two_artifact_transaction(newer);
        // The newer transaction only wrote the Codex rules.
        complete_seeded_transaction_for(newer, &[ArtifactId::CodexRules]);

        reconcile_interrupted_setup_transactions(&ws, &home).expect("reconcile");

        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            "codex-applied",
            "an artifact the newer transaction wrote keeps its content"
        );
        assert_eq!(
            fs::read_to_string(home.join(".config/opencode/AGENTS.md")).unwrap(),
            "opencode-rules-backup",
            "an artifact only the older transaction wrote is still restored"
        );
        let manifest = read_manifest(&older);
        assert_eq!(
            manifest.transaction_status,
            setup_transaction::TransactionStatus::RollbackFailed
        );
        assert_eq!(
            manifest.operations[0].rollback_status,
            setup_transaction::RollbackStatus::Failed
        );
        assert_eq!(
            manifest.operations[1].rollback_status,
            setup_transaction::RollbackStatus::Restored
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn reconcile_keeps_managed_state_owned_by_a_newer_completed_transaction() {
        let env = TempSetupEnv::new("reconcile-newer");
        fs::create_dir_all(env.home.join(".codex")).unwrap();
        fs::create_dir_all(env.home.join(".config/opencode")).unwrap();
        fs::write(env.home.join(".codex/AGENTS.md"), "codex-applied").unwrap();
        fs::write(
            env.home.join(".config/opencode/AGENTS.md"),
            "opencode-applied",
        )
        .unwrap();
        let older = "9876543210987654321";
        let newer = "9876543210987654322";
        seed_two_artifact_transaction(older);
        seed_two_artifact_transaction(newer);
        // The newer transaction wrote no artifact the older one covers, so the older one is
        // still rolled back; it only owns the managed state.
        complete_seeded_transaction_for(newer, &[]);
        // The newer transaction published this managed state.
        let state = crate::managed_state::ManagedState {
            schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: crate::stable_digest::bytes(b"bundle"),
            artifacts: vec![],
        };
        crate::managed_state::write_managed_state_atomic(&env.ws, &state).unwrap();

        reconcile_interrupted_setup_transactions(&env.ws, &env.home).expect("reconcile");

        assert_eq!(
            crate::managed_state::read_managed_state(&env.ws),
            Some(state),
            "older rollback must not erase the newer transaction's managed state"
        );
        assert_eq!(
            read_manifest(older).transaction_status,
            setup_transaction::TransactionStatus::RolledBack
        );
    }

    #[test]
    fn explicit_rollback_refuses_when_a_newer_completed_transaction_exists() {
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let (base, home, _ws, older) = rollback_test_fixture();
        let newer = "9876543210987654322";
        seed_two_artifact_transaction(&older);
        let backup_dir = seed_two_artifact_transaction(newer);
        let mut manifest = read_manifest(newer);
        manifest.transaction_status = setup_transaction::TransactionStatus::Completed;
        setup_transaction::persist_manifest_atomic(
            &backup_dir.join("manifest.json"),
            &manifest,
            &backup_dir,
        )
        .unwrap();

        for dry_run in [true, false] {
            let result = rollback_transaction(&older, dry_run, &mut ProgressReporter::silent());
            assert!(!result.success, "dry_run={dry_run}");
            assert!(
                result.message.contains("newer completed transaction")
                    && result.message.contains(newer),
                "unclear refusal: {}",
                result.message
            );
        }
        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            "codex-applied"
        );
        assert_eq!(
            read_manifest(&older).transaction_status,
            setup_transaction::TransactionStatus::Failed,
            "refused rollback must not touch the older manifest"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn transaction_ids_compare_numerically() {
        assert!(transaction_id_is_newer("10", "9"));
        assert!(!transaction_id_is_newer("9", "10"));
        assert!(!transaction_id_is_newer("0005", "5"));
        assert!(transaction_id_is_newer(
            "1788000000000000001",
            "1788000000000000000"
        ));
    }

    #[test]
    fn apply_refreshes_stale_record_of_unchanged_artifact_outside_the_selection() {
        let env = TempSetupEnv::new("refresh-stale");
        let first = apply_planned_artifacts(
            &env.plan(&[SetupSurfaceId::CodexRules]),
            vec![],
            None,
            &mut ProgressReporter::silent(),
        );
        assert!(first.success, "{}", first.message);
        let codex = ArtifactId::CodexRules;
        let identity = crate::managed_state::artifact_identity(&codex);
        let installed = fs::read(env.home.join(".codex/AGENTS.md")).unwrap();

        // The record drifts, e.g. the file was synced by the legacy script.
        let mut state = crate::managed_state::read_managed_state(&env.ws).expect("state");
        for record in state
            .artifacts
            .iter_mut()
            .filter(|r| r.identity == identity)
        {
            record.hash = crate::stable_digest::bytes(b"older shipped version");
        }
        crate::managed_state::write_managed_state_atomic(&env.ws, &state).unwrap();
        let planned = env.plan(&[SetupSurfaceId::CodexRules]);
        assert_eq!(planned[0].kind, OperationKind::NoChange);

        // Any later apply, even of another surface, refreshes it.
        let second = apply_planned_artifacts(
            &env.plan(&[SetupSurfaceId::OpenCodeRules]),
            vec![],
            None,
            &mut ProgressReporter::silent(),
        );
        assert!(second.success, "{}", second.message);
        let state = crate::managed_state::read_managed_state(&env.ws).expect("state");
        let record = state
            .artifacts
            .iter()
            .find(|r| r.identity == identity)
            .expect("codex record");
        assert_eq!(
            record.hash,
            crate::rules_block::installed_managed_digest(&installed)
        );
    }

    #[cfg(unix)]
    #[test]
    fn setup_transaction_backups_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let mode_of = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let env = TempSetupEnv::new("private-backups");
        let first = apply_planned_artifacts(
            &env.plan(&[SetupSurfaceId::CodexRules]),
            vec![],
            None,
            &mut ProgressReporter::silent(),
        );
        assert!(first.success, "{}", first.message);

        // Age the installed file so the next apply backs it up before replacing it.
        let dest = env.home.join(".codex/AGENTS.md");
        fs::write(&dest, "older-codex").unwrap();
        let mut state = crate::managed_state::read_managed_state(&env.ws).expect("state");
        for record in state.artifacts.iter_mut() {
            record.hash = crate::stable_digest::bytes(b"older-codex");
        }
        crate::managed_state::write_managed_state_atomic(&env.ws, &state).unwrap();
        let second = apply_planned_artifacts(
            &env.plan(&[SetupSurfaceId::CodexRules]),
            vec![],
            None,
            &mut ProgressReporter::silent(),
        );
        assert!(second.success, "{}", second.message);

        let txn_dir = env.setup_root().join(&second.transaction_id);
        assert_eq!(mode_of(&txn_dir), 0o700);
        assert_eq!(mode_of(&txn_dir.join("manifest.json")), 0o600);
        assert_eq!(mode_of(&txn_dir.join("artifacts")), 0o700);
        let backup = fs::read_dir(txn_dir.join("artifacts"))
            .unwrap()
            .next()
            .expect("artifact backup")
            .unwrap()
            .path();
        assert_eq!(mode_of(&backup), 0o600);
        assert_eq!(fs::read_to_string(&backup).unwrap(), "older-codex");
    }

    // ── Failure injection and removal safety ──

    /// Restores permissions on drop so a failed assertion cannot leave an
    /// undeletable directory behind.
    #[cfg(unix)]
    struct PermissionGuard {
        path: PathBuf,
        mode: u32,
    }

    #[cfg(unix)]
    impl Drop for PermissionGuard {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode));
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_apply_rolls_back_completed_artifacts_and_restores_state() {
        use std::os::unix::fs::PermissionsExt;
        let env = TempSetupEnv::new("auto-rollback");
        let codex_dest = env.home.join(".codex/AGENTS.md");
        let opencode_dest = env.home.join(".config/opencode/AGENTS.md");
        let surfaces = [SetupSurfaceId::CodexRules, SetupSurfaceId::OpenCodeRules];

        // Install both, then age them: installed content differs from the
        // source but matches the managed record, so the next plan updates both.
        let first = apply_planned_artifacts(
            &env.plan(&surfaces),
            vec![],
            None,
            &mut ProgressReporter::silent(),
        );
        assert!(first.success, "{}", first.message);
        fs::write(&codex_dest, "old-codex").unwrap();
        fs::write(&opencode_dest, "old-opencode").unwrap();
        let mut state = crate::managed_state::read_managed_state(&env.ws).expect("state");
        for record in state.artifacts.iter_mut() {
            let old = if record.identity
                == crate::managed_state::artifact_identity(&ArtifactId::CodexRules)
            {
                b"old-codex".as_slice()
            } else {
                b"old-opencode".as_slice()
            };
            record.hash = crate::stable_digest::bytes(old);
        }
        crate::managed_state::write_managed_state_atomic(&env.ws, &state).unwrap();
        let state_before = fs::read(crate::managed_state::managed_state_path(&env.ws)).unwrap();
        let planned = env.plan(&surfaces);
        assert!(
            planned.iter().all(|p| p.kind == OperationKind::Update),
            "{planned:?}"
        );

        // The second artifact cannot be written: its directory is read-only.
        let opencode_dir = opencode_dest.parent().unwrap().to_path_buf();
        fs::set_permissions(&opencode_dir, fs::Permissions::from_mode(0o555)).unwrap();
        let _restore_permissions = PermissionGuard {
            path: opencode_dir.clone(),
            mode: 0o755,
        };
        if fs::write(opencode_dir.join(".probe"), "x").is_ok() {
            return; // permissions are not enforced (running as root)
        }

        let (mut progress, events) = ProgressReporter::collecting("apply_setup");
        let result = apply_planned_artifacts(&planned, vec![], None, &mut progress);

        assert!(!result.success, "second artifact must fail the apply");
        let events = events.snapshot();
        let last = events.last().expect("progress events");
        assert_eq!(
            (last.phase, last.done, last.total),
            (crate::apply_progress::ApplyPhase::Done, 1, Some(2)),
            "a failed apply still ends the stream, short of the total"
        );
        assert!(
            result
                .rolled_back
                .iter()
                .any(|label| label.contains("CodexRules")),
            "first artifact must be rolled back: {result:?}"
        );
        assert_eq!(fs::read_to_string(&codex_dest).unwrap(), "old-codex");
        assert_eq!(fs::read_to_string(&opencode_dest).unwrap(), "old-opencode");
        assert_eq!(
            fs::read(crate::managed_state::managed_state_path(&env.ws)).unwrap(),
            state_before,
            "managed state must be untouched by a rolled-back apply"
        );
        let manifest = read_manifest(&result.transaction_id);
        assert_eq!(
            manifest.transaction_status,
            setup_transaction::TransactionStatus::RolledBack
        );
        assert!(manifest
            .operations
            .iter()
            .all(|op| op.rollback_status == setup_transaction::RollbackStatus::Restored));
    }

    #[test]
    fn stale_removal_never_deletes_a_user_modified_file() {
        let env = TempSetupEnv::new("stale-removal");
        let stale_skill = |name: &str| {
            ArtifactId::skill_md(
                crate::skill_roots::SkillRoot::Claude,
                crate::artifact_registry::SkillName::new(name).unwrap(),
            )
        };
        let (untouched, edited) = (stale_skill("grill-me"), stale_skill("caveman"));
        let mut records = Vec::new();
        for (artifact, installed_by_app) in [(&untouched, "app copy"), (&edited, "app copy")] {
            let dest = artifact.resolve_dest(&env.home, &env.ws).unwrap();
            fs::create_dir_all(dest.parent().unwrap()).unwrap();
            fs::write(&dest, installed_by_app).unwrap();
            records.push(crate::managed_state::ManagedArtifactRecord {
                identity: crate::managed_state::artifact_identity(artifact),
                hash: crate::stable_digest::bytes(installed_by_app.as_bytes()),
                surface: None,
            });
        }
        // The user edits one skill the app once installed and has since retired.
        let edited_dest = edited.resolve_dest(&env.home, &env.ws).unwrap();
        fs::write(&edited_dest, "my own changes").unwrap();
        crate::managed_state::write_managed_state_atomic(
            &env.ws,
            &crate::managed_state::ManagedState {
                schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: records,
            },
        )
        .unwrap();

        let planned = env.plan(&[SetupSurfaceId::Skills]);
        let kind_of = |artifact: &ArtifactId| {
            planned
                .iter()
                .find(|p| &p.artifact == artifact)
                .map(|p| p.kind)
        };
        assert_eq!(kind_of(&untouched), Some(OperationKind::Remove));
        assert_eq!(kind_of(&edited), Some(OperationKind::Conflict));

        let stale: Vec<_> = planned
            .iter()
            .filter(|p| p.artifact == untouched || p.artifact == edited)
            .cloned()
            .collect();
        let result = apply_planned_artifacts(&stale, vec![], None, &mut ProgressReporter::silent());
        assert!(result.success, "{}", result.message);
        assert!(!untouched.resolve_dest(&env.home, &env.ws).unwrap().exists());
        assert_eq!(
            fs::read_to_string(&edited_dest).unwrap(),
            "my own changes",
            "a user-modified retired skill must be preserved"
        );
    }

    #[test]
    fn a_workspace_doc_dropped_from_the_bundle_is_a_backed_up_stale_removal() {
        let env = TempSetupEnv::new("stale-workspace-doc");
        // Prompt template docs shipped before the Prompt Builder was removed.
        let stale_doc = |rel: &str| {
            ArtifactId::WorkspaceFile(crate::artifact_registry::WorkspaceRelPath::new(rel).unwrap())
        };
        let (untouched, edited) = (
            stale_doc("docs/prompt-templates/prompt.md"),
            stale_doc("docs/prompt-templates/goal-prompt.md"),
        );
        let mut records = Vec::new();
        for artifact in [&untouched, &edited] {
            let dest = artifact.resolve_dest(&env.home, &env.ws).unwrap();
            fs::create_dir_all(dest.parent().unwrap()).unwrap();
            fs::write(&dest, "app copy").unwrap();
            records.push(crate::managed_state::ManagedArtifactRecord {
                identity: crate::managed_state::artifact_identity(artifact),
                hash: crate::stable_digest::bytes(b"app copy"),
                surface: None,
            });
        }
        let edited_dest = edited.resolve_dest(&env.home, &env.ws).unwrap();
        fs::write(&edited_dest, "my own changes").unwrap();
        crate::managed_state::write_managed_state_atomic(
            &env.ws,
            &crate::managed_state::ManagedState {
                schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: records,
            },
        )
        .unwrap();

        let planned = env.plan(&[SetupSurfaceId::WorkspaceBundle]);
        let kind_of = |artifact: &ArtifactId| {
            planned
                .iter()
                .find(|p| &p.artifact == artifact)
                .map(|p| p.kind)
        };
        assert_eq!(kind_of(&untouched), Some(OperationKind::Remove));
        assert_eq!(kind_of(&edited), Some(OperationKind::Manual));

        let stale: Vec<_> = planned
            .iter()
            .filter(|p| p.artifact == untouched || p.artifact == edited)
            .cloned()
            .collect();
        let result = apply_planned_artifacts(&stale, vec![], None, &mut ProgressReporter::silent());
        assert!(result.success, "{}", result.message);
        assert!(!untouched.resolve_dest(&env.home, &env.ws).unwrap().exists());
        assert_eq!(
            fs::read_to_string(&edited_dest).unwrap(),
            "my own changes",
            "a user-modified retired doc must be preserved"
        );

        let manifest = read_manifest(&result.transaction_id);
        let removed = manifest
            .operations
            .iter()
            .find(|op| op.artifact == untouched && op.kind == OperationKind::Remove)
            .expect("the removal is recorded in the transaction");
        let backup_rel = removed.backup_rel.as_ref().expect("removal is backed up");
        let backup = backup_root()
            .unwrap()
            .join("setup")
            .join(&result.transaction_id)
            .join(backup_rel);
        assert_eq!(fs::read_to_string(backup).unwrap(), "app copy");
    }

    #[cfg(unix)]
    #[test]
    fn retired_cli_scripts_are_backed_up_stale_removals_and_empty_lib_dir_is_pruned() {
        use std::os::unix::fs::PermissionsExt;

        let env = TempSetupEnv::new("stale-cli-scripts");
        // Installer scripts shipped before the app became the only installer.
        let stale_script = |rel: &str| {
            ArtifactId::WorkspaceFile(crate::artifact_registry::WorkspaceRelPath::new(rel).unwrap())
        };
        let (untouched, nested, edited) = (
            stale_script("scripts/install-skills.sh"),
            stale_script("scripts/lib/platform-paths.sh"),
            stale_script("scripts/bootstrap.sh"),
        );
        let kept = env.ws.join("scripts/generate-opencode-config.py");
        fs::create_dir_all(kept.parent().unwrap()).unwrap();
        fs::write(&kept, "kept helper").unwrap();
        let mut records = Vec::new();
        for artifact in [&untouched, &nested, &edited] {
            let dest = artifact.resolve_dest(&env.home, &env.ws).unwrap();
            fs::create_dir_all(dest.parent().unwrap()).unwrap();
            fs::write(&dest, "app copy").unwrap();
            fs::set_permissions(&dest, fs::Permissions::from_mode(0o755)).unwrap();
            records.push(crate::managed_state::ManagedArtifactRecord {
                identity: crate::managed_state::artifact_identity(artifact),
                hash: crate::stable_digest::bytes(b"app copy"),
                surface: None,
            });
        }
        let edited_dest = edited.resolve_dest(&env.home, &env.ws).unwrap();
        fs::write(&edited_dest, "my own changes").unwrap();
        crate::managed_state::write_managed_state_atomic(
            &env.ws,
            &crate::managed_state::ManagedState {
                schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: records,
            },
        )
        .unwrap();

        let planned = env.plan(&[SetupSurfaceId::WorkspaceBundle]);
        let kind_of = |artifact: &ArtifactId| {
            planned
                .iter()
                .find(|p| &p.artifact == artifact)
                .map(|p| p.kind)
        };
        assert_eq!(kind_of(&untouched), Some(OperationKind::Remove));
        assert_eq!(kind_of(&nested), Some(OperationKind::Remove));
        assert_eq!(kind_of(&edited), Some(OperationKind::Manual));

        let stale: Vec<_> = planned
            .iter()
            .filter(|p| [&untouched, &nested, &edited].contains(&&p.artifact))
            .cloned()
            .collect();
        let result = apply_planned_artifacts(&stale, vec![], None, &mut ProgressReporter::silent());
        assert!(result.success, "{}", result.message);
        assert!(!untouched.resolve_dest(&env.home, &env.ws).unwrap().exists());
        assert!(!nested.resolve_dest(&env.home, &env.ws).unwrap().exists());
        assert!(
            !env.ws.join("scripts/lib").exists(),
            "the emptied lib directory is pruned"
        );
        assert!(kept.is_file(), "a kept helper and its folder stay");
        assert_eq!(
            fs::read_to_string(&edited_dest).unwrap(),
            "my own changes",
            "a user-modified retired script must be preserved"
        );
        assert_eq!(
            fs::metadata(&edited_dest).unwrap().permissions().mode() & 0o777,
            0o755,
            "a preserved script keeps its executable bit"
        );

        let manifest = read_manifest(&result.transaction_id);
        let removed = manifest
            .operations
            .iter()
            .find(|op| op.artifact == nested && op.kind == OperationKind::Remove)
            .expect("the removal is recorded in the transaction");
        let backup_rel = removed.backup_rel.as_ref().expect("removal is backed up");
        let backup = backup_root()
            .unwrap()
            .join("setup")
            .join(&result.transaction_id)
            .join(backup_rel);
        assert_eq!(fs::read_to_string(backup).unwrap(), "app copy");
    }

    #[test]
    fn opencode_apply_preserves_user_secrets_and_never_returns_them() {
        const KEY_MARKER: &str = "test-secret-openkey-12345";
        const TOKEN_MARKER: &str = "test-secret-token-value-55555";

        let env = TempSetupEnv::new("opencode-secret-apply");
        let config_path = env.home.join(".config/opencode/opencode.json");
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        let user_config = serde_json::json!({
            "model": "test-model",
            "small_model": "test-small",
            "provider": {
                "custom-provider": {
                    "api_key": KEY_MARKER,
                    "models": {"gpt-4": {"limit": {"context": 100000}}}
                }
            },
            "mcp": {
                "custom-mcp": {"command": ["custom"], "env": {"TOKEN": TOKEN_MARKER}}
            },
            "unknown-key": "should-preserve"
        });
        fs::write(&config_path, user_config.to_string()).unwrap();

        let plan = preview_setup(vec!["open_code_config".into()]).expect("preview");
        let result = apply_setup(
            vec!["open_code_config".into()],
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        )
        .expect("apply");
        assert!(result.success, "{}", result.message);

        // The user-owned keys survive byte for byte; the managed keys follow the bundled template.
        let installed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        for key in ["provider", "unknown-key"] {
            assert_eq!(installed[key], user_config[key], "{key} must be preserved");
        }
        assert_eq!(
            installed["mcp"]["custom-mcp"], user_config["mcp"]["custom-mcp"],
            "a user MCP server must be preserved"
        );
        let template_path = crate::setup_roots::bundled_root_for(&env.ws)
            .expect("bundled root")
            .join("templates/opencode.json");
        let template: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(template_path).unwrap()).unwrap();
        let rendered = crate::commands::render_expected_opencode_config(&template, &env.home)
            .expect("rendered config");
        assert!(
            crate::commands::managed_opencode_keys_match(&installed, &rendered),
            "managed keys must be applied"
        );
        assert_ne!(installed["model"], user_config["model"]);

        // Nothing the UI receives, nor the ownership record, carries the user's secrets.
        let state_file = fs::read_to_string(crate::managed_state::managed_state_path(&env.ws))
            .expect("managed state is written");
        for (label, text) in [
            ("preview", serde_json::to_string(&plan).unwrap()),
            ("apply result", serde_json::to_string(&result).unwrap()),
            ("managed state", state_file),
        ] {
            for marker in [KEY_MARKER, TOKEN_MARKER] {
                assert!(!text.contains(marker), "{label} leaked {marker}");
            }
        }
    }

    // ── Target gating ──

    fn disable_targets(ids: &[&str]) {
        let mut settings = crate::settings::load();
        settings
            .enabled_target_ids
            .retain(|id| !ids.contains(&id.as_str()));
        crate::settings::save_with_revision_check(settings, None).expect("save settings");
    }

    #[test]
    fn gate_requested_surfaces_drops_target_disabled_and_may_empty() {
        let mut settings = crate::settings::AppSettings::default();
        settings
            .enabled_target_ids
            .retain(|id| id != "cursor_setup");
        let kept = gate_requested_surfaces(
            vec![
                SetupSurfaceId::CursorAgents,
                SetupSurfaceId::ClaudeRules,
                SetupSurfaceId::CursorMcp,
            ],
            &settings,
        )
        .expect("gate");
        assert_eq!(kept, vec![SetupSurfaceId::ClaudeRules]);

        let emptied = gate_requested_surfaces(
            vec![SetupSurfaceId::CursorAgents, SetupSurfaceId::CursorMcp],
            &settings,
        )
        .expect("gate");
        assert!(emptied.is_empty());
    }

    #[test]
    fn gate_requested_surfaces_still_rejects_disabled_harness() {
        let settings = crate::settings::AppSettings {
            enabled_harness_ids: vec![crate::agent_targets::HarnessId::Claude],
            ..Default::default()
        };
        let err = gate_requested_surfaces(vec![SetupSurfaceId::CodexRules], &settings)
            .expect_err("disabled harness");
        assert!(err.contains("Harness disabled"), "error: {err}");
    }

    #[test]
    fn preview_with_only_target_disabled_surfaces_is_an_empty_plan() {
        let _env = TempSetupEnv::new("gate-preview");
        disable_targets(&["cursor_setup"]);
        let plan =
            preview_setup(vec!["cursor_agents".into(), "cursor_mcp".into()]).expect("preview");
        assert!(plan.operations.is_empty(), "{:?}", plan.operations);
        assert!(plan.synced.is_empty());
        assert!(!plan.has_pending_changes);
        assert!(!plan.is_blocked);
        assert!(plan.plan_fingerprint.is_none());
        assert!(plan.preview_token.is_none());
    }

    #[test]
    fn preview_drops_target_disabled_surfaces_from_a_mixed_request() {
        let _env = TempSetupEnv::new("gate-preview-mixed");
        disable_targets(&["cursor_setup"]);
        let plan =
            preview_setup(vec!["cursor_agents".into(), "claude_rules".into()]).expect("preview");
        let surfaces: Vec<SetupSurfaceId> = plan.operations.iter().map(|op| op.surface).collect();
        assert_eq!(surfaces, vec![SetupSurfaceId::ClaudeRules]);
    }

    #[test]
    fn apply_with_only_target_disabled_surfaces_is_a_no_op() {
        let env = TempSetupEnv::new("gate-apply");
        disable_targets(&["cursor_setup"]);
        let result = apply_setup(vec!["cursor_mcp".into()], false, None, None)
            .expect("apply must not fail for gated-out surfaces");
        assert!(result.success);
        assert!(result.applied.is_empty());
        assert!(
            !env.home.join(".cursor").exists(),
            "a disabled target must not be written"
        );
    }

    #[test]
    fn installation_status_does_not_count_target_disabled_surfaces() {
        let _env = TempSetupEnv::new("gate-status");
        let both = vec!["claude_rules".to_string(), "cursor_agents".to_string()];
        let enabled = get_installation_status(both.clone()).expect("status");
        assert_eq!(enabled.surfaces.len(), 2);

        disable_targets(&["cursor_setup"]);
        let gated = get_installation_status(both).expect("status");
        let surfaces: Vec<SetupSurfaceId> = gated.surfaces.iter().map(|s| s.surface).collect();
        assert_eq!(surfaces, vec![SetupSurfaceId::ClaudeRules]);
        assert!(gated.counts.create_count < enabled.counts.create_count);

        let emptied = get_installation_status(vec!["cursor_agents".into()]).expect("status");
        assert!(emptied.surfaces.is_empty());
        assert_eq!(emptied.counts.create_count, 0);
        assert_eq!(
            emptied.state,
            crate::installation_status::InstallationState::Current
        );
    }

    // ── Cursor MCP merge into an existing mcp.json ──

    /// A `~/.cursor/mcp.json` the user already has: two servers of their own and a key the
    /// app does not manage, but no `playwright` entry.
    const CURSOR_USER_MCP: &str = r#"{
  "mcpServers": {
    "zeta": { "command": "zeta-mcp", "args": ["--flag", "1"] },
    "alpha": { "url": "https://example.invalid/mcp" }
  },
  "extra": true
}
"#;

    fn seed_cursor_mcp(env: &TempSetupEnv, content: &str) -> PathBuf {
        let path = env.home.join(".cursor/mcp.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn cursor_mcp_with_other_servers_and_no_playwright_plans_a_mergeable_update() {
        let env = TempSetupEnv::new("cursor-mcp-partial-plan");
        seed_cursor_mcp(&env, CURSOR_USER_MCP);

        let planned = env.plan(&[SetupSurfaceId::CursorMcp]);
        assert_eq!(planned.len(), 1, "{planned:?}");
        assert_eq!(planned[0].artifact, ArtifactId::CursorMcp);
        assert_eq!(planned[0].kind, OperationKind::Update);
        assert_eq!(
            planned[0].previous_state,
            setup_transaction::PreviousState::MergeableConfigFile
        );
        assert_eq!(
            planned[0].rollback_action,
            setup_transaction::RollbackAction::RestoreManagedConfigFile
        );

        let plan = preview_setup(vec!["cursor_mcp".into()]).expect("preview");
        assert!(!plan.is_blocked, "{:?}", plan.operations);
        assert!(plan.has_pending_changes);
        assert!(plan.preview_token.is_some());
        let kinds: Vec<OperationKind> = plan.operations.iter().map(|op| op.kind).collect();
        assert_eq!(kinds, vec![OperationKind::Update]);
    }

    fn apply_cursor_mcp() -> SetupResult {
        let plan = preview_setup(vec!["cursor_mcp".into()]).expect("preview");
        apply_setup(
            vec!["cursor_mcp".into()],
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        )
        .expect("apply")
    }

    fn server_names(config: &serde_json::Value) -> Vec<&str> {
        config["mcpServers"]
            .as_object()
            .expect("mcpServers object")
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn cursor_mcp_apply_adds_only_playwright_and_keeps_the_other_servers() {
        let env = TempSetupEnv::new("cursor-mcp-partial-apply");
        let path = seed_cursor_mcp(&env, CURSOR_USER_MCP);

        let result = apply_cursor_mcp();
        assert!(result.success, "{}", result.message);

        let before: serde_json::Value = serde_json::from_str(CURSOR_USER_MCP).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(server_names(&after), vec!["zeta", "alpha", "playwright"]);
        for server in ["zeta", "alpha"] {
            assert_eq!(
                after["mcpServers"][server], before["mcpServers"][server],
                "{server} must keep its value"
            );
        }
        assert_eq!(after["extra"], before["extra"]);
        let args = after["mcpServers"]["playwright"]["args"].to_string();
        assert!(args.contains("@playwright/mcp"), "{args}");

        // The merged file is the app's projection now, so nothing is pending.
        let plan = preview_setup(vec!["cursor_mcp".into()]).expect("preview");
        assert!(!plan.has_pending_changes, "{:?}", plan.operations);
        assert!(!plan.is_blocked);
    }

    #[test]
    fn cursor_mcp_apply_without_a_servers_key_keeps_the_rest_of_the_file() {
        let env = TempSetupEnv::new("cursor-mcp-no-servers-key");
        let path = seed_cursor_mcp(&env, "{\n  \"theme\": \"dark\"\n}\n");

        let result = apply_cursor_mcp();
        assert!(result.success, "{}", result.message);

        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["theme"], "dark");
        assert_eq!(server_names(&after), vec!["playwright"]);
    }

    /// An installed file the way an older app wrote it: the same entry with the previous pin and
    /// the flags of that time (`--config` only, without the Chrome selection and `--no-webmcp`),
    /// and the record that app made of it.
    fn as_the_older_app_wrote_it(env: &TempSetupEnv, artifact: &ArtifactId, path: &Path) {
        let text = fs::read_to_string(path).expect("installed file");
        let current: serde_json::Value = serde_json::from_str(&text).expect("installed JSON");
        let older = crate::commands::cursor_profile::as_the_previous_app_wrote_it(&current);
        assert_ne!(
            older, current,
            "the installed file must pin the current version"
        );
        let older_text = serde_json::to_string_pretty(&older).expect("serialize") + "\n";
        assert!(
            older_text.contains("@playwright/mcp@0.0.48")
                && !older_text.contains("--no-webmcp")
                && !older_text.contains("\"--browser\""),
            "{older_text}"
        );
        fs::write(path, older_text).expect("write the previous pin and flags");
        let digest = crate::setup_fingerprint::artifact_installed_managed_digest(
            artifact, &env.ws, &env.home,
        )
        .expect("digest of the installed entry");
        let mut state = crate::managed_state::read_managed_state(&env.ws).expect("managed state");
        let identity = crate::managed_state::artifact_identity(artifact);
        let record = state
            .artifacts
            .iter_mut()
            .find(|record| record.identity == identity)
            .expect("the apply recorded the artifact");
        record.hash = digest;
        crate::managed_state::write_managed_state_atomic(&env.ws, &state)
            .expect("write managed state");
    }

    #[test]
    fn a_playwright_pin_from_an_older_app_is_an_update_not_a_conflict() {
        let env = TempSetupEnv::new("previous-playwright-pin");
        let pin = crate::commands::cursor_profile::PLAYWRIGHT_MCP_VERSION;
        for (wire, surface, artifact, rel) in [
            (
                "open_code_config",
                SetupSurfaceId::OpenCodeConfig,
                ArtifactId::OpenCodeConfig,
                ".config/opencode/opencode.json",
            ),
            (
                "cursor_mcp",
                SetupSurfaceId::CursorMcp,
                ArtifactId::CursorMcp,
                ".cursor/mcp.json",
            ),
        ] {
            let apply = || {
                let plan = preview_setup(vec![wire.into()]).expect("preview");
                assert!(!plan.is_blocked, "{wire}: {:?}", plan.operations);
                apply_setup(
                    vec![wire.into()],
                    true,
                    plan.plan_fingerprint.clone(),
                    plan.preview_token.clone(),
                )
                .expect("apply")
            };
            let result = apply();
            assert!(result.success, "{wire}: {}", result.message);
            let path = env.home.join(rel);
            as_the_older_app_wrote_it(&env, &artifact, &path);

            let planned = env.plan(&[surface]);
            let kind = planned
                .iter()
                .find(|planned| planned.artifact == artifact)
                .map(|planned| planned.kind);
            assert_eq!(kind, Some(OperationKind::Update), "{wire}: {planned:?}");

            let result = apply();
            assert!(result.success, "{wire}: {}", result.message);
            let installed = fs::read_to_string(&path).unwrap();
            assert!(
                installed.contains(&format!("@playwright/mcp@{pin}"))
                    && !installed.contains("@playwright/mcp@0.0.48"),
                "{wire}: the pin must be refreshed"
            );
            let installed: serde_json::Value =
                serde_json::from_str(&installed).expect("installed JSON");
            let lists = crate::commands::cursor_profile::playwright_argument_lists(&installed);
            assert_eq!(lists.len(), 1, "{wire}: {lists:?}");
            assert!(
                lists[0]
                    .windows(crate::commands::cursor_profile::PLAYWRIGHT_MCP_BROWSER_FLAGS.len())
                    .any(|window| window
                        == crate::commands::cursor_profile::PLAYWRIGHT_MCP_BROWSER_FLAGS),
                "{wire}: the Chrome selection and the WebMCP flag must be added: {lists:?}"
            );
        }
    }

    #[test]
    fn cursor_mcp_rollback_restores_the_existing_file_byte_for_byte() {
        let env = TempSetupEnv::new("cursor-mcp-partial-rollback");
        let path = seed_cursor_mcp(&env, CURSOR_USER_MCP);

        let result = apply_cursor_mcp();
        assert!(result.success, "{}", result.message);
        assert_ne!(fs::read(&path).unwrap(), CURSOR_USER_MCP.as_bytes());

        let rolled_back = rollback_transaction(
            &result.transaction_id,
            false,
            &mut ProgressReporter::silent(),
        );
        assert!(rolled_back.success, "{}", rolled_back.message);
        assert_eq!(fs::read(&path).unwrap(), CURSOR_USER_MCP.as_bytes());
    }

    #[test]
    fn cursor_mcp_rollback_removes_the_added_entry_and_keeps_later_user_edits() {
        let env = TempSetupEnv::new("cursor-mcp-partial-rollback-merge");
        let path = seed_cursor_mcp(&env, CURSOR_USER_MCP);

        let result = apply_cursor_mcp();
        assert!(result.success, "{}", result.message);

        // The user adds a server after the apply: the file no longer matches what the apply
        // wrote, but the managed playwright entry is untouched.
        let mut edited: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        edited["mcpServers"]["omega"] = serde_json::json!({ "command": "omega-mcp" });
        fs::write(&path, serde_json::to_string_pretty(&edited).unwrap()).unwrap();

        let rolled_back = rollback_transaction(
            &result.transaction_id,
            false,
            &mut ProgressReporter::silent(),
        );
        assert!(rolled_back.success, "{}", rolled_back.message);
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(server_names(&after), vec!["zeta", "alpha", "omega"]);
        assert_eq!(after["extra"], serde_json::json!(true));
    }

    #[test]
    fn cursor_mcp_with_an_unusable_existing_file_stays_unavailable_and_untouched() {
        let cases: [(&str, &[u8]); 4] = [
            ("invalid-json", b"{not json"),
            ("unreadable", &[0xff, 0xfe, 0x00]),
            ("not-an-object", b"[]"),
            ("servers-not-an-object", b"{\"mcpServers\": []}"),
        ];
        for (label, bytes) in cases {
            let env = TempSetupEnv::new(&format!("cursor-mcp-unusable-{label}"));
            let path = env.home.join(".cursor/mcp.json");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();

            let planned = env.plan(&[SetupSurfaceId::CursorMcp]);
            assert_eq!(planned[0].kind, OperationKind::Unavailable, "{label}");

            let plan = preview_setup(vec!["cursor_mcp".into()]).expect("preview");
            assert!(plan.is_blocked, "{label}: {:?}", plan.operations);
            assert!(plan.plan_fingerprint.is_none(), "{label}");
            let applied = apply_setup(vec!["cursor_mcp".into()], true, None, None);
            assert!(
                !applied.as_ref().is_ok_and(|result| result.success),
                "{label}: {applied:?}"
            );
            assert_eq!(fs::read(&path).unwrap(), bytes, "{label}: file changed");
            assert!(
                !env.base.join("backups").exists(),
                "{label}: nothing may be backed up for a refused plan"
            );
        }
    }
}
