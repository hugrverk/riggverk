//! Isolated contract tests for pre-manifest upgrade reconciliation.
//!
//! Uses temp HOME and AGENT_WORKSPACE_PATH only — never the real profile.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::agent_skill_targets::{
        agent_global_skills_dest, codex_global_skills_dest, codex_legacy_skills_dest,
    };
    use crate::commands::setup::{
        apply_setup, preview_setup, rollback_setup_transaction, SetupResult,
    };
    use crate::managed_bootstrap::{LEGACY_SCOUT_AGENT, REMOVED_SKILL_NAMES};
    use crate::managed_state::{
        managed_state_path, read_managed_state, MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::setup_lifecycle::{OperationKind, SetupPlan, SetupSurfaceId};
    use crate::skill_discovery::discover_skill_catalog;
    use crate::test_env::{guard, guard::EnvRestore, set_test_user_dirs};

    fn bundled_workspace_src() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
    }

    fn temp_base(label: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-recon-{label}-{n}"))
    }

    fn surface_id_string(id: SetupSurfaceId) -> String {
        serde_json::to_value(id)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("{id:?}"))
    }

    fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
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

    fn write_minimal_skill(dir: &Path) {
        fs::create_dir_all(dir).expect("skill dir");
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: placeholder\ndescription: placeholder\n---\n",
        )
        .expect("skill md");
    }

    fn install_catalog_skills_to_harness(ws: &Path, _home: &Path, harness: &str) {
        let catalog = discover_skill_catalog(ws).expect("catalog");
        let dest_root = agent_global_skills_dest(harness).expect("dest");
        fs::create_dir_all(&dest_root).expect("dest root");
        for skill in &catalog {
            let target = dest_root.join(&skill.name);
            copy_dir_all(&skill.source_dir, &target).expect("copy skill");
        }
    }

    fn install_removed_skills_to_harness(_home: &Path, harness: &str) {
        let dest_root = agent_global_skills_dest(harness).expect("dest");
        fs::create_dir_all(&dest_root).expect("dest root");
        for name in REMOVED_SKILL_NAMES {
            write_minimal_skill(&dest_root.join(name));
        }
    }

    fn install_codex_legacy_skills(home: &Path, ws: &Path) {
        let legacy = codex_legacy_skills_dest(home);
        fs::create_dir_all(&legacy).expect("legacy root");
        let catalog = discover_skill_catalog(ws).expect("catalog");
        for skill in catalog.iter().take(3) {
            copy_dir_all(&skill.source_dir, &legacy.join(&skill.name)).expect("legacy copy");
        }
        fs::create_dir_all(legacy.join(".system")).expect(".system");
        fs::write(legacy.join(".system/prompt.md"), "keep me").expect(".system file");
    }

    fn seed_old_installation_workspace(ws: &Path) {
        fs::create_dir_all(ws.join("metadata/deprecated-skills")).expect("meta dir");
        fs::write(
            ws.join("metadata/deprecated-skills.json"),
            r#"{"deprecated":[]}"#,
        )
        .expect("meta json");
        fs::write(
            ws.join("metadata/deprecated-skills/agent-report-review.md"),
            "# deprecated copy",
        )
        .expect("meta copy");
    }

    struct OldInstallFixture {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
    }

    impl OldInstallFixture {
        fn build() -> Self {
            let base = temp_base("fixture");
            let _ = fs::remove_dir_all(&base);
            let home = base.join("home");
            let ws = base.join("workspace");
            fs::create_dir_all(&home).expect("home");
            copy_dir_all(&bundled_workspace_src(), &ws).expect("copy workspace");
            seed_old_installation_workspace(&ws);

            set_test_user_dirs(&home);
            let resolved_home = crate::platform_paths::resolve_user_home(
                &crate::platform_paths::PlatformEnv::from_process_env(),
                crate::platform_paths::Platform::current(),
            )
            .expect("home");

            for harness in ["opencode", "cursor", "claude", "codex"] {
                install_catalog_skills_to_harness(&ws, &resolved_home, harness);
                install_removed_skills_to_harness(&resolved_home, harness);
            }
            install_codex_legacy_skills(&resolved_home, &ws);
            let oc_agents = resolved_home.join(".config/opencode/agents");
            fs::create_dir_all(&oc_agents).expect("oc agents");
            for entry in fs::read_dir(ws.join("agents")).expect("agents dir") {
                let entry = entry.expect("agent entry");
                if entry.path().extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let name = entry.file_name();
                if name == "scout.md" {
                    fs::write(oc_agents.join("scout.md"), "# legacy scout").expect("oc scout");
                } else {
                    fs::copy(entry.path(), oc_agents.join(name)).expect("oc agent copy");
                }
            }

            let ws_canon = ws.canonicalize().unwrap_or_else(|_| ws.clone());
            unsafe {
                std::env::set_var("AGENT_WORKSPACE_PATH", ws_canon.to_string_lossy().as_ref());
                std::env::set_var(
                    "AGENT_WORKSPACE_BACKUP_DIR",
                    base.join("backups").to_string_lossy().as_ref(),
                );
            }

            Self {
                base,
                home: resolved_home,
                ws: ws_canon,
            }
        }

        fn harness_skill_count(&self, harness: &str) -> usize {
            let root = agent_global_skills_dest(harness).expect("dest");
            if !root.is_dir() {
                return 0;
            }
            fs::read_dir(&root)
                .expect("read skills")
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter(|e| {
                    let file_name = e.file_name();
                    let name = file_name.to_string_lossy();
                    !name.starts_with('.')
                })
                .count()
        }

        fn cleanup(self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn reconciliation_surface_ids() -> Vec<SetupSurfaceId> {
        vec![
            SetupSurfaceId::WorkspaceBundle,
            SetupSurfaceId::OpenCodeSkills,
            SetupSurfaceId::CodexSkills,
            SetupSurfaceId::ClaudeSkills,
            SetupSurfaceId::CursorSkills,
            SetupSurfaceId::OpenCodeAgents,
        ]
    }

    fn preview_reconciliation() -> SetupPlan {
        let surfaces: Vec<String> = reconciliation_surface_ids()
            .iter()
            .copied()
            .map(surface_id_string)
            .collect();
        preview_setup(surfaces).expect("preview reconciliation surfaces")
    }

    fn apply_surfaces_from_preview(plan: &SetupPlan) -> SetupResult {
        let mut surfaces: Vec<String> = plan
            .operations
            .iter()
            .filter(|op| op.kind.needs_apply())
            .map(|op| surface_id_string(op.surface))
            .collect();
        surfaces.sort();
        surfaces.dedup();
        apply_setup(
            surfaces,
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        )
        .expect("apply_setup")
    }

    #[test]
    fn pre_manifest_fixture_detects_stale_removals_before_apply() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();
        let planned = crate::setup_transaction::plan_artifacts_for_surfaces(
            &reconciliation_surface_ids(),
            &fixture.ws,
            &fixture.home,
        )
        .expect("artifact plan");
        assert!(
            planned.iter().any(|p| p.kind == OperationKind::Remove),
            "expected Remove artifacts in plan: {:?}",
            planned
        );
        let plan = preview_reconciliation();
        assert!(
            plan.operations
                .iter()
                .any(|op| op.kind == OperationKind::Remove),
            "expected Remove operations in surface preview: {:?}",
            plan.operations
        );
        fixture.cleanup();
    }

    #[test]
    fn pre_manifest_upgrade_reconciles_to_canonical_inventory() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();

        let plan = preview_reconciliation();
        let result = apply_surfaces_from_preview(&plan);
        assert!(result.success, "apply failed: {}", result.message);

        let catalog = discover_skill_catalog(&fixture.ws).expect("catalog");
        assert_eq!(
            catalog.len(),
            21,
            "workspace should retain 21 canonical skills"
        );

        assert!(
            !fixture.ws.join("metadata/deprecated-skills.json").exists(),
            "deprecated metadata json should be removed"
        );
        for harness in ["opencode", "cursor", "claude", "codex"] {
            assert_eq!(
                fixture.harness_skill_count(harness),
                21,
                "{harness} should have 21 skills after reconciliation"
            );
            let dest = agent_global_skills_dest(harness).expect("dest");
            for removed in REMOVED_SKILL_NAMES {
                assert!(
                    !dest.join(removed).exists(),
                    "{harness} should not retain removed skill {removed}"
                );
            }
        }

        assert!(
            !fixture
                .home
                .join(".config/opencode/agents/scout.md")
                .exists(),
            "legacy opencode scout agent should be removed"
        );

        let legacy = codex_legacy_skills_dest(&fixture.home);
        assert!(
            legacy.join(".system/prompt.md").is_file(),
            "codex legacy .system should be preserved"
        );
        let global = codex_global_skills_dest(&fixture.home);
        assert!(global.is_dir(), "codex global skills dir should exist");

        let managed = read_managed_state(&fixture.ws).expect("managed-state.json");
        assert_eq!(managed.schema_version, MANAGED_STATE_SCHEMA_VERSION);
        assert!(
            managed_state_path(&fixture.ws).is_file(),
            "managed state should be written"
        );

        fixture.cleanup();
    }

    #[test]
    fn pre_manifest_upgrade_is_idempotent_on_second_apply() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();

        let first = apply_surfaces_from_preview(&preview_reconciliation());
        assert!(first.success, "first apply: {}", first.message);

        let second_plan = preview_reconciliation();
        assert!(
            !second_plan
                .operations
                .iter()
                .any(|op| op.kind.needs_apply()),
            "second preview should be current: {:?}",
            second_plan.operations
        );

        fixture.cleanup();
    }

    #[test]
    fn pre_manifest_upgrade_rollback_restores_removed_stale_workspace_file() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();

        let surfaces = vec![surface_id_string(SetupSurfaceId::WorkspaceBundle)];
        let plan = preview_setup(surfaces).expect("preview workspace bundle");
        let applied = apply_surfaces_from_preview(&plan);
        assert!(applied.success, "apply: {}", applied.message);
        assert!(
            !fixture.ws.join("metadata/deprecated-skills.json").exists(),
            "stale workspace metadata should be removed before rollback"
        );

        let rolled =
            rollback_setup_transaction(applied.transaction_id.clone(), false).expect("rollback");
        assert!(
            fixture.ws.join("metadata/deprecated-skills.json").is_file(),
            "rollback should restore removed workspace metadata (success={}, message={}, failed={:?})",
            rolled.success,
            rolled.message,
            rolled.failed
        );

        fixture.cleanup();
    }

    #[test]
    fn bootstrap_does_not_treat_scout_skill_name_as_removed_skill() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();
        let dest = agent_global_skills_dest("opencode").expect("dest");
        write_minimal_skill(&dest.join(LEGACY_SCOUT_AGENT));
        let plan = preview_setup(vec![surface_id_string(SetupSurfaceId::OpenCodeSkills)])
            .expect("preview opencode skills");
        let remove_scout = plan
            .operations
            .iter()
            .any(|op| op.kind == OperationKind::Remove && op.summary.contains(LEGACY_SCOUT_AGENT));
        assert!(
            !remove_scout,
            "scout skill dir should not be auto-removed unless in REMOVED_SKILL_NAMES"
        );
        fixture.cleanup();
    }
}
