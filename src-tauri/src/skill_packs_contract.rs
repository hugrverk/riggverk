//! Contract tests for runtime skill packs.
//!
//! A pack is a folder of the user's own skills in the data folder
//! (`<workspace>/packs/<pack>/skills/...`). It joins the bundle in one catalog, and a skill is
//! owned, backed up and rolled back exactly as a bundled one. These tests install into a temp HOME
//! and data folder, with the real bundle or a copy of it that lacks the skills a test moves into a
//! pack. They never touch the real profile.

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
    use crate::managed_state::{artifact_identity, read_managed_state};
    use crate::setup_lifecycle::{OperationKind, SetupPlan, SetupSurfaceId};
    use crate::setup_transaction::{plan_artifacts_for_surfaces, PlannedArtifact};
    use crate::skill_roots::SkillRoot;
    use crate::skill_sources::{HeldState, PackSkillState, SkillSources};
    use crate::test_env::{canonical_skill_text, guard, guard::EnvRestore, set_test_user_dirs};

    const SURFACES: [SetupSurfaceId; 1] = [SetupSurfaceId::Skills];

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

    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).expect("create dir");
        for entry in fs::read_dir(from).expect("read dir") {
            let entry = entry.expect("entry");
            let target = to.join(entry.file_name());
            if entry.file_type().expect("file type").is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).expect("copy file");
            }
        }
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("chmod");
    }

    #[cfg(not(unix))]
    fn set_mode(_path: &Path, _mode: u32) {}

    /// The skills folders (Claude, then the shared agents folder) and the ownership records.
    type Footprint = (
        BTreeMap<String, Vec<u8>>,
        BTreeMap<String, Vec<u8>>,
        Option<Vec<u8>>,
    );

    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        // Drop order matters: the bundle override and the environment go before the lock.
        _bundle: Option<crate::setup_roots::test_bundle::Guard>,
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
            let base = std::env::temp_dir().join(format!("aw-skill-packs-{label}-{nanos}"));
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
                _bundle: None,
                _isolated: isolated,
                _restore: restore,
                _guard: guard,
            }
        }

        fn real_bundle() -> PathBuf {
            crate::setup_roots::bundled_root().expect("bundled root")
        }

        /// Ships a copy of the bundle without the named entries below `skills/`, from now on.
        fn ship_bundle_without(&mut self, removed: &[&str]) -> PathBuf {
            // The override is dropped first, so the copy is made from the real bundle.
            self._bundle = None;
            let bundle = self.base.join("bundle");
            let _ = fs::remove_dir_all(&bundle);
            copy_tree(&Self::real_bundle(), &bundle);
            for rel in removed {
                fs::remove_dir_all(bundle.join("skills").join(rel)).expect("remove from copy");
            }
            self._bundle = Some(crate::setup_roots::test_bundle::set(bundle.clone()));
            bundle
        }

        fn packs(&self) -> PathBuf {
            self.ws.join("packs")
        }

        /// A pack folder the way a user would clone one: owner-writable only.
        fn pack(&self, pack: &str) -> PathBuf {
            let dir = self.packs().join(pack);
            fs::create_dir_all(dir.join("skills")).expect("pack dir");
            set_mode(&dir, 0o755);
            dir
        }

        /// A skill in a pack. `files` are supporting files; `group` adds a folder level.
        fn pack_skill(
            &self,
            pack: &str,
            group: Option<&str>,
            name: &str,
            body: &str,
            files: &[(&str, &str)],
        ) -> PathBuf {
            let skills = self.pack(pack).join("skills");
            let dir = match group {
                Some(group) => skills.join(group).join(name),
                None => skills.join(name),
            };
            fs::create_dir_all(&dir).expect("skill dir");
            fs::write(dir.join("SKILL.md"), canonical_skill_text(name, body)).expect("SKILL.md");
            for (rel, text) in files {
                let path = dir.join(rel);
                fs::create_dir_all(path.parent().expect("parent")).expect("support dir");
                fs::write(path, text).expect("support file");
            }
            dir
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

        fn kind(&self, artifact: &ArtifactId) -> Option<OperationKind> {
            self.plan()
                .into_iter()
                .find(|planned| &planned.artifact == artifact)
                .map(|planned| planned.kind)
        }

        fn pending(&self) -> Vec<(ArtifactId, OperationKind)> {
            self.plan()
                .into_iter()
                .filter(|planned| planned.kind != OperationKind::NoChange)
                .map(|planned| (planned.artifact, planned.kind))
                .collect()
        }

        fn preview(&self) -> SetupPlan {
            preview_setup(SURFACES.iter().copied().map(surface_name).collect()).expect("preview")
        }

        fn apply(&self) -> SetupResult {
            let plan = self.preview();
            apply_setup(
                vec![surface_name(SetupSurfaceId::Skills)],
                true,
                plan.plan_fingerprint.clone(),
                plan.preview_token.clone(),
            )
            .expect("apply_setup")
        }

        fn sources(&self) -> SkillSources {
            SkillSources::for_workspace(&self.ws).expect("skill sources")
        }

        fn state_bytes(&self) -> Option<Vec<u8>> {
            fs::read(crate::managed_state::managed_state_path(&self.ws)).ok()
        }

        /// Everything an install leaves on disk: the skills folders and the ownership records.
        fn footprint(&self) -> Footprint {
            (
                files_below(&self.root(SkillRoot::Claude)),
                files_below(&self.root(SkillRoot::Agents)),
                self.state_bytes(),
            )
        }

        fn recorded_packs(&self) -> serde_json::Value {
            let path = crate::workspace_layout::state_file(&self.ws, "pack-skills.json");
            serde_json::from_slice(&fs::read(path).expect("pack-skills.json"))
                .expect("pack-skills.json is JSON")
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    // ── Moving a skill from the bundle into a pack ──

    #[test]
    fn a_skill_group_moved_byte_for_byte_from_the_bundle_into_a_pack_plans_and_writes_nothing() {
        let mut env = Env::new("moved");
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let installed = env.footprint();
        let report = file_of(
            SkillRoot::Claude,
            "kretsverket-status-report",
            "assets/report-template.html",
        );
        assert!(env.path(&report).is_file(), "the nested file is installed");

        // The next release ships without the group; the user keeps it in a pack, byte for byte.
        let bundle = Env::real_bundle();
        env.ship_bundle_without(&["kretsverket"]);
        env.pack("mine");
        copy_tree(
            &bundle.join("skills/kretsverket"),
            &env.packs().join("mine/skills/kretsverket"),
        );
        set_mode(&env.packs().join("mine"), 0o755);

        assert_eq!(env.pending(), vec![], "nothing to create, update or remove");
        assert_eq!(env.kind(&report), Some(OperationKind::NoChange));
        let plan = env.preview();
        assert!(
            plan.operations.iter().all(|op| !op.kind.needs_apply()),
            "the review has nothing to apply: {:?}",
            plan.operations.iter().map(|op| op.kind).collect::<Vec<_>>()
        );
        assert_eq!(env.footprint(), installed, "zero writes");
    }

    // ── Name collisions ──

    #[test]
    fn a_pack_skill_named_like_a_bundled_skill_is_shadowed_and_the_bundle_wins() {
        let env = Env::new("shadow");
        env.pack_skill("mine", None, "tdd", "the pack's own idea of tdd", &[]);
        env.pack_skill("mine", None, "my-checklist", "kept in the pack", &[]);

        let sources = env.sources();
        let pack = &sources.packs()[0];
        let tdd = pack.skills.iter().find(|s| s.name == "tdd").expect("tdd");
        assert_eq!(tdd.state, PackSkillState::Shadowed);
        assert!(tdd.reason.contains("bundle"), "{}", tdd.reason);
        let mine = pack
            .skills
            .iter()
            .find(|s| s.name == "my-checklist")
            .expect("mine");
        assert_eq!(mine.state, PackSkillState::Active);

        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let bundled = fs::read(Env::real_bundle().join("skills/tdd/SKILL.md")).expect("bundled");
        assert_eq!(
            fs::read(env.path(&file_of(SkillRoot::Claude, "tdd", "SKILL.md"))).expect("tdd"),
            bundled,
            "the bundle's tdd is installed"
        );
        assert!(
            env.path(&file_of(SkillRoot::Claude, "my-checklist", "SKILL.md"))
                .is_file(),
            "the other pack skill installs"
        );
        assert_eq!(env.pending(), vec![]);
    }

    #[test]
    fn two_packs_with_one_skill_name_fail_that_skill_only() {
        let env = Env::new("two-packs");
        env.pack_skill("alpha", None, "shared-name", "from alpha", &[]);
        env.pack_skill("beta", None, "shared-name", "from beta", &[]);
        env.pack_skill("alpha", None, "alpha-only", "fine", &[]);

        let sources = env.sources();
        for pack in sources.packs() {
            let shared = pack
                .skills
                .iter()
                .find(|s| s.name == "shared-name")
                .expect("shared");
            assert_eq!(shared.state, PackSkillState::Error, "{}", pack.name);
            assert!(shared.reason.contains("alpha") && shared.reason.contains("beta"));
        }
        // The plan still works, and installs everything else.
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        assert!(!env
            .path(&file_of(SkillRoot::Claude, "shared-name", "SKILL.md"))
            .exists());
        assert!(env
            .path(&file_of(SkillRoot::Claude, "alpha-only", "SKILL.md"))
            .is_file());
    }

    // ── A pack that goes missing ──

    #[test]
    fn a_missing_pack_plans_no_removal_and_forgetting_it_removes_the_copies_with_a_backup() {
        let env = Env::new("missing");
        env.pack_skill(
            "mine",
            None,
            "my-checklist",
            "kept in the pack",
            &[("notes.md", "n\n")],
        );
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let skill_md = file_of(SkillRoot::Claude, "my-checklist", "SKILL.md");
        let notes = file_of(SkillRoot::Agents, "my-checklist", "notes.md");
        assert!(env.path(&skill_md).is_file() && env.path(&notes).is_file());
        assert_eq!(
            env.recorded_packs()["packs"]["mine"],
            serde_json::json!(["my-checklist"]),
            "the install recorded which skills came from the pack"
        );

        // The pack folder is gone (a failed pull, an unmounted disk).
        fs::remove_dir_all(env.packs()).expect("remove packs");
        let removals: Vec<_> = env
            .pending()
            .into_iter()
            .filter(|(_, kind)| *kind == OperationKind::Remove)
            .collect();
        assert_eq!(removals, vec![], "an unreachable pack is not a retirement");
        assert_eq!(env.pending(), vec![]);
        let held = env.sources().held().to_vec();
        assert_eq!(held.len(), 1);
        assert_eq!(
            (held[0].pack.as_str(), held[0].name.as_str()),
            ("mine", "my-checklist")
        );
        assert_eq!(held[0].state, HeldState::Missing);
        let library = crate::commands::list_pack_skills().expect("library");
        let listed = library
            .skills
            .iter()
            .find(|s| s.name == "my-checklist")
            .expect("listed");
        assert_eq!(listed.state, "missing");
        let pack = library
            .packs
            .iter()
            .find(|p| p.name == "mine")
            .expect("pack");
        assert!(pack.forgettable);
        // Installing again leaves the held copies alone and keeps the record.
        let again = env.apply_if_needed();
        assert!(again.is_none(), "nothing to apply");
        assert!(env.path(&skill_md).is_file());
        assert_eq!(
            env.recorded_packs()["packs"]["mine"],
            serde_json::json!(["my-checklist"])
        );

        // Forgetting the pack is the explicit step; then the normal retirement applies.
        assert_eq!(
            crate::commands::forget_pack("mine".to_string()).expect("forget"),
            1
        );
        assert!(env.sources().held().is_empty());
        let kinds: Vec<_> = env.pending().into_iter().map(|(_, kind)| kind).collect();
        assert_eq!(
            kinds.len(),
            4,
            "SKILL.md and notes.md in two folders: {kinds:?}"
        );
        assert!(kinds.iter().all(|kind| *kind == OperationKind::Remove));
        let removed = env.apply();
        assert!(removed.success, "remove: {}", removed.message);
        assert!(!env.path(&skill_md).exists() && !env.path(&notes).exists());
        assert!(!env.root(SkillRoot::Claude).join("my-checklist").exists());
        assert!(
            read_managed_state(&env.ws)
                .expect("state")
                .artifacts
                .iter()
                .all(|record| record.identity != artifact_identity(&skill_md)),
            "the record is gone"
        );

        // The removal was a backed-up transaction: rolling it back brings the files back.
        let rolled = rollback_setup_transaction(removed.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert_eq!(
            fs::read_to_string(env.path(&notes)).expect("restored"),
            "n\n",
            "the backup restored the removed file"
        );
        assert!(env.path(&skill_md).is_file());
    }

    #[test]
    fn a_skill_removed_from_a_pack_that_is_present_is_retired_as_usual() {
        let env = Env::new("retired");
        env.pack_skill("mine", None, "keep-me", "stays", &[]);
        let gone = env.pack_skill("mine", None, "drop-me", "goes", &[("extra.md", "x\n")]);
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let drop_md = file_of(SkillRoot::Claude, "drop-me", "SKILL.md");
        assert!(env.path(&drop_md).is_file());

        fs::remove_dir_all(gone).expect("remove the skill from the pack");
        assert!(
            env.sources().held().is_empty(),
            "the pack is present: nothing is held"
        );
        assert_eq!(env.kind(&drop_md), Some(OperationKind::Remove));
        let removed = env.apply();
        assert!(removed.success, "remove: {}", removed.message);
        assert!(!env.path(&drop_md).exists());
        assert!(env
            .path(&file_of(SkillRoot::Claude, "keep-me", "SKILL.md"))
            .is_file());
        assert_eq!(
            env.recorded_packs()["packs"]["mine"],
            serde_json::json!(["keep-me"])
        );
    }

    // ── Unsafe packs ──

    #[cfg(unix)]
    #[test]
    fn a_symlinked_pack_or_a_symlink_inside_a_pack_is_refused() {
        let env = Env::new("symlinks");
        // A pack that is a link to a folder elsewhere.
        let elsewhere = env.base.join("elsewhere/skills");
        fs::create_dir_all(&elsewhere).expect("elsewhere");
        fs::write(
            env.base.join("elsewhere/skills/SKILL.md"),
            canonical_skill_text("linked-skill", "x"),
        )
        .expect("skill");
        fs::create_dir_all(env.packs()).expect("packs");
        std::os::unix::fs::symlink(env.base.join("elsewhere"), env.packs().join("linked"))
            .expect("link pack");
        // A pack with a link inside one of its skills.
        let dir = env.pack_skill("tainted", None, "has-link", "x", &[]);
        std::os::unix::fs::symlink(env.base.join("elsewhere"), dir.join("assets")).expect("link");
        env.pack_skill("tainted", None, "innocent", "x", &[]);
        // A pack whose SKILL.md is a link.
        let skill = env.pack("md-link").join("skills/linked-md");
        fs::create_dir_all(&skill).expect("skill dir");
        std::os::unix::fs::symlink(
            env.base.join("elsewhere/skills/SKILL.md"),
            skill.join("SKILL.md"),
        )
        .expect("link SKILL.md");

        let sources = env.sources();
        assert!(
            sources
                .ignored()
                .iter()
                .any(|(name, reason)| name == "linked" && reason.contains("symlink")),
            "{:?}",
            sources.ignored()
        );
        for name in ["tainted", "md-link"] {
            let pack = sources.packs().iter().find(|p| p.name == name).expect(name);
            assert!(
                pack.refused
                    .as_deref()
                    .is_some_and(|reason| reason.contains("symlink")),
                "{name}: {:?}",
                pack.refused
            );
            assert!(pack.skills.is_empty(), "none of its skills is read");
        }
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        for skill in ["linked-skill", "has-link", "innocent", "linked-md"] {
            assert!(
                !env.root(SkillRoot::Claude).join(skill).exists(),
                "{skill} is not installed"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_group_or_world_writable_pack_is_refused() {
        let env = Env::new("writable");
        env.pack_skill("loose", None, "loose-skill", "x", &[]);
        env.pack_skill("tight", None, "tight-skill", "x", &[]);
        set_mode(&env.packs().join("loose"), 0o775);

        let sources = env.sources();
        let loose = sources
            .packs()
            .iter()
            .find(|p| p.name == "loose")
            .expect("loose");
        assert!(
            loose
                .refused
                .as_deref()
                .is_some_and(|reason| reason.contains("writable")),
            "{:?}",
            loose.refused
        );
        let tight = sources
            .packs()
            .iter()
            .find(|p| p.name == "tight")
            .expect("tight");
        assert_eq!(tight.refused, None);

        set_mode(&env.packs().join("loose"), 0o757);
        assert!(env
            .sources()
            .packs()
            .iter()
            .find(|p| p.name == "loose")
            .expect("loose")
            .refused
            .is_some());

        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        assert!(!env.root(SkillRoot::Claude).join("loose-skill").exists());
        assert!(env
            .root(SkillRoot::Claude)
            .join("tight-skill/SKILL.md")
            .is_file());
    }

    #[test]
    fn folders_that_are_no_pack_are_ignored_with_a_reason() {
        let env = Env::new("names");
        env.pack_skill("good-pack", None, "good-skill", "x", &[]);
        fs::create_dir_all(env.packs().join("Bad_Name/skills")).expect("bad name");
        fs::write(env.packs().join("README.md"), "not a pack\n").expect("file");
        fs::create_dir_all(env.packs().join(".git")).expect("dot dir");

        let sources = env.sources();
        assert_eq!(sources.packs().len(), 1);
        assert_eq!(sources.ignored().len(), 1, "{:?}", sources.ignored());
        assert_eq!(sources.ignored()[0].0, "Bad_Name");
        assert!(sources.ignored()[0].1.contains("pack name"));
    }

    // ── Support files, rollback, uninstall ──

    #[test]
    fn nested_support_files_of_a_pack_skill_install_everywhere_and_roll_back() {
        let env = Env::new("nested");
        env.pack_skill(
            "mine",
            Some("tools"),
            "toolbox",
            "uses its files",
            &[
                ("assets/report/template.html", "<html>\n"),
                ("scripts/run.sh", "#!/bin/sh\necho ok\n"),
                ("REFERENCE.md", "ref\n"),
            ],
        );
        let before = env.footprint();
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);

        let expected: BTreeMap<String, Vec<u8>> = [
            ("REFERENCE.md", "ref\n"),
            ("SKILL.md", ""),
            ("assets/report/template.html", "<html>\n"),
            ("scripts/run.sh", "#!/bin/sh\necho ok\n"),
        ]
        .into_iter()
        .map(|(rel, text)| (rel.to_string(), text.as_bytes().to_vec()))
        .collect();
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            let mut installed = files_below(&env.root(root).join("toolbox"));
            let skill_md = installed.remove("SKILL.md").expect("SKILL.md");
            assert_eq!(
                skill_md,
                canonical_skill_text("toolbox", "uses its files").into_bytes()
            );
            let mut want = expected.clone();
            want.remove("SKILL.md");
            assert_eq!(installed, want, "{root:?}");
        }
        assert_eq!(env.pending(), vec![], "a second plan has nothing to do");

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert!(!env.root(SkillRoot::Claude).join("toolbox").exists());
        assert!(!env.root(SkillRoot::Agents).join("toolbox").exists());
        assert_eq!(env.footprint().0, before.0);
    }

    #[test]
    fn uninstall_removes_the_app_owned_copies_of_pack_skills_and_keeps_foreign_files() {
        let env = Env::new("uninstall");
        env.pack_skill(
            "mine",
            None,
            "my-checklist",
            "kept in the pack",
            &[("notes.md", "n\n")],
        );
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let claude = env.root(SkillRoot::Claude);
        fs::write(claude.join("my-checklist/mine.md"), "mine").expect("foreign file");

        let plan = preview_uninstall().expect("uninstall preview");
        let removed =
            apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(removed.success, "uninstall: {}", removed.message);

        assert!(!claude.join("my-checklist/SKILL.md").exists());
        assert!(!claude.join("my-checklist/notes.md").exists());
        assert!(!env.root(SkillRoot::Agents).join("my-checklist").exists());
        assert_eq!(
            fs::read_to_string(claude.join("my-checklist/mine.md")).expect("foreign"),
            "mine",
            "a file the user added stays"
        );
        assert!(
            env.packs()
                .join("mine/skills/my-checklist/SKILL.md")
                .is_file(),
            "the pack itself is never touched"
        );
    }

    #[test]
    fn uninstall_also_removes_the_copies_held_for_a_missing_pack() {
        let env = Env::new("uninstall-held");
        env.pack_skill("mine", None, "my-checklist", "kept in the pack", &[]);
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        fs::remove_dir_all(env.packs()).expect("remove packs");
        assert_eq!(env.sources().held().len(), 1);

        let plan = preview_uninstall().expect("uninstall preview");
        let removed =
            apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(removed.success, "uninstall: {}", removed.message);
        assert!(!env.root(SkillRoot::Claude).join("my-checklist").exists());
        assert!(!env.root(SkillRoot::Agents).join("my-checklist").exists());
    }

    #[test]
    fn an_installed_pack_skill_is_not_reported_as_the_users_own_copy() {
        let env = Env::new("loads");
        env.pack_skill("mine", None, "my-checklist", "kept in the pack", &[]);
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);

        let sources = env.sources();
        let records = read_managed_state(&env.ws).expect("state").artifacts;
        let proof = crate::skill_loads::OwnershipProof::new(&sources, &records).expect("proof");
        let loads = crate::skill_loads::effective_skill_loads(
            &env.home,
            &crate::agent_targets::default_enabled_harness_ids(),
            &crate::skill_loads::FolderPaths::resolve(&env.home),
            &proof,
        );
        let copies: Vec<_> = loads
            .harnesses
            .iter()
            .flat_map(|harness| &harness.skills)
            .filter(|load| load.name == "my-checklist")
            .flat_map(|load| &load.copies)
            .collect();
        assert!(!copies.is_empty(), "the installed pack skill is found");
        assert!(
            copies
                .iter()
                .all(|copy| copy.owner == crate::skill_loads::Owner::Aw && copy.current),
            "{copies:?}"
        );
        assert!(loads.foreign_duplicates.is_empty());
    }

    #[test]
    fn health_reads_packs_only_from_the_data_folder_it_is_given() {
        let env = Env::new("health");
        env.pack_skill("mine", None, "my-checklist", "kept in the pack", &[]);
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let bundle = Env::real_bundle();
        let roots = [SkillRoot::Claude];

        // The environment names a data folder with a pack in it, and still a check that was not
        // handed the folder looks at the bundle alone.
        let without = crate::skill_health::skill_files_status(
            &SkillSources::for_health(&bundle, None),
            &env.home,
            &roots,
        )
        .expect("status");
        let with = crate::skill_health::skill_files_status(
            &SkillSources::for_health(&bundle, Some(&env.ws)),
            &env.home,
            &roots,
        )
        .expect("status");
        assert_eq!(with.expected, without.expected + 1);
        assert_eq!(
            with.synced,
            without.synced + 1,
            "the installed pack skill is in sync"
        );
    }

    /// A pack skill whose directory name differs from its declared name, installed.
    fn install_renamed_pack_skill(env: &Env) -> PathBuf {
        let dir = env.pack_skill("mine", None, "folder-name", "x", &[("notes.md", "n\n")]);
        fs::write(
            dir.join("SKILL.md"),
            canonical_skill_text("declared-name", "kept in the pack"),
        )
        .expect("rename inside the file");
        env.pack_skill("mine", None, "steady", "stays", &[]);
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        assert!(env
            .root(SkillRoot::Claude)
            .join("declared-name/SKILL.md")
            .is_file());
        dir
    }

    fn no_removals(env: &Env) {
        let removals: Vec<_> = env
            .pending()
            .into_iter()
            .filter(|(_, kind)| *kind == OperationKind::Remove)
            .collect();
        assert_eq!(removals, vec![], "a broken pack skill is held, not retired");
    }

    #[test]
    fn a_broken_pack_skill_is_held_under_the_name_it_declares_not_its_folder_name() {
        let env = Env::new("declared-name");
        let dir = install_renamed_pack_skill(&env);

        // Still parses as far as its name, but no longer as a skill (no description).
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: declared-name\n---\n# broken\n",
        )
        .expect("break it");
        let sources = env.sources();
        let held = sources.held();
        assert_eq!(held.len(), 1, "{held:?}");
        assert_eq!(
            (held[0].pack.as_str(), held[0].name.as_str()),
            ("mine", "declared-name")
        );
        assert_eq!(held[0].state, HeldState::Error);
        no_removals(&env);
    }

    #[test]
    fn a_pack_with_a_broken_skill_holds_recorded_names_it_cannot_find() {
        let env = Env::new("fail-closed");
        let dir = install_renamed_pack_skill(&env);

        // Nothing readable is left of the skill, not even its name: another skill of a present pack
        // is broken, so the recorded name cannot be told removed from hidden.
        fs::write(dir.join("SKILL.md"), "garbage, no frontmatter at all\n").expect("break it");
        let held = env.sources().held().to_vec();
        assert_eq!(held.len(), 1, "{held:?}");
        assert_eq!(held[0].name, "declared-name");
        assert_eq!(held[0].state, HeldState::Error);
        no_removals(&env);

        // Deleting the skill from a pack with no broken skill is a removal on purpose.
        fs::remove_dir_all(&dir).expect("delete the skill");
        assert!(env.sources().held().is_empty());
        assert_eq!(
            env.kind(&file_of(SkillRoot::Claude, "declared-name", "SKILL.md")),
            Some(OperationKind::Remove)
        );
    }

    /// A pack with one installed skill, `my-checklist`.
    fn installed_pack(env: &Env) -> PathBuf {
        env.pack_skill("mine", None, "my-checklist", "kept in the pack", &[]);
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        env.packs().join("mine")
    }

    fn assert_held_not_retired(env: &Env, expected_reason: &str) {
        let sources = env.sources();
        let held = sources.held();
        assert_eq!(held.len(), 1, "{held:?}");
        assert_eq!(held[0].name, "my-checklist");
        assert!(
            held[0].reason.contains(expected_reason),
            "{}",
            held[0].reason
        );
        no_removals(env);
        assert!(env
            .root(SkillRoot::Claude)
            .join("my-checklist/SKILL.md")
            .is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_skills_folder_that_cannot_be_inspected_holds_the_installed_skills() {
        let env = Env::new("unreadable-skills");
        let pack = installed_pack(&env);

        // The pack folder cannot be searched, so its skills folder can neither be read nor found
        // missing.
        set_mode(&pack, 0o000);
        let reason = env.sources().packs()[0].refused.clone();
        set_mode(&pack, 0o755);
        assert!(
            reason.is_some_and(|reason| reason.contains("cannot")),
            "refused"
        );
        set_mode(&pack, 0o000);
        let held = env.sources().held().len();
        let removals = env
            .pending()
            .into_iter()
            .filter(|(_, kind)| *kind == OperationKind::Remove)
            .count();
        set_mode(&pack, 0o755);
        assert_eq!(held, 1);
        assert_eq!(removals, 0);
    }

    #[test]
    fn a_skills_entry_that_is_no_folder_refuses_the_pack_and_holds_its_skills() {
        let env = Env::new("skills-is-a-file");
        let pack = installed_pack(&env);
        fs::remove_dir_all(pack.join("skills")).expect("remove skills");
        fs::write(pack.join("skills"), "not a folder\n").expect("a file in its place");
        assert_held_not_retired(&env, "not a folder");
    }

    #[test]
    fn a_pack_that_holds_no_skills_any_more_holds_the_installed_ones() {
        let env = Env::new("emptied");
        let pack = installed_pack(&env);
        fs::remove_dir_all(pack.join("skills/my-checklist")).expect("empty the pack");
        assert_held_not_retired(&env, "no skills");

        // A pack folder without any skills folder is the same.
        fs::remove_dir_all(pack.join("skills")).expect("remove skills");
        assert_held_not_retired(&env, "no skills");
    }

    /// An installed skill the app retired long ago (`REMOVED_SKILL_NAMES`), with its record.
    fn install_retired_bundle_skill(env: &Env) -> ArtifactId {
        // Any retired name works; take it from the list so no retired name is spelled out here.
        let retired = crate::managed_bootstrap::REMOVED_SKILL_NAMES[0];
        let artifact = file_of(SkillRoot::Claude, retired, "SKILL.md");
        let dest = env.path(&artifact);
        fs::create_dir_all(dest.parent().expect("parent")).expect("dir");
        fs::write(&dest, b"retired skill\n").expect("write");
        let mut state = read_managed_state(&env.ws).expect("state");
        state
            .artifacts
            .push(crate::managed_state::ManagedArtifactRecord {
                identity: artifact_identity(&artifact),
                hash: crate::stable_digest::bytes(b"retired skill\n"),
                surface: None,
            });
        state.artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
        crate::managed_state::write_managed_state_atomic(&env.ws, &state).expect("state");
        artifact
    }

    fn record_path(env: &Env) -> PathBuf {
        crate::workspace_layout::state_file(&env.ws, "pack-skills.json")
    }

    fn assert_everything_unknown_is_held(env: &Env, retired: &ArtifactId, expected: &str) {
        let skill_md = file_of(SkillRoot::Claude, "my-checklist", "SKILL.md");
        let sources = env.sources();
        assert!(
            sources
                .record_problem()
                .is_some_and(|problem| problem.contains(expected)),
            "{:?}",
            sources.record_problem()
        );
        let held: Vec<_> = sources
            .held()
            .iter()
            .map(|held| held.name.as_str())
            .collect();
        assert_eq!(
            held,
            vec!["my-checklist"],
            "the retired bundle skill is not held"
        );
        assert_eq!(env.kind(&skill_md), None, "a held skill is not planned");
        assert_eq!(env.kind(retired), Some(OperationKind::Remove));
        let removals: Vec<_> = env
            .pending()
            .into_iter()
            .filter(|(_, kind)| *kind == OperationKind::Remove)
            .map(|(artifact, _)| artifact)
            .collect();
        assert_eq!(removals, vec![retired.clone()]);
    }

    #[test]
    fn a_corrupt_pack_record_holds_every_installed_skill_the_catalog_lacks() {
        let env = Env::new("corrupt-record");
        installed_pack(&env);
        let retired = install_retired_bundle_skill(&env);
        fs::remove_dir_all(env.packs()).expect("remove packs");
        fs::write(record_path(&env), "{ not json").expect("corrupt the record");

        assert_everything_unknown_is_held(&env, &retired, "cannot be read");
        // An apply goes on with what is provably retired, says nothing about the file in the
        // result, and leaves the file as it is.
        let result = env.apply();
        assert!(result.success, "apply: {}", result.message);
        assert!(!env.path(&retired).exists());
        assert!(
            result
                .manual_steps
                .iter()
                .all(|step| !step.contains("pack-skills")),
            "{:?}",
            result.manual_steps
        );
        assert_eq!(
            fs::read_to_string(record_path(&env)).expect("kept"),
            "{ not json"
        );
        assert!(env
            .root(SkillRoot::Claude)
            .join("my-checklist/SKILL.md")
            .is_file());
        assert_eq!(
            crate::commands::forget_pack("mine".to_string()).expect_err("no forgetting"),
            "pack-skills.json cannot be read, so installed pack skills are kept as they are; fix or remove the file"
        );
    }

    #[test]
    fn a_pack_record_of_another_schema_holds_them_too_and_is_not_rewritten() {
        let env = Env::new("foreign-record");
        installed_pack(&env);
        let retired = install_retired_bundle_skill(&env);
        fs::remove_dir_all(env.packs()).expect("remove packs");
        let foreign = r#"{"schema_version":99,"packs":{"mine":["my-checklist"]}}"#;
        fs::write(record_path(&env), foreign).expect("foreign record");

        assert_everything_unknown_is_held(&env, &retired, "another version");
        let result = env.apply();
        assert!(result.success, "apply: {}", result.message);
        assert_eq!(
            fs::read_to_string(record_path(&env)).expect("kept"),
            foreign
        );
        assert!(env
            .root(SkillRoot::Claude)
            .join("my-checklist/SKILL.md")
            .is_file());
        let library = crate::commands::list_pack_skills().expect("library");
        assert!(library.record_problem.is_some());
        assert!(library
            .skills
            .iter()
            .any(|s| s.name == "my-checklist" && s.state == "missing"));
    }

    #[test]
    fn rolling_back_an_uninstall_and_a_later_install_keeps_the_hold_on_a_missing_pack() {
        let env = Env::new("rollback-uninstall");
        installed_pack(&env);
        fs::remove_dir_all(env.packs()).expect("remove packs");
        let skill_md = env.root(SkillRoot::Claude).join("my-checklist/SKILL.md");

        let plan = preview_uninstall().expect("uninstall preview");
        let uninstalled =
            apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(uninstalled.success, "uninstall: {}", uninstalled.message);
        assert!(!skill_md.exists());
        // An Install in between records what is installed then, which is none of the pack.
        let reinstalled = env.apply();
        assert!(reinstalled.success, "install: {}", reinstalled.message);
        assert_eq!(
            env.recorded_packs()["packs"]["mine"],
            serde_json::json!(["my-checklist"])
        );

        let undone =
            rollback_setup_transaction(reinstalled.transaction_id, false).expect("rollback");
        assert!(undone.success, "rollback: {}", undone.message);
        let undone =
            rollback_setup_transaction(uninstalled.transaction_id, false).expect("rollback");
        assert!(undone.success, "rollback: {}", undone.message);

        assert!(skill_md.is_file(), "the uninstall is undone");
        assert_eq!(env.sources().held().len(), 1, "and the skill is held again");
        no_removals(&env);
    }

    #[test]
    fn rolling_back_a_forget_pack_apply_restores_the_record_as_it_was_after_the_choice() {
        let env = Env::new("rollback-forget");
        installed_pack(&env);
        fs::remove_dir_all(env.packs()).expect("remove packs");
        assert_eq!(
            crate::commands::forget_pack("mine".to_string()).expect("forget"),
            1
        );
        let after_forget = fs::read(record_path(&env)).expect("record");
        let skill_md = env.root(SkillRoot::Claude).join("my-checklist/SKILL.md");

        let removed = env.apply();
        assert!(removed.success, "remove: {}", removed.message);
        assert!(!skill_md.exists());
        assert!(
            read_packs(&env).is_empty(),
            "the apply that retired the skills dropped the entry"
        );

        let undone = rollback_setup_transaction(removed.transaction_id, false).expect("rollback");
        assert!(undone.success, "rollback: {}", undone.message);
        assert!(skill_md.is_file(), "the copies are back");
        assert_eq!(fs::read(record_path(&env)).expect("record"), after_forget);
        // Forgotten is still the user's choice: the next Install retires them again.
        assert!(env.sources().held().is_empty());
        assert_eq!(
            env.kind(&file_of(SkillRoot::Claude, "my-checklist", "SKILL.md")),
            Some(OperationKind::Remove)
        );
    }

    fn read_packs(env: &Env) -> serde_json::Map<String, serde_json::Value> {
        env.recorded_packs()["packs"]
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn a_pack_skill_md_over_one_mebibyte_is_an_error_and_is_not_read_whole() {
        let env = Env::new("huge-skill-md");
        let dir = env.pack_skill("mine", None, "huge", "x", &[]);
        let mut text = canonical_skill_text("huge", "x");
        text.push_str(&"a".repeat(1024 * 1024 + 1));
        fs::write(dir.join("SKILL.md"), text).expect("write");
        env.pack_skill("mine", None, "normal", "x", &[]);

        let sources = env.sources();
        let pack = &sources.packs()[0];
        let huge = pack
            .skills
            .iter()
            .find(|s| s.folder == "huge")
            .expect("huge");
        assert_eq!(huge.state, PackSkillState::Error);
        assert!(huge.reason.contains("over"), "{}", huge.reason);
        let normal = pack
            .skills
            .iter()
            .find(|s| s.name == "normal")
            .expect("normal");
        assert_eq!(normal.state, PackSkillState::Active);
    }

    #[test]
    fn the_take_bundled_review_names_the_pack_a_skill_comes_from() {
        let env = Env::new("take-source");
        installed_pack(&env);
        for skill in ["my-checklist", "tdd"] {
            fs::write(
                env.root(SkillRoot::Claude).join(skill).join("SKILL.md"),
                format!("my own {skill}\n"),
            )
            .expect("edit the installed copy");
        }

        let preview = crate::commands::preview_take_bundled(
            "skills".to_string(),
            vec![
                "skill:claude:my-checklist".to_string(),
                "skill:claude:tdd".to_string(),
            ],
        )
        .expect("preview");
        let source_of = |name: &str| {
            preview
                .units
                .iter()
                .find(|unit| unit.name == name)
                .unwrap_or_else(|| panic!("{name} is reviewed"))
                .source
                .clone()
        };
        assert_eq!(source_of("my-checklist"), Some("pack:mine".to_string()));
        assert_eq!(source_of("tdd"), None, "a bundled skill stays bundled");
    }

    impl Env {
        /// Applies when the plan has work; `None` when it has none.
        fn apply_if_needed(&self) -> Option<SetupResult> {
            if self.pending().is_empty() {
                None
            } else {
                Some(self.apply())
            }
        }
    }
}
