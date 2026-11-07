//! Contract tests for installing whole skill directories.
//!
//! A skill is a `SKILL.md` plus supporting files, and every file is its own managed artifact.
//! These tests install the real bundled skills into a temp HOME and runtime workspace and check
//! what lands on disk, what an update touches, and what removal leaves behind. They never touch
//! the real profile.

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
    use crate::managed_state::{
        artifact_identity, read_managed_state, write_managed_state_atomic, ManagedArtifactRecord,
        ManagedState, MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::setup_lifecycle::{OperationKind, SetupPlan, SetupSurfaceId};
    use crate::setup_transaction::{plan_artifacts_for_surfaces, PlannedArtifact};
    use crate::shipped_digests::test_override;
    use crate::skill_roots::SkillRoot;
    use crate::stable_digest;
    #[cfg(unix)]
    use crate::test_env::skill_file_counts;
    use crate::test_env::{guard, guard::EnvRestore, set_test_user_dirs, source_skill_count};

    const SKILL_SURFACES: [SetupSurfaceId; 1] = [SetupSurfaceId::Skills];

    fn surface_name(surface: SetupSurfaceId) -> String {
        serde_json::to_value(surface)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("{surface:?}"))
    }

    fn skill(name: &str) -> SkillName {
        SkillName::new(name).expect("skill name")
    }

    fn skill_file(root: SkillRoot, name: &str, rel: &str) -> ArtifactId {
        ArtifactId::skill_file(root, skill(name), SkillRelPath::new(rel).expect("rel path"))
    }

    fn bundled() -> PathBuf {
        crate::setup_roots::bundled_root().expect("bundled root")
    }

    /// Every file below `dir` as `/`-separated relative path and bytes.
    fn files_below(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fn walk(dir: &Path, prefix: &str, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in fs::read_dir(dir).expect("read dir") {
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

    /// A temp HOME and runtime workspace with the given surfaces already installed from the
    /// real bundle.
    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        // Drop order matters: restore the environment before releasing the lock.
        _restore: EnvRestore,
        _guard: MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(label: &str, surfaces: &[SetupSurfaceId]) -> Self {
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
            let base = std::env::temp_dir().join(format!("aw-skill-files-{label}-{nanos}"));
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
            let env = Self {
                base,
                home,
                ws,
                _restore: restore,
                _guard: guard,
            };
            if !surfaces.is_empty() {
                let result = env.apply(surfaces);
                assert!(result.success, "install: {}", result.message);
            }
            env
        }

        fn root(&self, root: SkillRoot) -> PathBuf {
            root.path(&self.home).expect("skill root")
        }

        fn path(&self, artifact: &ArtifactId) -> PathBuf {
            artifact.resolve_dest(&self.home, &self.ws).expect("dest")
        }

        fn plan(&self, surfaces: &[SetupSurfaceId]) -> Vec<PlannedArtifact> {
            plan_artifacts_for_surfaces(surfaces, &self.ws, &self.home).expect("plan")
        }

        fn kind(&self, surfaces: &[SetupSurfaceId], artifact: &ArtifactId) -> OperationKind {
            self.plan(surfaces)
                .into_iter()
                .find(|planned| &planned.artifact == artifact)
                .unwrap_or_else(|| panic!("artifact not planned: {artifact:?}"))
                .kind
        }

        /// Every planned operation that is not "already current".
        fn pending(&self, surfaces: &[SetupSurfaceId]) -> Vec<(ArtifactId, OperationKind)> {
            self.plan(surfaces)
                .into_iter()
                .filter(|planned| planned.kind != OperationKind::NoChange)
                .map(|planned| (planned.artifact, planned.kind))
                .collect()
        }

        fn preview(&self, surfaces: &[SetupSurfaceId]) -> SetupPlan {
            preview_setup(surfaces.iter().copied().map(surface_name).collect()).expect("preview")
        }

        fn apply(&self, surfaces: &[SetupSurfaceId]) -> SetupResult {
            let plan = self.preview(surfaces);
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

        /// Install `bytes` at the artifact's destination.
        fn write(&self, artifact: &ArtifactId, bytes: &[u8]) {
            let dest = self.path(artifact);
            fs::create_dir_all(dest.parent().expect("parent")).expect("parent dir");
            fs::write(dest, bytes).expect("write installed file");
        }

        fn state(&self) -> ManagedState {
            read_managed_state(&self.ws).unwrap_or(ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: stable_digest::bytes(b"bundle"),
                artifacts: Vec::new(),
            })
        }

        /// Record `bytes` as what the app installed for `artifact`.
        fn set_record(&self, artifact: &ArtifactId, bytes: &[u8]) {
            let mut state = self.state();
            let identity = artifact_identity(artifact);
            state.artifacts.retain(|record| record.identity != identity);
            state.artifacts.push(ManagedArtifactRecord {
                identity,
                hash: stable_digest::bytes(bytes),
                surface: None,
                role_models: Default::default(),
            });
            state.artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
            write_managed_state_atomic(&self.ws, &state).expect("write managed state");
        }

        fn record(&self, artifact: &ArtifactId) -> Option<String> {
            let identity = artifact_identity(artifact);
            self.state()
                .artifacts
                .into_iter()
                .find(|record| record.identity == identity)
                .map(|record| record.hash)
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn security_audit_and_the_status_report_install_all_their_files_byte_identical() {
        let env = Env::new("claude-dirs", &[SetupSurfaceId::Skills]);
        let claude = env.root(SkillRoot::Claude);
        let skills = bundled().join("skills");

        let security_audit = files_below(&skills.join("security-audit"));
        assert_eq!(
            security_audit.len(),
            20,
            "SKILL.md plus 19 supporting files"
        );
        assert_eq!(files_below(&claude.join("security-audit")), security_audit);
        assert_eq!(
            files_below(&env.root(SkillRoot::Agents).join("security-audit")),
            security_audit,
            "~/.agents/skills holds the same files"
        );

        let report_source = skills.join("status-report");
        let report = files_below(&report_source);
        for nested in ["assets/report-template.html", "scripts/verify-report.mjs"] {
            assert!(report.contains_key(nested), "{nested} ships with the skill");
        }
        assert_eq!(
            files_below(&claude.join("status-report")),
            report,
            "the skill installs flat under its name, nested directories included"
        );
    }

    #[test]
    fn every_wanted_folder_receives_the_whole_security_audit_directory_and_no_other_does() {
        // All four harnesses are enabled and Codex has its default home: Claude reads
        // `~/.claude/skills`, and Codex, OpenCode and Cursor read `~/.agents/skills`.
        let env = Env::new("all-roots", &SKILL_SURFACES);
        let expected = files_below(&bundled().join("skills/security-audit"));
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            assert_eq!(
                files_below(&env.root(root).join("security-audit")),
                expected,
                "{root:?}"
            );
        }
        for root in [SkillRoot::CodexHome, SkillRoot::OpenCode, SkillRoot::Cursor] {
            assert!(!env.root(root).exists(), "{root:?} receives no copy");
        }
        // Nothing is left to do.
        assert!(env.pending(&SKILL_SURFACES).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_source_with_an_executable_bit_installs_as_a_readable_file() {
        use std::os::unix::fs::PermissionsExt;
        let env = Env::new("mode", &[SetupSurfaceId::Skills]);
        let source = bundled().join("skills/security-audit/validate-findings.cjs");
        let source_mode = fs::metadata(&source).expect("source").permissions().mode();
        assert_ne!(
            source_mode & 0o111,
            0,
            "the bundled validator is executable"
        );
        let dest = env
            .root(SkillRoot::Claude)
            .join("security-audit/validate-findings.cjs");
        let mode = fs::metadata(&dest).expect("installed").permissions().mode();
        assert_ne!(
            mode & 0o400,
            0,
            "owner can read the installed script: {mode:o}"
        );
        assert_eq!(
            fs::read(&dest).expect("read"),
            fs::read(&source).expect("read")
        );
    }

    #[test]
    fn an_update_rewrites_only_the_files_that_differ() {
        let env = Env::new("update-one", &[SetupSurfaceId::Skills]);
        let surfaces = [SetupSurfaceId::Skills];
        let hunting = skill_file(SkillRoot::Claude, "security-audit", "HUNTING.md");
        let sibling = skill_file(SkillRoot::Claude, "security-audit", "ATTACK-CLASSES.md");
        let sibling_modified = fs::metadata(env.path(&sibling))
            .expect("sibling")
            .modified()
            .expect("mtime");

        // An older app version installed another HUNTING.md and recorded it.
        let older = b"hunting guide of an older version\n";
        env.write(&hunting, older);
        env.set_record(&hunting, older);
        assert_eq!(
            env.pending(&surfaces),
            vec![(hunting.clone(), OperationKind::Update)]
        );

        let result = env.apply(&surfaces);
        assert!(result.success, "apply: {}", result.message);
        assert_eq!(result.applied.len(), 1, "{:?}", result.applied);
        assert!(
            result.applied[0].contains("HUNTING.md"),
            "{:?}",
            result.applied
        );
        let current = fs::read(bundled().join("skills/security-audit/HUNTING.md")).expect("read");
        assert_eq!(fs::read(env.path(&hunting)).expect("installed"), current);
        assert_eq!(env.record(&hunting), Some(stable_digest::bytes(&current)));
        assert_eq!(
            fs::metadata(env.path(&sibling))
                .expect("sibling")
                .modified()
                .expect("mtime"),
            sibling_modified,
            "an unchanged sibling is not written again"
        );
        assert!(env.pending(&surfaces).is_empty());
    }

    #[test]
    fn an_edited_supporting_file_conflicts_alone_and_its_siblings_still_update() {
        let env = Env::new("edit-conflict", &[SetupSurfaceId::Skills]);
        let surfaces = [SetupSurfaceId::Skills];
        let edited = skill_file(SkillRoot::Claude, "security-audit", "HUNTING.md");
        let outdated = skill_file(SkillRoot::Claude, "security-audit", "ATTACK-CLASSES.md");

        // The user changed one file after the app installed it.
        let mine = b"my own hunting notes\n";
        env.write(&edited, mine);
        // A sibling is still the older version the app recorded.
        let older = b"attack classes of an older version\n";
        env.write(&outdated, older);
        env.set_record(&outdated, older);

        let mut pending = env.pending(&surfaces);
        pending.sort_by_key(|(artifact, _)| artifact_identity(artifact));
        let mut expected = vec![
            (edited.clone(), OperationKind::Conflict),
            (outdated.clone(), OperationKind::Update),
        ];
        expected.sort_by_key(|(artifact, _)| artifact_identity(artifact));
        assert_eq!(pending, expected);

        let result = env.apply(&surfaces);
        assert!(result.success, "apply: {}", result.message);
        assert_eq!(fs::read(env.path(&edited)).expect("kept"), mine);
        let current =
            fs::read(bundled().join("skills/security-audit/ATTACK-CLASSES.md")).expect("read");
        assert_eq!(fs::read(env.path(&outdated)).expect("updated"), current);
        assert_eq!(
            env.kind(&surfaces, &edited),
            OperationKind::Conflict,
            "the edit stays a conflict"
        );
    }

    #[test]
    fn a_supporting_file_without_a_record_is_owned_only_when_it_is_a_shipped_version() {
        let env = Env::new("shipped-support", &[SetupSurfaceId::Skills]);
        let surfaces = [SetupSurfaceId::Skills];
        let artifact = skill_file(SkillRoot::Claude, "security-audit", "HUNTING.md");
        let shipped = b"hunting guide the app shipped once\n";
        env.write(&artifact, shipped);
        let mut state = env.state();
        state
            .artifacts
            .retain(|record| record.identity != artifact_identity(&artifact));
        write_managed_state_atomic(&env.ws, &state).expect("drop record");

        // Nothing proves these bytes: preserved.
        assert_eq!(env.kind(&surfaces, &artifact), OperationKind::Conflict);

        // The key is the bundle-relative path of the source file.
        let _inject = test_override::inject(
            &serde_json::json!({
                "schema": 1,
                "sources": {"skills/security-audit/HUNTING.md": [stable_digest::bytes(shipped)]}
            })
            .to_string(),
        );
        assert_eq!(env.kind(&surfaces, &artifact), OperationKind::Update);
        // That version proves no other file.
        let other = skill_file(SkillRoot::Claude, "security-audit", "CLIENT-SIDE.md");
        env.write(&other, shipped);
        let mut state = env.state();
        state
            .artifacts
            .retain(|record| record.identity != artifact_identity(&other));
        write_managed_state_atomic(&env.ws, &state).expect("drop record");
        assert_eq!(env.kind(&surfaces, &other), OperationKind::Conflict);
    }

    #[test]
    fn a_retired_skill_is_removed_with_its_empty_directories_but_a_foreign_sibling_stays() {
        let env = Env::new("retired", &[SetupSurfaceId::Skills]);
        let surfaces = [SetupSurfaceId::Skills];
        let claude = env.root(SkillRoot::Claude);

        // Two skills the app installed once and no longer ships.
        let mut owned = Vec::new();
        for name in ["retired-kept", "retired-gone"] {
            for (rel, bytes) in [
                ("SKILL.md", &b"retired skill\n"[..]),
                ("HUNTING.md", &b"retired notes\n"[..]),
                ("assets/deep/page.html", &b"<html>\n"[..]),
            ] {
                let artifact = skill_file(SkillRoot::Claude, name, rel);
                env.write(&artifact, bytes);
                env.set_record(&artifact, bytes);
                owned.push(artifact);
            }
        }
        // A file the user added next to the app's files.
        fs::write(claude.join("retired-kept/my-notes.md"), "mine").expect("foreign");
        fs::write(claude.join("retired-kept/assets/deep/mine.html"), "mine").expect("foreign");

        for artifact in &owned {
            assert_eq!(env.kind(&surfaces, artifact), OperationKind::Remove);
        }
        let result = env.apply(&surfaces);
        assert!(result.success, "apply: {}", result.message);

        for artifact in &owned {
            assert!(!env.path(artifact).exists(), "{artifact:?}");
            assert_eq!(env.record(artifact), None);
        }
        // The directory holding a foreign file stays, and so does the path to it.
        assert_eq!(
            fs::read_to_string(claude.join("retired-kept/my-notes.md")).unwrap(),
            "mine"
        );
        assert!(claude.join("retired-kept/assets/deep/mine.html").is_file());
        // Directories the removal emptied are gone, up to but not including the skill root.
        assert!(!claude.join("retired-gone").exists());
        assert!(claude.is_dir(), "the skills root stays");
        assert!(claude.join("tdd/SKILL.md").is_file(), "current skills stay");

        // Rolling back puts every removed file and directory back.
        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        for artifact in &owned {
            assert!(env.path(artifact).is_file(), "{artifact:?}");
        }
        assert!(claude.join("retired-gone/assets/deep/page.html").is_file());
    }

    #[test]
    fn uninstall_removes_owned_files_and_keeps_foreign_files_and_skills() {
        let env = Env::new("uninstall", &[SetupSurfaceId::Skills]);
        let claude = env.root(SkillRoot::Claude);
        fs::write(claude.join("security-audit/my-notes.md"), "mine").expect("foreign file");
        fs::create_dir_all(claude.join("my-own-skill")).expect("foreign skill");
        fs::write(claude.join("my-own-skill/SKILL.md"), "mine").expect("foreign skill md");

        let plan = preview_uninstall().expect("uninstall preview");
        let result = apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(result.success, "uninstall: {}", result.message);

        assert_eq!(
            files_below(&claude.join("security-audit"))
                .keys()
                .collect::<Vec<_>>(),
            vec!["my-notes.md"],
            "only the foreign file is left"
        );
        assert!(
            !claude.join("tdd").exists(),
            "an emptied skill directory is removed"
        );
        assert!(!claude.join("status-report").exists());
        assert!(claude.join("my-own-skill/SKILL.md").is_file());
    }

    #[test]
    fn records_under_any_of_the_five_old_identities_move_to_the_skill_file_identity() {
        let env = Env::new("old-identities", &[]);
        let source = fs::read(bundled().join("skills/tdd/SKILL.md")).expect("tdd");
        let cases: [(&str, SkillRoot); 5] = [
            ("ClaudeSkill", SkillRoot::Claude),
            ("OpenCodeSkill", SkillRoot::OpenCode),
            ("CodexSkill", SkillRoot::CodexHome),
            ("CursorSkill", SkillRoot::Cursor),
            ("CodexLegacySkill", SkillRoot::Agents),
        ];
        let mut records = Vec::new();
        for (variant, root) in cases {
            let artifact = ArtifactId::skill_md(root, skill("tdd"));
            env.write(&artifact, &source);
            records.push(ManagedArtifactRecord {
                identity: format!(r#"{{"type":"{variant}","name":"tdd"}}"#),
                hash: stable_digest::bytes(&source),
                surface: None,
                role_models: Default::default(),
            });
        }
        write_managed_state_atomic(
            &env.ws,
            &ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: stable_digest::bytes(b"bundle"),
                artifacts: records,
            },
        )
        .expect("old managed state");

        let state = read_managed_state(&env.ws).expect("state");
        for (_, root) in cases {
            let identity = artifact_identity(&ArtifactId::skill_md(root, skill("tdd")));
            assert_eq!(
                state
                    .artifacts
                    .iter()
                    .filter(|record| record.identity == identity)
                    .count(),
                1,
                "{identity}"
            );
        }
        assert_eq!(state.artifacts.len(), 5);

        let planned = env.plan(&SKILL_SURFACES);
        let mut destinations = std::collections::HashSet::new();
        for operation in &planned {
            let dest = env.path(&operation.artifact);
            assert!(
                destinations.insert(dest.clone()),
                "two operations for {}: {planned:?}",
                dest.display()
            );
        }
        let kind_of = |root| {
            planned
                .iter()
                .find(|operation| operation.artifact == ArtifactId::skill_md(root, skill("tdd")))
                .map(|operation| operation.kind)
        };
        // The folders the enabled harnesses read keep their copy ...
        for root in [SkillRoot::Claude, SkillRoot::Agents] {
            assert_eq!(kind_of(root), Some(OperationKind::NoChange), "{root:?}");
        }
        // ... and the three older harness folders lose the copy the old records name.
        for root in [SkillRoot::OpenCode, SkillRoot::CodexHome, SkillRoot::Cursor] {
            assert_eq!(kind_of(root), Some(OperationKind::Remove), "{root:?}");
        }
    }

    #[test]
    fn a_transaction_manifest_written_with_old_identities_still_rolls_back() {
        let env = Env::new("old-manifest", &[]);
        let surfaces = [SetupSurfaceId::Skills];
        let claude = env.root(SkillRoot::Claude);
        // A skill the app retired: removing it is part of the transaction.
        let retired_md = skill_file(SkillRoot::Claude, "retired-skill", "SKILL.md");
        let retired_page = skill_file(SkillRoot::Claude, "retired-skill", "assets/page.html");
        for (artifact, bytes) in [
            (&retired_md, &b"retired\n"[..]),
            (&retired_page, &b"<html>\n"[..]),
        ] {
            env.write(artifact, bytes);
            env.set_record(artifact, bytes);
        }
        let result = env.apply(&surfaces);
        assert!(result.success, "apply: {}", result.message);
        assert!(!claude.join("retired-skill").exists());
        assert!(claude.join("tdd/SKILL.md").is_file());

        // Rewrite the manifest the way a version before per-file artifacts wrote it: the
        // SKILL.md of each Claude skill under its per-harness identity, naming the retired
        // per-harness surface.
        let manifest_path = env
            .base
            .join("backups/setup")
            .join(&result.transaction_id)
            .join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).expect("manifest"))
                .expect("manifest json");
        let mut rewritten = 0;
        for operation in manifest["operations"].as_array_mut().expect("operations") {
            let artifact = &operation["artifact"];
            if artifact["type"] == "SkillFile"
                && artifact["name"]["rel"] == "SKILL.md"
                && artifact["name"]["root"] == "claude"
            {
                let name = artifact["name"]["skill"].clone();
                operation["artifact"] = serde_json::json!({"type": "ClaudeSkill", "name": name});
                operation["surface"] = serde_json::json!("claude_skills");
                rewritten += 1;
            }
        }
        assert!(
            rewritten > source_skill_count(),
            "{} created skills and the retired one: {rewritten}",
            source_skill_count()
        );
        fs::write(&manifest_path, manifest.to_string()).expect("write manifest");

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(
            rolled.success,
            "rollback: {} {:?}",
            rolled.message, rolled.failed
        );
        assert_eq!(
            fs::read(env.path(&retired_md)).expect("restored"),
            b"retired\n"
        );
        assert_eq!(
            fs::read(env.path(&retired_page)).expect("restored"),
            b"<html>\n"
        );
        assert!(
            !claude.join("tdd").exists(),
            "a created skill is removed with its directory"
        );
        assert!(
            !env.root(SkillRoot::Agents).join("tdd").exists(),
            "so is the one created in the other folder"
        );
        assert!(
            !claude.join("security-audit").exists(),
            "created supporting files are removed too"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_skills_root_plans_a_conflict_for_every_file_of_that_root_only() {
        let env = Env::new("symlink-root", &[]);
        let elsewhere = env.base.join("elsewhere");
        fs::create_dir_all(&elsewhere).expect("target");
        fs::create_dir_all(env.home.join(".claude")).expect(".claude");
        std::os::unix::fs::symlink(&elsewhere, env.home.join(".claude/skills")).expect("symlink");

        let planned = env.plan(&[SetupSurfaceId::Skills]);
        let (skills, supporting) = skill_file_counts(
            &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../resources/default-workspace/skills"),
        );
        assert_eq!(
            planned
                .iter()
                .filter(|operation| matches!(&operation.artifact, ArtifactId::SkillFile(file) if file.root == SkillRoot::Claude))
                .count(),
            skills + supporting,
            "one conflict for every bundled skill file in the linked folder"
        );
        for operation in &planned {
            let ArtifactId::SkillFile(file) = &operation.artifact else {
                panic!("unexpected artifact {:?}", operation.artifact);
            };
            let expected = if file.root == SkillRoot::Claude {
                OperationKind::Conflict
            } else {
                OperationKind::Create
            };
            assert_eq!(operation.kind, expected, "{:?}", operation.artifact);
        }
        // Nothing was written through the link.
        assert!(fs::read_dir(&elsewhere).expect("target").next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_skill_directory_conflicts_only_for_that_skill() {
        let env = Env::new("symlink-skill", &[]);
        let claude = env.root(SkillRoot::Claude);
        let elsewhere = env.base.join("elsewhere");
        fs::create_dir_all(&elsewhere).expect("target");
        fs::create_dir_all(&claude).expect("skills root");
        std::os::unix::fs::symlink(&elsewhere, claude.join("security-audit")).expect("symlink");

        for operation in env.plan(&[SetupSurfaceId::Skills]) {
            let ArtifactId::SkillFile(file) = &operation.artifact else {
                panic!("unexpected artifact {:?}", operation.artifact);
            };
            let expected =
                if file.root == SkillRoot::Claude && file.skill.as_str() == "security-audit" {
                    OperationKind::Conflict
                } else {
                    OperationKind::Create
                };
            assert_eq!(operation.kind, expected, "{:?}", operation.artifact);
        }
    }

    #[test]
    fn something_in_the_way_of_a_skill_file_is_a_conflict_not_an_apply_failure() {
        let env = Env::new("in-the-way", &[]);
        let claude = env.root(SkillRoot::Claude);
        // A directory where HUNTING.md belongs, and a file where assets/ belongs.
        fs::create_dir_all(claude.join("security-audit/HUNTING.md")).expect("dir in the way");
        fs::create_dir_all(claude.join("status-report")).expect("skill dir");
        fs::write(claude.join("status-report/assets"), "a file").expect("file");

        let surfaces = [SetupSurfaceId::Skills];
        let hunting = skill_file(SkillRoot::Claude, "security-audit", "HUNTING.md");
        let template = skill_file(
            SkillRoot::Claude,
            "status-report",
            "assets/report-template.html",
        );
        let sibling = skill_file(SkillRoot::Claude, "security-audit", "LICENSE");
        assert_eq!(env.kind(&surfaces, &hunting), OperationKind::Conflict);
        assert_eq!(env.kind(&surfaces, &template), OperationKind::Conflict);
        assert_eq!(env.kind(&surfaces, &sibling), OperationKind::Create);

        let result = env.apply(&surfaces);
        assert!(result.success, "apply: {}", result.message);
        assert!(claude.join("security-audit/LICENSE").is_file());
        assert!(claude.join("security-audit/HUNTING.md").is_dir());
        assert!(claude.join("status-report/assets").is_file());
    }
}
