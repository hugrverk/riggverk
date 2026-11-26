// Test-only: the `tests` module of the file next to it. The inner attribute lets the repository checks
// that read production Rust skip this file.
#![cfg(test)]

use super::*;
use crate::artifact_registry::ArtifactId;
use crate::skill_roots::SkillRoot;
use std::fs;

fn temp(label: &str) -> PathBuf {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!("aw-txn-{label}-{n}"))
}

#[test]
fn expand_bundled_skills_count() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
    let one_root = SkillScope::of(&[SkillRoot::Claude]);
    let artifacts = expand_surface_fail_closed(SetupSurfaceId::Skills, &repo, &one_root).unwrap();
    let skill_md = artifacts
        .iter()
        .filter(
            |artifact| matches!(artifact, ArtifactId::SkillFile(file) if file.rel.is_skill_md()),
        )
        .count();
    let (expected_skills, supporting) = crate::test_env::skill_file_counts(&repo.join("skills"));
    assert_eq!(skill_md, expected_skills, "one SKILL.md per bundled skill");
    assert_eq!(
        artifacts.len() - skill_md,
        supporting,
        "supporting files of the bundled skills"
    );
}

#[test]
fn skill_without_a_canonical_source_is_unavailable_and_with_one_is_created() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let home = temp("skill-source-home");
    let ws = temp("skill-source-ws");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    crate::test_env::set_test_user_dirs(&home);
    unsafe {
        std::env::remove_var("OPENCODE_SKILLS_PATH");
        std::env::remove_var("CLAUDE_SKILLS_PATH");
    }
    let name = |name: &str| crate::artifact_registry::SkillName::new(name).unwrap();

    let skill_md = |root, name| ArtifactId::skill_md(root, name);
    let missing = skill_md(SkillRoot::OpenCode, name("no-such-skill"));
    assert_eq!(
        detect_artifact_state(&missing, &ws, &home),
        (OperationKind::Unavailable, PreviousState::Unavailable)
    );
    for artifact in [
        skill_md(SkillRoot::OpenCode, name("tdd")),
        skill_md(SkillRoot::Claude, name("tdd")),
    ] {
        assert_eq!(
            detect_artifact_state(&artifact, &ws, &home),
            (OperationKind::Create, PreviousState::Absent),
            "{artifact:?}"
        );
    }
    let _ = fs::remove_dir_all(&home);
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn workspace_bundle_wants_no_file_and_its_empty_expansion_is_not_an_error() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
    let artifacts =
        expand_surface_fail_closed(SetupSurfaceId::WorkspaceBundle, &repo, &SkillScope::all())
            .unwrap();
    assert!(artifacts.is_empty(), "{artifacts:?}");
    let ws = std::env::temp_dir().join(format!(
        "aw-empty-bundle-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    assert!(expand_surfaces_to_artifacts(
        &[SetupSurfaceId::WorkspaceBundle],
        &ws,
        &SkillScope::all()
    )
    .unwrap()
    .is_empty());
}

#[test]
fn fingerprint_rejects_empty() {
    assert!(!validate_fingerprint_format(""));
    assert!(!validate_fingerprint_format("not hex!"));
}

#[test]
fn aggregate_surface_keeps_safe_update_available_beside_conflict() {
    let kinds = vec![OperationKind::Update, OperationKind::Conflict];
    assert_eq!(aggregate_operation_kind(&kinds), OperationKind::Update);
}

#[test]
fn aggregate_surface_update_when_any_artifact_differs() {
    let kinds = vec![OperationKind::NoChange, OperationKind::Create];
    assert_eq!(aggregate_operation_kind(&kinds), OperationKind::Create);
    let kinds = vec![OperationKind::NoChange, OperationKind::Update];
    assert_eq!(aggregate_operation_kind(&kinds), OperationKind::Update);
}

#[test]
fn preview_token_rejects_reuse() {
    clear_preview_tokens_for_test();
    let ws = temp("token-ws");
    fs::create_dir_all(&ws).unwrap();
    let fp = "abc123def4567890";
    let surfaces = vec![SetupSurfaceId::OpenCodeRules];
    let token = issue_preview_token(&ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
    validate_preview_token(&token, &ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
    consume_preview_token(&token).unwrap();
    assert!(validate_preview_token(&token, &ws, fp, PreviewPurpose::Apply, &surfaces).is_err());
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn rapid_identical_previews_receive_distinct_tokens() {
    clear_preview_tokens_for_test();
    let ws = temp("token-rapid");
    fs::create_dir_all(&ws).unwrap();
    let fp = "abc123def4567890abcdef1234567890";
    let surfaces = vec![SetupSurfaceId::OpenCodeRules];
    let first = issue_preview_token(&ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
    let second = issue_preview_token(&ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
    assert_ne!(
        first, second,
        "rapid duplicate previews must get distinct tokens"
    );
    validate_preview_token(&first, &ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
    validate_preview_token(&second, &ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn rollback_does_not_include_untouched_surface_sibling() {
    let ops = vec![
        ArtifactManifestOperation {
            surface: SetupSurfaceId::OpenCodeRules,
            kind: OperationKind::Update,
            previous_state: PreviousState::ManagedFile,
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some("artifacts/a".into()),
            apply_status: ApplyStatus::InFlight,
            ..Default::default()
        },
        ArtifactManifestOperation {
            surface: SetupSurfaceId::OpenCodeRules,
            kind: OperationKind::Update,
            previous_state: PreviousState::ManagedFile,
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some("artifacts/b".into()),
            ..Default::default()
        },
    ];
    let eligible = rollback_eligible_indices(&ops);
    assert_eq!(
        eligible,
        vec![0],
        "only the InFlight artifact must be eligible for rollback"
    );
}

#[test]
fn pending_operations_remain_pending_after_failed_first_artifact() {
    let ops = vec![
        ArtifactManifestOperation {
            apply_status: ApplyStatus::Failed,
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some("artifacts/a".into()),
            ..Default::default()
        },
        ArtifactManifestOperation {
            apply_status: ApplyStatus::Pending,
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some("artifacts/b".into()),
            ..Default::default()
        },
    ];
    let eligible = rollback_eligible_indices(&ops);
    assert_eq!(eligible, vec![0]);
    assert_eq!(ops[1].apply_status, ApplyStatus::Pending);
}

#[test]
fn preview_token_rejects_fingerprint_mismatch() {
    clear_preview_tokens_for_test();
    let ws = temp("token-fp");
    fs::create_dir_all(&ws).unwrap();
    let surfaces = vec![SetupSurfaceId::OpenCodeRules];
    let token =
        issue_preview_token(&ws, "aaaaaaaaaaaaaaaa", PreviewPurpose::Apply, &surfaces).unwrap();
    assert!(validate_preview_token(
        &token,
        &ws,
        "bbbbbbbbbbbbbbbb",
        PreviewPurpose::Apply,
        &surfaces
    )
    .is_err());
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn rollback_action_for_skill_file_uses_file_semantics() {
    assert_eq!(
        rollback_action_for(OperationKind::Update, PreviousState::ManagedFile),
        RollbackAction::RestoreFile
    );
    assert_eq!(
        rollback_action_for(OperationKind::Remove, PreviousState::ManagedFile),
        RollbackAction::RestoreFile
    );
}

#[test]
fn manifest_rejects_duplicate_artifact_ids() {
    let ws = temp("manifest-dup");
    let manifest = ArtifactTransactionManifest {
        schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
        workspace_key: workspace_key(&ws).unwrap_or_default(),
        created_at: "1".into(),
        finished_at: None,
        receipt: None,
        surface_ids: vec![SetupSurfaceId::OpenCodeRules],
        transaction_status: TransactionStatus::Prepared,
        previous_managed_state_present: false,
        previous_managed_state_trusted: false,
        previous_managed_state_digest: None,
        previous_managed_state_backup_rel: None,
        operations: vec![
            ArtifactManifestOperation {
                artifact: ArtifactId::OpenCodeRules,
                surface: SetupSurfaceId::OpenCodeRules,
                kind: OperationKind::Update,
                previous_state: PreviousState::ManagedFile,
                rollback_action: RollbackAction::RestoreFile,
                backup_rel: Some("artifacts/x".into()),
                ..Default::default()
            },
            ArtifactManifestOperation {
                artifact: ArtifactId::OpenCodeRules,
                surface: SetupSurfaceId::OpenCodeRules,
                kind: OperationKind::Update,
                previous_state: PreviousState::ManagedFile,
                rollback_action: RollbackAction::RestoreFile,
                backup_rel: Some("artifacts/y".into()),
                ..Default::default()
            },
        ],
    };
    assert!(validate_manifest(&manifest, &ws).is_err());
}

#[test]
fn directory_backup_validation_rejects_missing_original_entry() {
    let base = temp("dir-backup-missing");
    let _ = fs::remove_dir_all(&base);
    let original = base.join("original");
    let backup = base.join("backup");
    fs::create_dir_all(original.join("nested")).unwrap();
    fs::write(original.join("nested/a.txt"), b"a").unwrap();
    fs::create_dir_all(&backup).unwrap();
    fs::write(backup.join("extra.txt"), b"x").unwrap();
    let err = validate_directory_backup_tree(&original, &backup).expect_err("missing");
    assert!(err.contains("mismatch") || err.contains("missing"), "{err}");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn directory_backup_validation_accepts_exact_copy() {
    let base = temp("dir-backup-exact");
    let _ = fs::remove_dir_all(&base);
    let original = base.join("original");
    let backup = base.join("backup");
    fs::create_dir_all(original.join("nested")).unwrap();
    fs::write(original.join("nested/a.txt"), b"a").unwrap();
    fs::create_dir_all(backup.join("nested")).unwrap();
    fs::write(backup.join("nested/a.txt"), b"a").unwrap();
    assert!(validate_directory_backup_tree(&original, &backup).is_ok());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn validate_artifact_source_dest_rejects_dangling_destination() {
    #[cfg(unix)]
    {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe { std::env::remove_var("CODEX_HOME") };
        let base = temp("dangling-dest");
        let _ = fs::remove_dir_all(&base);
        let ws = base.join("ws");
        let home = base.join("home");
        fs::create_dir_all(ws.join("templates/sync")).unwrap();
        fs::write(ws.join("templates/sync/codex-rules.md"), "rules").unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        let link = home.join(".codex/AGENTS.md");
        std::os::unix::fs::symlink(home.join("missing-rules"), &link).unwrap();
        let artifact = ArtifactId::CodexRules;
        let err = validate_artifact_source_dest(&artifact, &ws, &home).expect_err("dangling dest");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }
}

fn codex_agent_artifact() -> ArtifactId {
    ArtifactId::CodexAgent(crate::artifact_registry::AgentName::new("repo-scout").unwrap())
}

#[test]
fn validate_artifact_source_dest_allows_codex_home_outside_home() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let base = temp("codex-home-outside");
    let ws = base.join("ws");
    let home = base.join("home");
    let codex = base.join("elsewhere/codex");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&codex).unwrap();
    unsafe { std::env::set_var("CODEX_HOME", &codex) };

    for artifact in [
        ArtifactId::CodexRules,
        ArtifactId::CodexConfig,
        codex_agent_artifact(),
    ] {
        let (_, dest) = validate_artifact_source_dest(&artifact, &ws, &home)
            .unwrap_or_else(|e| panic!("{artifact:?}: {e}"));
        assert!(dest.starts_with(&codex), "{artifact:?}: {dest:?}");
    }
    // Surfaces that live under home keep their home allowlist.
    let (_, dest) = validate_artifact_source_dest(&ArtifactId::ClaudeRules, &ws, &home).unwrap();
    assert!(dest.starts_with(&home), "{dest:?}");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn validate_artifact_source_dest_rejects_relative_codex_home() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let base = temp("codex-home-relative");
    let ws = base.join("ws");
    let home = base.join("home");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&home).unwrap();
    unsafe { std::env::set_var("CODEX_HOME", "relative/codex") };

    let err = validate_artifact_source_dest(&ArtifactId::CodexRules, &ws, &home)
        .expect_err("relative CODEX_HOME must be rejected");
    assert!(err.contains("CODEX_HOME must be an absolute path"), "{err}");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn a_flagged_pack_skill_gets_its_own_review_line_naming_its_keys() {
    use crate::artifact_registry::{SkillName, SkillRelPath};
    use crate::skill_discovery::PrivilegedKey;
    use crate::skill_roots::SkillRoot;
    let file = |skill: &str, rel: &str, kind: OperationKind| PlannedArtifact {
        artifact: ArtifactId::skill_file(
            SkillRoot::Claude,
            SkillName::new(skill).unwrap(),
            SkillRelPath::new(rel).unwrap(),
        ),
        surface: SetupSurfaceId::Skills,
        kind,
        previous_state: PreviousState::Absent,
        rollback_action: RollbackAction::RemoveCreatedFile,
        rules: None,
        rules_rewrite: None,
        mcp: None,
        file: None,
        overwrite: None,
    };
    let planned = [
        file("tdd", "SKILL.md", OperationKind::Create),
        file("deploy", "SKILL.md", OperationKind::Create),
        file("deploy", "notes.md", OperationKind::Create),
    ];
    let long = "x".repeat(250);
    let flagged = std::collections::BTreeMap::from([(
        "deploy".to_string(),
        FlaggedSkill {
            pack: "team".to_string(),
            keys: vec![
                PrivilegedKey {
                    key: "allowed-tools".to_string(),
                    value: "Bash(git *)".to_string(),
                    note: "grants tool access without asking".to_string(),
                },
                PrivilegedKey {
                    key: "model".to_string(),
                    value: long,
                    note: String::new(),
                },
            ],
        },
    )]);
    let packs = std::collections::BTreeMap::from([("deploy".to_string(), "team".to_string())]);
    let (lines, writes) = skill_plan_details(
        &planned,
        &SkillScope::all(),
        &flagged,
        &Default::default(),
        &packs,
    );
    // The flagged pack skill is counted on its own line, not in the folder's.
    assert_eq!(
        writes
            .iter()
            .map(|write| (write.line, write.pack.as_str(), write.skills))
            .collect::<Vec<_>>(),
        [(1, "team", 1)]
    );
    assert!(writes[0]
        .harnesses
        .contains(&crate::agent_targets::HarnessId::Claude));
    assert_eq!(
        lines,
        [
            "+ ~/.claude/skills (1 skill, 1 file)".to_string(),
            format!(
                "+ ~/.claude/skills/deploy (2 files; pack team; allowed-tools: Bash(git *) \
                     [grants tool access without asking]; model: {}… (whole value in the Library))",
                "x".repeat(200)
            ),
        ]
    );
    assert_eq!(
        skill_plan_details(
            &planned,
            &SkillScope::all(),
            &Default::default(),
            &Default::default(),
            &packs,
        ),
        (
            vec!["+ ~/.claude/skills (2 skills, 3 files)".to_string()],
            vec![PackWrite {
                line: 0,
                pack: "team".to_string(),
                skills: 1,
                harnesses: writes[0].harnesses.clone(),
            }]
        )
    );
}

#[cfg(unix)]
#[test]
fn a_transaction_folder_is_trusted_only_without_links_or_shared_write() {
    let base = temp("txn-trust");
    let txn = base.join("setup/123");
    fs::create_dir_all(&txn).unwrap();
    fs::write(txn.join("manifest.json"), b"{}").unwrap();
    check_transaction_folder_trusted(&txn).expect("no artifacts folder is fine");

    fs::write(base.join("planted.json"), b"{}").unwrap();
    fs::remove_file(txn.join("manifest.json")).unwrap();
    std::os::unix::fs::symlink(base.join("planted.json"), txn.join("manifest.json")).unwrap();
    assert_eq!(
        check_transaction_folder_trusted(&txn).unwrap_err(),
        "refusing the setup manifest: it is a link"
    );
    fs::remove_file(txn.join("manifest.json")).unwrap();
    assert_eq!(
        check_transaction_folder_trusted(&txn).unwrap_err(),
        "cannot inspect the setup manifest"
    );
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn explicit_rollback_restores_codex_artifact_under_codex_home_outside_home() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let base = temp("codex-home-restore");
    let ws = base.join("ws");
    let home = base.join("home");
    let codex = base.join("elsewhere/codex");
    let backup_dir = base.join("backup");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(codex.join("agents")).unwrap();
    fs::create_dir_all(backup_dir.join("artifacts")).unwrap();
    unsafe { std::env::set_var("CODEX_HOME", &codex) };
    let dest = codex.join("agents/repo-scout.toml");
    fs::write(&dest, "applied").unwrap();
    fs::write(backup_dir.join("artifacts/agent"), "before").unwrap();
    let op = ArtifactManifestOperation {
        artifact: codex_agent_artifact(),
        surface: SetupSurfaceId::CodexAgents,
        kind: OperationKind::Update,
        previous_state: PreviousState::ManagedFile,
        rollback_action: RollbackAction::RestoreFile,
        backup_rel: Some("artifacts/agent".into()),
        apply_status: ApplyStatus::Applied,
        ..Default::default()
    };

    restore_artifact_from_backup_with_mode(
        &op,
        &backup_dir,
        &home,
        RollbackRestoreMode::FullBackup,
        Some(&ws),
    )
    .expect("restore under CODEX_HOME");

    assert_eq!(fs::read_to_string(&dest).unwrap(), "before");
    let _ = fs::remove_dir_all(&base);
}

/// A backed-up skill script comes back executable, and a plain skill file comes back plain.
#[cfg(unix)]
#[test]
fn restoring_a_skill_file_from_its_backup_restores_the_execute_bit() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let _isolated = crate::test_env::guard::isolate_data_location_env();
    unsafe { std::env::remove_var("CLAUDE_SKILLS_PATH") };
    let base = temp("skill-exec-restore");
    let ws = base.join("ws");
    let home = base.join("home");
    let backup_dir = base.join("backup");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&backup_dir).unwrap();
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    for (rel, before, after) in [
        ("scripts/run.sh", 0o755, 0o644),
        ("references/guide.md", 0o644, 0o755),
    ] {
        let artifact = ArtifactId::skill_file(
            SkillRoot::Claude,
            crate::artifact_registry::SkillName::new("demo").unwrap(),
            crate::artifact_registry::SkillRelPath::new(rel).unwrap(),
        );
        let dest = artifact.resolve_dest(&home, &ws).unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, "before").unwrap();
        fs::set_permissions(&dest, fs::Permissions::from_mode(before)).unwrap();
        let backup_rel = backup_artifact(&artifact, &backup_dir, &home, &ws)
            .unwrap()
            .expect("backed up");
        let backed_up = backup_dir.join(&backup_rel);
        assert_eq!(
            mode(&backed_up),
            if before & 0o100 != 0 { 0o700 } else { 0o600 }
        );

        // The update rewrote the file with the other mode.
        fs::write(&dest, "after").unwrap();
        fs::set_permissions(&dest, fs::Permissions::from_mode(after)).unwrap();
        let op = ArtifactManifestOperation {
            artifact,
            surface: SetupSurfaceId::Skills,
            kind: OperationKind::Update,
            previous_state: PreviousState::ManagedFile,
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some(backup_rel),
            apply_status: ApplyStatus::Applied,
            ..Default::default()
        };
        restore_artifact_from_backup_with_mode(
            &op,
            &backup_dir,
            &home,
            RollbackRestoreMode::FullBackup,
            Some(&ws),
        )
        .expect("restore");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "before");
        let restored = mode(&dest);
        assert_eq!(
            restored & 0o111 != 0,
            before & 0o100 != 0,
            "{rel}: {restored:o}"
        );
        assert_eq!(restored & 0o022, 0, "{rel}: never group or world writable");
    }
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn rollback_status_in_flight_serializes_and_deserializes() {
    let status = RollbackStatus::InFlight;
    let json = serde_json::to_string(&status).unwrap();
    assert_eq!(json, "\"in_flight\"");
    let parsed: RollbackStatus = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, RollbackStatus::InFlight);
}

#[test]
fn validate_transaction_rejects_in_flight_on_rolled_back() {
    let ws = temp("txn-inflight-rolled");
    let manifest = ArtifactTransactionManifest {
        schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
        workspace_key: workspace_key(&ws).unwrap_or_default(),
        created_at: "1".into(),
        finished_at: None,
        receipt: None,
        surface_ids: vec![SetupSurfaceId::OpenCodeRules],
        transaction_status: TransactionStatus::RolledBack,
        previous_managed_state_present: false,
        previous_managed_state_trusted: false,
        previous_managed_state_digest: None,
        previous_managed_state_backup_rel: None,
        operations: vec![ArtifactManifestOperation {
            artifact: ArtifactId::OpenCodeRules,
            surface: SetupSurfaceId::OpenCodeRules,
            kind: OperationKind::Update,
            previous_state: PreviousState::ManagedFile,
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some("artifacts/x".into()),
            apply_status: ApplyStatus::Applied,
            rollback_status: RollbackStatus::InFlight,
            ..Default::default()
        }],
    };
    assert!(validate_transaction_rollback_status_combo(&manifest).is_err());
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn compute_finalize_rollback_status_all_restored() {
    let ops = vec![
        ArtifactManifestOperation {
            apply_status: ApplyStatus::Applied,
            rollback_status: RollbackStatus::Restored,
            ..Default::default()
        },
        ArtifactManifestOperation {
            apply_status: ApplyStatus::Applied,
            rollback_status: RollbackStatus::Restored,
            ..Default::default()
        },
    ];
    assert_eq!(
        compute_finalize_rollback_status(&ops),
        TransactionStatus::RolledBack
    );
}

#[test]
fn compute_finalize_rollback_status_unresolved_failed() {
    let ops = vec![ArtifactManifestOperation {
        apply_status: ApplyStatus::Applied,
        rollback_status: RollbackStatus::Failed,
        ..Default::default()
    }];
    assert_eq!(
        compute_finalize_rollback_status(&ops),
        TransactionStatus::RollbackFailed
    );
}

#[test]
fn validation_fails_on_update_after_apply() {
    let _guard = crate::test_env::guard::lock();
    let home = temp("val-home");
    let ws = temp("val-ws");
    fs::create_dir_all(home.join(".codex")).unwrap();
    let artifact = ArtifactId::CodexRules;
    let bundled = crate::setup_roots::bundled_root().unwrap();
    let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
    let installed = home.join(".codex/AGENTS.md");
    // An unwrapped file that equals the source still shows a pending update:
    // apply was supposed to put the base in a managed block.
    fs::write(&installed, &source).unwrap();
    let err = validate_artifact_after_apply(&artifact, &ws, &home).unwrap_err();
    assert!(err.contains("Update"), "{err}");
    // A block that differs from the source is no valid outcome either.
    fs::write(&installed, crate::rules_block::render_new("# other base\n")).unwrap();
    assert!(validate_artifact_after_apply(&artifact, &ws, &home).is_err());
    // The source in a block, with user text around it, is.
    fs::write(
        &installed,
        format!("mine\n{}tail\n", crate::rules_block::render_new(&source)),
    )
    .unwrap();
    assert!(validate_artifact_after_apply(&artifact, &ws, &home).is_ok());
    let _ = fs::remove_dir_all(&home);
    let _ = fs::remove_dir_all(&ws);
}

// ── Automatic rollback safety ──

/// Update of the Codex rules file with a backup holding `original`.
/// Returns (op, backup_dir, home, ws).
fn automatic_restore_fixture(
    label: &str,
    original: &str,
    installed: &str,
) -> (ArtifactManifestOperation, PathBuf, PathBuf, PathBuf) {
    let base = temp(label);
    let home = base.join("home");
    let ws = base.join("ws");
    let backup_dir = base.join("txn");
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::create_dir_all(backup_dir.join("artifacts")).unwrap();
    fs::write(backup_dir.join("artifacts/codex-rules"), original).unwrap();
    fs::write(home.join(".codex/AGENTS.md"), installed).unwrap();
    let op = ArtifactManifestOperation {
        artifact: ArtifactId::CodexRules,
        surface: SetupSurfaceId::CodexRules,
        kind: OperationKind::Update,
        previous_state: PreviousState::ManagedFile,
        rollback_action: RollbackAction::RestoreFile,
        backup_rel: Some("artifacts/codex-rules".into()),
        apply_status: ApplyStatus::InFlight,
        ..Default::default()
    };
    (op, backup_dir, home, ws)
}

#[test]
fn automatic_restore_keeps_user_edit_when_digests_were_never_recorded() {
    let _guard = crate::test_env::guard::lock();
    let (op, backup_dir, home, ws) =
        automatic_restore_fixture("auto-user-edit", "original", "user edit");
    let err = restore_artifact_from_backup(&op, &backup_dir, &home, &ws).unwrap_err();
    assert_eq!(err, CHANGED_SINCE_APPLY);
    assert_eq!(
        fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
        "user edit"
    );
}

#[test]
fn automatic_restore_keeps_a_rules_file_the_whole_of_which_nothing_proves() {
    let _guard = crate::test_env::guard::lock();
    let bundled = crate::setup_roots::bundled_root().unwrap();
    let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
    // An older manifest: no digest recorded before the write. The managed block matching the
    // source says nothing about the text around it, so the file is not replaced.
    let (op, backup_dir, home, ws) =
        automatic_restore_fixture("auto-unproven", "original", &source);
    let err = restore_artifact_from_backup(&op, &backup_dir, &home, &ws).unwrap_err();
    assert_eq!(err, CHANGED_SINCE_APPLY);
    assert_eq!(
        fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
        source
    );
}

#[test]
fn automatic_restore_restores_recorded_output_and_skips_original() {
    let _guard = crate::test_env::guard::lock();
    let bundled = crate::setup_roots::bundled_root().unwrap();
    let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
    let (mut op, backup_dir, home, ws) =
        automatic_restore_fixture("auto-planned", "original", &source);
    op.expected_full_digest = Some(crate::stable_digest::bytes(source.as_bytes()));
    restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("restore");
    assert_eq!(
        fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
        "original"
    );
    // Restoring again is a no-op: the artifact is at its pre-apply state.
    restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("idempotent");
    assert_eq!(
        fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
        "original"
    );
}

#[cfg(unix)]
#[test]
fn a_backup_file_others_can_write_is_never_restored() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = crate::test_env::guard::lock();
    let bundled = crate::setup_roots::bundled_root().unwrap();
    let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
    let (mut op, backup_dir, home, ws) =
        automatic_restore_fixture("auto-shared-backup", "original", &source);
    op.expected_full_digest = Some(crate::stable_digest::bytes(source.as_bytes()));
    let backup = backup_dir.join("artifacts/codex-rules");
    let dest = home.join(".codex/AGENTS.md");
    let set_mode = |path: &Path, mode: u32| {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap()
    };

    set_mode(&backup, 0o666);
    let refused = "refusing the setup backup: it is writable by its group or by everyone; \
                       run chmod go-w on it";
    assert_eq!(
        restore_artifact_from_backup(&op, &backup_dir, &home, &ws).unwrap_err(),
        refused
    );
    assert_eq!(
        restore_artifact_from_backup_for_explicit_rollback(&op, &backup_dir, &home, &ws)
            .unwrap_err(),
        refused
    );
    assert_eq!(
        validate_backup_for_rollback(&op, &backup_dir).unwrap_err(),
        refused
    );
    assert_eq!(
        fs::read_to_string(&dest).unwrap(),
        source,
        "nothing restored"
    );

    // Owner-only, as this version writes it, or 0644 as releases before v2026.10.1 left it.
    for mode in [0o600, 0o644] {
        fs::write(&dest, &source).unwrap();
        set_mode(&backup, mode);
        validate_backup_for_rollback(&op, &backup_dir).expect("trusted backup");
        restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("restore");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "original");
    }
}

#[cfg(unix)]
#[test]
fn a_folder_backup_is_trusted_only_when_nothing_below_it_is_shared() {
    use std::os::unix::fs::PermissionsExt;
    let base = temp("shared-backup-tree");
    let tree = base.join("txn/artifacts/skill");
    fs::create_dir_all(tree.join("nested")).unwrap();
    fs::write(tree.join("SKILL.md"), "skill").unwrap();
    fs::write(tree.join("nested/notes.md"), "notes").unwrap();
    let op = ArtifactManifestOperation {
        rollback_action: RollbackAction::RestoreFile,
        backup_rel: Some("artifacts/skill".into()),
        ..Default::default()
    };
    let backup_dir = base.join("txn");
    let set_mode = |path: &Path, mode: u32| {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap()
    };
    for path in [tree.clone(), tree.join("nested")] {
        set_mode(&path, 0o755);
    }
    validate_backup_for_rollback(&op, &backup_dir).expect("0755 folders, 0644 files");
    set_mode(&tree.join("nested/notes.md"), 0o666);
    assert!(validate_backup_for_rollback(&op, &backup_dir)
        .unwrap_err()
        .starts_with("refusing the setup backup: it is writable"));
    set_mode(&tree.join("nested/notes.md"), 0o600);
    set_mode(&tree.join("nested"), 0o777);
    assert!(validate_backup_for_rollback(&op, &backup_dir)
        .unwrap_err()
        .starts_with("refusing the setup backup: it is writable"));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn automatic_restore_keeps_edit_made_after_recorded_apply() {
    let _guard = crate::test_env::guard::lock();
    let (mut op, backup_dir, home, ws) =
        automatic_restore_fixture("auto-recorded", "original", "applied");
    let dest = home.join(".codex/AGENTS.md");
    op.apply_status = ApplyStatus::Applied;
    op.post_apply_digest = Some(crate::stable_digest::bytes(b"applied"));
    op.post_apply_full_digest = Some(crate::stable_digest::bytes(b"applied"));
    restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("unchanged restores");
    assert_eq!(fs::read_to_string(&dest).unwrap(), "original");

    fs::write(&dest, "edited later").unwrap();
    let err = restore_artifact_from_backup(&op, &backup_dir, &home, &ws).unwrap_err();
    assert_eq!(err, CHANGED_SINCE_APPLY);
    assert_eq!(fs::read_to_string(&dest).unwrap(), "edited later");
}

#[test]
fn rollback_after_a_crash_uses_the_digest_recorded_before_the_write() {
    let _guard = crate::test_env::guard::lock();
    // What the app wrote is no longer what the source makes (the source changed since), and
    // no post-apply digest was saved: only the digest recorded before the write proves it.
    let (mut op, backup_dir, home, ws) =
        automatic_restore_fixture("crash-proof", "original", "written by an older source");
    let dest = home.join(".codex/AGENTS.md");
    op.expected_full_digest = Some(crate::stable_digest::bytes(b"written by an older source"));
    validate_update_target_unchanged(&op, &ws, &home).expect("explicit preflight");
    restore_artifact_from_backup_for_explicit_rollback(&op, &backup_dir, &home, &ws)
        .expect("explicit rollback");
    assert_eq!(fs::read_to_string(&dest).unwrap(), "original");

    fs::write(&dest, "written by an older source").unwrap();
    restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("automatic rollback");
    assert_eq!(fs::read_to_string(&dest).unwrap(), "original");

    // Anything else is kept, by both.
    fs::write(&dest, "edited after the crash").unwrap();
    for result in [
        restore_artifact_from_backup_for_explicit_rollback(&op, &backup_dir, &home, &ws),
        restore_artifact_from_backup(&op, &backup_dir, &home, &ws),
    ] {
        assert_eq!(result.unwrap_err(), CHANGED_SINCE_APPLY);
    }
    assert_eq!(fs::read_to_string(&dest).unwrap(), "edited after the crash");
}

#[test]
fn restore_file_failure_keeps_the_destination() {
    let _guard = crate::test_env::guard::lock();
    let (mut op, backup_dir, home, ws) =
        automatic_restore_fixture("restore-keeps-dest", "original", "current");
    // A backup that is not a regular file makes the copy fail.
    fs::remove_file(backup_dir.join("artifacts/codex-rules")).unwrap();
    fs::create_dir_all(backup_dir.join("artifacts/codex-rules")).unwrap();
    op.apply_status = ApplyStatus::Applied;
    let err = restore_artifact_from_backup_with_mode(
        &op,
        &backup_dir,
        &home,
        RollbackRestoreMode::FullBackup,
        Some(&ws),
    )
    .expect_err("directory backup cannot be restored");
    assert!(err.contains("restore file"), "{err}");
    assert_eq!(
        fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
        "current",
        "failed restore must not delete the destination"
    );
}

#[test]
fn refreshed_record_turns_the_next_source_change_into_update_not_conflict() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let base = temp("stale-record-plan");
    let home = base.join("home");
    let ws = base.join("ws");
    fs::create_dir_all(home.join(".codex")).unwrap();
    crate::test_env::set_test_user_dirs(&home);
    let bundled = crate::setup_roots::bundled_root().unwrap();
    let artifact = ArtifactId::CodexRules;
    let identity = crate::managed_state::artifact_identity(&artifact);

    // Installed == current source, record stale: planned as no change.
    let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
    fs::write(
        home.join(".codex/AGENTS.md"),
        crate::rules_block::render_new(&source),
    )
    .unwrap();
    let stale = crate::managed_state::ManagedState {
        schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
        bundled_version: crate::stable_digest::bytes(b"bundle"),
        artifacts: vec![crate::managed_state::ManagedArtifactRecord {
            identity: identity.clone(),
            hash: crate::stable_digest::bytes(b"older shipped version"),
            surface: None,
            role_models: Default::default(),
        }],
    };
    let (kind, _) = detect_artifact_state(&artifact, &ws, &home);
    assert_eq!(kind, OperationKind::NoChange);

    // The next apply refreshes the record from the installed content.
    let refreshed = crate::managed_state::next_state_from_operations(
        Some(&stale),
        &bundled,
        &ws,
        &home,
        &[],
        &[],
    )
    .unwrap();

    // Once the source moves on, the installed file differs from it. Only the
    // refreshed record still proves ownership, so only it yields an update.
    let installed = fs::read(home.join(".codex/AGENTS.md")).unwrap();
    let decide = |state: &crate::managed_state::ManagedState| {
        crate::rules_block::assess(
            Some(&installed),
            "# a newer base\n",
            managed_hash_for(&identity, &state.artifacts).as_deref(),
            &|_| false,
        )
        .plan
    };
    assert_eq!(
        decide(&stale),
        crate::rules_block::RulesPlan::Conflict(crate::rules_block::RulesConflict::BaseBlockEdited)
    );
    assert_eq!(
        decide(&refreshed),
        crate::rules_block::RulesPlan::UpdateBlock
    );
    let _ = fs::remove_dir_all(base);
}

#[test]
fn managed_opencode_rollback_removes_added_entries_and_keeps_user_edits_and_order() {
    let _env = crate::test_env::guard::default_xdg_config_home();
    let home = temp("opencode-rollback-home");
    let ws = home.join("workspace");
    let backups = temp("opencode-rollback-backups");
    let backup: serde_json::Value = serde_json::from_str(
            r#"{"theme":"before","model":"old/main","provider":{"z":{},"a":{}},
                "mcp":{"first":{},"last":{}},
                "agent":{"plan":{"model":"mine/plan","prompt":"mine"},
                    "inspector":{"description":"mine","prompt":"keep"},"custom":{}},"keybinds":{}}"#,
        ).unwrap();
    let rendered = serde_json::json!({
        "model":"new/main", "lsp":true, "permission":{"*":"ask"},
        "mcp":{"playwright":{"command":["test-mcp"]}},
        "agent":{"plan":{"permission":{"edit":"deny"}},
            "explore":{"permission":{"edit":"deny"}},
            "inspector":{"model":"new/cheap"},"sentinel":{"model":"new/cheap"}}
    });
    let mut current = crate::commands::merge_managed_opencode_config(&backup, &rendered);
    current["theme"] = serde_json::json!("edited after apply");
    current["agent"]["inspector"]["prompt"] = serde_json::json!("edited after apply");
    current["user_after_apply"] = serde_json::json!({"keep":true});
    current["last_user_key"] = serde_json::json!("keep last");
    let mut expected = backup.clone();
    expected["model"] = current["model"].clone();
    expected["theme"] = current["theme"].clone();
    expected["agent"]["inspector"]["prompt"] = current["agent"]["inspector"]["prompt"].clone();
    expected["user_after_apply"] = current["user_after_apply"].clone();
    expected["last_user_key"] = current["last_user_key"].clone();
    fs::create_dir_all(home.join(".config/opencode")).unwrap();
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(backups.join("artifacts")).unwrap();
    let dest = home.join(".config/opencode/opencode.json");
    let current_text = serde_json::to_string_pretty(&current)
        .unwrap()
        .replace("new/main", r"new/\u006dain");
    fs::write(&dest, current_text).unwrap();
    fs::write(
        backups.join("artifacts/opencode-config"),
        serde_json::to_vec(&backup).unwrap(),
    )
    .unwrap();
    let op = ArtifactManifestOperation {
        artifact: ArtifactId::OpenCodeConfig,
        surface: SetupSurfaceId::OpenCodeConfig,
        kind: OperationKind::Update,
        previous_state: PreviousState::MergeableConfigFile,
        rollback_action: RollbackAction::RestoreManagedConfigFile,
        backup_rel: Some("artifacts/opencode-config".into()),
        ..Default::default()
    };
    restore_artifact_from_backup_with_mode(
        &op,
        &backups,
        &home,
        RollbackRestoreMode::ManagedProjectionMerge,
        Some(&ws),
    )
    .unwrap();
    let restored: serde_json::Value = serde_json::from_slice(&fs::read(&dest).unwrap()).unwrap();
    assert!(fs::read_to_string(&dest)
        .unwrap()
        .contains(r"new/\u006dain"));
    // String comparison checks the order of every retained user object as well as values.
    assert_eq!(
        serde_json::to_string(&restored).unwrap(),
        serde_json::to_string(&expected).unwrap()
    );
    for dir in [&home, &backups] {
        let _ = fs::remove_dir_all(dir);
    }
}

/// Rollback puts back the role models an apply changed, the user's own and the ones the app
/// recorded writing, and the backup check agrees with the restored file.
#[test]
fn managed_opencode_rollback_restores_role_models_and_matches_the_backup() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let home = temp("opencode-role-rollback-home");
    let backups = temp("opencode-role-rollback-backups");
    fs::create_dir_all(home.join(".config/opencode")).unwrap();
    crate::test_env::set_test_user_dirs(&home);
    let ws = home.join("workspace");
    let dest = home.join(".config/opencode/opencode.json");
    fs::create_dir_all(backups.join("artifacts")).unwrap();
    let op = ArtifactManifestOperation {
        artifact: ArtifactId::OpenCodeConfig,
        surface: SetupSurfaceId::OpenCodeConfig,
        kind: OperationKind::Update,
        previous_state: PreviousState::MergeableConfigFile,
        rollback_action: RollbackAction::RestoreManagedConfigFile,
        backup_rel: Some("artifacts/opencode-config".into()),
        ..Default::default()
    };
    let record = |role_models: &[(&str, &str)]| {
        let state = crate::managed_state::ManagedState {
            schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: crate::stable_digest::bytes(b"bundle"),
            artifacts: vec![crate::managed_state::ManagedArtifactRecord {
                identity: crate::managed_state::artifact_identity(&ArtifactId::OpenCodeConfig),
                hash: crate::stable_digest::bytes(b"record"),
                surface: None,
                role_models: role_models
                    .iter()
                    .map(|(role, model)| (role.to_string(), model.to_string()))
                    .collect(),
            }],
        };
        crate::managed_state::write_managed_state_atomic(&ws, &state).unwrap();
    };
    let roll_back = |backup: &serde_json::Value, current: &serde_json::Value| {
        fs::write(
            backups.join("artifacts/opencode-config"),
            serde_json::to_vec(backup).unwrap(),
        )
        .unwrap();
        fs::write(&dest, serde_json::to_vec_pretty(current).unwrap()).unwrap();
        assert!(!artifact_matches_previous_backup_state(&op, &backups, &home, &ws).unwrap());
        restore_artifact_from_backup_with_mode(
            &op,
            &backups,
            &home,
            RollbackRestoreMode::ManagedProjectionMerge,
            Some(&ws),
        )
        .unwrap();
        assert!(artifact_matches_previous_backup_state(&op, &backups, &home, &ws).unwrap());
        serde_json::from_slice::<serde_json::Value>(&fs::read(&dest).unwrap()).unwrap()
    };

    // An override pinned every role over the user's own inspector model.
    crate::commands::update_opencode_model_selection(
        "main/large".to_string(),
        "main/small".to_string(),
        Some("cheap/fast".to_string()),
        None,
    )
    .unwrap();
    record(&[]);
    let backup = serde_json::json!({"agent": {"inspector": {"model": "mine/pin"}}});
    let mut current = serde_json::json!({"agent": {}});
    for role in ["repo-scout", "inspector", "sentinel", "verifier", "scribe"] {
        current["agent"][role] = serde_json::json!({"model": "cheap/fast"});
    }
    assert_eq!(roll_back(&backup, &current), backup);

    // After a reset an apply removed the scribe model the app recorded writing.
    crate::commands::reset_opencode_model_selection().unwrap();
    record(&[("scribe", "cheap/fast")]);
    let backup = serde_json::json!({
        "agent": {"scribe": {"model": "cheap/fast"}, "inspector": {"model": "mine/pin"}}
    });
    let current = serde_json::json!({"agent": {"inspector": {"model": "mine/pin"}}});
    assert_eq!(
        roll_back(&backup, &current)["agent"]["scribe"]["model"],
        "cheap/fast"
    );

    for dir in [&home, &backups] {
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(unix)]
#[test]
fn managed_codex_rollback_never_runs_workspace_scripts() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    unsafe { std::env::remove_var("CODEX_HOME") };

    let home = temp("codex-rollback-home");
    let ws = temp("codex-rollback-ws");
    let backups = temp("codex-rollback-backups");
    let sentinel = temp("codex-rollback-sentinel");
    let malicious = format!(
        "#!/usr/bin/env python3\nopen('{}', 'w').write('executed')\n",
        sentinel.display()
    );
    for script in ["merge-codex-config.py", "ensure-codex-routing-defaults.py"] {
        fs::create_dir_all(ws.join("scripts")).unwrap();
        fs::write(ws.join("scripts").join(script), &malicious).unwrap();
    }
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(
        home.join(".codex/config.toml"),
        "approval_policy = \"never\"\n",
    )
    .unwrap();
    fs::create_dir_all(backups.join("artifacts")).unwrap();
    fs::write(
        backups.join("artifacts/codex-config"),
        "approval_policy = \"on-request\"\n",
    )
    .unwrap();
    let op = ArtifactManifestOperation {
        artifact: ArtifactId::CodexConfig,
        surface: SetupSurfaceId::CodexConfig,
        kind: OperationKind::Update,
        previous_state: PreviousState::MergeableConfigFile,
        rollback_action: RollbackAction::RestoreManagedConfigFile,
        backup_rel: Some("artifacts/codex-config".into()),
        ..Default::default()
    };

    let result = restore_artifact_from_backup_with_mode(
        &op,
        &backups,
        &home,
        RollbackRestoreMode::ManagedProjectionMerge,
        Some(&ws),
    );
    let sentinel_created = sentinel.exists();
    let restored = fs::read_to_string(home.join(".codex/config.toml")).unwrap_or_default();
    for dir in [&home, &ws, &backups] {
        let _ = fs::remove_dir_all(dir);
    }
    let _ = fs::remove_file(&sentinel);

    assert!(
        !sentinel_created,
        "a merge script inside the workspace must never run"
    );
    result.expect("the bundled merge scripts render the rollback");
    assert!(restored.contains("approval_policy"), "{restored}");
}

fn shipped_fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
    let base = temp(label);
    let home = base.join("home");
    let ws = base.join("ws");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    (base, home, ws)
}

fn write_file(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn inject_shipped(key: &str, bytes: &[u8]) -> crate::shipped_digests::test_override::Guard {
    crate::shipped_digests::test_override::inject(&crate::shipped_digests::test_override::json_for(
        key,
        &[crate::stable_digest::bytes(bytes)],
    ))
}

#[test]
fn stale_artifact_that_is_a_shipped_version_is_removed_with_or_without_a_record() {
    let (base, home, ws) = shipped_fixture("stale-shipped");
    let bundled = crate::setup_roots::bundled_root().unwrap();
    let retired = crate::managed_bootstrap::REMOVED_SKILL_NAMES[0];
    let artifact = ArtifactId::skill_md(
        SkillRoot::Claude,
        crate::artifact_registry::SkillName::new(retired).unwrap(),
    );
    let dest = artifact.resolve_dest(&home, &ws).unwrap();
    let shipped = b"a version the app shipped\n";
    let key = format!("skills/{retired}/SKILL.md");
    let _inject = inject_shipped(&key, shipped);
    let other_record = crate::stable_digest::bytes(b"an older recorded hash");
    let detect =
        |record: Option<&str>| detect_stale_artifact_state(&artifact, &ws, &bundled, &home, record);
    let remove = (OperationKind::Remove, PreviousState::ManagedFile);
    let conflict = (OperationKind::Conflict, PreviousState::Conflict);

    write_file(&dest, shipped);
    assert_eq!(detect(None), remove);
    assert_eq!(detect(Some(&other_record)), remove);
    assert_eq!(
        detect(Some(&crate::stable_digest::bytes(shipped))),
        remove,
        "a matching record is proof on its own"
    );

    // Anything the app never shipped keeps today's behaviour.
    write_file(&dest, b"the user edited this\n");
    assert_eq!(detect(None), conflict);
    assert_eq!(detect(Some(&other_record)), conflict);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn stale_artifact_ownership_ignores_metadata_that_does_not_parse() {
    let (base, home, ws) = shipped_fixture("stale-malformed");
    let bundled = crate::setup_roots::bundled_root().unwrap();
    let retired = crate::managed_bootstrap::REMOVED_SKILL_NAMES[0];
    let artifact = ArtifactId::skill_md(
        SkillRoot::Claude,
        crate::artifact_registry::SkillName::new(retired).unwrap(),
    );
    let dest = artifact.resolve_dest(&home, &ws).unwrap();
    write_file(&dest, b"a version the app shipped\n");
    let _inject = crate::shipped_digests::test_override::inject("{ not json");
    assert_eq!(
        detect_stale_artifact_state(&artifact, &ws, &bundled, &home, None),
        (OperationKind::Conflict, PreviousState::Conflict)
    );
    let _ = fs::remove_dir_all(base);
}

#[test]
fn a_shipped_copy_in_the_old_codex_folder_is_removed_whatever_else_is_installed() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    unsafe {
        std::env::remove_var("CODEX_HOME");
        std::env::remove_var("CODEX_SKILLS_PATH");
    }
    let (base, home, ws) = shipped_fixture("legacy-shipped");
    crate::test_env::set_test_user_dirs(&home);
    let bundled = crate::setup_roots::bundled_root().unwrap();
    let name = crate::artifact_registry::SkillName::new("tdd").unwrap();
    let old = ArtifactId::skill_md(SkillRoot::CodexHome, name.clone());
    let other = ArtifactId::skill_md(SkillRoot::Agents, name);
    let shipped = b"a version the app shipped\n";
    let _inject = inject_shipped("templates/skills/codex/tdd/SKILL.md", shipped);
    write_file(&old.resolve_dest(&home, &ws).unwrap(), shipped);
    let detect =
        |artifact: &ArtifactId| detect_stale_artifact_state(artifact, &ws, &bundled, &home, None);
    let remove = (OperationKind::Remove, PreviousState::ManagedFile);

    assert_eq!(detect(&old), remove);
    // A different copy in the folder Codex reads now does not change that: each file is
    // judged on its own bytes.
    write_file(
        &other.resolve_dest(&home, &ws).unwrap(),
        b"the user's own copy\n",
    );
    assert_eq!(detect(&old), remove);
    // The user's copy is not proven app-owned and is kept.
    assert_eq!(
        detect(&other),
        (OperationKind::Conflict, PreviousState::Conflict)
    );
    let _ = fs::remove_dir_all(base);
}

#[test]
fn recorded_hash_mismatch_is_an_update_only_for_a_shipped_version() {
    let (base, home, ws) = shipped_fixture("refine-shipped");
    let bundled = crate::setup_roots::bundled_root().unwrap();
    let artifact =
        ArtifactId::ClaudeAgent(crate::artifact_registry::AgentName::new("verifier").unwrap());
    let dest = artifact.resolve_dest(&home, &ws).unwrap();
    let shipped = b"an older verifier agent\n";
    let _inject = inject_shipped("templates/claude/agents/verifier.md", shipped);
    let stale_record = crate::stable_digest::bytes(b"an even older recorded hash");
    let refine = |record: Option<&str>| {
        refine_with_managed_hash(
            OperationKind::Update,
            PreviousState::ManagedFile,
            &artifact,
            &ws,
            &bundled,
            &home,
            record,
        )
    };

    write_file(&dest, shipped);
    assert_eq!(
        refine(Some(&stale_record)),
        (OperationKind::Update, PreviousState::ManagedFile)
    );
    write_file(&dest, b"the user edited this\n");
    assert_eq!(
        refine(Some(&stale_record)),
        (OperationKind::Conflict, PreviousState::Conflict)
    );
    let _ = fs::remove_dir_all(base);
}

// ── Skill files ──

fn bundled_repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
}

/// Every artifact the bundle can install, skill files in every root included, and every old
/// copy of the bundle a workspace cleanup backs up.
fn every_bundled_artifact() -> Vec<ArtifactId> {
    let repo = bundled_repo();
    let mut artifacts = Vec::new();
    for surface in SetupSurfaceId::ALL {
        artifacts.extend(expand_surface_fail_closed(*surface, &repo, &SkillScope::all()).unwrap());
    }
    artifacts.extend(
        crate::commands::retired_workspace_files::workspace_copy_paths().map(|rel| {
            ArtifactId::WorkspaceFile(crate::artifact_registry::WorkspaceRelPath::new(rel).unwrap())
        }),
    );
    artifacts
}

#[test]
fn backup_ids_are_unique_across_the_bundle_and_within_the_length_cap() {
    let artifacts = every_bundled_artifact();
    let mut seen = HashSet::new();
    for artifact in &artifacts {
        let id = artifact_backup_rel(artifact);
        assert!(id.len() <= 120, "{id}");
        assert!(seen.insert(id.clone()), "{id} names two artifacts");
    }
    assert!(artifacts.len() > 300, "{}", artifacts.len());
}

#[test]
fn skill_backup_ids_cannot_collide_through_dashes_underscores_or_slashes() {
    let file = |root, skill: &str, rel: &str| {
        artifact_backup_rel(&ArtifactId::skill_file(
            root,
            crate::artifact_registry::SkillName::new(skill).unwrap(),
            crate::artifact_registry::SkillRelPath::new(rel).unwrap(),
        ))
    };
    let ids = [
        file(SkillRoot::Claude, "a-b", "c"),
        file(SkillRoot::Claude, "a", "b-c"),
        file(SkillRoot::Claude, "a", "b/c"),
        file(SkillRoot::Claude, "a", "b__c"),
        file(SkillRoot::Claude, "a", "b_c"),
        file(SkillRoot::CodexHome, "a", "b/c"),
        file(SkillRoot::Agents, "a", "b/c"),
    ];
    let unique: HashSet<&String> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len(), "{ids:?}");
}

#[test]
fn a_backup_id_over_the_cap_keeps_a_digest_of_the_whole_id() {
    let rel = |name: &str| {
        artifact_backup_rel(&ArtifactId::WorkspaceFile(
            crate::artifact_registry::WorkspaceRelPath::new(format!(
                "docs/{}/{name}.md",
                "long-directory-name".repeat(8)
            ))
            .unwrap(),
        ))
    };
    let (first, second) = (rel("first"), rel("second"));
    assert!(first.len() <= 120 && second.len() <= 120);
    assert_ne!(
        first, second,
        "ids that differ only past the cap stay distinct"
    );
}

#[test]
fn removing_a_skill_file_removes_the_directories_it_empties_up_to_the_skill_root_only() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let base = temp("empty-skill-dirs");
    let home = base.join("home");
    fs::create_dir_all(&home).unwrap();
    crate::test_env::set_test_user_dirs(&home);
    let ws = base.join("ws");
    let name = crate::artifact_registry::SkillName::new("some-skill").unwrap();
    let artifact = |rel: &str| {
        ArtifactId::skill_file(
            SkillRoot::Claude,
            name.clone(),
            crate::artifact_registry::SkillRelPath::new(rel).unwrap(),
        )
    };
    let skills = home.join(".claude/skills");
    let clean = |artifact: &ArtifactId| {
        let dest = artifact.resolve_dest(&home, &ws).unwrap();
        fs::remove_file(&dest).unwrap();
        remove_empty_skill_directories(artifact, &dest, &home, &home).unwrap();
    };

    // Emptied directories go, from the file's own up to the skill's.
    let deep = artifact("assets/deep/page.html");
    write_file(&deep.resolve_dest(&home, &ws).unwrap(), b"x");
    clean(&deep);
    assert!(!skills.join("some-skill").exists());
    assert!(skills.is_dir(), "the skill root is never removed");

    // A foreign file keeps its directory and everything above it.
    let owned = artifact("assets/deep/page.html");
    write_file(&owned.resolve_dest(&home, &ws).unwrap(), b"x");
    write_file(&skills.join("some-skill/assets/mine.md"), b"mine");
    clean(&owned);
    assert!(!skills.join("some-skill/assets/deep").exists());
    assert!(skills.join("some-skill/assets/mine.md").is_file());

    // A sibling file of the skill keeps the skill directory.
    fs::remove_file(skills.join("some-skill/assets/mine.md")).unwrap();
    fs::remove_dir(skills.join("some-skill/assets")).unwrap();
    let md = artifact("SKILL.md");
    write_file(&md.resolve_dest(&home, &ws).unwrap(), b"x");
    write_file(&skills.join("some-skill/notes.md"), b"mine");
    clean(&md);
    assert!(skills.join("some-skill/notes.md").is_file());

    // Anything that is not a skill file is left alone.
    let rules_dir = home.join(".claude");
    remove_empty_skill_directories(&ArtifactId::ClaudeRules, &rules_dir.join("x"), &home, &home)
        .unwrap();
    assert!(rules_dir.is_dir());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn a_stale_artifact_at_a_wanted_destination_is_planned_once_as_the_wanted_one() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let (base, home, ws) = shipped_fixture("same-destination");
    crate::test_env::set_test_user_dirs(&home);
    // Codex reads the folder that older versions cleaned up as legacy: both roots coincide.
    unsafe {
        std::env::remove_var("CODEX_HOME");
        std::env::set_var("CODEX_SKILLS_PATH", home.join(".agents/skills"));
    }
    let name = crate::artifact_registry::SkillName::new("tdd").unwrap();
    let wanted = ArtifactId::skill_md(SkillRoot::CodexHome, name.clone());
    let legacy = ArtifactId::skill_md(SkillRoot::Agents, name);
    let dest = wanted.resolve_dest(&home, &ws).unwrap();
    assert_eq!(dest, legacy.resolve_dest(&home, &ws).unwrap());
    let source = fs::read(
        wanted
            .resolve_source(&crate::setup_roots::bundled_root().unwrap())
            .unwrap(),
    )
    .unwrap();
    write_file(&dest, &source);
    let state = crate::managed_state::ManagedState {
        schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
        bundled_version: crate::stable_digest::bytes(b"bundle"),
        artifacts: [&wanted, &legacy]
            .iter()
            .map(|artifact| crate::managed_state::ManagedArtifactRecord {
                identity: crate::managed_state::artifact_identity(artifact),
                hash: crate::stable_digest::bytes(&source),
                surface: None,
                role_models: Default::default(),
            })
            .collect(),
    };
    crate::managed_state::write_managed_state_atomic(&ws, &state).unwrap();

    let scope = SkillScope::of(&[SkillRoot::CodexHome]);
    let planned = plan_artifacts_for_surfaces_in(&[SetupSurfaceId::Skills], &ws, &home, &scope)
        .expect("plan");
    let for_dest: Vec<_> = planned
        .iter()
        .filter(|operation| operation.artifact.resolve_dest(&home, &ws).as_ref() == Ok(&dest))
        .collect();
    assert_eq!(for_dest.len(), 1, "{for_dest:?}");
    assert_eq!(for_dest[0].artifact, wanted);
    assert_eq!(for_dest[0].kind, OperationKind::NoChange);
    let _ = fs::remove_dir_all(base);
}
