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
    use crate::commands::{copy_skill_to_pack, read_skill, save_pack_skill};
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

        /// Ships a copy of the bundle with `MOVED_GROUP` added below `skills/`, from now on: the
        /// release before its skills moved into a pack. Returns the group's source folder.
        fn ship_bundle_with_moved_group(&mut self) -> PathBuf {
            // The override is dropped first, so the copy is made from the real bundle.
            self._bundle = None;
            let bundle = self.base.join("bundle");
            let _ = fs::remove_dir_all(&bundle);
            copy_tree(&Self::real_bundle(), &bundle);
            let group = bundle.join("skills").join(MOVED_GROUP);
            for (name, files) in MOVED_SKILLS {
                let dir = group.join(name);
                fs::create_dir_all(&dir).expect("moved skill dir");
                fs::write(
                    dir.join("SKILL.md"),
                    canonical_skill_text(name, "shipped by the bundle"),
                )
                .expect("SKILL.md");
                for (rel, text) in files.iter() {
                    let path = dir.join(rel);
                    fs::create_dir_all(path.parent().expect("parent")).expect("support dir");
                    fs::write(path, text).expect("support file");
                }
            }
            self._bundle = Some(crate::setup_roots::test_bundle::set(bundle));
            group
        }

        /// Ships the real bundle again, from now on: the release that dropped the group.
        fn ship_real_bundle(&mut self) {
            self._bundle = None;
        }

        fn packs(&self) -> PathBuf {
            self.ws.join("packs")
        }

        /// A pack folder the way a user would clone one: owner-writable only.
        fn pack(&self, pack: &str) -> PathBuf {
            let dir = self.packs().join(pack);
            fs::create_dir_all(dir.join("skills")).expect("pack dir");
            set_mode(&self.packs(), 0o755);
            set_mode(&dir, 0o755);
            dir
        }

        /// Owner-writable modes below `dir`, whatever the umask of the machine running the tests.
        fn tighten(dir: &Path) {
            set_mode(dir, 0o755);
            for entry in fs::read_dir(dir).expect("read dir").flatten() {
                let path = entry.path();
                if entry.file_type().expect("file type").is_dir() {
                    Self::tighten(&path);
                } else {
                    set_mode(&path, 0o644);
                }
            }
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
            Self::tighten(&skills);
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

    /// A grouped pair of skills an earlier release bundled, with nested supporting files: the
    /// shape of the domain skills that left the bundle for a team pack.
    const MOVED_GROUP: &str = "team";
    const MOVED_SKILLS: [(&str, &[(&str, &str)]); 2] = [
        (
            "team-report",
            &[
                ("assets/report-template.html", "<html>template</html>\n"),
                ("scripts/verify-report.mjs", "export const ok = true;\n"),
            ],
        ),
        ("team-change", &[]),
    ];

    /// Every installed file of the moved skills, in both skills folders.
    fn moved_files(env: &Env) -> BTreeMap<String, Vec<u8>> {
        let mut out = BTreeMap::new();
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            for (name, _) in MOVED_SKILLS {
                for (rel, bytes) in files_below(&env.root(root).join(name)) {
                    out.insert(format!("{root:?}/{name}/{rel}"), bytes);
                }
            }
        }
        out
    }

    /// Installs the release that bundled the group, then ships the one that dropped it.
    fn installed_from_the_bundle(label: &str) -> (Env, PathBuf, BTreeMap<String, Vec<u8>>) {
        let mut env = Env::new(label);
        let group = env.ship_bundle_with_moved_group();
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let installed = moved_files(&env);
        assert_eq!(
            installed.len(),
            8,
            "four files in two folders: {installed:?}"
        );
        env.ship_real_bundle();
        (env, group, installed)
    }

    #[test]
    fn a_skill_group_moved_byte_for_byte_from_the_bundle_into_a_pack_plans_and_writes_nothing() {
        let (env, group, _) = installed_from_the_bundle("moved");
        let installed = env.footprint();
        let report = file_of(
            SkillRoot::Claude,
            "team-report",
            "assets/report-template.html",
        );
        assert!(env.path(&report).is_file(), "the nested file is installed");

        // The user keeps the group in a pack, byte for byte.
        env.pack("mine");
        copy_tree(&group, &env.packs().join("mine/skills").join(MOVED_GROUP));
        Env::tighten(&env.packs().join("mine/skills"));

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

    /// The pack's copy differs from the last bundled one: one Update installs the pack's files,
    /// with no conflict and nothing removed, and rolling it back restores the bundled copies.
    #[test]
    fn a_pack_with_newer_copies_of_moved_skills_takes_over_in_one_update_and_rolls_back() {
        let (env, group, installed) = installed_from_the_bundle("moved-newer");
        let pack_group = env.packs().join("mine/skills").join(MOVED_GROUP);
        env.pack("mine");
        copy_tree(&group, &pack_group);
        let pack_md = canonical_skill_text("team-report", "kept in the team pack");
        fs::write(pack_group.join("team-report/SKILL.md"), &pack_md).expect("pack SKILL.md");
        fs::write(pack_group.join("team-report/assets/logo.svg"), "<svg/>\n").expect("new file");
        Env::tighten(&env.packs().join("mine/skills"));

        let mut pending = env.pending();
        pending.sort_by_key(|(artifact, _)| artifact_identity(artifact));
        let mut expected = Vec::new();
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            expected.push((
                file_of(root, "team-report", "SKILL.md"),
                OperationKind::Update,
            ));
            expected.push((
                file_of(root, "team-report", "assets/logo.svg"),
                OperationKind::Create,
            ));
        }
        expected.sort_by_key(|(artifact, _)| artifact_identity(artifact));
        assert_eq!(
            pending, expected,
            "only the pack's changes, no conflict or removal"
        );

        let result = env.apply();
        assert!(result.success, "update: {}", result.message);
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            assert_eq!(
                files_below(&env.root(root).join("team-report")),
                files_below(&pack_group.join("team-report")),
                "{root:?} holds the pack's copy"
            );
            assert_eq!(
                files_below(&env.root(root).join("team-change")),
                files_below(&pack_group.join("team-change")),
            );
        }
        assert_eq!(env.pending(), vec![]);
        assert_eq!(
            env.recorded_packs()["packs"]["mine"],
            serde_json::json!(["team-change", "team-report"])
        );

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert_eq!(moved_files(&env), installed, "the bundled copies are back");
    }

    /// Without the pack the moved skills are retired like any skill the bundle dropped: the
    /// app's copies are removed with a backup, and a skill the user edited is kept whole.
    #[test]
    fn without_the_pack_moved_skills_are_retired_with_a_backup_and_an_edited_one_is_kept() {
        let (env, _, installed) = installed_from_the_bundle("moved-no-pack");
        let edited = file_of(SkillRoot::Claude, "team-change", "SKILL.md");
        let mine = b"my own notes on the team change\n";
        fs::write(env.path(&edited), mine).expect("edit");

        let kinds: BTreeMap<String, OperationKind> = env
            .pending()
            .into_iter()
            .map(|(artifact, kind)| (artifact_identity(&artifact), kind))
            .collect();
        assert_eq!(
            kinds.get(&artifact_identity(&edited)),
            Some(&OperationKind::Conflict)
        );
        let removals = kinds
            .values()
            .filter(|kind| **kind == OperationKind::Remove)
            .count();
        assert_eq!(removals, 7, "every other file is removed: {kinds:?}");

        let result = env.apply();
        assert!(result.success, "retire: {}", result.message);
        assert_eq!(fs::read(env.path(&edited)).expect("kept"), mine);
        assert!(!env.root(SkillRoot::Claude).join("team-report").exists());
        assert!(!env.root(SkillRoot::Agents).join("team-report").exists());
        assert!(!env.root(SkillRoot::Agents).join("team-change").exists());

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        let mut expected = installed;
        expected.insert("Claude/team-change/SKILL.md".to_string(), mine.to_vec());
        assert_eq!(
            moved_files(&env),
            expected,
            "the backup restored every removed file"
        );
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

    /// The name and description are the ones a YAML harness reads, so a nested `name:` cannot
    /// slip a bundled name past "bundle wins".
    #[test]
    fn pack_skill_frontmatter_is_read_like_yaml_top_level_keys() {
        let env = Env::new("frontmatter");
        let skills = env.pack("mine").join("skills");
        for (folder, text) in [
            (
                "nested",
                "---\ndescription: shadow try\ntargets: claude\nmetadata:\n  name: nested-helper\nname: tdd\n---\nbody\n",
            ),
            (
                "quoted",
                "---\nname: \"quoted\"\ndescription: 'a quoted name'\ntargets: claude\n---\nbody\n",
            ),
            (
                "folded",
                "---\nname: folded\ndescription: >-\n  the real description\n  continues\ntargets: claude\n---\nbody\n",
            ),
            (
                "twice",
                "---\nname: twice\ndescription: d\ntargets: claude\nname: tdd\n---\nbody\n",
            ),
        ] {
            fs::create_dir_all(skills.join(folder)).expect("skill dir");
            fs::write(skills.join(folder).join("SKILL.md"), text).expect("SKILL.md");
        }
        Env::tighten(&skills);

        let sources = env.sources();
        let by_folder = |folder: &str| {
            sources.packs()[0]
                .skills
                .iter()
                .find(|skill| skill.folder == folder)
                .cloned()
                .expect(folder)
        };
        let nested = by_folder("nested");
        assert_eq!(
            (nested.name.as_str(), nested.state),
            ("tdd", PackSkillState::Shadowed)
        );
        let quoted = by_folder("quoted");
        assert_eq!(
            (quoted.name.as_str(), quoted.state),
            ("quoted", PackSkillState::Active)
        );
        assert_eq!(quoted.description, "a quoted name");
        let folded = by_folder("folded");
        assert_eq!(folded.state, PackSkillState::Active);
        assert_eq!(folded.description, "the real description continues");
        let twice = by_folder("twice");
        assert_eq!(twice.state, PackSkillState::Error);
        assert!(twice.reason.contains("more than once"), "{}", twice.reason);
    }

    /// The older top-level layout, the Agent Skills spec layout (`metadata:`) and a mix of both.
    const LAYOUTS: [(&str, &str); 3] = [
        (
            "legacy",
            "---\nname: legacy\ndescription: older layout\ncategory: x\nrisk: low\ntargets: codex, opencode, claude, cursor\nrelated: tdd\n---\nbody\n",
        ),
        (
            "spec",
            "---\nname: spec\ndescription: spec layout\nlicense: MIT\nmetadata:\n  category: x\n  risk: low\n  targets: codex, opencode, claude, cursor, pi\n---\nbody\n",
        ),
        (
            "mixed",
            "---\nname: mixed\ndescription: both layouts\ntargets: nope\nmetadata:\n  targets: claude, grok\n---\nbody\n",
        ),
    ];

    /// Packs written before the spec layout keep their top-level keys: every layout loads and
    /// installs byte for byte, and in a mixed file `metadata.targets` is the one validated.
    #[test]
    fn pack_skills_in_the_older_and_the_spec_frontmatter_layout_install() {
        let env = Env::new("layouts");
        let skills = env.pack("mine").join("skills");
        for (folder, text) in LAYOUTS {
            fs::create_dir_all(skills.join(folder)).expect("skill dir");
            fs::write(skills.join(folder).join("SKILL.md"), text).expect("SKILL.md");
        }
        Env::tighten(&skills);
        let sources = env.sources();
        for (folder, _) in LAYOUTS {
            let skill = sources.packs()[0]
                .skills
                .iter()
                .find(|skill| skill.folder == folder)
                .expect(folder);
            assert_eq!(
                skill.state,
                PackSkillState::Active,
                "{folder}: {}",
                skill.reason
            );
        }
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        for (folder, text) in LAYOUTS {
            for root in [SkillRoot::Claude, SkillRoot::Agents] {
                let installed = env.root(root).join(folder).join("SKILL.md");
                assert_eq!(fs::read_to_string(installed).expect(folder), text);
            }
        }
    }

    /// `targets` is Riggverk's key, not the Agent Skills spec's: a pack skill without it (a skill
    /// taken from elsewhere) is for all nine harnesses and installs as is. A target it names must
    /// still exist.
    #[test]
    fn a_pack_skill_without_targets_is_for_every_harness_and_an_unknown_target_is_an_error() {
        let env = Env::new("no-targets");
        let skills = env.pack("mine").join("skills");
        let spec = "---\nname: spec-only\ndescription: Use for spec work.\nlicense: MIT\n---\n# Spec\n";
        let unknown = "---\nname: unknown-target\ndescription: d\ntargets: claude, gemini\n---\n";
        for (name, text) in [("spec-only", spec), ("unknown-target", unknown)] {
            fs::create_dir_all(skills.join(name)).expect("skill dir");
            fs::write(skills.join(name).join("SKILL.md"), text).expect("SKILL.md");
        }
        Env::tighten(&skills);
        let sources = env.sources();
        let state = |name: &str| {
            let skill = sources.packs()[0]
                .skills
                .iter()
                .find(|skill| skill.name == name)
                .expect(name);
            (skill.state, skill.reason.clone())
        };
        assert_eq!(state("spec-only").0, PackSkillState::Active);
        let (unknown_state, reason) = state("unknown-target");
        assert_eq!(unknown_state, PackSkillState::Error);
        assert!(reason.contains("unknown target 'gemini'"), "{reason}");
        let catalog = crate::skill_sources::SourceRoot::catalog(&sources).expect("catalog");
        let spec_skill = catalog
            .iter()
            .find(|entry| entry.skill.name == "spec-only")
            .expect("in the catalog");
        assert_eq!(
            spec_skill.skill.targets,
            crate::agent_skill_targets::VALID_SKILL_AGENTS
                .iter()
                .map(|target| target.to_string())
                .collect::<Vec<_>>()
        );
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            let installed = env.root(root).join("spec-only/SKILL.md");
            assert_eq!(fs::read_to_string(installed).expect("installed"), spec);
            assert!(!env.root(root).join("unknown-target").exists());
        }
    }

    /// Keys the harness acts on without asking reach the skills folders byte for byte, so the review
    /// names them and their values on a line of the skill's own; they are shown, never refused.
    #[test]
    fn a_pack_skill_that_grants_tools_is_named_with_its_keys_in_the_review_and_installs_as_is() {
        let env = Env::new("privileged");
        let text = "---\nname: deploy\ndescription: Use for deploys.\ntargets: claude, codex\n\
                    allowed-tools: Bash(touch *)\nhooks:\n  PreToolUse:\n    - matcher: Bash\n---\n# Deploy\n";
        let skills = env.pack("team").join("skills");
        fs::create_dir_all(skills.join("deploy")).expect("skill dir");
        fs::write(skills.join("deploy/SKILL.md"), text).expect("SKILL.md");
        Env::tighten(&skills);

        // The Library lists them beside the skill, whose frontmatter it does not render.
        let library = serde_json::to_value(crate::commands::list_pack_skills().expect("library"))
            .expect("library JSON");
        let listed = library["skills"]
            .as_array()
            .expect("skills")
            .iter()
            .find(|skill| skill["id"] == "pack:team/deploy")
            .expect("deploy listed");
        assert_eq!(
            listed["privileged"],
            serde_json::json!([
                {"key": "allowed-tools", "value": "Bash(touch *)", "note": "grants tool access without asking"},
                {"key": "hooks", "value": "PreToolUse: - matcher: Bash", "note": "runs commands without asking"},
            ])
        );

        let details: Vec<String> = env
            .preview()
            .operations
            .into_iter()
            .filter(|op| op.surface == SetupSurfaceId::Skills)
            .flat_map(|op| op.details)
            .collect();
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            let expected = format!(
                "+ {}/deploy (pack team; allowed-tools: Bash(touch *) [grants tool access without \
                 asking]; hooks: PreToolUse: - matcher: Bash [runs commands without asking])",
                root.display()
            );
            assert!(details.contains(&expected), "{details:#?}");
        }

        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            let installed = env.root(root).join("deploy/SKILL.md");
            assert_eq!(fs::read_to_string(installed).expect("installed"), text);
        }
    }

    /// On a case-insensitive volume `Notes.md` and `notes.md` are one file: a case-only rename is
    /// an update of the installed file, never a conflict plus a removal that deletes it.
    #[test]
    fn a_case_only_rename_of_a_supporting_file_updates_it_and_removes_nothing() {
        let env = Env::new("case-rename");
        let dir = env.pack_skill("mine", None, "casey", "body", &[("Notes.md", "v1\n")]);
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let claude = env.root(SkillRoot::Claude).join("casey");
        if !claude.join("notes.md").is_file() {
            // A case-sensitive volume: the two names are two files, nothing to prove here.
            return;
        }

        // Same content, new case: nothing to write, and nothing removed.
        fs::rename(dir.join("Notes.md"), dir.join("tmp.md")).expect("rename");
        fs::rename(dir.join("tmp.md"), dir.join("notes.md")).expect("rename");
        Env::tighten(&env.pack("mine").join("skills"));
        assert!(
            env.pending()
                .iter()
                .all(|(_, kind)| *kind != OperationKind::Remove),
            "{:?}",
            env.pending()
        );
        if let Some(result) = env.apply_if_needed() {
            assert!(result.success, "apply: {}", result.message);
        }
        assert_eq!(
            fs::read_to_string(claude.join("notes.md")).expect("still installed"),
            "v1\n"
        );

        // New content too: one update per root, no conflict, no removal.
        fs::write(dir.join("notes.md"), "v2\n").expect("edit");
        Env::tighten(&env.pack("mine").join("skills"));
        let pending = env.pending();
        assert_eq!(pending.len(), 2, "{pending:?}");
        for (artifact, kind) in &pending {
            assert_eq!(*kind, OperationKind::Update, "{artifact:?}");
            assert!(
                artifact
                    .as_skill_file()
                    .is_some_and(|file| file.rel.as_str() == "notes.md"),
                "{artifact:?}"
            );
        }
        let result = env.apply();
        assert!(result.success, "apply: {}", result.message);
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            let installed = files_below(&env.root(root).join("casey"));
            assert_eq!(installed.len(), 2, "{root:?}: {:?}", installed.keys());
            assert_eq!(
                fs::read_to_string(env.root(root).join("casey/notes.md")).expect("installed"),
                "v2\n"
            );
        }
        assert_eq!(env.pending(), vec![]);
        let state = String::from_utf8(env.state_bytes().expect("state")).expect("utf-8");
        assert!(!state.contains("Notes.md"), "the old case is not recorded");
    }

    /// Dot folders are never read: a `.venv` (symlinks) or an `.archive` of old skills inside a
    /// pack skill is skipped, not taken for nesting, and not installed.
    #[test]
    fn dot_folders_inside_a_pack_skill_are_skipped() {
        let env = Env::new("dot-folders");
        let dir = env.pack_skill("mine", None, "venvy", "body", &[("REFERENCE.md", "r\n")]);
        fs::create_dir_all(dir.join(".venv/bin")).expect("venv");
        #[cfg(unix)]
        std::os::unix::fs::symlink("/usr/bin/python3", dir.join(".venv/bin/python"))
            .expect("venv link");
        fs::create_dir_all(dir.join(".archive/old")).expect("archive");
        fs::write(
            dir.join(".archive/old/SKILL.md"),
            canonical_skill_text("old", "old"),
        )
        .expect("archived skill");

        let sources = env.sources();
        let skill = &sources.packs()[0].skills[0];
        assert_eq!(
            (skill.name.as_str(), skill.state),
            ("venvy", PackSkillState::Active),
            "{}",
            skill.reason
        );
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let installed: Vec<String> = files_below(&env.root(SkillRoot::Claude).join("venvy"))
            .into_keys()
            .collect();
        assert_eq!(installed, vec!["REFERENCE.md", "SKILL.md"]);
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

    /// Without the record, a pack that later goes missing would read as a retirement: an Install
    /// that cannot save it is undone, not reported as a success with a warning.
    #[test]
    fn an_install_whose_pack_record_cannot_be_saved_is_undone() {
        let env = Env::new("record-write");
        env.pack_skill("mine", None, "my-checklist", "kept in the pack", &[]);
        let before = env.footprint();
        crate::skill_sources::failing_writes::set(true);
        let result = env.apply();
        crate::skill_sources::failing_writes::set(false);
        assert!(!result.success, "{}", result.message);
        assert!(
            result
                .message
                .starts_with(crate::commands::setup::PACK_RECORD_NOT_SAVED),
            "{}",
            result.message
        );
        assert!(!env
            .path(&file_of(SkillRoot::Claude, "my-checklist", "SKILL.md"))
            .exists());
        assert_eq!(
            (env.footprint().0, env.footprint().1),
            (before.0, before.1),
            "the installed files are rolled back"
        );
        assert!(!crate::workspace_layout::state_file(&env.ws, "pack-skills.json").exists());

        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        assert_eq!(
            env.recorded_packs()["packs"]["mine"],
            serde_json::json!(["my-checklist"])
        );
    }

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

    /// The reason the pack `name` is refused with, if it is.
    fn refusal(sources: &SkillSources, name: &str) -> Option<String> {
        sources
            .packs()
            .iter()
            .find(|p| p.name == name)
            .expect(name)
            .refused
            .clone()
    }

    #[cfg(unix)]
    #[test]
    fn a_writable_skills_folder_or_skill_entry_refuses_the_pack_and_holds_its_skills() {
        let env = Env::new("writable-inside");
        let skill = env.pack_skill("mine", None, "my-checklist", "x", &[("notes/a.md", "a")]);
        let pack = env.packs().join("mine");
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        assert_eq!(refusal(&env.sources(), "mine"), None);

        // Each of these is a folder or file a pack-mate could rewrite after the review.
        let loose: [(&str, PathBuf, u32, u32); 5] = [
            ("skills", pack.join("skills"), 0o775, 0o755),
            ("skill folder", skill.clone(), 0o757, 0o755),
            ("nested folder", skill.join("notes"), 0o775, 0o755),
            ("SKILL.md", skill.join("SKILL.md"), 0o666, 0o644),
            ("nested file", skill.join("notes/a.md"), 0o664, 0o644),
        ];
        for (label, path, bad, good) in loose {
            set_mode(&path, bad);
            let sources = env.sources();
            let reason = refusal(&sources, "mine");
            assert!(
                reason.as_deref().is_some_and(|r| r.contains("writable")),
                "{label}: {reason:?}"
            );
            assert!(sources.packs()[0].skills.is_empty(), "{label}");
            assert_eq!(sources.held().len(), 1, "{label}: {:?}", sources.held());
            assert_eq!(sources.held()[0].name, "my-checklist", "{label}");
            no_removals(&env);
            set_mode(&path, good);
            assert_eq!(refusal(&env.sources(), "mine"), None, "{label} restored");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_writable_packs_folder_refuses_every_pack_and_holds_their_skills() {
        let env = Env::new("writable-packs");
        env.pack_skill("mine", None, "my-checklist", "x", &[]);
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);

        set_mode(&env.packs(), 0o775);
        let sources = env.sources();
        assert!(sources.packs().is_empty());
        assert!(
            sources
                .ignored()
                .iter()
                .any(|(name, reason)| name == "packs" && reason.contains("writable")),
            "{:?}",
            sources.ignored()
        );
        assert_eq!(sources.held().len(), 1, "{:?}", sources.held());
        no_removals(&env);
        assert!(env
            .root(SkillRoot::Claude)
            .join("my-checklist/SKILL.md")
            .is_file());

        set_mode(&env.packs(), 0o755);
        assert!(env.sources().ignored().is_empty());
        assert_eq!(env.sources().packs().len(), 1);
    }

    /// Ownership cannot be changed without privileges, so only the side that can be tested is: the
    /// entries a normal clone leaves are owned by the current user and pass.
    #[cfg(unix)]
    #[test]
    fn entries_owned_by_the_current_user_pass_the_owner_check() {
        let env = Env::new("owner");
        env.pack_skill("mine", None, "my-checklist", "x", &[("notes/a.md", "a")]);
        let sources = env.sources();
        assert_eq!(refusal(&sources, "mine"), None);
        assert_eq!(sources.packs()[0].skills.len(), 1);
    }

    #[test]
    fn a_plan_with_many_artifacts_reads_the_bundle_and_packs_once() {
        let env = Env::new("one-read");
        env.pack_skill("mine", None, "my-checklist", "x", &[]);
        env.pack_skill("mine", Some("group"), "grouped", "x", &[]);

        let before = crate::skill_sources::reads::total();
        let planned = env.plan();
        let reads = crate::skill_sources::reads::total() - before;
        assert!(planned.len() > 50, "a plan of {} artifacts", planned.len());
        assert_eq!(reads, 1, "{reads} reads for {} artifacts", planned.len());

        let before = crate::skill_sources::reads::total();
        let plan = env.preview();
        let reads = crate::skill_sources::reads::total() - before;
        assert!(!plan.operations.is_empty());
        assert_eq!(reads, 1, "a preview read the catalog {reads} times");

        // An apply reads once per stage (the fingerprint check, the plan it applies, the run with
        // its preflight), however many artifacts there are.
        let before = crate::skill_sources::reads::total();
        let result = apply_setup(
            vec![surface_name(SetupSurfaceId::Skills)],
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        )
        .expect("apply_setup");
        let reads = crate::skill_sources::reads::total() - before;
        assert!(result.success, "install: {}", result.message);
        assert_eq!(reads, 3, "an apply read the catalog {reads} times");
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
                role_models: Default::default(),
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

    #[test]
    fn undoing_an_earlier_install_keeps_a_pack_forgotten_after_it() {
        let env = Env::new("undo-keeps-forget");
        installed_pack(&env);
        env.pack_skill("theirs", None, "their-tool", "from another pack", &[]);
        let later = env.apply();
        assert!(later.success, "install: {}", later.message);
        let their_skill = env.root(SkillRoot::Claude).join("their-tool/SKILL.md");
        assert!(their_skill.is_file());

        // The first pack goes and the user forgets it; then the later install is undone.
        fs::remove_dir_all(env.packs().join("mine")).expect("remove pack");
        assert_eq!(
            crate::commands::forget_pack("mine".to_string()).expect("forget"),
            1
        );
        let undone = rollback_setup_transaction(later.transaction_id, false).expect("rollback");
        assert!(undone.success, "rollback: {}", undone.message);

        assert!(!their_skill.exists(), "the later install is undone");
        assert_eq!(
            env.recorded_packs()["forgotten"],
            serde_json::json!(["mine"]),
            "the choice made after it stays"
        );
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
        /// An isolated personal data folder and a small, grouped bundle with supporting files.
        fn personal_copy(label: &str) -> Self {
            let mut env = Self::new(label);
            env.ws = env.home.join(".config/riggverk");
            unsafe { std::env::set_var("RIGGVERK_WORKSPACE_PATH", &env.ws) };
            let bundle = env.base.join("copy-bundle");
            copy_tree(&Self::real_bundle(), &bundle);
            fs::remove_dir_all(bundle.join("skills")).expect("replace bundled skills");
            let source = bundle.join("skills/group/original");
            fs::create_dir_all(source.join("assets")).expect("source assets");
            fs::write(
                source.join("SKILL.md"),
                canonical_skill_text("original", "# Original\n\nname: body-stays-original\n"),
            )
            .expect("source skill");
            fs::write(source.join("assets/guide.txt"), "supporting text\n").expect("support file");
            env._bundle = Some(crate::setup_roots::test_bundle::set(bundle));
            env
        }

        /// Applies when the plan has work; `None` when it has none.
        fn apply_if_needed(&self) -> Option<SetupResult> {
            if self.pending().is_empty() {
                None
            } else {
                Some(self.apply())
            }
        }
    }

    // ── Library personal copies and edits ──

    fn assert_no_copy_or_staging(env: &Env, name: &str) {
        let skills = env.packs().join("personal/skills");
        assert!(
            !skills.join(name).exists(),
            "no published copy after a failure"
        );
        if let Ok(entries) = fs::read_dir(skills) {
            assert!(entries
                .flatten()
                .all(|entry| !entry.file_name().to_string_lossy().starts_with(".copy-")));
        }
    }

    #[test]
    fn library_copy_renames_only_frontmatter_and_joins_the_personal_catalog_without_installing() {
        let env = Env::personal_copy("library-copy");
        let original = files_below(&env.base.join("copy-bundle/skills/group/original"));
        let copied = copy_skill_to_pack("original".into(), "my-original".into()).expect("copy");
        assert_eq!(copied.id, "pack:personal/my-original");
        assert_eq!(copied.name, "my-original");
        assert_eq!(copied.pack, "personal");
        assert_eq!(
            copied.path,
            "~/.config/riggverk/packs/personal/skills/my-original/SKILL.md"
        );
        let dir = env.packs().join("personal/skills/my-original");
        let text = fs::read_to_string(dir.join("SKILL.md")).expect("copied SKILL.md");
        assert_eq!(
            text,
            std::str::from_utf8(&original["SKILL.md"])
                .expect("source text")
                .replacen("name: original\n", "name: my-original\n", 1)
        );
        assert_eq!(
            fs::read(dir.join("assets/guide.txt")).expect("support file"),
            original["assets/guide.txt"]
        );
        assert_eq!(
            files_below(&env.base.join("copy-bundle/skills/group/original")),
            original,
            "bundle unchanged"
        );
        let sources = env.sources();
        assert_eq!(sources.pack_of("my-original"), Some("personal"));
        let personal = sources
            .packs()
            .iter()
            .find(|pack| pack.name == "personal")
            .expect("personal pack");
        assert!(personal.refused.is_none());
        assert_eq!(personal.skills[0].state, PackSkillState::Active);
        assert!(
            !env.root(SkillRoot::Claude).exists(),
            "copy does not install"
        );
        assert!(
            !env.root(SkillRoot::Agents).exists(),
            "copy does not install"
        );
        assert!(env.state_bytes().is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [
                env.packs(),
                env.packs().join("personal"),
                env.packs().join("personal/skills"),
                dir.clone(),
                dir.join("assets"),
            ] {
                assert_eq!(
                    fs::metadata(path).expect("dir mode").permissions().mode() & 0o777,
                    0o700
                );
            }
            for path in [dir.join("SKILL.md"), dir.join("assets/guide.txt")] {
                assert_eq!(
                    fs::metadata(path).expect("file mode").permissions().mode() & 0o777,
                    0o600
                );
            }
        }
    }

    #[test]
    fn library_copy_refuses_bundled_and_existing_personal_names() {
        let env = Env::personal_copy("copy-collisions");
        assert!(copy_skill_to_pack("original".into(), "original".into()).is_err());
        let copied = copy_skill_to_pack("original".into(), "mine".into()).expect("copy");
        let before = files_below(&env.packs());
        assert!(copy_skill_to_pack("original".into(), "mine".into()).is_err());
        assert!(
            copy_skill_to_pack(copied.id, "another".into()).is_err(),
            "pack ids are not bundled names"
        );
        assert!(
            copy_skill_to_pack("mine".into(), "another".into()).is_err(),
            "pack names are not bundle sources"
        );
        assert_eq!(files_below(&env.packs()), before);
        fs::create_dir(env.packs().join("personal/skills/empty-folder"))
            .expect("existing empty folder");
        assert!(copy_skill_to_pack("original".into(), "empty-folder".into()).is_err());
        assert_no_copy_or_staging(&env, "another");
    }

    #[test]
    fn library_copy_refuses_a_name_claimed_by_another_pack_or_a_held_skill() {
        let env = Env::personal_copy("copy-other-pack");
        env.pack_skill("team", Some("group"), "taken", "# Taken\n", &[]);
        assert!(copy_skill_to_pack("original".into(), "taken".into()).is_err());
        assert_no_copy_or_staging(&env, "taken");
        assert!(save_pack_skill("pack:team/taken".into(), "changed\n".into(), None).is_err());
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        fs::remove_dir_all(env.packs().join("team")).expect("missing team pack");
        assert!(env.sources().held().iter().any(|held| held.name == "taken"));
        assert!(copy_skill_to_pack("original".into(), "taken".into()).is_err());
    }

    #[test]
    fn library_copy_refuses_invalid_names_without_creating_a_pack_or_exposing_paths() {
        let env = Env::personal_copy("copy-invalid");
        for name in [
            "../x",
            "X",
            "-x",
            "",
            "/private/x",
            "has_underscore",
            &"x".repeat(65),
        ] {
            let error =
                copy_skill_to_pack("original".into(), name.into()).expect_err("invalid name");
            assert!(!error.contains("/private/"));
            assert!(!error.contains(env.home.to_string_lossy().as_ref()));
        }
        assert!(!env.packs().exists());
    }

    #[test]
    fn library_copy_refuses_oversized_or_too_many_files_and_cleans_staging() {
        let env = Env::personal_copy("copy-limits");
        let source = env.base.join("copy-bundle/skills/group/original");
        fs::write(source.join("large.txt"), vec![b'x'; 1024 * 1024]).expect("large file");
        let error =
            copy_skill_to_pack("original".into(), "too-large".into()).expect_err("size limit");
        assert!(error.contains("1 MiB"));
        assert_no_copy_or_staging(&env, "too-large");
        fs::remove_file(source.join("large.txt")).expect("remove large file");
        for index in 0..64 {
            fs::write(source.join(format!("file-{index}.txt")), "x").expect("extra file");
        }
        let error =
            copy_skill_to_pack("original".into(), "too-many".into()).expect_err("file limit");
        assert!(error.contains("64 file"));
        assert_no_copy_or_staging(&env, "too-many");
    }

    #[cfg(unix)]
    #[test]
    fn library_copy_refuses_source_symlinks_including_hidden_entries_and_special_files() {
        let env = Env::personal_copy("copy-unsafe-source");
        let source = env.base.join("copy-bundle/skills/group/original");
        let outside = env.base.join("outside.txt");
        fs::write(&outside, "outside\n").expect("outside file");
        for rel in ["assets/link", ".hidden-link"] {
            let link = source.join(rel);
            std::os::unix::fs::symlink(&outside, &link).expect("source symlink");
            let error = copy_skill_to_pack("original".into(), "unsafe-copy".into())
                .expect_err("symlink refused");
            assert!(!error.contains(env.base.to_string_lossy().as_ref()));
            assert_no_copy_or_staging(&env, "unsafe-copy");
            fs::remove_file(link).expect("remove symlink");
        }
        // Unix socket addresses have a small length limit; bind in /tmp before moving the inode.
        let socket_path = Path::new("/tmp").join(format!(
            "riggverk-copy-socket-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _socket = std::os::unix::net::UnixListener::bind(&socket_path).expect("special file");
        fs::rename(socket_path, source.join("socket")).expect("move special file into source");
        assert!(copy_skill_to_pack("original".into(), "unsafe-copy".into()).is_err());
        assert_no_copy_or_staging(&env, "unsafe-copy");
        assert_eq!(
            fs::read_to_string(outside).expect("outside unchanged"),
            "outside\n"
        );
    }

    #[test]
    fn library_save_writes_only_skill_md_with_an_owner_only_backup_and_skips_unchanged_text() {
        let env = Env::personal_copy("save-personal");
        let copied = copy_skill_to_pack("original".into(), "my-original".into()).expect("copy");
        let dir = env.packs().join("personal/skills/my-original");
        let before = fs::read_to_string(dir.join("SKILL.md")).expect("previous text");
        let content = canonical_skill_text("my-original", "# Edited\n");
        let saved = save_pack_skill(copied.id.clone(), content.clone(), None).expect("save");
        assert!(saved.success);
        assert_eq!(saved.action, "save_pack_skill");
        assert_eq!(saved.stdout, "saved with backup");
        assert_eq!(saved.stderr, "");
        assert_eq!(saved.exit_code, Some(0));
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).expect("saved content"),
            content
        );
        assert_eq!(
            read_skill(copied.id.clone())
                .expect("read after save")
                .content,
            content
        );
        assert_eq!(
            fs::read_to_string(dir.join("assets/guide.txt")).expect("support unchanged"),
            "supporting text\n"
        );
        let backup_root = env.base.join("backups/docs");
        let backups = files_below(&backup_root);
        assert_eq!(backups.len(), 1);
        assert_eq!(
            backups.values().next().expect("backup text"),
            before.as_bytes()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let backup = backup_root.join(backups.keys().next().expect("backup path"));
            assert_eq!(
                fs::metadata(&backup)
                    .expect("backup mode")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(backup.parent().expect("parent"))
                    .expect("backup dir mode")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(dir.join("SKILL.md"))
                    .expect("saved mode")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(
            save_pack_skill(copied.id, content, None)
                .expect("unchanged")
                .stdout,
            "unchanged"
        );
        assert_eq!(
            files_below(&backup_root),
            backups,
            "unchanged saves make no backup"
        );
        assert_eq!(files_below(&dir).len(), 2, "no temporary file remains");
    }

    /// A save that renames or breaks the skill would leave it unreadable and unsaveable in the
    /// Library, with its installed copy held stale; it is refused before anything is written.
    #[test]
    fn library_save_refuses_text_that_renames_or_breaks_the_skill() {
        let env = Env::personal_copy("save-rename");
        let copied = copy_skill_to_pack("original".into(), "my-original".into()).expect("copy");
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
        let before = files_below(&env.packs());
        for (content, expected) in [
            (
                canonical_skill_text("original", "# Edited\n"),
                "The name in the frontmatter must stay my-original.",
            ),
            (
                canonical_skill_text("another-name", "# Edited\n"),
                "The name in the frontmatter must stay my-original.",
            ),
            (
                "---\nname: \"my-original\"\nname: original\ndescription: d\ntargets: claude\n---\n"
                    .to_string(),
                "The frontmatter cannot be read",
            ),
            (
                "---\nname: my-original\ntargets: claude\n---\n".to_string(),
                "The description in the frontmatter cannot be empty.",
            ),
            (
                "---\nname: my-original\ndescription: d\ntargets: gemini\n---\n".to_string(),
                "The targets in the frontmatter",
            ),
            ("no frontmatter\n".to_string(), "The frontmatter cannot be read"),
        ] {
            let error = save_pack_skill(copied.id.clone(), content, None).unwrap_err();
            assert!(error.starts_with(expected), "{error}");
        }
        assert_eq!(files_below(&env.packs()), before, "nothing written");
        assert!(!env.base.join("backups/docs").exists(), "no backup");
        let quoted =
            "---\nname: 'my-original'\ndescription: still mine\ntargets: claude\n---\nbody\n";
        assert!(save_pack_skill(copied.id.clone(), quoted.into(), None).is_ok());
        assert!(save_pack_skill(
            copied.id,
            canonical_skill_text("my-original", "# Back\n"),
            None
        )
        .is_ok());
    }

    /// A Library save writes the text as given: a personal skill keeps the layout it is in, and
    /// one in the older top-level layout still saves.
    #[test]
    fn library_save_keeps_either_frontmatter_layout_byte_for_byte() {
        let env = Env::personal_copy("save-layouts");
        let copied = copy_skill_to_pack("original".into(), "my-original".into()).expect("copy");
        let skill_md = env.packs().join("personal/skills/my-original/SKILL.md");
        for (_, text) in LAYOUTS {
            let content = text.replacen(
                text.lines().nth(1).expect("name line"),
                "name: my-original",
                1,
            );
            save_pack_skill(copied.id.clone(), content.clone(), None).expect("save");
            assert_eq!(fs::read_to_string(&skill_md).expect("saved"), content);
        }
        let result = env.apply();
        assert!(result.success, "install: {}", result.message);
    }

    #[test]
    fn library_save_refuses_a_personal_skill_changed_on_disk_since_it_was_read() {
        let env = Env::personal_copy("save-revision");
        env.pack_skill("team", None, "team-skill", "# Team\n", &[]);
        let copied = copy_skill_to_pack("original".into(), "mine".into()).expect("copy");
        let path = env.packs().join("personal/skills/mine/SKILL.md");
        let opened = read_skill(copied.id.clone()).expect("read");
        let revision = opened.revision.expect("a personal skill has a revision");
        assert!(read_skill("pack:team/team-skill".into())
            .expect("read team")
            .revision
            .is_none());

        let elsewhere = canonical_skill_text("mine", "# Edited elsewhere\n");
        fs::write(&path, &elsewhere).expect("outside edit");
        let mine = canonical_skill_text("mine", "# Mine\n");
        let refused = save_pack_skill(copied.id.clone(), mine.clone(), Some(revision))
            .expect_err("changed on disk");
        assert!(refused.contains("changed on disk"), "{refused}");
        assert_eq!(fs::read_to_string(&path).expect("unchanged"), elsewhere);

        let reread = read_skill(copied.id.clone()).expect("reload").revision;
        assert!(
            save_pack_skill(copied.id, mine.clone(), reread)
                .expect("save after reload")
                .success
        );
        assert_eq!(fs::read_to_string(&path).expect("saved"), mine);
    }

    #[test]
    fn library_save_refuses_other_packs_bundle_ids_traversal_missing_and_oversized_content() {
        let env = Env::personal_copy("save-refusals");
        env.pack_skill("team", None, "team-skill", "# Team\n", &[]);
        let copied = copy_skill_to_pack("original".into(), "mine".into()).expect("copy");
        let before = files_below(&env.packs());
        for id in [
            "pack:team/team-skill",
            "original",
            "pack:personal/original",
            "pack:personal/../mine",
            "pack:personal/mine/SKILL.md",
            "pack:personal/",
            "pack:personal/missing",
            "pack:personal/..\\mine",
        ] {
            assert!(
                save_pack_skill(id.into(), "changed\n".into(), None).is_err(),
                "{id}"
            );
        }
        assert!(save_pack_skill(copied.id, "x".repeat(512 * 1024 + 1), None).is_err());
        assert_eq!(files_below(&env.packs()), before);
        assert!(!env.base.join("backups").exists());
    }

    #[test]
    fn library_save_refuses_shadowed_ambiguous_broken_and_held_personal_skills() {
        let env = Env::personal_copy("save-inactive");
        let shadowed = env.pack_skill("personal", None, "original", "# Shadowed\n", &[]);
        let before = fs::read(shadowed.join("SKILL.md")).expect("shadowed text");
        assert!(save_pack_skill(
            "pack:personal/original".into(),
            canonical_skill_text("original", "changed"),
            None
        )
        .is_err());
        assert_eq!(
            fs::read(shadowed.join("SKILL.md")).expect("unchanged"),
            before
        );
        let copied = copy_skill_to_pack("original".into(), "mine".into()).expect("copy");
        env.pack_skill("team", None, "mine", "# Ambiguous\n", &[]);
        assert!(save_pack_skill(
            copied.id.clone(),
            canonical_skill_text("mine", "changed"),
            None
        )
        .is_err());
        fs::remove_dir_all(env.packs().join("team")).expect("remove duplicate");
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        fs::write(
            env.packs().join("personal/skills/mine/SKILL.md"),
            "broken frontmatter\n",
        )
        .expect("break it");
        assert!(save_pack_skill(
            copied.id.clone(),
            canonical_skill_text("mine", "changed"),
            None
        )
        .is_err());
        fs::remove_dir_all(env.packs().join("personal")).expect("missing personal pack");
        assert!(env
            .sources()
            .held()
            .iter()
            .any(|held| held.pack == "personal" && held.name == "mine"));
        assert!(save_pack_skill(copied.id, canonical_skill_text("mine", "changed"), None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn library_writes_refuse_unsafe_pack_permissions_and_symlinked_save_targets() {
        let env = Env::personal_copy("library-permissions");
        let copied = copy_skill_to_pack("original".into(), "mine".into()).expect("copy");
        let target = env.packs().join("personal/skills/mine/SKILL.md");
        let original = fs::read(&target).expect("copied text");
        for dir in [
            env.packs(),
            env.packs().join("personal"),
            env.packs().join("personal/skills"),
        ] {
            set_mode(&dir, 0o777);
            assert!(save_pack_skill(
                copied.id.clone(),
                canonical_skill_text("mine", "changed"),
                None
            )
            .is_err());
            assert!(copy_skill_to_pack("original".into(), "second".into()).is_err());
            assert_no_copy_or_staging(&env, "second");
            set_mode(&dir, 0o700);
        }
        let outside = env.base.join("outside.md");
        fs::write(&outside, &original).expect("outside file");
        fs::remove_file(&target).expect("remove target");
        std::os::unix::fs::symlink(&outside, &target).expect("target symlink");
        assert!(save_pack_skill(copied.id, canonical_skill_text("mine", "changed"), None).is_err());
        assert_eq!(fs::read(outside).expect("outside unchanged"), original);
        assert!(!env.base.join("backups").exists());
    }
}
