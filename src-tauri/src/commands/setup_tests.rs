// Test-only: the `tests` module of the file next to it. The inner attribute lets the repository checks
// that read production Rust skip this file.
#![cfg(test)]

use super::*;

/// `apply_single_artifact` with the sources of `workspace_root`, as an apply holds them.
fn apply_single_artifact(
    artifact: &crate::artifact_registry::ArtifactId,
    workspace_root: &Path,
    home: &Path,
    rules_rewrite: Option<&setup_transaction::RulesRewrite>,
    overwrite: Option<&setup_transaction::Overwrite>,
) -> Result<(), String> {
    let sources = crate::skill_sources::SkillSources::for_workspace(workspace_root)?;
    super::apply_single_artifact(
        artifact,
        workspace_root,
        home,
        &sources,
        rules_rewrite,
        overwrite,
    )
}
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

#[test]
fn apply_persists_receipt_facts_and_finish_time() {
    let env = TempSetupEnv::new("receipt");
    let plan = test_plan(vec![
        (
            SetupSurfaceId::CodexRules,
            OperationKind::Create,
            "create".into(),
        ),
        (
            SetupSurfaceId::ClaudeRules,
            OperationKind::NoChange,
            "current".into(),
        ),
        (
            SetupSurfaceId::OpenCodeRules,
            OperationKind::Conflict,
            "/private/conflict text".into(),
        ),
        (
            SetupSurfaceId::ClaudeConfig,
            OperationKind::Manual,
            "/private/manual text".into(),
        ),
    ]);
    let result = apply_setup_plan_with_token(&plan, None, &mut ProgressReporter::silent());
    assert!(result.success, "{}", result.message);
    let path = env
        .setup_root()
        .join(&result.transaction_id)
        .join("manifest.json");
    let raw = fs::read_to_string(&path).expect("manifest");
    let manifest: ArtifactTransactionManifest = serde_json::from_str(&raw).expect("parse");
    assert!(manifest
        .finished_at
        .as_ref()
        .is_some_and(|time| time >= &manifest.created_at));
    assert_eq!(
        manifest.receipt,
        Some(SetupReceipt {
            synced: vec![SetupSurfaceId::ClaudeRules],
            left_for_you: vec![
                SetupReceiptItem {
                    surface: SetupSurfaceId::OpenCodeRules,
                    reason: SetupReceiptReason::Conflict
                },
                SetupReceiptItem {
                    surface: SetupSurfaceId::ClaudeConfig,
                    reason: SetupReceiptReason::Manual
                },
            ],
        })
    );
    assert!(!raw.contains("/private/conflict text"));
    assert!(!raw.contains("/private/manual text"));

    let before = fs::read(&path).unwrap();
    let dry = rollback_transaction(
        &result.transaction_id,
        true,
        &mut ProgressReporter::silent(),
    );
    assert!(dry.success, "{}", dry.message);
    assert_eq!(fs::read(&path).unwrap(), before, "dry run writes nothing");
    let undone = rollback_transaction(
        &result.transaction_id,
        false,
        &mut ProgressReporter::silent(),
    );
    assert!(undone.success, "{}", undone.message);
    let restored: ArtifactTransactionManifest =
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(
        restored.receipt, manifest.receipt,
        "rollback preserves receipt facts"
    );
}

#[test]
fn receipt_records_partial_surface_conflicts_without_claiming_it_was_current() {
    let env = TempSetupEnv::new("receipt-partial");
    let mut planned = env.plan(&[SetupSurfaceId::CodexRules]);
    let mut blocked = planned[0].clone();
    blocked.kind = OperationKind::Conflict;
    planned.push(blocked.clone());
    planned.push(blocked);
    let mut current = planned[0].clone();
    current.kind = OperationKind::NoChange;
    planned.push(current);
    let receipt = receipt_for_artifacts(&planned);
    assert!(receipt.synced.is_empty());
    assert_eq!(
        receipt.left_for_you,
        vec![SetupReceiptItem {
            surface: SetupSurfaceId::CodexRules,
            reason: SetupReceiptReason::Conflict,
        }]
    );
}

#[test]
fn old_manifest_round_trips_without_receipt_or_finish_time() {
    let env = TempSetupEnv::new("old-receipt");
    let old = serde_json::json!({
        "schema_version": ARTIFACT_MANIFEST_SCHEMA_VERSION,
        "workspace_key": setup_transaction::workspace_key(&env.ws).unwrap(),
        "created_at": "1",
        "surface_ids": ["codex_rules"],
        "transaction_status": "completed",
        "previous_managed_state_present": false,
        "previous_managed_state_trusted": false,
        "operations": [{
            "artifact": { "type": "CodexRules" },
            "surface": "codex_rules",
            "kind": "create",
            "previous_state": "absent",
            "rollback_action": "remove_created_file",
            "backup_rel": null,
            "apply_status": "applied",
            "validation_status": "passed",
            "rollback_status": "pending"
        }]
    });
    let manifest: ArtifactTransactionManifest =
        serde_json::from_value(old.clone()).expect("old manifest");
    assert!(manifest.receipt.is_none());
    assert!(manifest.finished_at.is_none());
    setup_transaction::validate_manifest(&manifest, &env.ws).expect("valid old manifest");
    let dir = env.setup_root().join("1");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("manifest.json");
    setup_transaction::persist_manifest_atomic(&path, &manifest, &dir)
        .expect("persist old manifest");
    let round_trip: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(round_trip, old);
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
        apply_single_artifact(&rules, &ws, &home, Some(&rewrite), Some(&rules_reviewed)).is_err()
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
    // The backup folder comes from the environment.
    let _env = TempSetupEnv::new("rollback-nonexistent");
    let result = rollback_transaction(
        "1234567890123456789",
        false,
        &mut ProgressReporter::silent(),
    );
    assert!(!result.success);
    assert!(result.message.contains("not found") || result.message.contains("Transaction backup"));
}

#[test]
fn setup_backup_dir_creates_missing_parent_chain() {
    let _guard = guard::lock();
    let home = std::env::temp_dir().join("aw-setup-backup-chain");
    let _ = fs::remove_dir_all(&home);
    crate::test_env::create_dir_all(&home).expect("create dir");
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

#[cfg(unix)]
#[test]
fn setup_backup_dir_reports_a_backup_entry_it_cannot_make_private() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = guard::lock();
    let _restore = guard::EnvRestore::capture();
    let home = std::env::temp_dir().join(format!("aw-setup-backup-tighten-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    let root = home.join("backups");
    crate::test_env::create_dir_all(root.join("20260101-000000")).expect("legacy run");
    // Owner write-only: it cannot be opened to drop the group and other bits.
    let stuck = root.join("20260101-000000/config");
    fs::write(&stuck, b"old").expect("legacy file");
    fs::set_permissions(&stuck, fs::Permissions::from_mode(0o266)).expect("chmod");
    set_test_user_dirs(&home);
    unsafe { std::env::set_var("RIGGVERK_BACKUP_DIR", root.to_string_lossy().as_ref()) };

    let error = setup_backup_dir("txn-tighten-test").expect_err("an entry left open");
    assert!(error.contains("config"), "{error}");

    fs::set_permissions(&stuck, fs::Permissions::from_mode(0o644)).expect("chmod");
    let dir = setup_backup_dir("txn-tighten-test").expect("every entry made private");
    assert!(dir.is_dir());
    assert_eq!(
        fs::metadata(&stuck).unwrap().permissions().mode() & 0o777,
        0o600
    );
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
    let env = TempSetupEnv::new("detect-oc-create");
    let (ws, home) = (env.ws.clone(), env.home.clone());
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
    let env = TempSetupEnv::new("detect-skills-create");
    let (ws, home) = (env.ws.clone(), env.home.clone());
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
    // CODEX_HOME is part of the environment the detection reads; the helper points it into
    // the temp home.
    let env = TempSetupEnv::new("detect-cx-invalid");
    let (ws, home) = (env.ws.clone(), env.home.clone());
    fs::create_dir_all(home.join(".codex")).expect("create codex dir");
    fs::create_dir_all(&ws).expect("create ws");
    fs::create_dir_all(ws.join("templates/codex")).expect("create templates");

    // Write invalid TOML as installed config
    fs::write(home.join(".codex/config.toml"), "not valid toml {{{").unwrap();
    fs::write(ws.join("templates/codex/config.toml"), "[profile]\n").unwrap();

    let (_surface, kind, summary) = detect_surface_state(SetupSurfaceId::CodexConfig, &ws, &home);
    assert_eq!(
        kind,
        OperationKind::Conflict,
        "invalid TOML should be Conflict, got {kind:?}: {summary}"
    );
}

// ── Preview integrity tests ──

#[test]
fn plan_fingerprint_is_stable_for_same_surface_set() {
    // The fingerprint reads settings and paths from the process environment.
    let env = TempSetupEnv::new("fingerprint-stable");
    setup_transaction::clear_preview_tokens_for_test();
    let (ws, home) = (env.ws.clone(), env.home.clone());
    fs::create_dir_all(&ws).expect("runtime");
    let surfaces = vec![SetupSurfaceId::OpenCodeRules, SetupSurfaceId::CodexRules];
    let fp1 = compute_plan_fingerprint_for_surfaces(&surfaces, &ws, &home).expect("fp1");
    let fp2 = compute_plan_fingerprint_for_surfaces(&surfaces, &ws, &home).expect("fp2");
    assert_eq!(fp1, fp2);
    assert!(setup_transaction::validate_fingerprint_format(&fp1));
}

#[test]
fn plan_fingerprint_changes_when_surfaces_differ() {
    let env = TempSetupEnv::new("fingerprint-different");
    let (ws, home) = (env.ws.clone(), env.home.clone());
    fs::create_dir_all(&ws).expect("runtime");
    let fp1 = compute_plan_fingerprint_for_surfaces(&[SetupSurfaceId::OpenCodeRules], &ws, &home)
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
        finished_at: None,
        receipt: None,
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
        finished_at: None,
        receipt: None,
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

#[cfg(unix)]
#[test]
fn a_transaction_folder_others_can_write_is_never_restored_from() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = guard::lock();
    let _restore = guard::EnvRestore::capture();
    let (base, home, ws, txn_id) = rollback_test_fixture();
    let backup_dir = seed_two_artifact_transaction(&txn_id);
    let codex = home.join(".codex/AGENTS.md");
    let before = fs::read(&codex).ok();
    let set_mode = |path: &Path, mode: u32| {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap()
    };
    for (path, open_mode, phrase) in [
        (
            backup_dir.clone(),
            0o777,
            "refusing the setup transaction folder",
        ),
        (
            backup_dir.join("manifest.json"),
            0o666,
            "refusing the setup manifest",
        ),
        (
            backup_dir.join("artifacts"),
            0o707,
            "refusing the setup backup folder",
        ),
    ] {
        let kept_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        set_mode(&path, open_mode);
        let error = reconcile_interrupted_setup_transactions(&ws, &home).unwrap_err();
        assert!(
            error.contains(phrase) && error.contains("writable by its group or by everyone"),
            "{error}"
        );
        let result = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
        assert!(
            !result.success && result.message.contains(phrase),
            "{}",
            result.message
        );
        assert!(!result.message.contains(&*backup_dir.to_string_lossy()));
        assert_eq!(fs::read(&codex).ok(), before, "nothing was restored");
        set_mode(&path, kept_mode);
    }
    let manifest = read_manifest(&txn_id);
    assert_ne!(
        manifest.transaction_status,
        setup_transaction::TransactionStatus::RolledBack
    );
    // Not writable by others again: the interrupted transaction is restored as before.
    reconcile_interrupted_setup_transactions(&ws, &home).expect("reconcile transaction");
    assert_eq!(fs::read_to_string(&codex).unwrap(), "codex-rules-backup");
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

#[cfg(unix)]
#[test]
fn retrying_a_rollback_that_failed_only_on_the_pack_record_restores_the_record() {
    let _guard = guard::lock();
    let _restore = guard::EnvRestore::capture();
    let (base, _home, ws, txn_id) = rollback_test_fixture();
    let backup_dir = seed_two_artifact_transaction(&txn_id);
    let record = crate::workspace_layout::state_file(&ws, crate::skill_sources::PACK_SKILLS_FILE);
    fs::create_dir_all(record.parent().unwrap()).unwrap();
    fs::write(&record, "written by the transaction").unwrap();
    // The snapshot cannot be read at first: the rollback restores every artifact, then
    // fails on the record.
    let snapshot = backup_dir.join("pack-skills.previous.json");
    std::os::unix::fs::symlink(base.join("elsewhere"), &snapshot).unwrap();
    let first = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());
    assert!(!first.success);
    let manifest = read_manifest(&txn_id);
    assert_eq!(
        manifest.transaction_status,
        setup_transaction::TransactionStatus::RollbackFailed
    );
    assert!(manifest
        .operations
        .iter()
        .all(|op| op.rollback_status == setup_transaction::RollbackStatus::Restored));

    fs::remove_file(&snapshot).unwrap();
    fs::write(&snapshot, "before the transaction").unwrap();
    let retry = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());

    assert!(retry.success, "{} {:?}", retry.message, retry.failed);
    assert_eq!(
        fs::read_to_string(&record).unwrap(),
        "before the transaction"
    );
    assert_eq!(
        read_manifest(&txn_id).transaction_status,
        setup_transaction::TransactionStatus::RolledBack
    );
    let _ = fs::remove_dir_all(&base);
}

#[cfg(unix)]
#[test]
fn a_rollback_retry_that_still_cannot_restore_the_records_stays_rollback_failed() {
    let _guard = guard::lock();
    let _restore = guard::EnvRestore::capture();
    let (base, _home, _ws, txn_id) = rollback_test_fixture();
    let backup_dir = seed_two_artifact_transaction(&txn_id);
    std::os::unix::fs::symlink(
        base.join("elsewhere"),
        backup_dir.join("pack-skills.previous.json"),
    )
    .unwrap();
    assert!(!rollback_transaction(&txn_id, false, &mut ProgressReporter::silent()).success);

    let retry = rollback_transaction(&txn_id, false, &mut ProgressReporter::silent());

    assert!(!retry.success);
    assert_eq!(
        read_manifest(&txn_id).transaction_status,
        setup_transaction::TransactionStatus::RollbackFailed
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
        let restore = guard::isolate_data_location_env();
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
            std::env::set_var("CODEX_HOME", base.join("home/.codex"));
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

/// Marks a finished transaction as interrupted mid-apply, as a crash would have left it.
fn mark_interrupted(env: &TempSetupEnv, transaction_id: &str) {
    let path = env.setup_root().join(transaction_id).join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("manifest")).expect("json");
    manifest["transaction_status"] = serde_json::json!("applying");
    fs::write(&path, manifest.to_string()).expect("write manifest");
}

#[test]
fn an_apply_reconciles_interrupted_transactions_before_it_checks_the_preview() {
    let env = TempSetupEnv::new("reconcile-before-check");
    let surfaces = vec!["codex_agents".to_string()];
    let plan = preview_setup(surfaces.clone()).expect("first preview");
    let first = apply_setup(
        surfaces.clone(),
        false,
        plan.plan_fingerprint,
        plan.preview_token,
    )
    .expect("first apply");
    assert!(first.success, "{}", first.message);
    let agents_dir = env.home.join(".codex/agents");
    let mut agents: Vec<PathBuf> = fs::read_dir(&agents_dir)
        .expect("agents")
        .map(|entry| entry.expect("entry").path())
        .collect();
    agents.sort();
    assert!(agents.len() >= 2, "{agents:?}");

    // The app crashed before the first apply finished, and one agent file is gone since.
    mark_interrupted(&env, &first.transaction_id);
    fs::remove_file(&agents[0]).expect("remove one agent");

    // The preview still sees the other agents as installed; the reconcile removes them.
    let plan = preview_setup(surfaces.clone()).expect("second preview");
    let err = apply_setup(
        surfaces.clone(),
        false,
        plan.plan_fingerprint,
        plan.preview_token,
    )
    .expect_err("the plan approved before the reconcile is stale");
    assert!(err.contains("fingerprint mismatch"), "{err}");

    let plan = preview_setup(surfaces.clone()).expect("third preview");
    let result = apply_setup(surfaces, false, plan.plan_fingerprint, plan.preview_token)
        .expect("third apply");
    assert!(result.success, "{}", result.message);
    for agent in &agents {
        assert!(agent.is_file(), "{}", agent.display());
    }
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
    let result = apply_planned_artifacts(&planned, vec![], None, &mut ProgressReporter::silent());
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

/// Rewrites a finished transaction as a crash after its last write and before its post-apply
/// digests were saved would have left it. `keep_expected` keeps the digest recorded before the
/// write; without it the manifest reads as one from an older version.
fn mark_crashed_before_digests(env: &TempSetupEnv, transaction_id: &str, keep_expected: bool) {
    let path = env.setup_root().join(transaction_id).join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("manifest")).expect("json");
    manifest["transaction_status"] = serde_json::json!("applying");
    for op in manifest["operations"].as_array_mut().expect("operations") {
        let op = op.as_object_mut().expect("operation");
        assert!(op.contains_key("expected_full_digest"), "{op:?}");
        op.insert("apply_status".into(), serde_json::json!("in_flight"));
        op.insert("validation_status".into(), serde_json::json!("pending"));
        op.remove("post_apply_digest");
        op.remove("post_apply_full_digest");
        if !keep_expected {
            op.remove("expected_full_digest");
        }
    }
    fs::write(&path, manifest.to_string()).expect("write manifest");
}

/// Applies the Codex rules file into an empty Codex folder: the apply creates it.
fn apply_created_codex_rules(env: &TempSetupEnv) -> (String, PathBuf) {
    let planned = env.plan(&[SetupSurfaceId::CodexRules]);
    let rules = planned
        .iter()
        .find(|p| p.artifact == ArtifactId::CodexRules)
        .expect("codex rules planned");
    assert_eq!(
        rules.rollback_action,
        setup_transaction::RollbackAction::RemoveCreatedFile
    );
    let result = apply_planned_artifacts(&planned, vec![], None, &mut ProgressReporter::silent());
    assert!(result.success, "apply: {}", result.message);
    (result.transaction_id, env.home.join(".codex/AGENTS.md"))
}

#[test]
fn reconcile_keeps_user_additions_to_a_file_created_before_a_crash() {
    for keep_expected in [true, false] {
        let env = TempSetupEnv::new("crash-created-additions");
        let (transaction_id, rules) = apply_created_codex_rules(&env);
        mark_crashed_before_digests(&env, &transaction_id, keep_expected);
        // The user adds their own text around the block before the next launch.
        let mut text = fs::read_to_string(&rules).expect("rules");
        text.push_str("\nMy own notes\n");
        fs::write(&rules, &text).expect("user addition");

        reconcile_interrupted_setup_transactions(&env.ws, &env.home)
            .expect("a kept file must not block setup");

        assert_eq!(
            fs::read_to_string(&rules).expect("the created file is kept"),
            text,
            "keep_expected={keep_expected}"
        );
        let manifest: ArtifactTransactionManifest = serde_json::from_str(
            &fs::read_to_string(env.setup_root().join(&transaction_id).join("manifest.json"))
                .expect("manifest"),
        )
        .expect("parse");
        assert_eq!(
            manifest.transaction_status,
            setup_transaction::TransactionStatus::RollbackFailed
        );
    }
}

#[test]
fn reconcile_removes_a_file_created_before_a_crash_when_it_is_exactly_the_output() {
    let env = TempSetupEnv::new("crash-created-untouched");
    let (transaction_id, rules) = apply_created_codex_rules(&env);
    mark_crashed_before_digests(&env, &transaction_id, true);

    reconcile_interrupted_setup_transactions(&env.ws, &env.home).expect("reconcile");

    assert!(!rules.exists(), "the file the app created is removed");
}

#[test]
fn explicit_rollback_of_a_crashed_apply_removes_the_file_once_it_is_the_output_again() {
    let env = TempSetupEnv::new("crash-explicit-rollback");
    let (transaction_id, rules) = apply_created_codex_rules(&env);
    mark_crashed_before_digests(&env, &transaction_id, true);
    let output = fs::read_to_string(&rules).expect("rules");
    // The reconcile keeps the file while the user's addition is in it.
    fs::write(&rules, format!("{output}\nMy own notes\n")).expect("user addition");
    reconcile_interrupted_setup_transactions(&env.ws, &env.home).expect("reconcile");
    assert!(rules.is_file());

    // The user takes the addition out again and asks for the undo.
    fs::write(&rules, &output).expect("addition removed");
    let result = rollback_transaction(&transaction_id, false, &mut ProgressReporter::silent());

    assert!(result.success, "{} {:?}", result.message, result.failed);
    assert!(!rules.exists(), "the file the app created is removed");
}

#[test]
fn the_digest_recorded_before_each_write_is_the_written_file() {
    let env = TempSetupEnv::new("expected-digest");
    let mut settings = crate::settings::load();
    settings
        .enabled_target_ids
        .push("claude_config".to_string());
    crate::settings::save_with_revision_check(settings, None).expect("settings");
    // A settings.json to merge into, beside files created from nothing.
    fs::create_dir_all(env.home.join(".claude")).expect("claude folder");
    fs::write(
        env.home.join(".claude/settings.json"),
        "{\n  \"model\": \"opus\"\n}\n",
    )
    .expect("settings.json");
    let planned = env.plan(&[
        SetupSurfaceId::CodexRules,
        SetupSurfaceId::ClaudeConfig,
        SetupSurfaceId::CodexAgents,
    ]);
    let kinds: Vec<_> = planned.iter().map(|p| (&p.artifact, p.kind)).collect();
    assert!(
        kinds.contains(&(&ArtifactId::ClaudeSettings, OperationKind::Update)),
        "{kinds:?}"
    );
    assert!(kinds.contains(&(&ArtifactId::CodexRules, OperationKind::Create)));
    let result = apply_planned_artifacts(&planned, vec![], None, &mut ProgressReporter::silent());
    assert!(result.success, "apply: {}", result.message);
    let manifest: ArtifactTransactionManifest = serde_json::from_str(
        &fs::read_to_string(
            env.setup_root()
                .join(&result.transaction_id)
                .join("manifest.json"),
        )
        .expect("manifest"),
    )
    .expect("parse");
    assert!(manifest.operations.len() > 2);
    for op in &manifest.operations {
        assert!(op.expected_full_digest.is_some(), "{:?}", op.artifact);
        assert_eq!(
            op.expected_full_digest, op.post_apply_full_digest,
            "{:?}",
            op.artifact
        );
    }
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
    explicit_rollback_refuses_with_a_newer(setup_transaction::TransactionStatus::Completed);
}

#[test]
fn explicit_rollback_refuses_when_a_newer_rollback_failed() {
    // Its leftover artifacts are still recorded in the managed state the older undo would
    // restore its snapshot over.
    explicit_rollback_refuses_with_a_newer(setup_transaction::TransactionStatus::RollbackFailed);
}

fn explicit_rollback_refuses_with_a_newer(status: setup_transaction::TransactionStatus) {
    let _guard = guard::lock();
    let _restore = guard::EnvRestore::capture();
    let (base, home, _ws, older) = rollback_test_fixture();
    let newer = "9876543210987654322";
    seed_two_artifact_transaction(&older);
    let backup_dir = seed_two_artifact_transaction(newer);
    let mut manifest = read_manifest(newer);
    manifest.transaction_status = status;
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
            result.message.contains("newer transaction") && result.message.contains(newer),
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
    let (untouched, edited) = (stale_skill("agent-report-review"), stale_skill("caveman"));
    let mut records = Vec::new();
    for (artifact, installed_by_app) in [(&untouched, "app copy"), (&edited, "app copy")] {
        let dest = artifact.resolve_dest(&env.home, &env.ws).unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, installed_by_app).unwrap();
        records.push(crate::managed_state::ManagedArtifactRecord {
            identity: crate::managed_state::artifact_identity(artifact),
            hash: crate::stable_digest::bytes(installed_by_app.as_bytes()),
            surface: None,
            role_models: Default::default(),
            owned_values: None,
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
            role_models: Default::default(),
            owned_values: None,
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
            role_models: Default::default(),
            owned_values: None,
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
    assert_eq!(installed["model"], user_config["model"]);
    assert_eq!(installed["small_model"], user_config["small_model"]);

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

// ── File counts of the review ──

#[test]
fn a_surface_of_several_files_says_how_many_it_writes() {
    let env = TempSetupEnv::new("file-count-lines");
    let surfaces: Vec<String> = vec![
        "claude_agents".into(),
        "claude_rules".into(),
        "open_code_config".into(),
    ];
    let plan = preview_setup(surfaces.clone()).expect("preview");
    let details = |surface: SetupSurfaceId| {
        plan.operations
            .iter()
            .find(|planned| planned.surface == surface)
            .expect("planned")
            .details
            .clone()
    };
    // One file is the row of its surface.
    assert!(details(SetupSurfaceId::ClaudeRules).is_empty());
    assert_eq!(
        details(SetupSurfaceId::OpenCodeConfig),
        [
            "+ ~/.config/opencode (2 files)",
            "+ ~/.config/playwright-mcp/config.json"
        ]
    );

    // The count is the number of files the apply writes.
    let result = apply_setup(
        surfaces,
        true,
        plan.plan_fingerprint.clone(),
        plan.preview_token.clone(),
    )
    .expect("apply");
    assert!(result.success, "{}", result.message);
    let agents = fs::read_dir(env.home.join(".claude/agents"))
        .expect("agents folder")
        .count();
    assert!(agents > 1, "{agents}");
    assert_eq!(
        details(SetupSurfaceId::ClaudeAgents),
        [format!("+ ~/.claude/agents ({agents} files)")]
    );
    let again = preview_setup(vec!["claude_agents".into()]).expect("preview again");
    assert!(again.operations.iter().all(|op| op.details.is_empty()));
}

#[test]
fn file_count_lines_group_the_files_by_kind_and_folder() {
    let home = Path::new("/home/u");
    let at = |kind: OperationKind, rel: &str| (kind, home.join(rel));
    assert_eq!(
        file_count_lines(
            &[
                at(OperationKind::Create, ".claude/agents/new.md"),
                at(OperationKind::Update, ".claude/agents/inspector.md"),
                at(OperationKind::Update, ".claude/agents/verifier.md"),
                at(OperationKind::Remove, ".claude/agents/old.md"),
            ],
            home
        ),
        [
            "+ ~/.claude/agents/new.md",
            "~ ~/.claude/agents (2 files)",
            "- ~/.claude/agents/old.md"
        ]
    );
}

// ── OpenCode review lines ──

fn opencode_op(plan: &SetupPlan) -> &PlannedOperation {
    plan.operations
        .iter()
        .find(|op| matches!(op.surface, SetupSurfaceId::OpenCodeConfig))
        .expect("the OpenCode config is planned")
}

/// A user's own `opencode.json` and `tui.json` with values for keys Riggverk manages.
fn write_own_opencode_profile(env: &TempSetupEnv, playwright: &str, lsp: &str) {
    let dir = env.home.join(".config/opencode");
    fs::create_dir_all(&dir).unwrap();
    let config = format!(
        r#"{{
    "$schema": "https://opencode.ai/config.json",
    "theme": "tokyonight",
    "model": "anthropic/claude-sonnet-4-5",
    "default_agent": "build",
    "share": "manual",
    "autoupdate": false,
    "permission": {{
        "edit": "allow",
        "bash": {{ "git push*": "ask", "*": "allow" }},
        "webfetch": "allow"
    }},
    "lsp": {lsp},
    "watcher": {{ "ignore": ["priv/static/**"] }},
    "mcp": {{
        "github": {{ "type": "remote", "url": "https://example.invalid/mcp" }},
        "playwright": {playwright}
    }}
}}
"#
    );
    fs::write(dir.join("opencode.json"), config).unwrap();
    fs::write(
        dir.join("tui.json"),
        "{\n  \"theme\": \"gruvbox\",\n  \"mouse\": false\n}\n",
    )
    .unwrap();
}

#[test]
fn opencode_review_names_every_managed_key_the_install_changes() {
    let env = TempSetupEnv::new("opencode-review-keys");
    write_own_opencode_profile(
        &env,
        r#"{ "type": "local", "command": ["npx", "@playwright/mcp@latest", "--extension"] }"#,
        r#"{ "elixir-ls": { "command": ["/opt/elixir-ls/language_server.sh"], "extensions": [".ex", ".exs"] } }"#,
    );

    let plan = preview_setup(vec!["open_code_config".into()]).expect("preview");
    let op = opencode_op(&plan);
    assert_eq!(op.kind, OperationKind::Update);
    assert_eq!(
            op.details,
            [
                "~ opencode.json share (now \"manual\"; becomes \"disabled\")",
                "~ opencode.json autoupdate (now false; becomes \"notify\")",
                "~ opencode.json snapshot (not set now; becomes true)",
                "~ opencode.json default_agent (now \"build\"; becomes \"architect\")",
                "~ opencode.json lsp (now your settings with 1 entry: elixir-ls; becomes true)",
                "~ opencode.json compaction (not set now; becomes Riggverk's settings with 3 entries: auto, prune, reserved)",
                "~ opencode.json watcher (now your settings with 1 entry: ignore; becomes Riggverk's settings with 1 entry: ignore)",
                "~ opencode.json permission (now your settings with 3 entries: edit, bash, webfetch; becomes Riggverk's settings with 17 entries: *, external_directory, doom_loop, ...)",
                "~ opencode.json mcp.playwright (your entry is replaced by Riggverk's)",
                "~ opencode.json agent.plan.permission (not set now; becomes Riggverk's settings with 5 entries: question, plan_exit, task, ...)",
                "~ opencode.json agent.explore.permission (not set now; becomes Riggverk's settings with 17 entries: *, external_directory, doom_loop, ...)",
                "~ tui.json $schema (not set now; becomes \"https://opencode.ai/tui.json\")",
                "~ tui.json theme (now \"gruvbox\"; becomes \"system\")",
                "~ tui.json leader_timeout (not set now; becomes 2000)",
                "~ tui.json scroll_acceleration (not set now; becomes Riggverk's settings with 1 entry: enabled)",
                "~ tui.json diff_style (not set now; becomes \"auto\")",
                "~ tui.json mouse (now false; becomes true)",
                "+ ~/.config/playwright-mcp/config.json (new file)",
            ]
        );

    // The lines describe the write: what was not listed stays, and the next review is clean.
    let result = apply_setup(
        vec!["open_code_config".into()],
        true,
        plan.plan_fingerprint.clone(),
        plan.preview_token.clone(),
    )
    .expect("apply");
    assert!(result.success, "{}", result.message);
    let installed: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(env.home.join(".config/opencode/opencode.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(installed["theme"], "tokyonight");
    assert_eq!(installed["model"], "anthropic/claude-sonnet-4-5");
    assert_eq!(installed["mcp"]["github"]["type"], "remote");
    let again = preview_setup(vec!["open_code_config".into()]).expect("preview again");
    assert!(again.synced.contains(&SetupSurfaceId::OpenCodeConfig));
    assert!(again.operations.iter().all(|op| op.details.is_empty()));
}

#[test]
fn opencode_review_never_shows_a_secret_of_an_mcp_entry_or_an_object_value() {
    const MCP_SECRET: &str = "sk-live-mcp-secret-0123456789";
    const LSP_SECRET: &str = "lsp-env-secret-9876543210";
    let env = TempSetupEnv::new("opencode-review-secret");
    write_own_opencode_profile(
        &env,
        &format!(
            r#"{{ "type": "local", "command": ["npx", "@playwright/mcp", "--token={MCP_SECRET}"],
                     "environment": {{ "API_KEY": "{MCP_SECRET}" }},
                     "headers": {{ "Authorization": "Bearer {MCP_SECRET}" }} }}"#
        ),
        &format!(
            r#"{{ "gopls": {{ "command": ["gopls"], "env": {{ "GOPROXY_TOKEN": "{LSP_SECRET}" }} }} }}"#
        ),
    );

    let plan = preview_setup(vec!["open_code_config".into()]).expect("preview");
    let details = &opencode_op(&plan).details;
    assert!(details.contains(
        &"~ opencode.json mcp.playwright (your entry is replaced by Riggverk's)".to_string()
    ));
    assert!(details.contains(
        &"~ opencode.json lsp (now your settings with 1 entry: gopls; becomes true)".to_string()
    ));
    let text = serde_json::to_string(&plan).unwrap();
    for secret in [MCP_SECRET, LSP_SECRET, "GOPROXY_TOKEN", "API_KEY", "Bearer"] {
        assert!(!text.contains(secret), "the review shows {secret}");
    }
}

#[test]
fn opencode_review_of_a_fresh_install_has_no_key_lines() {
    let _env = TempSetupEnv::new("opencode-review-fresh");
    let plan = preview_setup(vec!["open_code_config".into()]).expect("preview");
    let op = opencode_op(&plan);
    assert_eq!(op.kind, OperationKind::Create);
    // Only the files it creates: nothing of the user's is replaced.
    assert!(
        op.details
            .iter()
            .all(|line| line.starts_with("+ ~/.config/")),
        "{:?}",
        op.details
    );
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
    let plan = preview_setup(vec!["cursor_agents".into(), "cursor_mcp".into()]).expect("preview");
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
    let plan = preview_setup(vec!["cursor_agents".into(), "claude_rules".into()]).expect("preview");
    let surfaces: Vec<SetupSurfaceId> = plan.operations.iter().map(|op| op.surface).collect();
    assert_eq!(surfaces, vec![SetupSurfaceId::ClaudeRules]);
}

#[test]
fn a_skill_or_agent_file_edited_after_the_backup_is_not_overwritten() {
    let env = TempSetupEnv::new("unchanged-since-backup");
    let agent =
        ArtifactId::ClaudeAgent(crate::artifact_registry::AgentName::new("inspector").unwrap());
    let dest = agent.resolve_dest(&env.home, &env.ws).expect("dest");
    fs::create_dir_all(dest.parent().unwrap()).expect("agents dir");
    fs::write(&dest, "backed up\n").expect("installed");
    let backup_dir = env.base.join("backup");
    let rel = setup_transaction::backup_artifact(&agent, &backup_dir, &env.home, &env.ws)
        .expect("backup")
        .expect("backed up");
    let check =
        || ensure_unchanged_since_backup(&agent, Some(&rel), &backup_dir, &env.ws, &env.home);
    check().expect("untouched since the backup");

    fs::write(&dest, "edited by the user\n").expect("external edit");
    let err = check().expect_err("an edit after the backup must stop the write");
    assert!(err.contains("changed during apply"), "{err}");
    assert_eq!(fs::read_to_string(&dest).unwrap(), "edited by the user\n");

    // Nothing was backed up: a file that appeared since is the user's too.
    let err = ensure_unchanged_since_backup(&agent, None, &backup_dir, &env.ws, &env.home)
        .expect_err("a file created after the backup must stop the write");
    assert!(err.contains("changed during apply"), "{err}");
    fs::remove_file(&dest).expect("remove");
    ensure_unchanged_since_backup(&agent, None, &backup_dir, &env.ws, &env.home)
        .expect("still absent");

    // Merged config files are not skill or agent files and keep their own flows.
    ensure_unchanged_since_backup(
        &ArtifactId::ClaudeRules,
        None,
        &backup_dir,
        &env.ws,
        &env.home,
    )
    .expect("not a skill or agent file");
}

#[test]
fn apply_with_only_target_disabled_surfaces_asks_for_a_new_preview() {
    let env = TempSetupEnv::new("gate-apply");
    disable_targets(&["cursor_setup"]);
    // Even with a fingerprint and token from an earlier preview: the reviewed scope is gone.
    let err = apply_setup(
        vec!["cursor_mcp".into()],
        false,
        Some("a".repeat(64)),
        Some("token".into()),
    )
    .expect_err("a scope emptied by gating must not report a successful apply");
    assert!(err.contains("Re-run preview"), "error: {err}");
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

/// Only the entry the app inserts is scanned for credentials: another server of the user's
/// with a token in `env`, or any word holding `sk-`, neither fails the apply nor is changed.
#[test]
fn cursor_mcp_merge_never_scans_the_users_other_servers() {
    for (label, content) in [
        (
            "token",
            r#"{"mcpServers":{"github":{"command":"gh-mcp","env":{"GITHUB_TOKEN":"abc123"}}}}"#,
        ),
        (
            "disk",
            r#"{"mcpServers":{"fs":{"command":"fs-mcp","args":["--disk-cache"]}}}"#,
        ),
    ] {
        let env = TempSetupEnv::new(&format!("cursor-mcp-user-{label}"));
        let path = seed_cursor_mcp(&env, content);
        let planned = env.plan(&[SetupSurfaceId::CursorMcp]);
        assert_eq!(planned[0].kind, OperationKind::Update, "{label}");

        let result = apply_cursor_mcp();
        assert!(result.success, "{label}: {}", result.message);
        let before: serde_json::Value = serde_json::from_str(content).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let user_server = server_names(&before)[0];
        assert_eq!(
            after["mcpServers"][user_server], before["mcpServers"][user_server],
            "{label}"
        );
        assert!(after["mcpServers"]["playwright"].is_object(), "{label}");
    }
}

#[test]
fn a_user_server_with_a_token_does_not_roll_back_the_rest_of_the_install() {
    let env = TempSetupEnv::new("cursor-mcp-user-token-whole");
    seed_cursor_mcp(
        &env,
        r#"{"mcpServers":{"fs":{"command":"fs-mcp","args":["--disk-cache"]}}}"#,
    );
    let surfaces = vec!["claude_rules".to_string(), "cursor_mcp".to_string()];
    let plan = preview_setup(surfaces.clone()).expect("preview");
    let result = apply_setup(
        surfaces,
        true,
        plan.plan_fingerprint.clone(),
        plan.preview_token.clone(),
    )
    .expect("apply");
    assert!(result.success, "{}", result.message);
    assert!(env.home.join(".claude/CLAUDE.md").is_file());
}

/// A `playwright` entry of the user's own that differs from the app's, without a record that
/// the app wrote it, is a conflict and stays as it is (as for Copilot, Pi and Kilo).
#[test]
fn a_differing_cursor_playwright_entry_without_a_record_is_a_conflict() {
    let env = TempSetupEnv::new("cursor-mcp-own-playwright");
    let content = r#"{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest","--headless"]}}}"#;
    let path = seed_cursor_mcp(&env, content);

    let planned = env.plan(&[SetupSurfaceId::CursorMcp]);
    assert_eq!(planned.len(), 1, "{planned:?}");
    assert_eq!(planned[0].kind, OperationKind::Conflict);
    assert_eq!(
        planned[0].previous_state,
        setup_transaction::PreviousState::Conflict
    );

    let plan = preview_setup(vec!["cursor_mcp".into()]).expect("preview");
    if !plan.is_blocked {
        let _ = apply_setup(
            vec!["cursor_mcp".into()],
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        );
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
}

/// The transaction backs `mcp.json` up; the apply makes no second, untracked copy beside it.
#[test]
fn cursor_mcp_apply_backs_the_file_up_only_in_its_transaction() {
    let env = TempSetupEnv::new("cursor-mcp-one-backup");
    seed_cursor_mcp(&env, CURSOR_USER_MCP);

    let result = apply_cursor_mcp();
    assert!(result.success, "{}", result.message);

    let root = backup_root().expect("backup root");
    let runs: Vec<String> = fs::read_dir(&root)
        .expect("backup root")
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(runs, vec!["setup".to_string()], "{runs:?}");
    let copies = fs::read_dir(env.setup_root().join(&result.transaction_id))
        .expect("transaction backup")
        .count();
    assert!(copies > 0, "the transaction holds the backup");
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

/// An installed file the way an older app wrote it (`older` turns the current entry into
/// that app's), and the record that app made of it.
fn as_the_older_app_wrote_it(
    env: &TempSetupEnv,
    artifact: &ArtifactId,
    path: &Path,
    older: fn(&serde_json::Value) -> serde_json::Value,
) {
    let text = fs::read_to_string(path).expect("installed file");
    let current: serde_json::Value = serde_json::from_str(&text).expect("installed JSON");
    let older = older(&current);
    assert_ne!(older, current, "the installed file must be the current one");
    let older_text = serde_json::to_string_pretty(&older).expect("serialize") + "\n";
    fs::write(path, older_text).expect("write the older entry");
    let digest =
        crate::setup_fingerprint::artifact_installed_managed_digest(artifact, &env.ws, &env.home)
            .expect("digest of the installed entry");
    let mut state = crate::managed_state::read_managed_state(&env.ws).expect("managed state");
    let identity = crate::managed_state::artifact_identity(artifact);
    let record = state
        .artifacts
        .iter_mut()
        .find(|record| record.identity == identity)
        .expect("the apply recorded the artifact");
    record.hash = digest;
    crate::managed_state::write_managed_state_atomic(&env.ws, &state).expect("write managed state");
}

#[cfg(unix)]
#[test]
fn config_files_are_private_when_new_and_preserve_existing_modes() {
    use std::os::unix::fs::PermissionsExt;
    let env = TempSetupEnv::new("config-modes");
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    for (artifact, rel) in [
        (ArtifactId::CodexConfig, ".codex/config.toml"),
        (ArtifactId::OpenCodeConfig, ".config/opencode/opencode.json"),
        (ArtifactId::CursorMcp, ".cursor/mcp.json"),
    ] {
        let path = env.home.join(rel);
        apply_single_artifact(&artifact, &env.ws, &env.home, None, None).expect("create");
        assert_eq!(mode(&path), 0o600, "{artifact:?}");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        apply_single_artifact(&artifact, &env.ws, &env.home, None, None).expect("update");
        assert_eq!(mode(&path), 0o644, "{artifact:?}");
    }
}

#[test]
fn a_playwright_entry_from_an_older_app_is_an_update_not_a_conflict() {
    let env = TempSetupEnv::new("previous-playwright-pin");
    let pin = crate::commands::cursor_profile::PLAYWRIGHT_MCP_VERSION;
    // The previous pin and the flags of that time (`--config` only, without the Chrome
    // selection and `--no-webmcp`), and later `npx --prefix <folder> -y ...` started in the
    // harness's working folder.
    let older_apps: [fn(&serde_json::Value) -> serde_json::Value; 2] = [
        crate::commands::cursor_profile::as_the_previous_app_wrote_it,
        crate::commands::cursor_profile::as_the_npx_prefix_app_wrote_it,
    ];
    for ((wire, surface, artifact, rel), older) in [
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
    ]
    .into_iter()
    .flat_map(|surface| older_apps.map(|older| (surface.clone(), older)))
    {
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
        let path = env.home.join(rel);
        if !path.exists() {
            let result = apply();
            assert!(result.success, "{wire}: {}", result.message);
        }
        as_the_older_app_wrote_it(&env, &artifact, &path, older);

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
        let lists = crate::commands::cursor_profile::playwright_command_lines(&installed);
        assert_eq!(lists.len(), 1, "{wire}: {lists:?}");
        assert!(
            lists[0]
                .windows(crate::commands::cursor_profile::PLAYWRIGHT_MCP_BROWSER_FLAGS.len())
                .any(|window| window
                    == crate::commands::cursor_profile::PLAYWRIGHT_MCP_BROWSER_FLAGS),
            "{wire}: the Chrome selection and the WebMCP flag must be added: {lists:?}"
        );
        assert_eq!(
            lists[0][..3],
            [
                "/bin/sh",
                "-c",
                crate::commands::cursor_profile::PLAYWRIGHT_NPX_SCRIPT
            ],
            "{wire}: npx must start in the output folder: {lists:?}"
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

// ── A skill is one unit: its SKILL.md decides whose it is ──

use crate::skill_roots::SkillRoot;

/// Folders where a user may hold their own copy of a skill the app bundles too.
const USER_SKILL_ROOTS: [(&str, SkillRoot); 3] = [
    (".agents/skills", SkillRoot::Agents),
    (".claude/skills", SkillRoot::Claude),
    (".codex/skills", SkillRoot::CodexHome),
];

fn bundled_skill_dir(env: &TempSetupEnv, name: &str) -> PathBuf {
    crate::setup_roots::bundled_root_for(&env.ws)
        .expect("bundled root")
        .join("skills")
        .join(name)
}

/// Every file under `dir` with the digest of its bytes, by path relative to `dir`.
fn snapshot_files(dir: &Path) -> Vec<(PathBuf, String)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(PathBuf, String)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let rel = path.strip_prefix(base).unwrap().to_path_buf();
                out.push((rel, crate::stable_digest::file(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// Cloudflare's `security-audit` skill as the user installed it from upstream: every file but
/// `SKILL.md` is byte-identical to the vendored copy, and upstream has a `README.md` and no
/// `UPSTREAM.md`.
fn seed_upstream_security_audit(env: &TempSetupEnv, root: &str) -> PathBuf {
    let source = bundled_skill_dir(env, "security-audit");
    let dest = env.home.join(root).join("security-audit");
    fs::create_dir_all(&dest).unwrap();
    for entry in fs::read_dir(&source).unwrap().flatten() {
        let name = entry.file_name();
        if name == "SKILL.md" || name == "UPSTREAM.md" || !entry.path().is_file() {
            continue;
        }
        fs::copy(entry.path(), dest.join(&name)).unwrap();
    }
    fs::write(
        dest.join("SKILL.md"),
        "---\nname: security-audit\ndescription: the upstream version\n---\n# upstream\n",
    )
    .unwrap();
    fs::write(dest.join("README.md"), "upstream readme\n").unwrap();
    dest
}

fn install_skills() {
    let plan = preview_setup(vec!["skills".into()]).expect("preview");
    let result = apply_setup(
        vec!["skills".into()],
        true,
        plan.plan_fingerprint,
        plan.preview_token,
    )
    .expect("apply");
    assert!(result.success, "install: {}", result.message);
}

/// Previews a full uninstall and applies it when it removes anything.
fn uninstall_all() -> UninstallPlanView {
    let view = preview_uninstall().expect("preview uninstall");
    if view.plan_fingerprint.is_some() {
        let result = apply_uninstall(view.plan_fingerprint.clone(), view.preview_token.clone())
            .expect("uninstall");
        assert!(result.success, "uninstall: {}", result.message);
    }
    view
}

fn listed_under(items: &[UninstallItem], dir: &Path) -> Vec<String> {
    items
        .iter()
        .filter(|item| Path::new(&item.path).starts_with(dir))
        .map(|item| item.path.clone())
        .collect()
}

fn skill_record_identities(root: SkillRoot, skill: &str, names: &[&str]) -> Vec<String> {
    names
        .iter()
        .map(|name| {
            crate::managed_state::artifact_identity(&ArtifactId::skill_file(
                root,
                crate::artifact_registry::SkillName::new(skill).unwrap(),
                crate::artifact_registry::SkillRelPath::new(*name).unwrap(),
            ))
        })
        .collect()
}

fn recorded(env: &TempSetupEnv, identity: &str) -> bool {
    crate::managed_state::read_managed_state(&env.ws)
        .is_some_and(|state| state.artifacts.iter().any(|r| r.identity == identity))
}

#[test]
fn uninstall_without_any_install_leaves_a_users_own_skill_whole() {
    for (root, _) in USER_SKILL_ROOTS {
        let env = TempSetupEnv::new("unit-uninstall-no-install");
        let dest = seed_upstream_security_audit(&env, root);
        let before = snapshot_files(&dest);

        let view = uninstall_all();

        assert_eq!(
            listed_under(&view.removable, &dest),
            Vec::<String>::new(),
            "{root}: {}",
            view.summary
        );
        // Every file the bundle has too is reported as kept, not only the user's SKILL.md.
        let preserved = listed_under(&view.preserved, &dest);
        for (rel, _) in &before {
            if bundled_skill_dir(&env, "security-audit")
                .join(rel)
                .is_file()
            {
                // Compared as paths: `root` uses `/`, which Windows paths mix with `\`.
                let path = dest.join(rel);
                assert!(
                    preserved.iter().any(|kept| Path::new(kept) == path),
                    "{root}: {} not preserved",
                    path.display()
                );
            }
        }
        assert_eq!(snapshot_files(&dest), before, "{root}");
    }
}

#[test]
fn install_leaves_a_users_own_skill_untouched_and_uninstall_keeps_it_whole() {
    for (root, skill_root) in USER_SKILL_ROOTS {
        let env = TempSetupEnv::new("unit-install-upstream");
        let dest = seed_upstream_security_audit(&env, root);
        let before = snapshot_files(&dest);

        install_skills();

        assert_eq!(
            snapshot_files(&dest),
            before,
            "{root}: install wrote into the user's skill"
        );
        let mut names: Vec<String> = before
            .iter()
            .map(|(rel, _)| rel.display().to_string())
            .collect();
        names.push("UPSTREAM.md".to_string());
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        for identity in skill_record_identities(skill_root, "security-audit", &names) {
            assert!(
                !recorded(&env, &identity),
                "{root}: install adopted {identity}"
            );
        }

        let view = uninstall_all();

        assert!(
            !view.removable.is_empty(),
            "{root}: the app's own skills are removable"
        );
        assert_eq!(
            listed_under(&view.removable, &dest),
            Vec::<String>::new(),
            "{root}: {}",
            view.summary
        );
        assert_eq!(snapshot_files(&dest), before, "{root}");
    }
}

#[test]
fn install_then_uninstall_on_a_clean_profile_removes_every_installed_skill_file() {
    let env = TempSetupEnv::new("unit-clean-profile");
    install_skills();
    assert!(env
        .home
        .join(".agents/skills/security-audit/UPSTREAM.md")
        .is_file());

    uninstall_all();

    for (root, _) in USER_SKILL_ROOTS {
        assert_eq!(
            snapshot_files(&env.home.join(root))
                .into_iter()
                .map(|(rel, _)| rel)
                .collect::<Vec<_>>(),
            Vec::<PathBuf>::new(),
            "{root}"
        );
    }
}

#[test]
fn uninstall_of_an_app_installed_skill_keeps_only_what_the_user_edited_or_added() {
    let env = TempSetupEnv::new("unit-owned-skill");
    install_skills();
    let dir = env.home.join(".agents/skills/security-audit");
    fs::write(dir.join("HUNTING.md"), "my own hunting notes\n").unwrap();
    fs::write(dir.join("NOTES.md"), "mine\n").unwrap();

    uninstall_all();

    assert!(!dir.join("SKILL.md").exists());
    assert!(!dir.join("UPSTREAM.md").exists());
    assert!(!dir.join("ATTACK-CLASSES.md").exists());
    assert_eq!(
        fs::read_to_string(dir.join("HUNTING.md")).unwrap(),
        "my own hunting notes\n"
    );
    assert_eq!(fs::read_to_string(dir.join("NOTES.md")).unwrap(), "mine\n");
}

#[test]
fn taking_the_bundled_skill_md_lets_the_next_install_complete_the_skill() {
    let env = TempSetupEnv::new("unit-take-bundled");
    let dest = seed_upstream_security_audit(&env, ".agents/skills");
    install_skills();
    assert!(!dest.join("UPSTREAM.md").exists());

    let key = format!("skill:{}:security-audit", SkillRoot::Agents.label());
    let preview =
        crate::commands::file_conflicts::preview_take_bundled("skills".into(), vec![key.clone()])
            .expect("preview take bundled");
    let taken = crate::commands::file_conflicts::apply_take_bundled(
        "skills".into(),
        vec![key],
        Some(preview.plan_fingerprint),
        Some(preview.preview_token),
    )
    .expect("take bundled");
    assert!(taken.success, "take bundled: {}", taken.message);
    install_skills();

    let bundled = bundled_skill_dir(&env, "security-audit");
    for (rel, digest) in snapshot_files(&bundled) {
        assert_eq!(
            crate::stable_digest::file(&dest.join(&rel)).ok(),
            Some(digest),
            "{} not installed",
            rel.display()
        );
    }

    uninstall_all();

    assert_eq!(
        snapshot_files(&dest)
            .into_iter()
            .map(|(rel, _)| rel)
            .collect::<Vec<_>>(),
        vec![PathBuf::from("README.md")]
    );
}
