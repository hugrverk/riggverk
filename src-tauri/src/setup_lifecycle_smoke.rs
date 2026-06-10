//! Isolated setup lifecycle smoke (no webview). Run via `scripts/smoke-tauri-runtime.sh`.

#[cfg(test)]
mod tests {
    use crate::setup_lifecycle::OperationKind;
    use crate::setup_transaction::{
        clear_preview_tokens_for_test, validate_preview_token, PreviewPurpose,
    };
    use crate::test_env::guard;
    use crate::{
        preview_repair_setup, preview_setup, repair_setup_command, rollback_setup_transaction,
    };
    use std::fs;
    use std::path::PathBuf;

    fn smoke_enabled() -> bool {
        std::env::var("AGENT_WORKSPACE_SMOKE").ok().as_deref() == Some("1")
    }

    fn smoke_workspace() -> PathBuf {
        PathBuf::from(
            std::env::var("AGENT_WORKSPACE_PATH").expect("AGENT_WORKSPACE_PATH for smoke"),
        )
    }

    fn smoke_home() -> PathBuf {
        PathBuf::from(std::env::var("HOME").expect("HOME for smoke"))
    }

    #[test]
    fn smoke_preview_token_survives_stale_fingerprint() {
        if !smoke_enabled() {
            return;
        }
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        clear_preview_tokens_for_test();
        let ws = smoke_workspace();
        let home = smoke_home();
        let rules = home.join(".codex/AGENTS.md");
        if rules.is_file() {
            fs::remove_file(&rules).ok();
        }
        let preview = preview_repair_setup().expect("repair preview");
        let Some(fp) = preview.repair_fingerprint else {
            return;
        };
        let Some(token) = preview.repair_preview_token else {
            return;
        };
        let planned = crate::setup_transaction::plan_artifacts_for_surfaces(
            &crate::setup_lifecycle::SetupSurfaceId::ALL
                .iter()
                .filter(|s| {
                    !matches!(
                        s,
                        crate::setup_lifecycle::SetupSurfaceId::DeprecatedSkillCleanup
                    )
                })
                .copied()
                .collect::<Vec<_>>(),
            &ws,
            &home,
        )
        .expect("plan");
        let mut surfaces: Vec<_> = planned
            .iter()
            .filter(|p| matches!(p.kind, OperationKind::Create))
            .map(|p| p.surface)
            .collect();
        surfaces.sort_by_key(|s| format!("{s:?}"));
        surfaces.dedup();
        if surfaces.is_empty() {
            return;
        }
        assert!(validate_preview_token(
            &token,
            &ws,
            "deadbeef00000001",
            PreviewPurpose::Repair,
            &surfaces
        )
        .is_err());
        assert!(
            validate_preview_token(&token, &ws, &fp, PreviewPurpose::Repair, &surfaces).is_ok()
        );
    }

    #[test]
    fn smoke_dangling_destination_rejected_in_repair_preview() {
        if !smoke_enabled() {
            return;
        }
        #[cfg(unix)]
        {
            let _guard = guard::lock();
            let _restore = guard::EnvRestore::capture();
            let home = smoke_home();
            let rules = home.join(".config/opencode/AGENTS.md");
            if rules.is_file() {
                fs::remove_file(&rules).ok();
            }
            let parent = rules.parent().unwrap();
            fs::create_dir_all(parent).ok();
            std::os::unix::fs::symlink(home.join("missing-rules"), &rules).ok();
            let preview = preview_repair_setup().expect("repair preview");
            let plan = preview_setup(vec![]).expect("setup preview");
            let blocked = preview.skipped_conflicts > 0
                || plan.is_blocked
                || plan
                    .conflicts
                    .iter()
                    .any(|op| op.surface == crate::setup_lifecycle::SetupSurfaceId::OpenCodeRules);
            assert!(
                blocked
                    || !preview
                        .missing_artifacts
                        .iter()
                        .any(|a| a.contains("OpenCodeRules")),
                "dangling destination must not appear as safe create target"
            );
        }
    }

    #[test]
    fn smoke_repair_opencode_config_renders_paths() {
        if !smoke_enabled() {
            return;
        }
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let home = smoke_home();
        let config = home.join(".config/opencode/opencode.json");
        if config.is_file() {
            fs::remove_file(&config).ok();
        }
        let preview = preview_repair_setup().expect("repair preview");
        let Some(fp) = preview.repair_fingerprint else {
            return;
        };
        let Some(token) = preview.repair_preview_token else {
            return;
        };
        if !preview
            .missing_artifacts
            .iter()
            .any(|a| a.contains("OpenCodeConfig"))
        {
            return;
        }
        let result = repair_setup_command(true, Some(fp), Some(token)).expect("repair");
        assert!(result.success, "repair failed: {}", result.message);
        let content = fs::read_to_string(&config).expect("read repaired config");
        assert!(!content.contains("__PLAYWRIGHT_MCP_CONFIG_PATH__"));
        assert!(!content.contains("__PLAYWRIGHT_BROWSERS_PATH__"));
    }

    #[test]
    fn smoke_rollback_dry_run_on_latest_transaction() {
        if !smoke_enabled() {
            return;
        }
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let backup_root = std::env::var("AGENT_WORKSPACE_BACKUP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                smoke_home().join("Library/Application Support/ai.agentworkspace.app/backups")
            });
        let setup_dir = backup_root.join("setup");
        if !setup_dir.is_dir() {
            return;
        }
        let mut txn_dirs: Vec<_> = fs::read_dir(&setup_dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        txn_dirs.sort();
        let Some(txn_id) = txn_dirs.pop() else {
            return;
        };
        let dry = rollback_setup_transaction(txn_id, true).expect("rollback dry-run");
        assert!(
            dry.success
                || dry.message.contains("not eligible")
                || dry.message.contains("already rolled back")
                || dry.message.contains("No applied")
                || dry.message.contains("artifact changed"),
            "rollback dry-run unexpected: {}",
            dry.message
        );
    }
}
