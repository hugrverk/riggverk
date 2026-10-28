//! Read-only, workspace-scoped projection of setup transaction evidence.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::agent_targets::HarnessId;
use crate::apply_progress::artifact_display_path;
use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
use crate::setup_transaction::{
    self, ApplyStatus, ArtifactTransactionManifest, RollbackStatus, SetupReceipt, TransactionStatus,
};

use super::setup::{
    newer_completed_transaction, transaction_id_is_newer, validate_transaction_id_format,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupHistoryStatus {
    Applied,
    RolledBack,
    /// Also covers interrupted runs that never reached completed status.
    Failed,
}

#[derive(Debug, Default, Serialize)]
pub struct SetupHistoryCounts {
    pub create: usize,
    pub update: usize,
    pub remove: usize,
}

#[derive(Debug, Serialize)]
pub struct SetupHistoryChange {
    pub surface: SetupSurfaceId,
    pub kind: OperationKind,
    /// The existing home-relative display label, never an absolute destination.
    pub path: String,
    pub applied: bool,
    pub restored: bool,
}

#[derive(Debug, Serialize)]
pub struct SetupHistoryEntry {
    pub transaction_id: String,
    /// Unix nanoseconds encoded as a decimal string, as stored by the writer.
    pub created_at: String,
    /// Not recorded by older versions.
    pub finished_at: Option<String>,
    pub status: SetupHistoryStatus,
    pub surfaces: Vec<SetupSurfaceId>,
    /// Harness-specific surfaces; shared skills are represented in `surfaces`.
    pub harnesses: Vec<HarnessId>,
    pub changes: Vec<SetupHistoryChange>,
    pub operation_counts: SetupHistoryCounts,
    pub backup_files: usize,
    pub is_newest_completed: bool,
    /// UI offer only. Live-file preconditions still require rollback's dry run and confirmation.
    pub undoable: bool,
    /// `None` means the run did not record Checked / Left for you facts.
    pub receipt: Option<SetupReceipt>,
}

fn list_history_from_root(
    root: &Path,
    workspace: &Path,
    home: &Path,
    limit: Option<u32>,
) -> Result<Vec<SetupHistoryEntry>, String> {
    let limit = limit.unwrap_or(20) as usize;
    if limit == 0 {
        return Ok(Vec::new());
    }
    let setup_root = root.join("setup");
    let metadata = match fs::symlink_metadata(&setup_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Cannot read setup history folder".into()),
    };
    if !metadata.is_dir() || crate::path_safety::reject_symlink(root, "backup root").is_err() {
        return Err("Cannot read setup history folder safely".into());
    }
    let workspace_key = setup_transaction::workspace_key(workspace)
        .map_err(|_| "Cannot resolve setup history workspace".to_string())?;
    let entries =
        fs::read_dir(&setup_root).map_err(|_| "Cannot read setup history folder".to_string())?;
    let mut manifests = Vec::new();
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if !validate_transaction_id_format(&id)
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        let path = entry.path().join("manifest.json");
        if !fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<ArtifactTransactionManifest>(&raw) else {
            continue;
        };
        if !setup_transaction::workspace_keys_match(&manifest.workspace_key, &workspace_key)
            || setup_transaction::validate_manifest(&manifest, workspace).is_err()
            || !validate_transaction_id_format(&manifest.created_at)
            || manifest
                .finished_at
                .as_deref()
                .is_some_and(|time| !validate_transaction_id_format(time))
        {
            continue;
        }
        manifests.push((id, entry.path(), manifest));
    }
    // Directory ids are nanosecond timestamps. Numeric ordering also handles older short ids.
    manifests.sort_by(|a, b| {
        if transaction_id_is_newer(&a.0, &b.0) {
            std::cmp::Ordering::Less
        } else if transaction_id_is_newer(&b.0, &a.0) {
            std::cmp::Ordering::Greater
        } else {
            b.0.cmp(&a.0)
        }
    });
    let newest_completed = manifests
        .iter()
        .find(|(_, _, manifest)| manifest.transaction_status == TransactionStatus::Completed)
        .and_then(|(id, dir, manifest)| {
            // Reuse rollback's guard, including completed headers whose full manifest is damaged.
            newer_completed_transaction(dir, &manifest.workspace_key)
                .is_ok_and(|newer| newer.is_none())
                .then_some(id.as_str())
        });
    let mut history = Vec::new();
    for (id, dir, manifest) in manifests.iter().take(limit) {
        let is_newest_completed = newest_completed == Some(id.as_str());
        let undoable = is_newest_completed
            && manifest
                .operations
                .iter()
                .any(setup_transaction::operation_eligible_for_rollback_mutation);
        let mut counts = SetupHistoryCounts::default();
        let mut surfaces = Vec::new();
        let mut harnesses = Vec::new();
        let mut changes = Vec::new();
        for operation in &manifest.operations {
            match operation.kind {
                OperationKind::Create => counts.create += 1,
                OperationKind::Update => counts.update += 1,
                OperationKind::Remove => counts.remove += 1,
                _ => unreachable!("validated manifest operation kind"),
            }
            if !surfaces.contains(&operation.surface) {
                surfaces.push(operation.surface);
            }
            if let Some(harness) = operation.surface.harness() {
                if !harnesses.contains(&harness) {
                    harnesses.push(harness);
                }
            }
            changes.push(SetupHistoryChange {
                surface: operation.surface,
                kind: operation.kind,
                path: artifact_display_path(&operation.artifact, home, workspace),
                applied: operation.apply_status == ApplyStatus::Applied,
                restored: operation.rollback_status == RollbackStatus::Restored,
            });
        }
        history.push(SetupHistoryEntry {
            transaction_id: id.clone(),
            created_at: manifest.created_at.clone(),
            finished_at: manifest.finished_at.clone(),
            status: match manifest.transaction_status {
                TransactionStatus::Completed => SetupHistoryStatus::Applied,
                TransactionStatus::RolledBack => SetupHistoryStatus::RolledBack,
                _ => SetupHistoryStatus::Failed,
            },
            surfaces,
            harnesses,
            changes,
            operation_counts: counts,
            backup_files: super::backups::setup_backup_file_count(dir),
            is_newest_completed,
            undoable,
            receipt: manifest.receipt.clone(),
        });
    }
    Ok(history)
}

#[tauri::command]
pub fn list_setup_history(limit: Option<u32>) -> Result<Vec<SetupHistoryEntry>, String> {
    let root = super::backups::backup_root()
        .map_err(|_| "Cannot resolve setup history backup folder".to_string())?;
    let workspace = super::workspace::setup_workspace_target_path()
        .map_err(|_| "Cannot resolve setup history workspace".to_string())?;
    let home = crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .map_err(|_| "Cannot resolve setup history home folder".to_string())?;
    list_history_from_root(&root, &workspace, &home, limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_registry::{ArtifactId, WorkspaceRelPath};
    use crate::setup_transaction::{
        ArtifactManifestOperation, PreviousState, RollbackAction, SetupReceiptItem,
        SetupReceiptReason, ValidationStatus, ARTIFACT_MANIFEST_SCHEMA_VERSION,
    };
    use crate::test_env::{guard, set_test_user_dirs};
    use std::path::PathBuf;

    struct Env {
        base: PathBuf,
        workspace: PathBuf,
        root: PathBuf,
        _restore: guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Env {
        fn new() -> Self {
            let lock = guard::lock();
            let restore = guard::isolate_data_location_env();
            let base = std::env::temp_dir().join(format!(
                "riggverk-history-{}",
                setup_transaction::new_transaction_id().unwrap()
            ));
            let home = base.join("home");
            let workspace = base.join("workspace");
            let root = base.join("backups");
            fs::create_dir_all(&home).unwrap();
            set_test_user_dirs(&home);
            unsafe {
                std::env::set_var("CODEX_HOME", home.join(".codex"));
                std::env::set_var("RIGGVERK_WORKSPACE_PATH", &workspace);
                std::env::set_var("RIGGVERK_BACKUP_DIR", &root);
            }
            Self {
                base,
                workspace,
                root,
                _restore: restore,
                _lock: lock,
            }
        }

        fn manifest(&self, id: &str, status: TransactionStatus) -> ArtifactTransactionManifest {
            ArtifactTransactionManifest {
                schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
                workspace_key: setup_transaction::workspace_key(&self.workspace).unwrap(),
                created_at: id.into(),
                finished_at: None,
                receipt: None,
                surface_ids: vec![SetupSurfaceId::CodexRules],
                transaction_status: status,
                previous_managed_state_present: false,
                previous_managed_state_trusted: false,
                previous_managed_state_digest: None,
                previous_managed_state_backup_rel: None,
                operations: vec![ArtifactManifestOperation {
                    artifact: ArtifactId::CodexRules,
                    surface: SetupSurfaceId::CodexRules,
                    kind: OperationKind::Create,
                    previous_state: PreviousState::Absent,
                    rollback_action: RollbackAction::RemoveCreatedFile,
                    apply_status: ApplyStatus::Applied,
                    validation_status: ValidationStatus::Passed,
                    rollback_status: if status == TransactionStatus::RolledBack {
                        RollbackStatus::Restored
                    } else {
                        RollbackStatus::Pending
                    },
                    ..Default::default()
                }],
            }
        }

        fn write(&self, id: &str, manifest: &ArtifactTransactionManifest) -> PathBuf {
            let dir = self.root.join("setup").join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("manifest.json"),
                serde_json::to_vec(manifest).unwrap(),
            )
            .unwrap();
            dir
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn empty_backup_root_returns_no_history_and_creates_nothing() {
        let env = Env::new();
        assert!(list_setup_history(None).unwrap().is_empty());
        assert!(!env.root.exists());
        assert!(!env.workspace.exists());
        fs::create_dir_all(env.root.join("setup")).unwrap();
        assert!(list_setup_history(None).unwrap().is_empty());
    }

    #[test]
    fn skips_foreign_damaged_unreadable_and_invalid_manifests_before_limiting() {
        let env = Env::new();
        env.write("1", &env.manifest("1", TransactionStatus::Completed));
        let mut foreign = env.manifest("2", TransactionStatus::Completed);
        foreign.workspace_key = env
            .base
            .join("other-workspace")
            .to_string_lossy()
            .into_owned();
        env.write("2", &foreign);
        let damaged = env.write("3", &env.manifest("3", TransactionStatus::Completed));
        fs::write(damaged.join("manifest.json"), "{broken").unwrap();
        let unreadable = env.write("4", &env.manifest("4", TransactionStatus::Completed));
        fs::write(unreadable.join("manifest.json"), [0xff, 0xfe]).unwrap();
        fs::create_dir_all(env.root.join("setup/5/manifest.json")).unwrap();
        let mut invalid = env.manifest("6", TransactionStatus::Completed);
        invalid.operations[0].backup_rel = Some("/private/should-not-escape".into());
        env.write("6", &invalid);
        let mut invalid_time = env.manifest("7", TransactionStatus::Completed);
        invalid_time.finished_at = Some("/private/should-not-escape".into());
        env.write("7", &invalid_time);
        let history = list_setup_history(Some(1)).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].transaction_id, "1");
    }

    #[test]
    fn orders_timestamps_numerically_newest_first_and_respects_limit() {
        let env = Env::new();
        // Creation order intentionally differs from timestamp order.
        for id in ["100", "9", "10"] {
            env.write(id, &env.manifest(id, TransactionStatus::Completed));
        }
        let history = list_setup_history(None).unwrap();
        assert_eq!(
            history
                .iter()
                .map(|entry| entry.transaction_id.as_str())
                .collect::<Vec<_>>(),
            ["100", "10", "9"]
        );
        assert_eq!(list_setup_history(Some(2)).unwrap().len(), 2);
        assert!(list_setup_history(Some(0)).unwrap().is_empty());
    }

    #[test]
    fn defaults_to_twenty_entries() {
        let env = Env::new();
        for id in 1..=25 {
            let id = id.to_string();
            env.write(&id, &env.manifest(&id, TransactionStatus::Completed));
        }
        let history = list_setup_history(None).unwrap();
        assert_eq!(history.len(), 20);
        assert_eq!(history[0].transaction_id, "25");
        assert_eq!(list_setup_history(Some(25)).unwrap().len(), 25);
    }

    #[test]
    fn only_the_newest_completed_entry_offers_undo_after_reload() {
        let env = Env::new();
        for (id, status) in [
            ("1", TransactionStatus::Completed),
            ("2", TransactionStatus::Completed),
            ("3", TransactionStatus::RolledBack),
            ("4", TransactionStatus::Failed),
        ] {
            env.write(id, &env.manifest(id, status));
        }
        // No apply or session state is needed; every call reconstructs history from disk.
        for _ in 0..2 {
            let history = list_setup_history(None).unwrap();
            let undoable: Vec<_> = history.iter().filter(|entry| entry.undoable).collect();
            assert_eq!(undoable.len(), 1);
            assert_eq!(undoable[0].transaction_id, "2");
            assert!(undoable[0].is_newest_completed);
            assert_eq!(
                history
                    .iter()
                    .filter(|entry| entry.is_newest_completed)
                    .count(),
                1
            );
            assert_eq!(history[0].status, SetupHistoryStatus::Failed);
            assert_eq!(history[1].status, SetupHistoryStatus::RolledBack);
            assert_eq!(history[2].status, SetupHistoryStatus::Applied);
        }
    }

    #[test]
    fn damaged_newer_completed_header_still_blocks_undo_like_rollback() {
        let env = Env::new();
        env.write("1", &env.manifest("1", TransactionStatus::Completed));
        let dir = env.write("2", &env.manifest("2", TransactionStatus::Completed));
        let mut damaged =
            serde_json::to_value(env.manifest("2", TransactionStatus::Completed)).unwrap();
        damaged["operations"] = serde_json::json!(["damaged"]);
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&damaged).unwrap(),
        )
        .unwrap();
        let history = list_setup_history(None).unwrap();
        assert_eq!(history.len(), 1);
        assert!(!history[0].is_newest_completed);
        assert!(!history[0].undoable);
    }

    #[test]
    fn completed_entry_without_remaining_rollback_operations_does_not_offer_undo() {
        let env = Env::new();
        let mut manifest = env.manifest("1", TransactionStatus::Completed);
        manifest.operations[0].rollback_status = RollbackStatus::Restored;
        env.write("1", &manifest);
        let history = list_setup_history(None).unwrap();
        assert!(history[0].is_newest_completed);
        assert!(!history[0].undoable);
    }

    #[test]
    fn returns_safe_labels_counts_times_and_optional_receipt_without_contents() {
        let env = Env::new();
        let mut manifest = env.manifest("1", TransactionStatus::Completed);
        manifest.finished_at = Some("2".into());
        manifest.receipt = Some(SetupReceipt {
            synced: vec![SetupSurfaceId::ClaudeRules],
            left_for_you: vec![SetupReceiptItem {
                surface: SetupSurfaceId::OpenCodeRules,
                reason: SetupReceiptReason::Conflict,
            }],
        });
        for (artifact, surface, kind, rel) in [
            (
                ArtifactId::ClaudeRules,
                SetupSurfaceId::ClaudeRules,
                OperationKind::Update,
                "artifacts/claude/rules",
            ),
            (
                ArtifactId::OpenCodeRules,
                SetupSurfaceId::OpenCodeRules,
                OperationKind::Remove,
                "artifacts/opencode/rules",
            ),
            (
                ArtifactId::WorkspaceFile(WorkspaceRelPath::new("docs/history.md").unwrap()),
                SetupSurfaceId::WorkspaceBundle,
                OperationKind::Remove,
                "artifacts/workspace/history.md",
            ),
        ] {
            manifest.operations.push(ArtifactManifestOperation {
                artifact,
                surface,
                kind,
                previous_state: PreviousState::ManagedFile,
                rollback_action: RollbackAction::RestoreFile,
                backup_rel: Some(rel.into()),
                apply_status: ApplyStatus::Applied,
                validation_status: ValidationStatus::Passed,
                ..Default::default()
            });
        }
        let dir = env.write("1", &manifest);
        for operation in &manifest.operations {
            if let Some(rel) = &operation.backup_rel {
                let path = dir.join(rel);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, "private fixture contents").unwrap();
            }
        }
        let before = fs::read(dir.join("manifest.json")).unwrap();
        let history = list_setup_history(None).unwrap();
        let entry = &history[0];
        assert_eq!(entry.created_at, "1");
        assert_eq!(entry.finished_at.as_deref(), Some("2"));
        assert_eq!(entry.receipt, manifest.receipt);
        assert_eq!(entry.operation_counts.create, 1);
        assert_eq!(entry.operation_counts.update, 1);
        assert_eq!(entry.operation_counts.remove, 2);
        assert_eq!(entry.backup_files, 3);
        assert_eq!(
            entry.harnesses,
            [HarnessId::Codex, HarnessId::Claude, HarnessId::OpenCode]
        );
        assert_eq!(entry.changes[0].path, "~/.codex/AGENTS.md");
        assert_eq!(entry.changes[1].path, "~/.claude/CLAUDE.md");
        assert!(entry
            .changes
            .iter()
            .all(|change| change.applied && !change.restored));
        let output = serde_json::to_string(&history).unwrap();
        assert!(!output.contains(env.base.to_str().unwrap()));
        assert!(!output.contains("workspace_key"));
        assert!(!output.contains("backup_rel"));
        assert!(!output.contains("private fixture contents"));
        for change in &entry.changes {
            assert!(!Path::new(&change.path).is_absolute());
        }
        assert_eq!(fs::read(dir.join("manifest.json")).unwrap(), before);
        assert!(
            !env.workspace.exists(),
            "listing must not migrate or create the workspace"
        );

        manifest.receipt = None;
        env.write("1", &manifest);
        assert!(list_setup_history(None).unwrap()[0].receipt.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_manifests_and_runs_and_refuses_a_symlinked_setup_root() {
        use std::os::unix::fs::symlink;
        let env = Env::new();
        let real = env.write("1", &env.manifest("1", TransactionStatus::Completed));
        symlink(&real, env.root.join("setup/2")).unwrap();
        fs::create_dir_all(env.root.join("setup/3")).unwrap();
        symlink(
            real.join("manifest.json"),
            env.root.join("setup/3/manifest.json"),
        )
        .unwrap();
        assert_eq!(list_setup_history(None).unwrap().len(), 1);
        fs::rename(env.root.join("setup"), env.root.join("saved")).unwrap();
        symlink(env.root.join("saved"), env.root.join("setup")).unwrap();
        let error = list_setup_history(None).unwrap_err();
        assert!(!error.contains(env.base.to_str().unwrap()));
    }
}
