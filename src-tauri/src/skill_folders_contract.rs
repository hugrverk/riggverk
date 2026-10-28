//! Contract tests for installing skills into the folders the enabled harnesses read.
//!
//! The roots follow the enabled harnesses and the Codex home (`skill_roots::install_roots`).
//! These tests drive the real preview, apply, rollback and uninstall commands in a temp HOME and
//! runtime workspace against the bundled skills, and check what lands on disk, what moves, what is
//! kept, and that one transaction covers a move. They never touch the real profile.

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::MutexGuard;

    use crate::agent_targets::HarnessId;
    use crate::artifact_registry::{catalog_skill_files, ArtifactId, SkillFiles, SkillName};
    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, rollback_setup_transaction,
        SetupResult,
    };
    use crate::managed_state::{
        artifact_identity, read_managed_state, write_managed_state_atomic, ManagedArtifactRecord,
        ManagedState, MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::setup_lifecycle::{OperationKind, SetupPlan, SetupSurfaceId};
    use crate::setup_transaction::{
        plan_artifacts_for_surfaces, ArtifactTransactionManifest, PlannedArtifact,
    };
    use crate::skill_roots::SkillRoot;
    use crate::stable_digest;
    use crate::test_env::{guard, guard::EnvRestore, set_test_user_dirs, source_skill_count};

    const C: HarnessId = HarnessId::Claude;
    const X: HarnessId = HarnessId::Codex;
    const O: HarnessId = HarnessId::OpenCode;

    fn skill(name: &str) -> SkillName {
        SkillName::new(name).expect("skill name")
    }

    fn bundled() -> PathBuf {
        crate::setup_roots::bundled_root().expect("bundled root")
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
        fs::write(path, bytes).expect("write file");
    }

    /// The `SKILL.md` of a skill, as the bundle ships it.
    fn canonical(name: &str) -> Vec<u8> {
        fs::read(crate::skill_discovery::canonical_skill_md(&bundled(), name))
            .expect("canonical SKILL.md")
    }

    fn catalog() -> Vec<SkillFiles> {
        catalog_skill_files(&bundled()).expect("bundled catalog")
    }

    fn file_count(skills: &[SkillFiles]) -> usize {
        skills.iter().map(|skill| skill.files.len()).sum()
    }

    /// Every regular file below `dir`, relative and `/`-separated.
    fn files_below(dir: &Path) -> BTreeSet<String> {
        fn walk(dir: &Path, prefix: &str, out: &mut BTreeSet<String>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let rel = format!("{prefix}{name}");
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    walk(&entry.path(), &format!("{rel}/"), out);
                } else {
                    out.insert(rel);
                }
            }
        }
        let mut out = BTreeSet::new();
        walk(dir, "", &mut out);
        out
    }

    fn surface_name(surface: SetupSurfaceId) -> String {
        serde_json::to_value(surface)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("{surface:?}"))
    }

    /// A temp HOME and runtime workspace; nothing is installed.
    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        // Drop order matters: restore the environment before releasing the lock.
        _restore: EnvRestore,
        _guard: MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(label: &str) -> Self {
            let guard = guard::lock();
            let restore = EnvRestore::capture();
            for key in [
                "CODEX_HOME",
                "CODEX_SKILLS_PATH",
                "CURSOR_SKILLS_PATH",
                "OPENCODE_SKILLS_PATH",
                "CLAUDE_SKILLS_PATH",
            ] {
                unsafe { std::env::remove_var(key) };
            }
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-skill-folders-{label}-{nanos}"));
            let home = base.join("home");
            let ws = base.join("runtime");
            fs::create_dir_all(&home).expect("home");
            set_test_user_dirs(&home);
            unsafe {
                std::env::set_var("RIGGVERK_WORKSPACE_PATH", ws.to_string_lossy().as_ref());
                std::env::set_var(
                    "RIGGVERK_BACKUP_DIR",
                    base.join("backups").to_string_lossy().as_ref(),
                );
            }
            Self {
                base,
                home,
                ws,
                _restore: restore,
                _guard: guard,
            }
        }

        /// Enables exactly these harnesses in the settings file.
        fn enable(&self, harnesses: &[HarnessId]) {
            crate::settings::mutate_settings(|settings| {
                settings.enabled_harness_ids = harnesses.to_vec();
                Ok(crate::settings::MutationOutcome::Changed)
            })
            .expect("write settings");
        }

        /// Customises `CODEX_HOME`; returns it.
        fn isolate_codex_home(&self) -> PathBuf {
            let isolated = self.base.join("isolated-codex");
            unsafe { std::env::set_var("CODEX_HOME", &isolated) };
            isolated
        }

        fn root(&self, root: SkillRoot) -> PathBuf {
            root.path(&self.home).expect("skill root")
        }

        fn dest(&self, root: SkillRoot, skill_name: &str, rel: &str) -> PathBuf {
            self.root(root).join(skill_name).join(rel)
        }

        fn plan(&self) -> Vec<PlannedArtifact> {
            plan_artifacts_for_surfaces(&[SetupSurfaceId::Skills], &self.ws, &self.home)
                .expect("plan")
        }

        fn preview(&self) -> SetupPlan {
            preview_setup(vec![surface_name(SetupSurfaceId::Skills)]).expect("preview")
        }

        fn apply(&self) -> SetupResult {
            let plan = self.preview();
            apply_from(&plan)
        }

        /// Roots (of the five) that hold at least one file.
        fn roots_with_files(&self) -> Vec<SkillRoot> {
            SkillRoot::ALL
                .into_iter()
                .filter(|root| !files_below(&self.root(*root)).is_empty())
                .collect()
        }

        fn state(&self) -> ManagedState {
            read_managed_state(&self.ws).unwrap_or(ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: stable_digest::bytes(b"bundle"),
                artifacts: Vec::new(),
            })
        }

        fn add_records(&self, records: Vec<ManagedArtifactRecord>) {
            let mut state = self.state();
            for record in records {
                state
                    .artifacts
                    .retain(|existing| existing.identity != record.identity);
                state.artifacts.push(record);
            }
            state.artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
            write_managed_state_atomic(&self.ws, &state).expect("write managed state");
        }

        /// Installs the `SKILL.md` of every bundled skill in `root` as an older version did, and
        /// records each under the identity that version used (`ClaudeSkill`, `CodexSkill`,
        /// `CodexLegacySkill`, `OpenCodeSkill` or `CursorSkill`).
        fn install_old_copies(&self, root: SkillRoot, variant: &str) {
            let mut records = Vec::new();
            for skill_files in catalog() {
                let name = skill_files.name.as_str();
                let bytes = canonical(name);
                write(&self.dest(root, name, "SKILL.md"), &bytes);
                records.push(ManagedArtifactRecord {
                    identity: format!(r#"{{"type":"{variant}","name":"{name}"}}"#),
                    hash: stable_digest::bytes(&bytes),
                    surface: None,
                });
            }
            self.add_records(records);
        }

        fn read_manifest(&self, transaction_id: &str) -> ArtifactTransactionManifest {
            let path = self
                .base
                .join("backups/setup")
                .join(transaction_id)
                .join("manifest.json");
            serde_json::from_str(&fs::read_to_string(path).expect("manifest")).expect("parse")
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn apply_from(plan: &SetupPlan) -> SetupResult {
        let mut names: Vec<String> = plan
            .operations
            .iter()
            .filter(|op| op.kind.needs_apply())
            .map(|op| surface_name(op.surface))
            .collect();
        names.sort();
        names.dedup();
        apply_setup(
            names,
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        )
        .expect("apply_setup")
    }

    fn skills_operation(plan: &SetupPlan) -> &crate::setup_lifecycle::PlannedOperation {
        let mut ops = plan
            .operations
            .iter()
            .filter(|op| op.surface == SetupSurfaceId::Skills);
        let op = ops.next().expect("a skills operation");
        assert!(ops.next().is_none(), "one operation for the skills surface");
        op
    }

    // ── Which folders ──

    #[test]
    fn each_enabled_harness_set_installs_into_the_folders_it_reads() {
        let env = Env::new("harness-sets");
        let all = catalog();
        let expected_files: BTreeSet<String> = all
            .iter()
            .flat_map(|skill| {
                skill
                    .files
                    .iter()
                    .map(|rel| format!("{}/{}", skill.name.as_str(), rel.as_str()))
            })
            .collect();
        assert_eq!(expected_files.len(), file_count(&all));

        for (enabled, folders) in [
            (vec![C], vec![SkillRoot::Claude]),
            (vec![X], vec![SkillRoot::Agents]),
        ] {
            // Start from a clean profile for each set.
            let _ = fs::remove_dir_all(env.home.join(".claude"));
            let _ = fs::remove_dir_all(env.home.join(".agents"));
            let _ = fs::remove_file(crate::managed_state::managed_state_path(&env.ws));
            env.enable(&enabled);
            let result = env.apply();
            assert!(result.success, "{enabled:?}: {}", result.message);
            assert_eq!(env.roots_with_files(), folders, "{enabled:?}");
            for root in folders {
                assert_eq!(files_below(&env.root(root)), expected_files, "{root:?}");
            }
            // Nothing is left to do.
            assert!(env.plan().iter().all(|p| p.kind == OperationKind::NoChange));
        }
    }

    #[test]
    fn claude_skills_path_moves_the_claude_folder_inside_the_home_folder() {
        let env = Env::new("claude-override");
        env.enable(&[C]);
        let custom = env.home.join("dotfiles/claude-skills");
        unsafe { std::env::set_var("CLAUDE_SKILLS_PATH", &custom) };
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert!(custom.join("tdd/SKILL.md").is_file());
        assert!(!env.home.join(".claude/skills").exists());
    }

    // ── The Codex move ──

    /// Codex only, default home: skills an older version put in `$CODEX_HOME/skills` move to
    /// `~/.agents/skills`.
    fn codex_move_fixture(label: &str) -> Env {
        let env = Env::new(label);
        env.enable(&[X]);
        env.install_old_copies(SkillRoot::CodexHome, "CodexSkill");
        // Codex's own skills and a skill of the user's, in the same folder.
        write(
            &env.root(SkillRoot::CodexHome)
                .join(".system/imagegen/SKILL.md"),
            b"codex\n",
        );
        write(
            &env.root(SkillRoot::CodexHome).join("my-own-skill/SKILL.md"),
            b"mine\n",
        );
        env
    }

    #[test]
    fn codex_skills_move_to_agents_skills_in_one_transaction_and_roll_back() {
        let env = codex_move_fixture("codex-move");
        let all = catalog();
        let old_root = env.root(SkillRoot::CodexHome);

        let plan = env.preview();
        let op = skills_operation(&plan);
        assert_eq!(
            op.kind,
            OperationKind::Update,
            "a move is neither a plain create nor remove"
        );
        assert_eq!(
            op.details,
            vec![
                format!(
                    "+ ~/.agents/skills ({} skills, {} files)",
                    all.len(),
                    file_count(&all)
                ),
                format!("- $CODEX_HOME/skills ({} skills, owned copies)", all.len()),
            ]
        );
        assert!(plan.has_pending_changes && !plan.is_blocked, "{plan:?}");

        let result = env.apply();
        assert!(result.success, "{}", result.message);
        for skill_files in &all {
            let name = skill_files.name.as_str();
            for rel in &skill_files.files {
                let installed = fs::read(env.dest(SkillRoot::Agents, name, rel.as_str()))
                    .unwrap_or_else(|_| panic!("{name}/{} missing", rel.as_str()));
                let source = fs::read(
                    crate::skill_discovery::canonical_skill_dir(&bundled(), name)
                        .join(rel.as_str()),
                )
                .expect("source");
                assert_eq!(installed, source, "{name}/{}", rel.as_str());
            }
            assert!(
                !old_root.join(name).exists(),
                "{name} is gone from the old folder"
            );
        }
        assert_eq!(
            files_below(&old_root),
            BTreeSet::from([
                ".system/imagegen/SKILL.md".to_string(),
                "my-own-skill/SKILL.md".to_string()
            ]),
            "Codex's own skills and the user's skill are untouched"
        );

        // One transaction: every creation comes before every removal.
        let manifest = env.read_manifest(&result.transaction_id);
        let first_remove = manifest
            .operations
            .iter()
            .position(|op| op.kind == OperationKind::Remove)
            .expect("removals");
        assert!(manifest.operations[..first_remove]
            .iter()
            .all(|op| op.kind != OperationKind::Remove));
        assert!(manifest.operations[first_remove..]
            .iter()
            .all(|op| op.kind == OperationKind::Remove));
        assert_eq!(manifest.operations.len(), file_count(&all) + all.len());

        // The records follow the files.
        let state = env.state();
        let recorded = |root: SkillRoot, name: &str| {
            let identity = artifact_identity(&ArtifactId::skill_md(root, skill(name)));
            state
                .artifacts
                .iter()
                .any(|record| record.identity == identity)
        };
        assert!(recorded(SkillRoot::Agents, "tdd"));
        assert!(!recorded(SkillRoot::CodexHome, "tdd"));

        // Rolling back restores the old state in one step.
        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "{}", rolled.message);
        assert!(files_below(&env.root(SkillRoot::Agents)).is_empty());
        for skill_files in &all {
            assert_eq!(
                fs::read(old_root.join(skill_files.name.as_str()).join("SKILL.md"))
                    .expect("restored"),
                canonical(skill_files.name.as_str())
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_halfway_through_the_codex_move_restores_the_old_state() {
        use std::os::unix::fs::PermissionsExt;

        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }

        let env = codex_move_fixture("codex-move-failure");
        let old_root = env.root(SkillRoot::CodexHome);
        let before: Vec<(PathBuf, Vec<u8>)> = files_below(&old_root)
            .into_iter()
            .map(|rel| (old_root.join(&rel), fs::read(old_root.join(&rel)).unwrap()))
            .collect();
        let state_before =
            fs::read(crate::managed_state::managed_state_path(&env.ws)).expect("state");

        // From the 30th operation on, find one whose directory no earlier operation writes into:
        // a read-only directory there fails the apply with many files already written.
        let planned = env.plan();
        let creations: Vec<PathBuf> = planned
            .iter()
            .filter(|op| op.kind == OperationKind::Create)
            .map(|op| {
                op.artifact
                    .resolve_dest(&env.home, &env.ws)
                    .expect("dest")
                    .parent()
                    .expect("parent")
                    .to_path_buf()
            })
            .collect();
        let failing = (29..creations.len())
            .find(|index| !creations[..*index].contains(&creations[*index]))
            .expect("an operation after the 29th");
        fs::create_dir_all(&creations[failing]).expect("directory");
        fs::set_permissions(&creations[failing], fs::Permissions::from_mode(0o555)).unwrap();
        let _restore = Restore(creations[failing].clone());
        if fs::write(creations[failing].join(".probe"), "x").is_ok() {
            return; // permissions are not enforced (running as root)
        }

        let result = env.apply();
        assert!(!result.success, "the apply must fail");
        assert!(
            result.rolled_back.len() >= 29,
            "{} operations rolled back",
            result.rolled_back.len()
        );
        // Nothing of the new folder is left, and the old folder is byte for byte as it was.
        assert!(
            files_below(&env.root(SkillRoot::Agents)).is_empty(),
            "{:?}",
            files_below(&env.root(SkillRoot::Agents))
        );
        for (path, bytes) in before {
            assert_eq!(
                fs::read(&path).expect("old file"),
                bytes,
                "{}",
                path.display()
            );
        }
        assert_eq!(
            fs::read(crate::managed_state::managed_state_path(&env.ws)).expect("state"),
            state_before,
            "the managed state is untouched"
        );
        let manifest = env.read_manifest(&result.transaction_id);
        assert_eq!(
            manifest.transaction_status,
            crate::setup_transaction::TransactionStatus::RolledBack
        );
    }

    #[test]
    fn an_edited_copy_in_the_old_codex_folder_is_kept_and_reported() {
        let env = codex_move_fixture("codex-move-edited");
        let edited = env.dest(SkillRoot::CodexHome, "tdd", "SKILL.md");
        write(&edited, b"my own tdd\n");

        let plan = env.preview();
        let op = skills_operation(&plan);
        assert!(
            op.details.contains(
                &"! $CODEX_HOME/skills/tdd (edited, kept; Codex reads both copies)".to_string()
            ),
            "{:?}",
            op.details
        );
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert_eq!(fs::read(&edited).unwrap(), b"my own tdd\n");
        assert!(env.dest(SkillRoot::Agents, "tdd", "SKILL.md").is_file());
        assert!(!env
            .dest(SkillRoot::CodexHome, "diagnose", "SKILL.md")
            .exists());
    }

    // ── A customised Codex home ──

    #[test]
    fn a_custom_codex_home_keeps_its_skills_inside_it_and_clears_agents_skills() {
        let env = Env::new("custom-codex-home");
        env.enable(&[X]);
        let isolated = env.isolate_codex_home();
        env.install_old_copies(SkillRoot::Agents, "CodexLegacySkill");
        write(
            &env.root(SkillRoot::Agents).join("my-own-skill/SKILL.md"),
            b"mine\n",
        );

        let plan = env.preview();
        let op = skills_operation(&plan);
        assert!(
            op.details
                .iter()
                .any(|line| line.starts_with("+ $CODEX_HOME/skills (")),
            "{:?}",
            op.details
        );
        assert!(
            op.details
                .iter()
                .any(|line| line.starts_with("- ~/.agents/skills (")),
            "{:?}",
            op.details
        );
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert!(isolated.join("skills/tdd/SKILL.md").is_file());
        assert_eq!(
            files_below(&env.root(SkillRoot::Agents)),
            BTreeSet::from(["my-own-skill/SKILL.md".to_string()])
        );
    }

    #[test]
    fn a_custom_codex_home_with_opencode_and_no_claude_reads_claude_skills_not_agents_skills() {
        let env = Env::new("custom-codex-opencode");
        env.enable(&[X, O]);
        let isolated = env.isolate_codex_home();
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert!(isolated.join("skills/tdd/SKILL.md").is_file());
        assert!(env.dest(SkillRoot::Claude, "tdd", "SKILL.md").is_file());
        assert!(
            !env.root(SkillRoot::Agents).exists(),
            "Codex would read an installed copy outside its own home"
        );
    }

    // ── Turning harnesses on and off ──

    #[test]
    fn disabling_and_enabling_a_harness_replans_the_folders_it_alone_needed() {
        let env = Env::new("toggle");
        env.enable(&[C, X]);
        assert!(env.apply().success);
        assert_eq!(
            env.roots_with_files(),
            vec![SkillRoot::Claude, SkillRoot::Agents]
        );
        let with_both = env.preview();
        assert!(!with_both.has_pending_changes, "{with_both:?}");

        // The user keeps a note of their own inside an installed skill.
        let note = env.dest(SkillRoot::Agents, "tdd", "my-notes.md");
        write(&note, b"mine\n");

        // Toggling writes nothing; the next preview plans the removal.
        env.enable(&[C]);
        assert_eq!(
            env.roots_with_files(),
            vec![SkillRoot::Claude, SkillRoot::Agents]
        );
        let plan = env.preview();
        assert_ne!(plan.plan_fingerprint, with_both.plan_fingerprint);
        let op = skills_operation(&plan);
        assert_eq!(
            op.details,
            vec![format!(
                "- ~/.agents/skills ({} skills, owned copies)",
                catalog().len()
            )]
        );
        let removed = env.apply();
        assert!(removed.success, "{}", removed.message);
        assert_eq!(
            files_below(&env.root(SkillRoot::Agents)),
            BTreeSet::from(["tdd/my-notes.md".to_string()]),
            "only the file the app did not write stays, in its own directory"
        );
        assert!(files_below(&env.root(SkillRoot::Claude)).len() > source_skill_count());

        // Enabling Codex again installs the folder again.
        env.enable(&[C, X]);
        let reinstalled = env.apply();
        assert!(reinstalled.success, "{}", reinstalled.message);
        assert!(env.dest(SkillRoot::Agents, "tdd", "SKILL.md").is_file());
        assert_eq!(fs::read(&note).unwrap(), b"mine\n");
    }

    #[test]
    fn enabling_claude_moves_opencode_from_agents_skills_to_claude_skills() {
        let env = Env::new("toggle-claude");
        env.enable(&[O]);
        assert!(env.apply().success);
        assert_eq!(env.roots_with_files(), vec![SkillRoot::Agents]);

        // OpenCode reads `~/.claude/skills` as well, so one folder is enough.
        env.enable(&[O, C]);
        let plan = env.preview();
        let op = skills_operation(&plan);
        assert!(op
            .details
            .iter()
            .any(|line| line.starts_with("+ ~/.claude/skills (")));
        assert!(op
            .details
            .iter()
            .any(|line| line.starts_with("- ~/.agents/skills (")));
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert_eq!(env.roots_with_files(), vec![SkillRoot::Claude]);
    }

    #[test]
    fn with_no_harness_enabled_nothing_is_planned_and_nothing_is_removed() {
        let env = Env::new("no-harness");
        env.install_old_copies(SkillRoot::OpenCode, "OpenCodeSkill");
        env.enable(&[]);
        assert!(env.plan().is_empty());
        let plan = env.preview();
        assert!(!plan.has_pending_changes && !plan.is_blocked, "{plan:?}");
        let (_, kind, _) = crate::setup_transaction::detect_surface_state(
            SetupSurfaceId::Skills,
            &env.ws,
            &env.home,
        );
        assert_eq!(kind, OperationKind::NoChange);
        assert!(env.dest(SkillRoot::OpenCode, "tdd", "SKILL.md").is_file());
    }

    #[test]
    fn unreadable_settings_make_the_skills_surface_unavailable_and_plan_no_removal() {
        let env = Env::new("unreadable-settings");
        env.install_old_copies(SkillRoot::OpenCode, "OpenCodeSkill");
        let settings_path = crate::platform_paths::settings_file_path(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .expect("settings path");
        write(&settings_path, b"{ this is not json");

        let error = plan_artifacts_for_surfaces(&[SetupSurfaceId::Skills], &env.ws, &env.home)
            .expect_err("no plan from a guess");
        assert!(error.contains("enabled"), "{error}");
        let (_, kind, _) = crate::setup_transaction::detect_surface_state(
            SetupSurfaceId::Skills,
            &env.ws,
            &env.home,
        );
        assert_eq!(kind, OperationKind::Unavailable);
        let plan = env.preview();
        assert!(plan.is_blocked && !plan.has_pending_changes, "{plan:?}");
        // The other surfaces do not depend on the settings.
        assert!(plan_artifacts_for_surfaces(
            &[SetupSurfaceId::WorkspaceBundle],
            &env.ws,
            &env.home
        )
        .is_ok());
        assert!(env.dest(SkillRoot::OpenCode, "tdd", "SKILL.md").is_file());
    }

    #[test]
    fn a_client_that_still_sends_the_retired_skill_surfaces_gets_the_skills_surface_once() {
        let env = Env::new("retired-ids");
        env.enable(&[C]);
        let plan = preview_setup(
            [
                "claude_skills",
                "codex_skills",
                "open_code_skills",
                "cursor_skills",
                "skills",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        )
        .expect("preview");
        let op = skills_operation(&plan);
        assert_eq!(op.kind, OperationKind::Create);
        let result = apply_from(&plan);
        assert!(result.success, "{}", result.message);
        assert!(env.dest(SkillRoot::Claude, "tdd", "SKILL.md").is_file());
    }

    // ── The light tier: Copilot, Pi and Kilo read shared folders ──

    const P: HarnessId = HarnessId::Copilot;
    const I: HarnessId = HarnessId::Pi;
    const K: HarnessId = HarnessId::Kilo;

    #[test]
    fn enabling_pi_on_a_claude_only_profile_installs_agents_skills_in_one_transaction() {
        let env = Env::new("light-pi-on");
        env.enable(&[C]);
        assert!(env.apply().success);
        assert_eq!(env.roots_with_files(), vec![SkillRoot::Claude]);
        let all = catalog();

        // Pi reads ~/.agents/skills and not ~/.claude/skills: it needs a folder of its own.
        env.enable(&[C, I]);
        let plan = env.preview();
        let op = skills_operation(&plan);
        assert_eq!(
            op.details,
            vec![format!(
                "+ ~/.agents/skills ({} skills, {} files)",
                all.len(),
                file_count(&all)
            )]
        );
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert_eq!(
            env.roots_with_files(),
            vec![SkillRoot::Claude, SkillRoot::Agents]
        );
        assert!(!env.preview().has_pending_changes);

        let manifest = env.read_manifest(&result.transaction_id);
        assert_eq!(manifest.operations.len(), file_count(&all));
        assert!(manifest
            .operations
            .iter()
            .all(|op| op.kind == OperationKind::Create));

        // Rolling back removes exactly what that transaction wrote.
        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "{}", rolled.message);
        assert_eq!(env.roots_with_files(), vec![SkillRoot::Claude]);
        assert!(files_below(&env.root(SkillRoot::Agents)).is_empty());
    }

    #[test]
    fn copilot_and_pi_behind_an_isolated_codex_home_are_unserved_and_agents_skills_stays_empty() {
        let env = Env::new("light-isolated");
        env.enable(&[X, P, I]);
        let isolated = env.isolate_codex_home();
        assert_eq!(crate::skill_roots::unserved(&[X, P, I], true), vec![P, I]);

        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert!(isolated.join("skills/tdd/SKILL.md").is_file());
        assert_eq!(
            env.roots_with_files(),
            vec![SkillRoot::CodexHome],
            "isolation wins: nothing is installed into ~/.agents/skills for the unserved"
        );
        assert!(!env.preview().has_pending_changes);
    }

    #[test]
    fn kilo_behind_an_isolated_codex_home_reads_claude_skills() {
        let env = Env::new("light-kilo-isolated");
        env.enable(&[X, K]);
        let isolated = env.isolate_codex_home();
        assert!(crate::skill_roots::unserved(&[X, K], true).is_empty());

        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert!(isolated.join("skills/tdd/SKILL.md").is_file());
        assert!(env.dest(SkillRoot::Claude, "tdd", "SKILL.md").is_file());
        assert!(!env.root(SkillRoot::Agents).exists());
    }

    #[test]
    fn kilo_is_served_by_either_shared_folder_and_adds_none_next_to_claude() {
        for (enabled, folders) in [
            (vec![K], vec![SkillRoot::Agents]),
            (vec![C, K], vec![SkillRoot::Claude]),
            (vec![X, K], vec![SkillRoot::Agents]),
            (vec![C, X, K], vec![SkillRoot::Claude, SkillRoot::Agents]),
        ] {
            let env = Env::new("light-kilo");
            env.enable(&enabled);
            let result = env.apply();
            assert!(result.success, "{enabled:?}: {}", result.message);
            assert_eq!(env.roots_with_files(), folders, "{enabled:?}");
        }
    }

    #[test]
    fn disabling_pi_removes_the_copies_the_app_owns_and_keeps_an_edited_one() {
        let env = Env::new("light-pi-off");
        env.enable(&[C, I]);
        assert!(env.apply().success);
        write(
            &env.dest(SkillRoot::Agents, "tdd", "SKILL.md"),
            b"my own tdd\n",
        );
        write(
            &env.dest(SkillRoot::Agents, "tdd", "my-notes.md"),
            b"mine\n",
        );

        env.enable(&[C]);
        let plan = env.preview();
        let op = skills_operation(&plan);
        assert!(
            op.details
                .contains(&"! ~/.agents/skills/tdd (edited, kept)".to_string()),
            "{:?}",
            op.details
        );
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert_eq!(
            files_below(&env.root(SkillRoot::Agents)),
            BTreeSet::from(["tdd/SKILL.md".to_string(), "tdd/my-notes.md".to_string()]),
            "the edited copy and the user's file stay; every other copy of the app goes"
        );
        assert_eq!(
            fs::read(env.dest(SkillRoot::Agents, "tdd", "SKILL.md")).unwrap(),
            b"my own tdd\n"
        );
        assert!(files_below(&env.root(SkillRoot::Claude)).len() > source_skill_count());
    }

    // ── The folders older versions filled ──

    #[test]
    fn opencode_and_cursor_folders_lose_owned_copies_and_keep_edited_and_foreign_ones() {
        let env = Env::new("old-harness-folders");
        env.enable(&[C]);
        env.install_old_copies(SkillRoot::OpenCode, "OpenCodeSkill");
        env.install_old_copies(SkillRoot::Cursor, "CursorSkill");
        for root in [SkillRoot::OpenCode, SkillRoot::Cursor] {
            write(&env.dest(root, "tdd", "SKILL.md"), b"my own tdd\n");
            write(&env.dest(root, "my-own-skill", "SKILL.md"), b"mine\n");
            write(&env.dest(root, "diagnose", "my-notes.md"), b"mine\n");
        }

        let plan = env.preview();
        let op = skills_operation(&plan);
        for line in [
            "! ~/.config/opencode/skills/tdd (edited, kept)",
            "! ~/.cursor/skills/tdd (edited, kept)",
        ] {
            assert!(
                op.details.contains(&line.to_string()),
                "{line}: {:?}",
                op.details
            );
        }
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        for root in [SkillRoot::OpenCode, SkillRoot::Cursor] {
            assert_eq!(
                files_below(&env.root(root)),
                BTreeSet::from([
                    "tdd/SKILL.md".to_string(),
                    "my-own-skill/SKILL.md".to_string(),
                    "diagnose/my-notes.md".to_string(),
                ]),
                "{root:?}"
            );
            assert_eq!(
                fs::read(env.dest(root, "tdd", "SKILL.md")).unwrap(),
                b"my own tdd\n"
            );
        }
        assert!(env.dest(SkillRoot::Claude, "tdd", "SKILL.md").is_file());
    }

    #[test]
    fn uninstall_removes_the_apps_copies_from_every_folder_and_nothing_else() {
        let env = Env::new("uninstall-all-roots");
        for (root, variant) in [
            (SkillRoot::Claude, "ClaudeSkill"),
            (SkillRoot::Agents, "CodexLegacySkill"),
            (SkillRoot::CodexHome, "CodexSkill"),
            (SkillRoot::OpenCode, "OpenCodeSkill"),
            (SkillRoot::Cursor, "CursorSkill"),
        ] {
            env.install_old_copies(root, variant);
            write(&env.root(root).join("my-own-skill/SKILL.md"), b"mine\n");
        }
        write(
            &env.root(SkillRoot::CodexHome)
                .join(".system/imagegen/SKILL.md"),
            b"codex\n",
        );
        write(
            &env.dest(SkillRoot::Cursor, "tdd", "SKILL.md"),
            b"my own tdd\n",
        );

        let plan = preview_uninstall().expect("uninstall preview");
        let result = apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(result.success, "{}", result.message);
        for root in SkillRoot::ALL {
            let mut left = files_below(&env.root(root));
            let mut expected = BTreeSet::from(["my-own-skill/SKILL.md".to_string()]);
            if root == SkillRoot::CodexHome {
                expected.insert(".system/imagegen/SKILL.md".to_string());
            }
            if root == SkillRoot::Cursor {
                expected.insert("tdd/SKILL.md".to_string());
            }
            left.retain(|rel| !rel.is_empty());
            assert_eq!(left, expected, "{root:?}");
        }
    }

    // ── Operation budget ──

    /// The worst first upgrade after this change: a profile from before the shared skill files
    /// with all four harnesses enabled. Every file of the bundle is created or updated; the
    /// retired adapters the runtime workspace still holds, the older copies in every folder
    /// nobody needs any more and the skills the app dropped long ago are removed, all of it
    /// in one transaction.
    struct WorstCase {
        planned: Vec<PlannedArtifact>,
        retired_workspace_files: usize,
        removed_skill_copies: usize,
    }

    fn build_worst_case(env: &Env) -> WorstCase {
        use crate::managed_bootstrap::REMOVED_SKILL_NAMES;

        let all = catalog();
        let mut records: Vec<ManagedArtifactRecord> = Vec::new();
        let mut record = |identity: String, bytes: &[u8]| {
            records.push(ManagedArtifactRecord {
                identity,
                hash: stable_digest::bytes(bytes),
                surface: None,
            });
        };

        // The runtime workspace still holds the files of the per-harness skill adapters and
        // their manifest, and the files of the first skills bundle.
        let mut retired: Vec<String> = Vec::new();
        for harness in ["claude", "codex", "opencode", "cursor"] {
            for skill_files in &all {
                retired.push(format!(
                    "templates/skills/{harness}/{}/SKILL.md",
                    skill_files.name.as_str()
                ));
            }
        }
        for index in 0..9 {
            retired.push(format!("templates/skills/_overlays/overlay-{index}.md"));
        }
        retired.push("metadata/skill-adapters.json".to_string());
        retired.push("metadata/deprecated-skills.json".to_string());
        retired.push("agents/scout.md".to_string());
        for name in REMOVED_SKILL_NAMES {
            retired.push(format!("metadata/deprecated-skills/{name}/SKILL.md"));
            retired.push(format!("skills/{name}/SKILL.md"));
        }
        // And the whole copy of the bundle earlier releases kept there.
        for rel in crate::commands::retired_workspace_files::RETIRED_WORKSPACE_FILES {
            if !retired.iter().any(|listed| listed == rel) {
                retired.push((*rel).to_string());
            }
        }
        for rel in &retired {
            let bytes = format!("retired {rel}\n").into_bytes();
            write(&env.ws.join(rel), &bytes);
            record(crate::managed_state::workspace_file_identity(rel), &bytes);
        }

        // Older copies of every current skill in the three folders that are not wanted with
        // the default Codex home, and the retired skills in all five.
        let mut skill_copies = 0;
        for (root, variant) in [
            (SkillRoot::CodexHome, "CodexSkill"),
            (SkillRoot::OpenCode, "OpenCodeSkill"),
            (SkillRoot::Cursor, "CursorSkill"),
        ] {
            for skill_files in &all {
                let name = skill_files.name.as_str();
                let bytes = canonical(name);
                write(&env.dest(root, name, "SKILL.md"), &bytes);
                record(format!(r#"{{"type":"{variant}","name":"{name}"}}"#), &bytes);
                skill_copies += 1;
            }
        }
        for (root, variant) in [
            (SkillRoot::Claude, "ClaudeSkill"),
            (SkillRoot::Agents, "CodexLegacySkill"),
            (SkillRoot::CodexHome, "CodexSkill"),
            (SkillRoot::OpenCode, "OpenCodeSkill"),
            (SkillRoot::Cursor, "CursorSkill"),
        ] {
            for name in REMOVED_SKILL_NAMES {
                let bytes = format!("retired skill {name}\n").into_bytes();
                write(&env.dest(root, name, "SKILL.md"), &bytes);
                record(format!(r#"{{"type":"{variant}","name":"{name}"}}"#), &bytes);
                skill_copies += 1;
            }
        }
        env.add_records(records);

        let surfaces = crate::settings::enabled_setup_surfaces(&crate::settings::load());
        let planned =
            plan_artifacts_for_surfaces(&surfaces, &env.ws, &env.home).expect("worst case plan");
        WorstCase {
            planned,
            retired_workspace_files: retired.len(),
            removed_skill_copies: skill_copies,
        }
    }

    #[test]
    fn the_worst_first_upgrade_fits_one_transaction_with_room_to_spare() {
        let env = Env::new("budget");
        let worst = build_worst_case(&env);
        let count = |kind| worst.planned.iter().filter(|op| op.kind == kind).count();
        let (creates, updates, removes) = (
            count(OperationKind::Create),
            count(OperationKind::Update),
            count(OperationKind::Remove),
        );
        let operations = creates + updates + removes;
        println!(
            "worst case: {operations} operations ({creates} create, {updates} update, {removes} remove); {} retired workspace files ({} of them old copies of the bundle), {} removed skill copies, {} skills with {} files per folder",
            worst.retired_workspace_files,
            crate::commands::retired_workspace_files::RETIRED_WORKSPACE_FILES.len(),
            worst.removed_skill_copies,
            catalog().len(),
            file_count(&catalog()),
        );
        // The case is the one it claims to be.
        assert!(
            removes >= worst.retired_workspace_files + worst.removed_skill_copies,
            "{removes}"
        );
        assert!(
            creates >= 2 * file_count(&catalog()),
            "both wanted folders are filled: {creates}"
        );
        assert_eq!(count(OperationKind::Conflict), 0);
        assert!(
            operations + operations / 2 <= crate::setup_transaction::MAX_MANIFEST_OPERATIONS,
            "{operations} operations leave less than half again as margin under the limit ({})",
            crate::setup_transaction::MAX_MANIFEST_OPERATIONS
        );

        // The manifest of that transaction is valid, removals last.
        let manifest = ArtifactTransactionManifest {
            schema_version: crate::setup_transaction::ARTIFACT_MANIFEST_SCHEMA_VERSION,
            workspace_key: crate::setup_transaction::workspace_key(&env.ws).expect("key"),
            created_at: "1".to_string(),
            finished_at: None,
            receipt: None,
            surface_ids: SetupSurfaceId::ALL.to_vec(),
            transaction_status: crate::setup_transaction::TransactionStatus::Prepared,
            previous_managed_state_present: false,
            previous_managed_state_trusted: false,
            previous_managed_state_digest: None,
            previous_managed_state_backup_rel: None,
            operations: worst
                .planned
                .iter()
                .filter(|op| op.kind.needs_apply())
                .map(|op| crate::setup_transaction::ArtifactManifestOperation {
                    artifact: op.artifact.clone(),
                    surface: op.surface,
                    kind: op.kind,
                    previous_state: op.previous_state,
                    rollback_action: op.rollback_action,
                    backup_rel: (op.kind != OperationKind::Create)
                        .then(|| crate::setup_transaction::artifact_backup_rel(&op.artifact)),
                    ..Default::default()
                })
                .collect(),
        };
        crate::setup_transaction::validate_manifest(&manifest, &env.ws).expect("valid manifest");
        let first_remove = manifest
            .operations
            .iter()
            .position(|op| op.kind == OperationKind::Remove)
            .expect("removals");
        assert!(manifest.operations[first_remove..]
            .iter()
            .all(|op| op.kind == OperationKind::Remove));
    }

    #[test]
    fn the_worst_first_upgrade_applies_in_one_transaction_and_is_current_afterwards() {
        let env = Env::new("budget-apply");
        let worst = build_worst_case(&env);
        let pending = worst
            .planned
            .iter()
            .filter(|op| op.kind.needs_apply())
            .count();
        let surfaces: Vec<String> =
            crate::settings::enabled_setup_surfaces(&crate::settings::load())
                .into_iter()
                .map(surface_name)
                .collect();
        let plan = preview_setup(surfaces).expect("preview");
        let result = apply_from(&plan);
        assert!(result.success, "{}", result.message);
        assert_eq!(
            env.read_manifest(&result.transaction_id).operations.len(),
            pending
        );

        // Both wanted folders hold the skills; the others hold nothing of the app's.
        assert_eq!(
            env.roots_with_files(),
            vec![SkillRoot::Claude, SkillRoot::Agents]
        );
        let again = preview_setup(
            crate::settings::enabled_setup_surfaces(&crate::settings::load())
                .into_iter()
                .map(surface_name)
                .collect(),
        )
        .expect("second preview");
        assert!(!again.has_pending_changes, "{:?}", again.operations);
    }
}
