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
    use crate::artifact_registry::{ArtifactId, SkillName};
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
        let name = dir
            .file_name()
            .and_then(|value| value.to_str())
            .expect("skill name");
        fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: historical fixture\ntargets: [codex, opencode, claude, cursor]\n---\n"
            ),
        )
        .expect("skill md");
    }

    #[test]
    fn old_current_workspace_file_without_managed_state_is_conflict() {
        let base = temp_base("historical-conflict");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("base");
        let home = base.join("home");
        let ws = base.join("workspace");
        fs::create_dir_all(&home).expect("home");
        copy_dir_all(&bundled_workspace_src(), &ws).expect("copy workspace");
        fs::write(
            ws.join("docs/USING_THE_APP.md"),
            "# Using the App\n\nA practical walkthrough of each app area.\n\n## Workspace page\n\nThe landing page and operations terminal. Shows whether the runtime workspace at `~/.config/agent-workspace` is installed, missing, or needs repair.\n\n- **install** / **repair** / **update resources** — copy bundled defaults into the canonical path (never overwrites existing files). **update resources** appears when the workspace is valid but newer bundled files are missing (for example prompt templates after an app upgrade).\n- **refresh** — reload diagnostics and status\n- **open folder** — open the installed workspace in Finder\n- **VERIFY** — release-check and backup management when the workspace is valid\n\nHarness pages (Codex, OpenCode, Cursor, Claude) provide detailed per-tool diff, sync, and install actions. The Workspace page provides a complementary unified **setup lifecycle** — preview, apply, repair, and rollback across managed surfaces. Use either path; they are not mutually exclusive.\n\n## Harness pages (Codex, OpenCode, Cursor, Claude)\n\nPer-tool diff/sync/install actions and skills install for that tool only. Open the harness from the top navigation after the workspace is installed.\n\n## Library\n\nBrowse and edit workspace content in a three-panel layout:\n\n1. **Source rail** (left) — Docs, Rules, Skills, Agents, Configs, Brain Setup\n2. **Item sidebar** (middle) — browse items by section or filter\n3. **Content pane** (right) — preview or edit selected content\n\n### Docs\n\nCurated docs grouped under Start, Guides, Reference, Prompt Templates, and Context. Prompt Templates ships as `docs/prompt-templates/*.md` after install, repair, or update resources. Use \"open\" for your system editor or edit in-app.\n\n### Rules\n\nView and edit `templates/global-agent-rules.md`. Synced to agent rule paths from harness pages.\n\n### Skills\n\nBrowse bundled skills in Library. Install or sync from harness pages (per-tool preview and apply) or from the Workspace unified setup lifecycle (apply/repair across harnesses). These paths are complementary.\n\n### Agents\n\nView and edit `agents/*.md` prompt definitions.\n\n### Configs\n\nView and edit `templates/opencode.json` and related config sources.\n\n## Brain Setup (Library)\n\nCopy a durable instruction block for external assistants (skill routing, security, verification). Does not run agents or change sync targets.\n\n## Settings\n\nAppearance, global text size, and theme colors. Settings autosave.\n\n## Tools\n\nIn-app utilities separate from harness sync:\n\n- **Prompt Loops** — copy/paste prompt templates with skill-weaving for agent runs.\n- **Repo Dashboard** — local git/gh snapshot of a checkout with three pages: Overview (summary, charts, recent activity, contributors), Work (active and done items from docs/gh), and Docs (searchable Markdown reader).\n\n## Dry-run before sync\n\n| Operation | Preview | Apply |\n|-----------|---------|-------|\n| Rules sync | Diff Rules | Sync Rules |\n| OpenCode config sync | Diff Configs | Sync Configs |\n| Codex config | Preview in setup lifecycle | Apply managed fields |\n| Skills install | Dry-run Skills | Install Skills |\n\n## Setup lifecycle (Workspace)\n\n- **Preview** issues a short-lived token and fingerprint; **apply** and **repair** consume the token only after complete backend preflight and immediately before the first mutation.\n- Failed preflight leaves the token valid for retry.\n- Failed apply or repair with a transaction ID remains available for **rollback** when dry-run shows eligible artifacts.\n- Explicit rollback persists per-artifact `in_flight` before each restore, then `restored` or `failed` after validation; interrupted rollbacks reconcile without double-restoring completed artifacts.\n- Transactions in `rolling_back` or `rollback_failed` can be resumed; already `restored` artifacts are skipped; when none remain eligible the transaction finalizes without further filesystem changes.\n- Rollback dry-run lists already restored, still-required, and conflicted artifacts and performs zero manifest writes.\n- Codex managed apply and rollback preserve same-line inline comments on managed scalar fields via the line-preserving merge script, or refuse safely with zero mutation on conflict.\n- Symlinked parents and dangling symlinks in managed paths are rejected.\n\n## Backups\n\nApplying changes that overwrite diverged target files creates backups under the platform-resolved Agent Workspace backup root (for example `~/Library/Application Support/ai.agentworkspace.app/backups` on macOS).\n\n## Release check\n\nRun **release-check** from Workspace VERIFY when the installed workspace includes `scripts/release-check.sh` (the app repo checkout; bundled starter may not include it).\n\nSee [WORKFLOWS.md](WORKFLOWS.md) for common patterns.\n",
        )
        .expect("old workspace doc");
        set_test_user_dirs(&home);
        let resolved_home = crate::platform_paths::resolve_user_home(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .expect("home");
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_PATH",
                ws.canonicalize().unwrap().to_string_lossy().as_ref(),
            );
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                base.join("backups").to_string_lossy().as_ref(),
            );
        }
        let artifact = crate::artifact_registry::ArtifactId::WorkspaceFile(
            crate::artifact_registry::WorkspaceRelPath::new("docs/USING_THE_APP.md").unwrap(),
        );
        let planned = crate::setup_transaction::plan_artifacts_for_surfaces(
            &[crate::setup_lifecycle::SetupSurfaceId::WorkspaceBundle],
            &ws,
            &resolved_home,
        )
        .expect("plan");
        let found = planned
            .iter()
            .find(|op| op.artifact == artifact)
            .expect("workspace file operation");
        assert_eq!(found.kind, OperationKind::Conflict);
        let _ = fs::remove_dir_all(&base);
    }

    fn install_current_skills_to_harness(harness: &str, limit: usize) {
        let mut catalog = discover_skill_catalog(&bundled_workspace_src()).expect("catalog");
        catalog.sort_by(|a, b| a.name.cmp(&b.name));
        let dest_root = agent_global_skills_dest(harness).expect("dest");
        fs::create_dir_all(&dest_root).expect("dest root");
        for skill in catalog.iter().take(limit) {
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

    fn install_codex_legacy_skills(home: &Path) {
        let legacy = codex_legacy_skills_dest(home);
        fs::create_dir_all(&legacy).expect("legacy root");
        let mut catalog = discover_skill_catalog(&bundled_workspace_src()).expect("catalog");
        catalog.sort_by(|a, b| a.name.cmp(&b.name));
        for skill in catalog.iter().take(16) {
            copy_dir_all(&skill.source_dir, &legacy.join(&skill.name)).expect("legacy copy");
        }
        for name in REMOVED_SKILL_NAMES {
            write_minimal_skill(&legacy.join(name));
        }
        fs::create_dir_all(legacy.join(".system")).expect(".system");
        fs::write(legacy.join(".system/prompt.md"), "keep me").expect(".system file");
        write_minimal_skill(&legacy.join("user-custom-skill"));
    }

    fn seed_old_installation_workspace(ws: &Path) {
        fs::create_dir_all(ws.join("metadata/deprecated-skills")).expect("meta dir");
        fs::write(
            ws.join("metadata/deprecated-skills.json"),
            "{\n  \"version\": 1,\n  \"skills\": [\n    \"agent-report-review\",\n    \"caveman\",\n    \"dependency-evaluation\",\n    \"grill-me\",\n    \"grill-with-docs\",\n    \"improve-codebase-architecture\",\n    \"nextjs-product-slice\",\n    \"supabase-rls-review\",\n    \"to-prd\",\n    \"triage\",\n    \"woocommerce-pdp-review\",\n    \"write-a-skill\"\n  ]\n}\n",
        )
        .expect("meta json");
        for name in REMOVED_SKILL_NAMES {
            write_minimal_skill(&ws.join("metadata/deprecated-skills").join(name));
            write_minimal_skill(&ws.join("skills").join(name));
        }
        fs::write(
            ws.join("agents/scout.md"),
            "---\nname: placeholder\ndescription: placeholder\n---\n",
        )
        .expect("runtime scout");
        fs::write(ws.join("user-owned.txt"), "keep runtime file").expect("runtime unknown");
    }

    fn install_agent_files(source: &Path, destination: &Path) {
        fs::create_dir_all(destination).expect("agent destination");
        for entry in fs::read_dir(source).expect("agent source") {
            let entry = entry.expect("agent entry");
            if entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("md")
            {
                fs::copy(entry.path(), destination.join(entry.file_name())).expect("copy agent");
            }
        }
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

            install_current_skills_to_harness("opencode", 16);
            install_removed_skills_to_harness(&resolved_home, "opencode");
            install_current_skills_to_harness("cursor", 21);
            install_removed_skills_to_harness(&resolved_home, "cursor");
            install_codex_legacy_skills(&resolved_home);

            let oc_agents = resolved_home.join(".config/opencode/agents");
            install_agent_files(&ws.join("agents"), &oc_agents);
            fs::write(
                oc_agents.join("scout.md"),
                "---\nname: placeholder\ndescription: placeholder\n---\n",
            )
            .expect("opencode scout");
            fs::write(oc_agents.join("user-agent.md"), "keep harness file")
                .expect("opencode unknown");

            let cursor_agents = resolved_home.join(".cursor/agents");
            install_agent_files(&ws.join("templates/cursor/agents"), &cursor_agents);
            fs::write(cursor_agents.join("user-agent.md"), "keep cursor agent")
                .expect("cursor unknown");

            let opencode_skills = agent_global_skills_dest("opencode").expect("opencode skills");
            fs::write(
                opencode_skills
                    .join(REMOVED_SKILL_NAMES[1])
                    .join("SKILL.md"),
                "modified stale harness skill",
            )
            .expect("modified harness skill");
            fs::write(
                ws.join("skills")
                    .join(REMOVED_SKILL_NAMES[0])
                    .join("SKILL.md"),
                format!(
                    "---\nname: {}\ndescription: user modified stale runtime skill\ntargets: [codex, opencode, claude, cursor]\n---\n",
                    REMOVED_SKILL_NAMES[0]
                ),
            )
            .expect("modified runtime skill");
            fs::write(
                codex_legacy_skills_dest(&resolved_home)
                    .join(REMOVED_SKILL_NAMES[2])
                    .join("SKILL.md"),
                "modified legacy Codex skill",
            )
            .expect("modified Codex skill");

            let mut current =
                discover_skill_catalog(&bundled_workspace_src()).expect("current catalog");
            current.sort_by(|a, b| a.name.cmp(&b.name));
            fs::write(
                opencode_skills
                    .join(&current.first().expect("current skill").name)
                    .join("SKILL.md"),
                "same-name unowned custom skill",
            )
            .expect("custom same-name skill");

            let ws_canon = ws.canonicalize().unwrap_or_else(|_| ws.clone());
            unsafe {
                std::env::set_var("AGENT_WORKSPACE_PATH", ws_canon.to_string_lossy().as_ref());
                std::env::set_var(
                    "AGENT_WORKSPACE_BACKUP_DIR",
                    base.join("backups").to_string_lossy().as_ref(),
                );
            }
            let bootstrap =
                crate::managed_bootstrap::infer_bootstrap_records(&ws_canon, &resolved_home)
                    .expect("bootstrap records");
            assert!(
                bootstrap.iter().any(|record| {
                    record.identity.contains("\"scout\"")
                        && record.surface.as_deref() == Some("open_code_agents")
                }),
                "exact historical scout should be bootstrap-owned: {bootstrap:?}"
            );

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
    fn fresh_profile_installs_workspace_through_unified_setup() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let base = temp_base("fresh");
        let home = base.join("home");
        let workspace = base.join("runtime");
        fs::create_dir_all(&home).expect("home");
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var("AGENT_WORKSPACE_PATH", workspace.to_string_lossy().as_ref());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                base.join("backups").to_string_lossy().as_ref(),
            );
        }
        let status = crate::installation_status::status_for_surfaces(
            &[SetupSurfaceId::WorkspaceBundle],
            &workspace,
            &home,
        )
        .expect("fresh status");
        assert_eq!(
            status.state,
            crate::installation_status::InstallationState::NotInstalled
        );
        let plan = preview_setup(vec![surface_id_string(SetupSurfaceId::WorkspaceBundle)])
            .expect("fresh preview");
        let result = apply_surfaces_from_preview(&plan);
        assert!(result.success, "fresh apply: {}", result.message);
        assert_eq!(
            discover_skill_catalog(&workspace)
                .expect("installed catalog")
                .len(),
            21
        );
        assert!(read_managed_state(&workspace).is_some());
        let current = crate::installation_status::status_for_surfaces(
            &[SetupSurfaceId::WorkspaceBundle],
            &workspace,
            &home,
        )
        .expect("current status");
        assert_eq!(
            current.state,
            crate::installation_status::InstallationState::Current
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn pre_manifest_fixture_detects_stale_removals_before_apply() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();
        assert_eq!(
            discover_skill_catalog(&fixture.ws)
                .expect("runtime catalog")
                .len(),
            33
        );
        assert_eq!(
            fs::read_dir(fixture.ws.join("agents"))
                .expect("runtime agents")
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("md")
                })
                .count(),
            7
        );
        assert_eq!(fixture.harness_skill_count("opencode"), 28);
        assert_eq!(fixture.harness_skill_count("cursor"), 33);
        assert_eq!(fixture.harness_skill_count("claude"), 0);
        assert_eq!(
            fs::read_dir(codex_legacy_skills_dest(&fixture.home))
                .expect("legacy Codex")
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.path().is_dir()
                        && !entry.file_name().to_string_lossy().starts_with('.')
                        && entry.file_name() != "user-custom-skill"
                })
                .count(),
            28
        );
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
            22,
            "modified stale runtime skill is preserved"
        );
        assert!(
            fixture
                .ws
                .join("skills")
                .join(REMOVED_SKILL_NAMES[0])
                .join("SKILL.md")
                .is_file(),
            "modified runtime skill should be preserved"
        );

        assert!(
            !fixture.ws.join("metadata/deprecated-skills.json").exists(),
            "deprecated metadata json should be removed"
        );
        for harness in ["cursor", "claude", "codex"] {
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
        assert_eq!(
            fixture.harness_skill_count("opencode"),
            22,
            "modified stale OpenCode skill should remain beside 21 current names"
        );
        assert!(
            agent_global_skills_dest("opencode")
                .expect("OpenCode skills")
                .join(REMOVED_SKILL_NAMES[1])
                .is_dir(),
            "modified stale OpenCode skill should be preserved"
        );

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
        assert!(
            legacy.join(REMOVED_SKILL_NAMES[2]).is_dir(),
            "modified legacy Codex skill should be preserved"
        );
        assert!(
            legacy.join("user-custom-skill/SKILL.md").is_file(),
            "unknown legacy Codex skill should be preserved"
        );
        assert!(
            fixture.ws.join("user-owned.txt").is_file(),
            "unknown runtime file should be preserved"
        );
        let global = codex_global_skills_dest(&fixture.home);
        assert!(global.is_dir(), "codex global skills dir should exist");

        let managed = read_managed_state(&fixture.ws).expect("managed-state.json");
        assert_eq!(managed.schema_version, MANAGED_STATE_SCHEMA_VERSION);
        assert!(
            managed_state_path(&fixture.ws).is_file(),
            "managed state should be written"
        );
        let exact_cursor = ArtifactId::CursorSkill(
            SkillName::new("accessibility-review").expect("canonical skill"),
        );
        assert!(
            managed
                .artifacts
                .iter()
                .any(|record| record.identity
                    == crate::managed_state::artifact_identity(&exact_cursor)),
            "selected exact current artifacts should be adopted"
        );
        let conflicted = ArtifactId::OpenCodeSkill(
            SkillName::new("accessibility-review").expect("canonical skill"),
        );
        assert!(
            managed
                .artifacts
                .iter()
                .all(|record| record.identity
                    != crate::managed_state::artifact_identity(&conflicted)),
            "same-name unowned conflict must remain unclaimed"
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
        assert!(
            !managed_state_path(&fixture.ws).exists(),
            "rollback must restore previous managed-state absence"
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
