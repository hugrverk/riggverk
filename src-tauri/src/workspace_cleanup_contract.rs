//! Contract of the workspace cleanup: the app no longer keeps a copy of the bundle in the
//! workspace folder, and the reviewed update of the `workspace` row removes the copies earlier
//! releases left there. Only copies the app provably wrote go, inside one transaction with
//! backups that `z` undoes; edited and unknown files, links, the state folder and the personal
//! docs stay.
//!
//! Every test runs with a temp HOME, a temp workspace folder and a temp backup folder.

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::MutexGuard;

    use crate::artifact_registry::{ArtifactId, WorkspaceRelPath};
    use crate::commands::retired_workspace_files::{LEGACY_MARKER_REL, RETIRED_WORKSPACE_FILES};
    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, rollback_setup_transaction,
        SetupResult,
    };
    use crate::managed_state::{
        managed_state_path, read_managed_state, write_managed_state_atomic, ManagedArtifactRecord,
        ManagedState, MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::setup_lifecycle::{OperationKind, SetupPlan, SetupSurfaceId};
    use crate::setup_transaction::{self, PlannedArtifact};
    use crate::stable_digest;
    use crate::test_env::guard::{self, EnvRestore};
    use crate::test_env::{seed_workspace_copy, set_test_user_dirs};

    /// `v0.1.0-rc.1`, the newest build the testers run: it predates the ownership records.
    const RC1_COMMIT: &str = "74367d9fcd2b3d4e913cf2a4ecf2b7655a21f24b";

    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        backups: PathBuf,
        // Drop order matters: restore the environment before releasing the lock.
        _restore: EnvRestore,
        _guard: MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(label: &str) -> Self {
            let guard = guard::lock();
            let restore = EnvRestore::capture();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-ws-cleanup-{label}-{nanos}"));
            let home = base.join("home");
            fs::create_dir_all(&home).expect("home");
            fs::create_dir_all(base.join("workspace")).expect("workspace");
            let ws = base.join("workspace").canonicalize().expect("workspace");
            let backups = base.join("backups");
            set_test_user_dirs(&home);
            unsafe {
                std::env::set_var("AGENT_WORKSPACE_PATH", ws.to_string_lossy().as_ref());
                std::env::set_var(
                    "AGENT_WORKSPACE_BACKUP_DIR",
                    backups.to_string_lossy().as_ref(),
                );
            }
            let home = crate::test_env::process_home();
            Self {
                base,
                home,
                ws,
                backups,
                _restore: restore,
                _guard: guard,
            }
        }

        fn plan(&self) -> Vec<PlannedArtifact> {
            setup_transaction::plan_artifacts_for_surfaces(
                &[SetupSurfaceId::WorkspaceBundle],
                &self.ws,
                &self.home,
            )
            .expect("plan")
        }

        fn write(&self, rel: &str, bytes: &[u8]) {
            let path = self.ws.join(rel);
            fs::create_dir_all(path.parent().expect("parent")).expect("folder");
            fs::write(path, bytes).expect("write");
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.ws)
                .expect("workspace")
                .map(|entry| {
                    entry
                        .expect("entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn workspace_file(rel: &str) -> ArtifactId {
        ArtifactId::WorkspaceFile(WorkspaceRelPath::new(rel).expect("workspace path"))
    }

    fn kind_of(planned: &[PlannedArtifact], rel: &str) -> Option<OperationKind> {
        let artifact = workspace_file(rel);
        planned
            .iter()
            .find(|operation| operation.artifact == artifact)
            .map(|operation| operation.kind)
    }

    fn preview_workspace() -> SetupPlan {
        preview_setup(vec!["workspace_bundle".to_string()]).expect("preview the workspace row")
    }

    /// Applies what the preview planned, with its token, as the review does on `y`.
    fn apply(plan: &SetupPlan) -> SetupResult {
        let mut surfaces: Vec<String> = plan
            .operations
            .iter()
            .filter(|op| op.kind.needs_apply())
            .map(|op| {
                serde_json::to_value(op.surface)
                    .expect("surface id")
                    .as_str()
                    .expect("surface id string")
                    .to_string()
            })
            .collect();
        surfaces.sort();
        surfaces.dedup();
        let result = apply_setup(
            surfaces,
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        )
        .expect("apply_setup");
        assert!(result.success, "apply: {}", result.message);
        result
    }

    /// Every regular file below `root`, by path relative to it.
    fn files_below(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).expect("read folder") {
                let entry = entry.expect("entry");
                let kind = entry.file_type().expect("file type");
                if kind.is_dir() {
                    stack.push(entry.path());
                } else if kind.is_file() {
                    let rel = entry
                        .path()
                        .strip_prefix(root)
                        .expect("below")
                        .to_path_buf();
                    files.insert(rel, fs::read(entry.path()).expect("read"));
                }
            }
        }
        files
    }

    fn git(args: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .args(args)
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    /// The workspace folder an `v0.1.0-rc.1` install left: the bundle of that build, byte for
    /// byte. Returns the relative paths written.
    fn seed_rc1_workspace(ws: &Path) -> Vec<String> {
        const PREFIX: &str = "resources/default-workspace/";
        let listing = git(&["ls-tree", "-r", "--name-only", RC1_COMMIT, PREFIX]);
        let mut written = Vec::new();
        for path in String::from_utf8(listing).expect("utf-8 listing").lines() {
            let rel = path.strip_prefix(PREFIX).expect("bundle path");
            let bytes = git(&["show", &format!("{RC1_COMMIT}:{path}")]);
            let dest = ws.join(rel);
            fs::create_dir_all(dest.parent().expect("parent")).expect("folder");
            fs::write(dest, bytes).expect("write rc.1 file");
            written.push(rel.to_string());
        }
        written
    }

    fn records(entries: Vec<ManagedArtifactRecord>) -> ManagedState {
        ManagedState {
            schema_version: MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: stable_digest::bytes(b"bundle"),
            artifacts: entries,
        }
    }

    fn record(rel: &str, bytes: &[u8]) -> ManagedArtifactRecord {
        ManagedArtifactRecord {
            identity: crate::managed_state::workspace_file_identity(rel),
            hash: stable_digest::bytes(bytes),
            surface: None,
        }
    }

    #[test]
    fn recorded_copies_are_removed_and_an_edited_one_is_left_in_place() {
        let env = Env::new("recorded");
        let copies = seed_workspace_copy(&env.ws);
        // A copy an older release wrote, proven by its record alone (no bundle or shipped version
        // has these bytes), and a recorded copy the user edited since.
        let older = b"an older copy the app installed\n";
        env.write("docs/WORKFLOWS.md", older);
        env.write("docs/START_HERE.md", b"my own start page\n");
        write_managed_state_atomic(
            &env.ws,
            &records(vec![
                record("docs/WORKFLOWS.md", older),
                record("docs/START_HERE.md", b"the copy the app installed\n"),
                record(LEGACY_MARKER_REL, b"{}"),
            ]),
        )
        .expect("records");

        let planned = env.plan();
        for rel in RETIRED_WORKSPACE_FILES {
            let expected = if *rel == "docs/START_HERE.md" {
                OperationKind::Manual
            } else {
                OperationKind::Remove
            };
            assert_eq!(kind_of(&planned, rel), Some(expected), "{rel}");
        }
        assert_eq!(
            kind_of(&planned, LEGACY_MARKER_REL),
            None,
            "the marker stays"
        );
        assert_eq!(copies.len(), RETIRED_WORKSPACE_FILES.len() + 1);
        assert!(planned
            .iter()
            .all(|operation| matches!(operation.artifact, ArtifactId::WorkspaceFile(_))));
        let start_here = planned
            .iter()
            .find(|operation| operation.artifact == workspace_file("docs/START_HERE.md"))
            .expect("left in place");
        assert!(start_here.file.is_none(), "never a file the user can keep");

        // The review says what goes and what stays.
        let plan = preview_workspace();
        assert!(!plan.is_blocked);
        let op = plan
            .operations
            .iter()
            .find(|op| op.surface == SetupSurfaceId::WorkspaceBundle)
            .expect("workspace operation");
        assert_eq!(op.kind, OperationKind::Remove);
        assert!(op.summary.contains("132 old copies"), "{}", op.summary);
        assert!(
            op.details
                .iter()
                .any(|line| line.starts_with("- skills/ (") && line.contains("old copies")),
            "{:?}",
            op.details
        );
        assert!(
            op.details
                .contains(&"= docs/START_HERE.md (edited or not the app's: left in place)".into()),
            "{:?}",
            op.details
        );
    }

    #[test]
    fn an_rc1_workspace_without_records_loses_every_unedited_copy_and_keeps_an_edited_one() {
        let env = Env::new("rc1");
        let written = seed_rc1_workspace(&env.ws);
        assert!(env.ws.join(LEGACY_MARKER_REL).is_file());
        assert!(read_managed_state(&env.ws).is_none(), "rc.1 has no records");
        let copies: Vec<&str> = RETIRED_WORKSPACE_FILES
            .iter()
            .copied()
            .filter(|rel| written.iter().any(|path| path == rel))
            .collect();
        assert!(copies.len() > 20, "{copies:?}");
        let edited = copies[0];
        env.write(edited, b"edited by the user\n");

        let planned = env.plan();
        for rel in &copies {
            let expected = if *rel == edited {
                OperationKind::Manual
            } else {
                OperationKind::Remove
            };
            assert_eq!(kind_of(&planned, rel), Some(expected), "{rel}");
        }
        assert_eq!(kind_of(&planned, LEGACY_MARKER_REL), None);
        // A file of that build the frozen list does not name is not the cleanup's to remove.
        assert_eq!(kind_of(&planned, "scripts/bootstrap.sh"), None);

        let result = apply(&preview_workspace());
        assert!(result.failed.is_empty(), "{:?}", result.failed);
        for rel in &copies {
            assert_eq!(env.ws.join(rel).exists(), *rel == edited, "{rel}");
        }
        assert_eq!(
            fs::read(env.ws.join(edited)).expect("edited copy"),
            b"edited by the user\n"
        );
        assert!(env.ws.join(LEGACY_MARKER_REL).is_file());
        assert!(env.ws.join("scripts/bootstrap.sh").is_file());
    }

    #[test]
    fn the_cleanup_leaves_personal_docs_the_marker_unknown_files_and_git_alone() {
        let env = Env::new("untouched");
        seed_workspace_copy(&env.ws);
        let mine: [(&str, &[u8]); 5] = [
            ("docs/context/notes.md", b"# My notes\n"),
            (".git/HEAD", b"ref: refs/heads/main\n"),
            ("my-notes.txt", b"mine\n"),
            ("skills/my-own/SKILL.md", b"---\nname: my-own\n---\n"),
            ("templates/mine.md", b"my template\n"),
        ];
        for (rel, bytes) in mine {
            env.write(rel, bytes);
        }
        let marker = fs::read(env.ws.join(LEGACY_MARKER_REL)).expect("marker");

        let planned = env.plan();
        for (rel, _) in mine {
            assert_eq!(kind_of(&planned, rel), None, "{rel}");
        }
        apply(&preview_workspace());

        for (rel, bytes) in mine {
            assert_eq!(fs::read(env.ws.join(rel)).expect(rel), bytes, "{rel}");
        }
        assert_eq!(
            fs::read(env.ws.join(LEGACY_MARKER_REL)).expect("marker"),
            marker
        );
        for rel in RETIRED_WORKSPACE_FILES {
            assert!(!env.ws.join(rel).exists(), "{rel}");
        }
        // Folders the removals emptied are gone; the ones that hold something stay.
        assert_eq!(
            env.names(),
            [
                ".agent-workspace",
                ".git",
                "docs",
                "my-notes.txt",
                "skills",
                "templates"
            ]
        );
        assert_eq!(
            files_below(&env.ws.join("skills"))
                .into_keys()
                .collect::<Vec<_>>(),
            [PathBuf::from("my-own/SKILL.md")]
        );
        assert_eq!(
            files_below(&env.ws.join("docs"))
                .into_keys()
                .collect::<Vec<_>>(),
            [PathBuf::from("context/notes.md")]
        );
        assert!(managed_state_path(&env.ws).is_file());
        let state = read_managed_state(&env.ws).expect("records");
        assert!(state
            .artifacts
            .iter()
            .all(|record| !record.identity.starts_with("workspace:file:")
                || record.identity.ends_with(LEGACY_MARKER_REL)));

        // Nothing is left to do: the second preview plans no operation.
        let again = preview_workspace();
        assert!(!again.has_pending_changes);
        assert!(
            again
                .operations
                .iter()
                .all(|op| op.kind == OperationKind::NoChange),
            "{:?}",
            again.operations
        );
        assert!(env.plan().is_empty(), "{:?}", env.plan());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_on_a_copy_or_on_its_folder_is_left_in_place() {
        use std::os::unix::fs::symlink;

        let env = Env::new("links");
        seed_workspace_copy(&env.ws);
        // `agent-specs/` is a link to a folder elsewhere holding the same bytes; `README.md` is a
        // link to a file elsewhere.
        let outside = env.base.join("outside");
        fs::create_dir_all(&outside).expect("outside");
        fs::rename(env.ws.join("agent-specs"), outside.join("agent-specs")).expect("move folder");
        symlink(outside.join("agent-specs"), env.ws.join("agent-specs")).expect("link folder");
        fs::rename(env.ws.join("README.md"), outside.join("README.md")).expect("move file");
        symlink(outside.join("README.md"), env.ws.join("README.md")).expect("link file");
        let outside_before = files_below(&outside);

        let planned = env.plan();
        let linked: Vec<&str> = RETIRED_WORKSPACE_FILES
            .iter()
            .copied()
            .filter(|rel| rel.starts_with("agent-specs/") || *rel == "README.md")
            .collect();
        assert!(linked.len() > 1);
        for rel in &linked {
            assert_eq!(kind_of(&planned, rel), Some(OperationKind::Manual), "{rel}");
        }
        assert_eq!(
            kind_of(&planned, "docs/START_HERE.md"),
            Some(OperationKind::Remove)
        );

        apply(&preview_workspace());
        assert_eq!(
            files_below(&outside),
            outside_before,
            "nothing behind a link"
        );
        assert!(fs::symlink_metadata(env.ws.join("agent-specs"))
            .expect("link")
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(env.ws.join("README.md"))
            .expect("link")
            .file_type()
            .is_symlink());
        assert!(!env.ws.join("docs/START_HERE.md").exists());
    }

    #[test]
    fn rollback_restores_every_copy_and_the_records_byte_for_byte() {
        let env = Env::new("rollback");
        seed_workspace_copy(&env.ws);
        // Records from an earlier install of a harness surface.
        let first = apply(
            &preview_setup(vec!["claude_agents".to_string()]).expect("preview claude agents"),
        );
        assert!(!first.transaction_id.is_empty());
        let before = files_below(&env.ws);
        let records_before = fs::read(managed_state_path(&env.ws)).expect("records");

        let result = apply(&preview_workspace());
        assert!(!env.ws.join("skills").exists());
        assert_ne!(files_below(&env.ws), before);

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(
            rolled.success,
            "rollback: {} {:?}",
            rolled.message, rolled.failed
        );
        assert_eq!(files_below(&env.ws), before, "every copy is back");
        assert_eq!(
            fs::read(managed_state_path(&env.ws)).expect("records"),
            records_before,
            "the records are back"
        );
    }

    #[test]
    fn uninstall_after_the_cleanup_keeps_the_data_folder_its_records_and_personal_docs() {
        let env = Env::new("uninstall");
        seed_workspace_copy(&env.ws);
        env.write("docs/context/notes.md", b"# My notes\n");
        // Install everything and clean up in one review, then uninstall.
        apply(&preview_setup(vec![]).expect("preview all"));
        assert!(!env.ws.join("skills").exists());

        let uninstall = preview_uninstall().expect("preview uninstall");
        assert!(
            uninstall
                .removable
                .iter()
                .all(|item| !Path::new(&item.path).starts_with(&env.ws)),
            "nothing of the data folder is removed: {:?}",
            uninstall
                .removable
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>()
        );
        let result = apply_uninstall(uninstall.plan_fingerprint, uninstall.preview_token)
            .expect("apply uninstall");
        assert!(result.success, "uninstall: {}", result.message);

        assert!(env.ws.is_dir());
        assert!(env.ws.join(LEGACY_MARKER_REL).is_file());
        assert!(managed_state_path(&env.ws).is_file());
        assert_eq!(
            fs::read(env.ws.join("docs/context/notes.md")).expect("personal doc"),
            b"# My notes\n"
        );
        assert!(!env.home.join(".claude/CLAUDE.md").exists());
    }

    /// Releases before this one installed the copy, and their transactions name its files. Such a
    /// manifest still reads and dry-runs, before and after the cleanup.
    #[test]
    fn an_old_transaction_that_installed_the_copy_still_dry_runs() {
        let env = Env::new("old-manifest");
        let files = ["README.md", "docs/START_HERE.md"];
        let bundle =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let mut operations = Vec::new();
        for rel in files {
            let bytes = fs::read(bundle.join(rel)).expect("bundle file");
            env.write(rel, &bytes);
            let artifact = workspace_file(rel);
            operations.push(setup_transaction::ArtifactManifestOperation {
                surface: SetupSurfaceId::WorkspaceBundle,
                kind: OperationKind::Create,
                previous_state: setup_transaction::PreviousState::Absent,
                rollback_action: setup_transaction::RollbackAction::RemoveCreatedFile,
                apply_status: setup_transaction::ApplyStatus::Applied,
                validation_status: setup_transaction::ValidationStatus::Passed,
                post_apply_digest: Some(
                    crate::setup_fingerprint::artifact_installed_managed_digest(
                        &artifact, &env.ws, &env.home,
                    )
                    .expect("digest"),
                ),
                post_apply_full_digest: Some(
                    crate::setup_fingerprint::artifact_installed_full_digest(
                        &artifact, &env.ws, &env.home,
                    )
                    .expect("full digest"),
                ),
                artifact,
                ..Default::default()
            });
        }
        let id = "1700000000000000000";
        let dir = env.backups.join("setup").join(id);
        fs::create_dir_all(&dir).expect("transaction folder");
        let manifest = setup_transaction::ArtifactTransactionManifest {
            schema_version: setup_transaction::ARTIFACT_MANIFEST_SCHEMA_VERSION,
            workspace_key: setup_transaction::workspace_key(&env.ws).expect("key"),
            created_at: id.to_string(),
            surface_ids: vec![SetupSurfaceId::WorkspaceBundle],
            transaction_status: setup_transaction::TransactionStatus::Completed,
            previous_managed_state_present: false,
            previous_managed_state_trusted: false,
            previous_managed_state_digest: None,
            previous_managed_state_backup_rel: None,
            operations,
        };
        setup_transaction::persist_manifest_atomic(&dir.join("manifest.json"), &manifest, &dir)
            .expect("old manifest");

        let dry = rollback_setup_transaction(id.to_string(), true).expect("dry run");
        assert!(dry.success, "{} {:?}", dry.message, dry.failed);
        assert_eq!(dry.applied.len(), files.len(), "{:?}", dry.applied);

        apply(&preview_workspace());
        for rel in files {
            assert!(!env.ws.join(rel).exists(), "{rel}");
        }
        // The cleanup is newer: the old transaction is refused as a whole, its manifest still
        // reads, and nothing is touched.
        let after = rollback_setup_transaction(id.to_string(), true).expect("dry run after");
        assert!(
            after.message.contains("newer completed transaction"),
            "{} {:?}",
            after.message,
            after.failed
        );
        for rel in files {
            assert!(!env.ws.join(rel).exists(), "{rel}");
        }
    }
}
