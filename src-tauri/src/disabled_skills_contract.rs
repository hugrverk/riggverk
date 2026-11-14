//! Contract tests for disabled skills (see `disabled_skills`).
//!
//! A disabled skill stays in the catalog but is not installed: its app-owned copies are removed by
//! the next Install with a backup, an edited copy stays as a manual step, and re-enabling plans it
//! again. These tests install into a temp HOME and data folder with the real bundle, through the
//! real preview, apply, rollback and uninstall commands, and never touch the real profile.

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::MutexGuard;

    use crate::artifact_registry::{ArtifactId, SkillName, SkillRelPath};
    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, rollback_setup_transaction,
        SetupResult,
    };
    use crate::disabled_skills::UNUSABLE;
    use crate::setup_lifecycle::{OperationKind, PlannedOperation, SetupPlan, SetupSurfaceId};
    use crate::setup_transaction::{plan_artifacts_for_surfaces, PlannedArtifact};
    use crate::skill_roots::SkillRoot;
    use crate::skill_sources::{PackSkillState, SkillSources, SourceRoot};
    use crate::test_env::{canonical_skill_text, guard, guard::EnvRestore, set_test_user_dirs};

    const SURFACES: [SetupSurfaceId; 1] = [SetupSurfaceId::Skills];
    /// A bundled skill with a supporting file.
    const TWO_FILES: &str = "pr-workflow";
    const TWO_FILES_SUPPORT: &str = "assets/pr-body.template.md";

    fn surface_name(surface: SetupSurfaceId) -> String {
        serde_json::to_value(surface)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("{surface:?}"))
    }

    fn file_of(root: SkillRoot, skill: &str, rel: &str) -> ArtifactId {
        ArtifactId::skill_file(
            root,
            SkillName::new(skill).expect("skill name"),
            SkillRelPath::new(rel).expect("rel path"),
        )
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    /// Every file below `dir` as `/`-separated relative path and bytes; empty when `dir` is gone.
    fn files_below(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fn walk(dir: &Path, prefix: &str, out: &mut BTreeMap<String, Vec<u8>>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries {
                let entry = entry.expect("entry");
                let name = entry.file_name().to_string_lossy().into_owned();
                let rel = format!("{prefix}{name}");
                if entry.file_type().expect("file type").is_dir() {
                    walk(&entry.path(), &format!("{rel}/"), out);
                } else {
                    out.insert(rel, fs::read(entry.path()).expect("read file"));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(dir, "", &mut out);
        out
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("chmod");
    }

    #[cfg(not(unix))]
    fn set_mode(_path: &Path, _mode: u32) {}

    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        // Drop order matters: the environment goes before the lock.
        _isolated: EnvRestore,
        _restore: EnvRestore,
        _guard: MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(label: &str) -> Self {
            let guard = guard::lock();
            let restore = EnvRestore::capture();
            let isolated = guard::isolate_data_location_env();
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
            let base = std::env::temp_dir().join(format!("aw-disabled-skills-{label}-{nanos}"));
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
                _isolated: isolated,
                _restore: restore,
                _guard: guard,
            }
        }

        /// A skill in the pack `pack`, owner-writable only like a cloned pack.
        fn pack_skill(&self, pack: &str, name: &str) {
            let packs = self.ws.join("packs");
            let dir = packs.join(pack).join("skills").join(name);
            fs::create_dir_all(&dir).expect("skill dir");
            fs::write(
                dir.join("SKILL.md"),
                canonical_skill_text(name, "a pack skill"),
            )
            .expect("SKILL.md");
            for folder in [
                packs.clone(),
                packs.join(pack),
                packs.join(pack).join("skills"),
                dir.clone(),
            ] {
                set_mode(&folder, 0o755);
            }
            set_mode(&dir.join("SKILL.md"), 0o644);
        }

        fn disable(&self, list: &[&str]) {
            crate::disabled_skills::set(&self.ws, &names(list), false).expect("disable");
        }

        fn enable(&self, list: &[&str]) {
            crate::disabled_skills::set(&self.ws, &names(list), true).expect("enable");
        }

        fn disabled_file(&self) -> PathBuf {
            crate::workspace_layout::state_file(
                &self.ws,
                crate::disabled_skills::DISABLED_SKILLS_FILE,
            )
        }

        fn root(&self, root: SkillRoot) -> PathBuf {
            root.path(&self.home).expect("skill root")
        }

        fn path(&self, artifact: &ArtifactId) -> PathBuf {
            artifact.resolve_dest(&self.home, &self.ws).expect("dest")
        }

        fn plan(&self) -> Vec<PlannedArtifact> {
            plan_artifacts_for_surfaces(&SURFACES, &self.ws, &self.home).expect("plan")
        }

        /// The planned kinds of the files of `skill`, per artifact.
        fn kinds_of(&self, skill: &str) -> Vec<(ArtifactId, OperationKind)> {
            self.plan()
                .into_iter()
                .filter(|planned| {
                    planned
                        .artifact
                        .as_skill_file()
                        .is_some_and(|file| file.skill.as_str() == skill)
                })
                .map(|planned| (planned.artifact, planned.kind))
                .collect()
        }

        fn preview(&self) -> SetupPlan {
            preview_setup(SURFACES.iter().copied().map(surface_name).collect()).expect("preview")
        }

        fn skills_operation(&self) -> PlannedOperation {
            let plan = self.preview();
            plan.operations
                .into_iter()
                .chain(plan.conflicts)
                .chain(plan.manual_steps)
                .find(|op| op.surface == SetupSurfaceId::Skills)
                .expect("skills operation")
        }

        fn apply(&self) -> SetupResult {
            let plan = self.preview();
            let result = apply_setup(
                vec![surface_name(SetupSurfaceId::Skills)],
                true,
                plan.plan_fingerprint.clone(),
                plan.preview_token.clone(),
            )
            .expect("apply_setup");
            assert!(result.success, "apply: {}", result.message);
            result
        }

        fn sources(&self) -> SkillSources {
            SkillSources::for_workspace(&self.ws).expect("skill sources")
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn real_bundle() -> PathBuf {
        crate::setup_roots::bundled_root().expect("bundled root")
    }

    #[test]
    fn a_disabled_skill_is_not_created_and_its_owned_copies_are_removed_with_a_backup_and_undo_restores_them(
    ) {
        let env = Env::new("remove");
        env.disable(&["tdd"]);
        assert!(
            env.kinds_of("tdd").is_empty(),
            "a disabled skill is not created"
        );
        env.apply();
        assert!(!env.root(SkillRoot::Claude).join("tdd").exists());
        assert!(env.root(SkillRoot::Claude).join("diagnose").is_dir());

        // Installed, then disabled: its app-owned copies are removed.
        env.enable(&["tdd"]);
        env.apply();
        let installed = files_below(&env.root(SkillRoot::Claude).join(TWO_FILES));
        assert_eq!(installed.len(), 2);
        env.disable(&[TWO_FILES]);
        let kinds = env.kinds_of(TWO_FILES);
        assert!(!kinds.is_empty());
        assert!(
            kinds.iter().all(|(_, kind)| *kind == OperationKind::Remove),
            "{kinds:?}"
        );
        let operation = env.skills_operation();
        assert_eq!(operation.kind, OperationKind::Remove);
        assert_eq!(operation.summary, "Skills: 1 disabled skill to remove");
        assert!(
            operation.details.contains(&format!(
                "- {}/{TWO_FILES} (2 files; disabled)",
                SkillRoot::Claude.display()
            )),
            "{:?}",
            operation.details
        );

        let result = env.apply();
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            assert!(!env.root(root).join(TWO_FILES).exists(), "{root:?}");
        }
        assert!(env.kinds_of(TWO_FILES).is_empty(), "nothing left to do");

        // Undo puts the copies back; the skill stays disabled, so the next Install removes them
        // again.
        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "{}", rolled.message);
        assert_eq!(
            files_below(&env.root(SkillRoot::Claude).join(TWO_FILES)),
            installed
        );
        assert!(env.sources().is_disabled(TWO_FILES));
        assert!(env
            .kinds_of(TWO_FILES)
            .iter()
            .all(|(_, kind)| *kind == OperationKind::Remove));
    }

    #[test]
    fn an_edited_copy_of_a_disabled_skill_stays_as_a_manual_step_with_all_its_files() {
        let env = Env::new("edited");
        env.apply();
        let skill_md = env.path(&file_of(SkillRoot::Claude, TWO_FILES, "SKILL.md"));
        let support = env.path(&file_of(SkillRoot::Claude, TWO_FILES, TWO_FILES_SUPPORT));
        fs::write(&skill_md, "my own pr workflow\n").expect("edit");
        env.disable(&[TWO_FILES]);

        let plan = env.plan();
        let claude: Vec<_> = plan
            .iter()
            .filter(|planned| {
                planned.artifact.as_skill_file().is_some_and(|file| {
                    file.skill.as_str() == TWO_FILES && file.root == SkillRoot::Claude
                })
            })
            .collect();
        assert_eq!(claude.len(), 2, "both files of the edited copy are planned");
        assert!(
            claude
                .iter()
                .all(|planned| planned.kind == OperationKind::Manual),
            "no file of the edited copy is removed"
        );
        let edited = claude
            .iter()
            .find(|planned| planned.artifact == file_of(SkillRoot::Claude, TWO_FILES, "SKILL.md"))
            .expect("SKILL.md planned");
        let conflict = edited.file.expect("a file conflict");
        assert!(!conflict.wanted);
        assert!(conflict.kept.is_none());
        // The untouched copy in the shared folder is the app's and goes.
        assert!(env
            .kinds_of(TWO_FILES)
            .iter()
            .filter(|(artifact, _)| artifact
                .as_skill_file()
                .is_some_and(|file| file.root == SkillRoot::Agents))
            .all(|(_, kind)| *kind == OperationKind::Remove));

        let operation = env.skills_operation();
        assert!(
            operation.details.contains(&format!(
                "= {}/{TWO_FILES} (disabled; your edited copy stays, delete it to stop loading it)",
                SkillRoot::Claude.display()
            )),
            "{:?}",
            operation.details
        );
        let plan = env.preview();
        assert!(!plan.is_blocked, "an edited disabled copy does not block");

        env.apply();
        assert_eq!(
            fs::read_to_string(&skill_md).expect("SKILL.md"),
            "my own pr workflow\n"
        );
        assert!(support.is_file(), "no half skill is left behind");
        assert!(!env.root(SkillRoot::Agents).join(TWO_FILES).exists());
    }

    #[test]
    fn a_kept_file_of_a_disabled_skill_stays() {
        let env = Env::new("kept");
        env.apply();
        let artifact = file_of(SkillRoot::Claude, TWO_FILES, "SKILL.md");
        let skill_md = env.path(&artifact);
        fs::write(&skill_md, "mine\n").expect("edit");
        crate::kept_files::keep(
            &env.ws,
            &[crate::kept_files::Keep {
                dest: crate::kept_files::dest_label(&artifact, &env.home, &env.ws).expect("dest"),
                artifact: artifact.clone(),
                bundle: None,
            }],
        )
        .expect("keep");
        env.disable(&[TWO_FILES]);

        let plan = env.plan();
        let kept = plan
            .iter()
            .find(|planned| planned.artifact == artifact)
            .expect("kept file planned");
        assert_eq!(kept.kind, OperationKind::Manual);
        assert!(crate::file_conflicts::is_kept(kept));
        let support = file_of(SkillRoot::Claude, TWO_FILES, TWO_FILES_SUPPORT);
        assert_eq!(
            plan.iter()
                .find(|planned| planned.artifact == support)
                .map(|planned| planned.kind),
            Some(OperationKind::Manual)
        );

        env.apply();
        assert_eq!(fs::read_to_string(&skill_md).expect("kept"), "mine\n");
        assert!(env.path(&support).is_file());
    }

    #[test]
    fn reenabling_plans_creates() {
        let env = Env::new("reenable");
        env.apply();
        env.disable(&["tdd"]);
        env.apply();
        assert!(!env.root(SkillRoot::Claude).join("tdd").exists());

        env.enable(&["tdd"]);
        let kinds = env.kinds_of("tdd");
        assert!(!kinds.is_empty());
        assert!(
            kinds.iter().all(|(_, kind)| *kind == OperationKind::Create),
            "{kinds:?}"
        );
        env.apply();
        assert_eq!(
            fs::read(env.path(&file_of(SkillRoot::Claude, "tdd", "SKILL.md"))).expect("tdd"),
            fs::read(real_bundle().join("skills/tdd/SKILL.md")).expect("bundled")
        );
    }

    #[test]
    fn disabling_every_skill_plans_removals_not_an_error() {
        let env = Env::new("all");
        env.apply();
        let every: Vec<String> = env
            .sources()
            .catalog()
            .expect("catalog")
            .into_iter()
            .map(|entry| entry.skill.name)
            .collect();
        crate::disabled_skills::set(&env.ws, &every, false).expect("disable all");

        let plan = env.plan();
        assert!(!plan.is_empty());
        assert!(
            plan.iter()
                .all(|planned| planned.kind == OperationKind::Remove),
            "every installed file is removed"
        );
        let operation = env.skills_operation();
        assert_eq!(
            operation.summary,
            format!("Skills: {} disabled skills to remove", every.len())
        );
        env.apply();
        assert!(files_below(&env.root(SkillRoot::Claude)).is_empty());
        assert!(env.plan().is_empty(), "nothing left to plan");

    }

    #[test]
    fn an_unusable_file_makes_skills_unavailable_and_plans_nothing() {
        let env = Env::new("unusable");
        env.apply();
        let before = files_below(&env.root(SkillRoot::Claude));
        fs::write(env.disabled_file(), "not json").expect("garbage");

        let error = plan_artifacts_for_surfaces(&SURFACES, &env.ws, &env.home).unwrap_err();
        assert_eq!(error, UNUSABLE);
        let operation = env.skills_operation();
        assert_eq!(operation.kind, OperationKind::Unavailable);
        assert_eq!(operation.summary, format!("Skills unavailable: {UNUSABLE}"));
        let plan = env.preview();
        assert!(!plan.has_pending_changes);
        assert!(plan.plan_fingerprint.is_none());
        // The rules route to skills too: they are unavailable as well.
        assert!(
            crate::pack_routing::rules_source_text(&ArtifactId::ClaudeRules, &env.sources())
                .is_err()
        );
        let rules = plan_artifacts_for_surfaces(&[SetupSurfaceId::ClaudeRules], &env.ws, &env.home)
            .expect("rules plan");
        assert!(
            rules
                .iter()
                .all(|planned| planned.kind == OperationKind::Unavailable),
            "{:?}",
            rules.iter().map(|planned| planned.kind).collect::<Vec<_>>()
        );
        assert_eq!(files_below(&env.root(SkillRoot::Claude)), before);
        assert_eq!(
            fs::read_to_string(env.disabled_file()).expect("file"),
            "not json"
        );
    }

    #[test]
    fn uninstall_removes_owned_copies_of_disabled_skills_even_with_an_unusable_file() {
        let env = Env::new("uninstall");
        env.apply();
        env.disable(&["tdd"]);
        assert!(env.root(SkillRoot::Claude).join("tdd").is_dir());

        let plan = preview_uninstall().expect("uninstall preview");
        let removed =
            apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(removed.success, "uninstall: {}", removed.message);
        assert!(!env.root(SkillRoot::Claude).join("tdd").exists());
        assert!(!env.root(SkillRoot::Claude).join("diagnose").exists());
        assert!(env.disabled_file().is_file(), "uninstall keeps the choice");

        // Again, with a file that cannot be read.
        env.enable(&["tdd"]);
        env.apply();
        fs::write(env.disabled_file(), "not json").expect("garbage");
        let plan = preview_uninstall().expect("uninstall preview");
        let removed =
            apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(removed.success, "uninstall: {}", removed.message);
        assert!(files_below(&env.root(SkillRoot::Claude)).is_empty());
        assert_eq!(
            fs::read_to_string(env.disabled_file()).expect("file"),
            "not json"
        );
    }

    #[test]
    fn a_disabled_pack_skill_is_removed_not_held() {
        let env = Env::new("pack");
        env.pack_skill("mine", "my-checklist");
        env.apply();
        assert!(env.root(SkillRoot::Claude).join("my-checklist").is_dir());

        env.disable(&["my-checklist"]);
        let sources = env.sources();
        assert!(sources.held().is_empty(), "{:?}", sources.held());
        assert_eq!(
            sources.packs()[0].skills[0].state,
            PackSkillState::Active,
            "the pack still provides it"
        );
        let kinds = env.kinds_of("my-checklist");
        assert!(!kinds.is_empty());
        assert!(kinds.iter().all(|(_, kind)| *kind == OperationKind::Remove));

        env.apply();
        assert!(!env.root(SkillRoot::Claude).join("my-checklist").exists());
        assert!(env.sources().held().is_empty());
        assert!(env.kinds_of("my-checklist").is_empty());
    }

    #[test]
    fn disabling_a_bundled_skill_does_not_unshadow_a_pack_skill() {
        let env = Env::new("shadow");
        env.pack_skill("mine", "tdd");
        env.apply();
        env.disable(&["tdd"]);

        let sources = env.sources();
        assert_eq!(sources.packs()[0].skills[0].state, PackSkillState::Shadowed);
        assert_eq!(sources.pack_of("tdd"), None, "the bundle still holds it");
        env.apply();
        assert!(
            !env.root(SkillRoot::Claude).join("tdd").exists(),
            "neither the bundled nor the pack tdd is installed"
        );
    }

    #[test]
    fn apply_refuses_a_preview_made_before_a_skill_was_disabled() {
        let env = Env::new("stale-preview");
        let plan = env.preview();
        assert!(plan.has_pending_changes);
        env.disable(&["tdd"]);
        let error = apply_setup(
            vec![surface_name(SetupSurfaceId::Skills)],
            true,
            plan.plan_fingerprint,
            plan.preview_token,
        )
        .unwrap_err();
        assert!(error.contains("fingerprint mismatch"), "{error}");
        assert!(!env.root(SkillRoot::Claude).exists());
    }

    #[test]
    fn runtime_expected_count_excludes_disabled() {
        let env = Env::new("runtime");
        env.apply();
        let bundle = real_bundle();
        let roots = [SkillRoot::Claude];
        let status = |label: &str| {
            crate::skill_health::skill_files_status(
                &SkillSources::for_health(&bundle, Some(&env.ws)),
                &env.home,
                &roots,
            )
            .expect(label)
        };
        let before = status("before");
        assert_eq!(before.synced, before.expected);

        env.disable(&["tdd", TWO_FILES]);
        let after = status("after");
        assert_eq!(after.expected, before.expected - 2);
        assert_eq!(after.synced, after.expected, "the others stay synced");
    }

    // ── Commands ──

    #[test]
    fn set_skills_enabled_refuses_shadowed_held_and_unknown_names_on_disable() {
        use crate::commands::set_skills_enabled;
        let env = Env::new("refusals");
        env.pack_skill("one", "dup");
        env.pack_skill("two", "dup");
        env.pack_skill("mine", "my-checklist");
        env.pack_skill("mine", "tdd");
        env.apply();
        // The pack folder of an installed skill goes: the skill is held.
        fs::remove_dir_all(env.ws.join("packs/mine/skills/my-checklist")).expect("remove");
        fs::remove_dir_all(env.ws.join("packs/mine/skills/tdd")).expect("remove");
        fs::remove_dir_all(env.ws.join("packs/mine")).expect("remove pack");
        assert_eq!(env.sources().held().len(), 1);

        let refuse = |name: &str| {
            let error = set_skills_enabled(vec![name.to_string()], false).unwrap_err();
            assert!(!env.disabled_file().exists(), "{name}: nothing is written");
            error
        };
        let held = refuse("my-checklist");
        assert!(held.contains("kept as it is installed"), "{held}");
        let broken = refuse("dup");
        assert!(broken.contains("another pack skill"), "{broken}");
        let unknown = refuse("no-such-skill");
        assert!(
            unknown.contains("no skill named no-such-skill"),
            "{unknown}"
        );
        // One refused name refuses the whole call.
        set_skills_enabled(names(&["diagnose", "no-such-skill"]), false).unwrap_err();
        assert!(!env.disabled_file().exists());
        assert!(set_skills_enabled(Vec::new(), false).is_err());

        // A shadowed pack skill has the bundled skill's name: that names the bundled skill, which
        // is disabled, and the pack skill stays shadowed.
        env.pack_skill("mine", "tdd");
        set_skills_enabled(names(&["tdd", "diagnose"]), false).expect("disable");
        let sources = env.sources();
        assert!(sources.is_disabled("tdd") && sources.is_disabled("diagnose"));
        let pack = sources
            .packs()
            .iter()
            .find(|pack| pack.name == "mine")
            .expect("pack");
        assert_eq!(pack.skills[0].state, PackSkillState::Shadowed);

        // A file that cannot be read refuses every change.
        fs::write(env.disabled_file(), "not json").expect("garbage");
        for enabled in [true, false] {
            assert_eq!(
                set_skills_enabled(names(&["diagnose"]), enabled),
                Err(UNUSABLE.to_string())
            );
        }
        let choices = crate::commands::list_skill_choices().expect("choices");
        assert_eq!(choices.problem.as_deref(), Some(UNUSABLE));
        assert!(choices.disabled.is_empty());
    }

    #[test]
    fn enable_forgets_an_unknown_name() {
        use crate::commands::{list_skill_choices, set_skills_enabled};
        let env = Env::new("forget");
        env.pack_skill("mine", "my-checklist");
        env.apply();
        set_skills_enabled(names(&["my-checklist", "tdd"]), false).expect("disable");
        let choices = list_skill_choices().expect("choices");
        let listed: Vec<(&str, &str, bool)> = choices
            .disabled
            .iter()
            .map(|skill| (skill.name.as_str(), skill.source.as_str(), skill.installed))
            .collect();
        assert_eq!(
            listed,
            vec![("my-checklist", "pack:mine", true), ("tdd", "bundle", true)]
        );

        // The pack goes: the name stays disabled and is listed as not in the catalog.
        fs::remove_dir_all(env.ws.join("packs")).expect("remove packs");
        let choices = list_skill_choices().expect("choices");
        assert_eq!(choices.disabled[0].name, "my-checklist");
        assert_eq!(choices.disabled[0].source, "unknown");
        assert!(env.sources().is_disabled("my-checklist"));

        set_skills_enabled(names(&["my-checklist"]), true).expect("enable");
        let choices = list_skill_choices().expect("choices");
        assert_eq!(
            choices
                .disabled
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["tdd"]
        );
        // Enabling a name that was never disabled changes nothing.
        set_skills_enabled(names(&["never-disabled"]), true).expect("enable");
        assert!(env.sources().is_disabled("tdd"));
    }

    #[test]
    fn named_by_lists_ci_triage_for_diagnose() {
        let env = Env::new("named-by");
        let choices = crate::commands::list_skill_choices().expect("choices");
        let by = choices.named_by.get("diagnose").expect("diagnose is named");
        assert!(by.contains(&"ci-triage".to_string()), "{by:?}");
        assert!(!by.contains(&"diagnose".to_string()), "not by itself");
        let mut sorted = by.clone();
        sorted.sort();
        assert_eq!(by, &sorted);
        assert!(choices.problem.is_none());
        assert!(choices.disabled.is_empty());
        drop(env);
    }

    // ── Harness pages ──

    #[test]
    fn a_disabled_skills_installed_copy_is_flagged() {
        use crate::skill_loads::{
            effective_skill_loads, FolderPaths, OwnershipProof, SkillLoadFlag,
        };
        let env = Env::new("loads");
        env.apply();
        let loads = || {
            let records = crate::managed_state::read_managed_state(&env.ws)
                .expect("state")
                .artifacts;
            let proof = OwnershipProof::new(&env.sources(), &records).expect("proof");
            effective_skill_loads(
                &env.home,
                &[crate::agent_targets::HarnessId::Claude],
                &FolderPaths::resolve(&env.home),
                &proof,
            )
        };
        let flags_of = |name: &str| {
            loads().harnesses[0]
                .skills
                .iter()
                .find(|load| load.name == name)
                .map(|load| load.flags.clone())
        };
        assert_eq!(flags_of("tdd"), Some(Vec::new()));

        env.disable(&["tdd"]);
        assert_eq!(flags_of("tdd"), Some(vec![SkillLoadFlag::Disabled]));
        assert_eq!(flags_of("diagnose"), Some(Vec::new()));
        env.apply();
        assert_eq!(flags_of("tdd"), None, "removed: nothing loads it");
    }

    #[cfg(unix)]
    #[test]
    fn a_disabled_skill_whose_recorded_support_file_is_a_dangling_link_keeps_all_its_files() {
        let env = Env::new("dangling");
        env.apply();
        let skill_md = env.path(&file_of(SkillRoot::Claude, TWO_FILES, "SKILL.md"));
        let support = env.path(&file_of(SkillRoot::Claude, TWO_FILES, TWO_FILES_SUPPORT));
        fs::remove_file(&support).expect("remove support file");
        std::os::unix::fs::symlink(env.base.join("nowhere"), &support).expect("dangling link");
        env.disable(&[TWO_FILES]);

        let claude: Vec<(ArtifactId, OperationKind)> = env
            .kinds_of(TWO_FILES)
            .into_iter()
            .filter(|(artifact, _)| {
                artifact
                    .as_skill_file()
                    .is_some_and(|file| file.root == SkillRoot::Claude)
            })
            .collect();
        assert_eq!(claude.len(), 2, "the link is planned too: {claude:?}");
        assert!(
            claude
                .iter()
                .all(|(_, kind)| *kind == OperationKind::Manual),
            "{claude:?}"
        );

        env.apply();
        assert!(skill_md.is_file(), "no half skill is left behind");
        assert!(fs::symlink_metadata(&support)
            .expect("link")
            .file_type()
            .is_symlink());
        assert!(!env.root(SkillRoot::Agents).join(TWO_FILES).exists());
    }
}
