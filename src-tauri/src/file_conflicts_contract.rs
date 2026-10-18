//! Contract tests for conflicts on skill and agent files: keeping the user's version, handing it
//! back, and the diff.
//!
//! They drive the real planner, status, preview, apply and uninstall commands against the bundled
//! skills and agents in a temp HOME and runtime workspace, and check that no skill or agent file is
//! ever written by keeping, handing back or diffing. They never touch the real profile.

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::MutexGuard;

    use crate::agent_targets::HarnessId;
    use crate::artifact_registry::{ArtifactId, SkillName, SkillRelPath};
    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, SetupResult,
    };
    use crate::commands::{preview_file_diff, set_files_kept};
    use crate::file_conflicts::{ConflictReason, DiffKind, UnitState};
    use crate::installation_status::{status_for_surfaces, InstallationState, InstallationStatus};
    use crate::kept_files::KEPT_FILES_REL;
    use crate::managed_state::{
        artifact_identity, read_managed_state, write_managed_state_atomic, ManagedArtifactRecord,
        ManagedState, MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::setup_lifecycle::{OperationKind, SetupPlan, SetupSurfaceId};
    use crate::setup_transaction::{plan_artifacts_for_surfaces, PlannedArtifact};
    use crate::skill_roots::SkillRoot;
    use crate::stable_digest;
    use crate::test_env::{guard, guard::EnvRestore, set_test_user_dirs};

    const SKILLS: [SetupSurfaceId; 1] = [SetupSurfaceId::Skills];

    fn surface_name(surface: SetupSurfaceId) -> String {
        serde_json::to_value(surface)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("{surface:?}"))
    }

    fn skill_file(root: SkillRoot, name: &str, rel: &str) -> ArtifactId {
        ArtifactId::skill_file(
            root,
            SkillName::new(name).expect("skill name"),
            SkillRelPath::new(rel).expect("rel path"),
        )
    }

    fn bundled() -> PathBuf {
        crate::setup_roots::bundled_root().expect("bundled root")
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

    /// A temp HOME and runtime workspace with the given surfaces already installed from the real
    /// bundle.
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
            let base = std::env::temp_dir().join(format!("aw-file-conflicts-{label}-{nanos}"));
            let home = base.join("home");
            let ws = base.join("runtime");
            fs::create_dir_all(&home).expect("home");
            set_test_user_dirs(&home);
            unsafe {
                std::env::set_var("AGENT_WORKSPACE_PATH", ws.to_string_lossy().as_ref());
                std::env::set_var(
                    "AGENT_WORKSPACE_BACKUP_DIR",
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

        /// Enables exactly these harnesses in the settings file.
        fn enable(&self, harnesses: &[HarnessId]) {
            crate::settings::mutate_settings(|settings| {
                settings.enabled_harness_ids = harnesses.to_vec();
                Ok(crate::settings::MutationOutcome::Changed)
            })
            .expect("write settings");
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

        fn planned(&self, surfaces: &[SetupSurfaceId], artifact: &ArtifactId) -> PlannedArtifact {
            self.plan(surfaces)
                .into_iter()
                .find(|planned| &planned.artifact == artifact)
                .unwrap_or_else(|| panic!("artifact not planned: {artifact:?}"))
        }

        fn kind(&self, surfaces: &[SetupSurfaceId], artifact: &ArtifactId) -> OperationKind {
            self.planned(surfaces, artifact).kind
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
            });
            state.artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
            write_managed_state_atomic(&self.ws, &state).expect("write managed state");
        }

        fn drop_record(&self, artifact: &ArtifactId) {
            let mut state = self.state();
            let identity = artifact_identity(artifact);
            state.artifacts.retain(|record| record.identity != identity);
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

        fn status(&self, surface: SetupSurfaceId) -> InstallationStatus {
            status_for_surfaces(&[surface], &self.ws, &self.home).expect("status")
        }

        fn keep(&self, surface: SetupSurfaceId, unit: &str) -> Result<(), String> {
            set_files_kept(surface_name(surface), vec![unit.to_string()], true)
        }

        fn hand_back(&self, surface: SetupSurfaceId, unit: &str) -> Result<(), String> {
            set_files_kept(surface_name(surface), vec![unit.to_string()], false)
        }

        fn kept_path(&self) -> PathBuf {
            self.ws.join(KEPT_FILES_REL)
        }

        /// Every file of the backup folder, to see whether an operation made a backup.
        fn backups(&self) -> BTreeSet<String> {
            files_below(&self.base.join("backups"))
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn skills_op(plan: &SetupPlan) -> &crate::setup_lifecycle::PlannedOperation {
        plan.operations
            .iter()
            .chain(plan.manual_steps.iter())
            .find(|op| op.surface == SetupSurfaceId::Skills && !op.details.is_empty())
            .expect("a skills operation with review lines")
    }

    fn tdd() -> ArtifactId {
        skill_file(SkillRoot::Claude, "tdd", "SKILL.md")
    }

    // ── 1. Keep, hand back ──

    #[test]
    fn keeping_an_edited_skill_file_stops_it_blocking_and_writes_no_skill_file() {
        let env = Env::new("keep", &SKILLS);
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);

        assert_eq!(env.kind(&SKILLS, &tdd()), OperationKind::Conflict);
        let status = env.status(SetupSurfaceId::Skills);
        assert_eq!(status.counts.conflict_count, 1);
        assert_eq!(status.counts.kept_count, 0);
        assert_eq!(status.state, InstallationState::Conflict);
        let files = status.surfaces[0].files.as_ref().expect("files status");
        assert_eq!((files.conflicts, files.kept), (1, 0));
        let unit = &files.units[0];
        assert_eq!(unit.key, "skill:claude:tdd");
        assert_eq!(unit.name, "tdd");
        assert_eq!(unit.folder, "~/.claude/skills");
        assert_eq!(unit.state, UnitState::Conflict);
        assert!(unit.wanted);
        assert!(env.preview(&SKILLS).is_blocked);

        let backups = env.backups();
        let record = env.record(&tdd());
        env.keep(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("keep");

        let planned = env.planned(&SKILLS, &tdd());
        assert_eq!(planned.kind, OperationKind::Manual);
        assert_eq!(
            planned.previous_state,
            crate::setup_transaction::PreviousState::Conflict
        );
        assert_eq!(
            planned.rollback_action,
            crate::setup_transaction::RollbackAction::NoAction
        );
        let status = env.status(SetupSurfaceId::Skills);
        assert_eq!(status.counts.conflict_count, 0);
        assert_eq!(status.counts.kept_count, 1);
        assert_eq!(status.state, InstallationState::Current);
        let files = status.surfaces[0].files.as_ref().expect("files status");
        assert_eq!((files.conflicts, files.kept, files.kept_updates), (0, 1, 0));
        assert_eq!(files.units[0].state, UnitState::Kept);
        assert!(!files.units[0].bundle_changed, "kept against this bundle");
        assert!(
            status.surfaces[0].detail.contains("you manage 1"),
            "{}",
            status.surfaces[0].detail
        );
        let plan = env.preview(&SKILLS);
        assert!(!plan.is_blocked && plan.conflicts.is_empty());
        assert!(plan
            .manual_steps
            .iter()
            .any(|op| op.surface == SetupSurfaceId::Skills
                && op.summary.contains("you manage 1 file")
                && op
                    .manual_step
                    .as_deref()
                    .is_some_and(|step| step.contains("hand them back"))));

        // Nothing was written but the choice itself.
        assert_eq!(fs::read(env.path(&tdd())).expect("file"), mine);
        assert_eq!(
            env.record(&tdd()),
            record,
            "the managed record is untouched"
        );
        assert_eq!(env.backups(), backups, "keeping makes no backup");
        let kept: serde_json::Value =
            serde_json::from_slice(&fs::read(env.kept_path()).expect("kept-files.json"))
                .expect("json");
        assert_eq!(kept["kept"].as_array().expect("entries").len(), 1);
        assert_eq!(kept["kept"][0]["dest"], "~/.claude/skills/tdd/SKILL.md");

        // Handing it back makes it a conflict again, and still writes no skill file.
        env.hand_back(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("hand back");
        assert_eq!(env.kind(&SKILLS, &tdd()), OperationKind::Conflict);
        assert_eq!(env.status(SetupSurfaceId::Skills).counts.kept_count, 0);
        assert_eq!(fs::read(env.path(&tdd())).expect("file"), mine);
        assert_eq!(env.backups(), backups);
    }

    #[test]
    fn handing_back_something_that_is_not_kept_changes_nothing() {
        let env = Env::new("hand-back-noop", &SKILLS);
        env.hand_back(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("nothing to hand back is not an error");
        env.hand_back(SetupSurfaceId::Skills, "skill:claude:no-such-skill")
            .expect("a unit that is gone has nothing to hand back");
        assert!(!env.kept_path().exists());
    }

    // ── 2. Why a file is a conflict ──

    #[test]
    fn a_recorded_file_that_changed_is_edited_and_one_without_a_record_is_unproven() {
        let env = Env::new("reasons", &SKILLS);
        let edited = skill_file(SkillRoot::Claude, "security-audit", "HUNTING.md");
        let unproven = skill_file(SkillRoot::Claude, "security-audit", "CLIENT-SIDE.md");
        env.write(&edited, b"mine\n");
        env.write(&unproven, b"mine too\n");
        env.drop_record(&unproven);

        let reason = |artifact: &ArtifactId| {
            env.planned(&SKILLS, artifact)
                .file
                .unwrap_or_else(|| panic!("a resolvable conflict: {artifact:?}"))
                .reason
        };
        assert_eq!(reason(&edited), ConflictReason::Edited);
        assert_eq!(reason(&unproven), ConflictReason::Unproven);

        let status = env.status(SetupSurfaceId::Skills);
        let unit = &status.surfaces[0].files.as_ref().expect("files").units[0];
        assert_eq!(unit.key, "skill:claude:security-audit");
        assert_eq!(unit.files.len(), 2, "both files are one unit");
        assert_eq!(
            unit.reason,
            ConflictReason::Edited,
            "edited wins for the unit"
        );
        let by_rel = |rel: &str| {
            unit.files
                .iter()
                .find(|file| file.rel == rel)
                .expect("file")
        };
        assert_eq!(by_rel("HUNTING.md").reason, ConflictReason::Edited);
        assert_eq!(by_rel("CLIENT-SIDE.md").reason, ConflictReason::Unproven);
    }

    // ── 3. A bundle that changed since the choice ──

    #[test]
    fn a_kept_file_reports_a_bundled_update_only_after_the_bundle_changed() {
        let env = Env::new("bundle-changed", &SKILLS);
        env.write(&tdd(), b"my own tdd\n");
        env.keep(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("keep");

        let flags = |env: &Env| {
            let status = env.status(SetupSurfaceId::Skills);
            let files = status.surfaces[0].files.clone().expect("files");
            (files.kept_updates, files.units[0].bundle_changed)
        };
        assert_eq!(flags(&env), (0, false));
        let plan = env.preview(&SKILLS);
        assert!(
            skills_op(&plan)
                .details
                .contains(&"= ~/.claude/skills/tdd (you manage; bundle unchanged)".to_string()),
            "{:?}",
            skills_op(&plan).details
        );

        // The bundle moves on: the digest recorded at keep time no longer matches.
        let artifact = tdd();
        crate::kept_files::keep(
            &env.ws,
            &[crate::kept_files::Keep {
                dest: crate::kept_files::dest_label(&artifact, &env.home, &env.ws).expect("dest"),
                artifact,
                bundle: Some(stable_digest::bytes(b"an older bundled tdd")),
            }],
        )
        .expect("record an older bundle digest");
        assert_eq!(flags(&env), (1, true));
        let plan = env.preview(&SKILLS);
        assert!(
            skills_op(&plan).details.contains(
                &"= ~/.claude/skills/tdd (you manage; bundled update available)".to_string()
            ),
            "{:?}",
            skills_op(&plan).details
        );
        assert_eq!(
            env.status(SetupSurfaceId::Skills).state,
            InstallationState::Current
        );
    }

    // ── 4. What cannot be kept ──

    #[test]
    fn a_clean_file_an_unknown_unit_and_a_surface_without_files_are_refused() {
        let env = Env::new("refused", &SKILLS);
        let clean = env.keep(SetupSurfaceId::Skills, "skill:claude:diagnose");
        assert!(
            clean
                .as_ref()
                .is_err_and(|e| e.contains("no conflicting or kept files")),
            "{clean:?}"
        );
        let unknown = env.keep(SetupSurfaceId::Skills, "skill:claude:no-such-skill");
        assert!(unknown.is_err());
        let garbage = env.keep(SetupSurfaceId::Skills, "../../etc/passwd");
        assert!(
            garbage.as_ref().is_err_and(|e| !e.contains("passwd")),
            "an error never echoes the key: {garbage:?}"
        );
        for surface in [
            "claude_rules",
            "workspace_bundle",
            "codex_config",
            "claude_skills",
            "nope",
        ] {
            assert!(
                set_files_kept(surface.to_string(), vec!["skill:claude:tdd".into()], true).is_err(),
                "{surface}"
            );
        }
        assert!(set_files_kept("skills".into(), vec![], true).is_err());
        assert!(!env.kept_path().exists(), "nothing was recorded");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_or_a_folder_in_the_way_is_a_plain_conflict_nothing_can_resolve() {
        let env = Env::new("blocked", &SKILLS);
        let claude = env.root(SkillRoot::Claude);

        // A symlinked skill directory.
        let elsewhere = env.base.join("elsewhere");
        fs::create_dir_all(&elsewhere).expect("target");
        fs::write(elsewhere.join("SKILL.md"), "mine\n").expect("target file");
        fs::remove_dir_all(claude.join("tdd")).expect("remove tdd");
        std::os::unix::fs::symlink(&elsewhere, claude.join("tdd")).expect("symlink");
        // A directory where a file belongs.
        let hunting = skill_file(SkillRoot::Claude, "security-audit", "HUNTING.md");
        fs::remove_file(env.path(&hunting)).expect("remove file");
        fs::create_dir_all(env.path(&hunting)).expect("dir in the way");

        for artifact in [tdd(), hunting] {
            let planned = env.planned(&SKILLS, &artifact);
            assert_eq!(planned.kind, OperationKind::Conflict, "{artifact:?}");
            assert!(planned.file.is_none(), "{artifact:?} is not resolvable");
        }
        let status = env.status(SetupSurfaceId::Skills);
        assert!(status.counts.conflict_count >= 2);
        assert!(status.surfaces[0].files.is_none(), "no unit to act on");
        for unit in ["skill:claude:tdd", "skill:claude:security-audit"] {
            assert!(env.keep(SetupSurfaceId::Skills, unit).is_err(), "{unit}");
        }
        // Nothing was written through the link.
        assert_eq!(files_below(&elsewhere).len(), 1);
    }

    #[test]
    fn workspace_files_keep_conflicting_even_when_an_entry_names_them() {
        let env = Env::new("workspace", &[SetupSurfaceId::WorkspaceBundle]);
        let readme = ArtifactId::WorkspaceFile(
            crate::artifact_registry::WorkspaceRelPath::new("README.md").expect("rel"),
        );
        env.write(&readme, b"my own readme\n");
        let surfaces = [SetupSurfaceId::WorkspaceBundle];
        assert_eq!(env.kind(&surfaces, &readme), OperationKind::Conflict);

        // An entry for it written by hand changes nothing: only skill and agent files are kept.
        let identity = artifact_identity(&readme);
        fs::create_dir_all(env.kept_path().parent().expect("parent")).expect("dir");
        fs::write(
            env.kept_path(),
            serde_json::json!({
                "schema_version": 1,
                "kept": [{"identity": identity, "dest": "~/ws/README.md"}]
            })
            .to_string(),
        )
        .expect("kept-files.json");
        let planned = env.planned(&surfaces, &readme);
        assert_eq!(planned.kind, OperationKind::Conflict);
        assert!(planned.file.is_none());
        assert!(set_files_kept(
            "workspace_bundle".into(),
            vec!["skill:claude:tdd".into()],
            true
        )
        .is_err());
    }

    // ── 5. What a kept file leaves alone, and what it does not ──

    #[test]
    fn a_clean_sibling_of_a_kept_file_still_updates_and_the_kept_file_stays() {
        let env = Env::new("sibling", &SKILLS);
        let kept = skill_file(SkillRoot::Claude, "security-audit", "HUNTING.md");
        let outdated = skill_file(SkillRoot::Claude, "security-audit", "ATTACK-CLASSES.md");
        let mine = b"my own hunting notes\n";
        env.write(&kept, mine);
        let older = b"attack classes of an older version\n";
        env.write(&outdated, older);
        env.set_record(&outdated, older);
        env.keep(SetupSurfaceId::Skills, "skill:claude:security-audit")
            .expect("keep");

        let mut pending = env.pending(&SKILLS);
        pending.sort_by_key(|(artifact, _)| artifact_identity(artifact));
        let mut expected = vec![
            (kept.clone(), OperationKind::Manual),
            (outdated.clone(), OperationKind::Update),
        ];
        expected.sort_by_key(|(artifact, _)| artifact_identity(artifact));
        assert_eq!(pending, expected);

        let result = env.apply(&SKILLS);
        assert!(result.success, "apply: {}", result.message);
        assert_eq!(fs::read(env.path(&kept)).expect("kept file"), mine);
        let current =
            fs::read(bundled().join("skills/security-audit/ATTACK-CLASSES.md")).expect("read");
        assert_eq!(fs::read(env.path(&outdated)).expect("updated"), current);
        assert_eq!(
            env.kind(&SKILLS, &kept),
            OperationKind::Manual,
            "still kept"
        );
        assert!(
            fs::read_to_string(env.kept_path())
                .expect("kept-files.json")
                .contains("HUNTING.md"),
            "writing a sibling does not end the choice"
        );
    }

    #[test]
    fn a_retired_skill_with_a_kept_file_loses_none_of_its_files_and_survives_an_update() {
        let env = Env::new("retired", &SKILLS);
        let claude = env.root(SkillRoot::Claude);
        let mut files = Vec::new();
        for name in ["retired-kept", "retired-gone"] {
            for (rel, bytes) in [
                ("SKILL.md", &b"retired skill\n"[..]),
                ("HUNTING.md", &b"retired notes\n"[..]),
                ("assets/deep/page.html", &b"<html>\n"[..]),
            ] {
                let artifact = skill_file(SkillRoot::Claude, name, rel);
                env.write(&artifact, bytes);
                env.set_record(&artifact, bytes);
                files.push(artifact);
            }
        }
        // The user edits the retired skill's SKILL.md.
        let edited = skill_file(SkillRoot::Claude, "retired-kept", "SKILL.md");
        let mine = b"my own copy of the retired skill\n";
        env.write(&edited, mine);

        let planned = env.planned(&SKILLS, &edited);
        assert_eq!(planned.kind, OperationKind::Conflict);
        let file = planned.file.expect("resolvable");
        assert!(!file.wanted, "the bundle no longer ships it");
        let status = env.status(SetupSurfaceId::Skills);
        let unit = &status.surfaces[0].files.as_ref().expect("files").units[0];
        assert!(!unit.wanted);

        env.keep(SetupSurfaceId::Skills, "skill:claude:retired-kept")
            .expect("keep");
        for artifact in &files {
            let in_kept_skill = matches!(artifact, ArtifactId::SkillFile(file) if file.skill.as_str() == "retired-kept");
            assert_eq!(
                env.kind(&SKILLS, artifact),
                if in_kept_skill {
                    OperationKind::Manual
                } else {
                    OperationKind::Remove
                },
                "{artifact:?}"
            );
        }
        let status = env.status(SetupSurfaceId::Skills);
        let unit = &status.surfaces[0].files.as_ref().expect("files").units[0];
        assert_eq!(unit.state, UnitState::Kept);
        assert!(
            !unit.bundle_changed,
            "nothing bundled here, no update to wait for"
        );

        let result = env.apply(&SKILLS);
        assert!(result.success, "apply: {}", result.message);
        assert!(
            !claude.join("retired-gone").exists(),
            "the clean retired skill goes"
        );
        assert_eq!(fs::read(env.path(&edited)).expect("kept"), mine);
        for rel in ["HUNTING.md", "assets/deep/page.html"] {
            assert!(
                claude.join("retired-kept").join(rel).is_file(),
                "{rel} stays with the file the user keeps"
            );
        }
        assert_eq!(env.kind(&SKILLS, &edited), OperationKind::Manual);
    }

    #[test]
    fn uninstall_leaves_a_kept_file_and_the_choice_alone() {
        let env = Env::new("uninstall", &SKILLS);
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);
        env.keep(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("keep");
        let kept = fs::read(env.kept_path()).expect("kept-files.json");

        let plan = preview_uninstall().expect("uninstall preview");
        assert!(
            plan.preserved
                .iter()
                .any(|item| item.path.ends_with("tdd/SKILL.md")),
            "{:?}",
            plan.preserved
                .iter()
                .map(|item| &item.path)
                .collect::<Vec<_>>()
        );
        let result = apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(result.success, "uninstall: {}", result.message);
        assert_eq!(fs::read(env.path(&tdd())).expect("kept file"), mine);
        assert_eq!(
            fs::read(env.kept_path()).expect("kept-files.json stays"),
            kept
        );
    }

    // ── 6. Roots ──

    /// Codex only, default home: `$CODEX_HOME/skills` is a folder older versions filled and that
    /// nothing wants any more.
    fn old_codex_folder(label: &str) -> Env {
        let env = Env::new(label, &[]);
        env.enable(&[HarnessId::Codex]);
        let bundled_tdd = fs::read(crate::skill_discovery::canonical_skill_md(
            &bundled(),
            "tdd",
        ))
        .expect("canonical tdd");
        let artifact = skill_file(SkillRoot::CodexHome, "tdd", "SKILL.md");
        env.write(&artifact, &bundled_tdd);
        env.set_record(&artifact, &bundled_tdd);
        env
    }

    #[test]
    fn a_kept_copy_in_a_folder_nothing_wants_is_left_and_its_readers_are_named() {
        let env = old_codex_folder("unwanted-root");
        let old = skill_file(SkillRoot::CodexHome, "tdd", "SKILL.md");
        let mine = b"my own tdd in the old codex folder\n";
        env.write(&old, mine);
        assert_eq!(env.kind(&SKILLS, &old), OperationKind::Conflict);
        let file = env.planned(&SKILLS, &old).file.expect("resolvable");
        assert!(!file.wanted);

        env.keep(SetupSurfaceId::Skills, "skill:codex-home:tdd")
            .expect("keep");
        assert_eq!(env.kind(&SKILLS, &old), OperationKind::Manual);

        let plan = env.preview(&SKILLS);
        assert!(
            skills_op(&plan).details.contains(
                &"= $CODEX_HOME/skills/tdd (you manage; Codex reads both copies)".to_string()
            ),
            "{:?}",
            skills_op(&plan).details
        );
        let result = env.apply(&SKILLS);
        assert!(result.success, "apply: {}", result.message);
        assert_eq!(fs::read(env.path(&old)).expect("kept"), mine);
        // The bundled copy is still created where Codex now reads (the effective-load view warns).
        assert!(env
            .path(&skill_file(SkillRoot::Agents, "tdd", "SKILL.md"))
            .is_file());

        // The unit lists the harness that reads the kept copy.
        let status = env.status(SetupSurfaceId::Skills);
        let unit = &status.surfaces[0].files.as_ref().expect("files").units[0];
        assert_eq!(unit.folder, "$CODEX_HOME/skills");
        assert!(!unit.wanted);
        assert_eq!(unit.read_by, vec!["Codex"]);
    }

    #[test]
    fn a_choice_does_not_follow_a_folder_that_moved() {
        let env = Env::new("moved-root", &SKILLS);
        env.write(&tdd(), b"my own tdd\n");
        env.keep(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("keep");
        assert_eq!(env.kind(&SKILLS, &tdd()), OperationKind::Manual);

        // The Claude folder moves; an edited copy of the same skill is in the new place.
        let custom = env.home.join("dotfiles/claude-skills");
        unsafe { std::env::set_var("CLAUDE_SKILLS_PATH", &custom) };
        env.write(&tdd(), b"my own tdd, somewhere else\n");
        assert_eq!(env.path(&tdd()), custom.join("tdd/SKILL.md"));
        let planned = env.planned(&SKILLS, &tdd());
        assert_eq!(
            planned.kind,
            OperationKind::Conflict,
            "the choice was for another folder"
        );
        assert!(planned.file.is_some_and(|file| file.kept.is_none()));
        assert_eq!(env.status(SetupSurfaceId::Skills).counts.conflict_count, 1);
    }

    // ── 7. Agents ──

    #[test]
    fn agent_files_of_every_harness_can_be_kept_and_handed_back() {
        let surfaces = [
            SetupSurfaceId::ClaudeAgents,
            SetupSurfaceId::OpenCodeAgents,
            SetupSurfaceId::CursorAgents,
            SetupSurfaceId::CodexAgents,
        ];
        let env = Env::new("agents", &surfaces);
        for surface in surfaces {
            let agent = env
                .plan(&[surface])
                .into_iter()
                .map(|planned| planned.artifact)
                .next()
                .unwrap_or_else(|| panic!("an agent on {surface:?}"));
            let (ArtifactId::ClaudeAgent(name)
            | ArtifactId::OpenCodeAgent(name)
            | ArtifactId::CursorAgent(name)
            | ArtifactId::CodexAgent(name)) = &agent
            else {
                panic!("{surface:?} plans {agent:?}");
            };
            let unit = format!("agent:{}", name.as_str());
            let mine = format!("my own {} agent\n", name.as_str());
            env.write(&agent, mine.as_bytes());

            assert_eq!(
                env.kind(&[surface], &agent),
                OperationKind::Conflict,
                "{surface:?}"
            );
            let status = env.status(surface);
            let files = status.surfaces[0].files.as_ref().expect("files status");
            assert_eq!(files.units[0].key, unit, "{surface:?}");
            assert_eq!(files.units[0].reason, ConflictReason::Edited);
            assert_eq!(
                files.units[0].read_by.len(),
                1,
                "an agent file is one harness's"
            );
            assert!(
                files.units[0].folder.contains("agents"),
                "{}",
                files.units[0].folder
            );

            env.keep(surface, &unit).expect("keep");
            assert_eq!(
                env.kind(&[surface], &agent),
                OperationKind::Manual,
                "{surface:?}"
            );
            let status = env.status(surface);
            assert_eq!(
                (status.counts.conflict_count, status.counts.kept_count),
                (0, 1)
            );
            assert!(
                status.surfaces[0].detail.contains("you manage 1"),
                "{}",
                status.surfaces[0].detail
            );
            assert_eq!(fs::read(env.path(&agent)).expect("kept"), mine.as_bytes());

            env.hand_back(surface, &unit).expect("hand back");
            assert_eq!(
                env.kind(&[surface], &agent),
                OperationKind::Conflict,
                "{surface:?}"
            );
            assert_eq!(fs::read(env.path(&agent)).expect("kept"), mine.as_bytes());
        }
        // The Codex agent is a `.toml` file; the others are Markdown.
        let codex = env.plan(&[SetupSurfaceId::CodexAgents]);
        assert!(env
            .path(&codex[0].artifact)
            .extension()
            .is_some_and(|ext| ext == "toml"));
    }

    // ── 11. An app write ends the choice ──

    #[test]
    fn a_file_that_turns_clean_is_updated_and_its_choice_ends() {
        let env = Env::new("prune", &SKILLS);
        let older = b"an older tdd the app wrote\n";
        env.write(&tdd(), b"my own tdd\n");
        env.keep(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("keep");
        assert!(fs::read_to_string(env.kept_path()).unwrap().contains("tdd"));

        // The user's file goes back to what the app recorded: the app owns it again.
        env.write(&tdd(), older);
        env.set_record(&tdd(), older);
        assert_eq!(env.kind(&SKILLS, &tdd()), OperationKind::Update);
        let result = env.apply(&SKILLS);
        assert!(result.success, "apply: {}", result.message);
        assert!(result.manual_steps.is_empty(), "{:?}", result.manual_steps);
        let current = fs::read(bundled().join("skills/tdd/SKILL.md")).expect("bundled tdd");
        assert_eq!(fs::read(env.path(&tdd())).expect("updated"), current);

        let kept: serde_json::Value =
            serde_json::from_slice(&fs::read(env.kept_path()).expect("kept-files.json"))
                .expect("json");
        assert_eq!(
            kept["kept"],
            serde_json::json!([]),
            "the choice ended with the write"
        );

        // A later edit is a new conflict, not covered by the old choice.
        env.write(&tdd(), b"edited again\n");
        let planned = env.planned(&SKILLS, &tdd());
        assert_eq!(planned.kind, OperationKind::Conflict);
        assert!(planned.file.is_some_and(|file| file.kept.is_none()));
    }

    #[test]
    fn a_choice_that_cannot_be_cleared_is_reported_and_the_apply_still_succeeds() {
        let env = Env::new("prune-fails", &SKILLS);
        let older = b"an older tdd the app wrote\n";
        env.write(&tdd(), b"my own tdd\n");
        env.keep(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("keep");
        env.write(&tdd(), older);
        env.set_record(&tdd(), older);
        // Another version of the app wrote the file: this one must not overwrite it.
        let foreign = r#"{"schema_version": 7, "kept": []}"#;
        fs::write(env.kept_path(), foreign).expect("foreign kept-files.json");

        let result = env.apply(&SKILLS);
        assert!(result.success, "the files were applied: {}", result.message);
        let current = fs::read(bundled().join("skills/tdd/SKILL.md")).expect("bundled tdd");
        assert_eq!(fs::read(env.path(&tdd())).expect("updated"), current);
        assert_eq!(result.manual_steps.len(), 1, "{:?}", result.manual_steps);
        assert!(
            result.manual_steps[0].contains("could not be cleared"),
            "{:?}",
            result.manual_steps
        );
        assert_eq!(fs::read_to_string(env.kept_path()).unwrap(), foreign);
    }

    // ── 13. Effective loads ──

    #[test]
    fn a_kept_copy_is_flagged_kept_and_still_counts_as_the_users_own() {
        use crate::skill_loads::{
            effective_skill_loads, FolderPaths, Owner, OwnershipProof, SkillLoadFlag,
        };
        let env = Env::new("loads", &SKILLS);
        env.write(&tdd(), b"my own tdd\n");

        let loads = |env: &Env| {
            let records = env.state().artifacts;
            let proof = OwnershipProof::new(&bundled(), &records)
                .expect("proof")
                .with_kept(crate::kept_files::KeptFiles::load(&env.ws));
            effective_skill_loads(
                &env.home,
                &[HarnessId::OpenCode],
                &FolderPaths::resolve(&env.home),
                &proof,
            )
        };
        let tdd_load = |loads: &crate::skill_loads::EffectiveSkillLoads| {
            loads.harnesses[0]
                .skills
                .iter()
                .find(|skill| skill.name == "tdd")
                .expect("tdd")
                .clone()
        };

        let before = tdd_load(&loads(&env));
        assert!(before.copies.iter().all(|copy| !copy.kept));
        assert_eq!(before.flags, vec![SkillLoadFlag::ForeignCopy]);

        env.keep(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("keep");
        let after = tdd_load(&loads(&env));
        assert_eq!(after.flags, before.flags, "duplicates still warn");
        let mine = after
            .copies
            .iter()
            .find(|copy| copy.path == "~/.claude/skills/tdd")
            .expect("the kept copy");
        assert_eq!(mine.owner, Owner::Foreign);
        assert!(mine.kept);
        assert!(
            after
                .copies
                .iter()
                .filter(|copy| copy.path != "~/.claude/skills/tdd")
                .all(|copy| !copy.kept && copy.owner == Owner::Aw),
            "the app's own copy is not kept"
        );
    }

    // ── The diff ──

    fn diff_of(surface: SetupSurfaceId, unit: &str) -> crate::file_conflicts::FileDiffView {
        preview_file_diff(surface_name(surface), unit.to_string()).expect("diff")
    }

    #[test]
    fn the_diff_shows_your_file_against_the_bundled_one_and_writes_nothing() {
        let env = Env::new("diff", &SKILLS);
        let bundled_text =
            fs::read_to_string(bundled().join("skills/tdd/SKILL.md")).expect("bundled tdd");
        let mut mine = bundled_text.clone();
        mine.push_str("an extra line of mine\n");
        env.write(&tdd(), mine.as_bytes());
        let backups = env.backups();
        let kept_before = env.kept_path().exists();

        let view = diff_of(SetupSurfaceId::Skills, "skill:claude:tdd");
        assert_eq!(view.name, "tdd");
        assert_eq!(view.folder, "~/.claude/skills");
        assert_eq!(view.files.len(), 1);
        assert_eq!(view.more_files, 0);
        let file = &view.files[0];
        assert_eq!(file.rel, "SKILL.md");
        assert_eq!(file.kind, DiffKind::Text);
        assert_eq!((file.added, file.removed), (0, 1));
        assert!(file.diff.contains("--- yours") && file.diff.contains("+++ bundled"));
        assert!(
            file.diff.contains("-an extra line of mine"),
            "{}",
            file.diff
        );
        assert_eq!(file.from_label, "yours");
        assert_eq!(file.to_label, "bundled");
        assert!(file
            .installed
            .as_ref()
            .is_some_and(|side| side.digest.len() == 19));

        // A kept file can be compared too.
        env.keep(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("keep");
        let view = diff_of(SetupSurfaceId::Skills, "skill:claude:tdd");
        assert_eq!(view.files[0].state, UnitState::Kept);

        assert_eq!(fs::read(env.path(&tdd())).expect("file"), mine.as_bytes());
        assert_eq!(env.backups(), backups);
        assert_eq!(
            env.kept_path().exists(),
            !kept_before,
            "only keeping wrote the choice"
        );
    }

    #[test]
    fn the_diff_names_files_it_cannot_or_must_not_show_without_their_text() {
        let env = Env::new("diff-kinds", &SKILLS);
        let bundled_text =
            fs::read_to_string(bundled().join("skills/tdd/SKILL.md")).expect("bundled tdd");
        let diff = |bytes: &[u8]| {
            env.write(&tdd(), bytes);
            diff_of(SetupSurfaceId::Skills, "skill:claude:tdd")
        };

        // Line endings only: taking the bundled file would change no word.
        let crlf = bundled_text.replace('\n', "\r\n");
        let view = diff(crlf.as_bytes());
        assert_eq!(view.files[0].kind, DiffKind::IdenticalText);
        assert!(view.files[0].diff.is_empty());
        assert!(view.files[0]
            .note
            .as_deref()
            .is_some_and(|note| note.contains("line endings")));

        // Not text.
        let view = diff(b"binary\0data");
        assert_eq!(view.files[0].kind, DiffKind::Binary);
        assert!(view.files[0].diff.is_empty());

        // Too large to compare: size and digest only.
        let view = diff(&vec![b'a'; 600 * 1024]);
        assert_eq!(view.files[0].kind, DiffKind::TooLarge);
        assert!(view.files[0]
            .installed
            .as_ref()
            .is_some_and(|side| side.bytes == 600 * 1024));

        // Key material is withheld whole, and its text is nowhere in the payload.
        let secret = "SECRET-KEY-BODY-0123456789";
        let key = format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{secret}\n-----END OPENSSH PRIVATE KEY-----\n"
        );
        let view = diff(key.as_bytes());
        assert_eq!(view.files[0].kind, DiffKind::Withheld);
        let payload = serde_json::to_string(&view).expect("serialize");
        assert!(!payload.contains(secret), "{payload}");
        assert!(!payload.contains("BEGIN OPENSSH"), "{payload}");
    }

    #[test]
    fn the_diff_of_a_unit_lists_every_conflicting_file_and_refuses_what_is_not_a_unit() {
        let env = Env::new("diff-unit", &SKILLS);
        for rel in ["HUNTING.md", "CLIENT-SIDE.md"] {
            env.write(
                &skill_file(SkillRoot::Claude, "security-audit", rel),
                b"mine\n",
            );
        }
        let view = diff_of(SetupSurfaceId::Skills, "skill:claude:security-audit");
        let rels: BTreeSet<&str> = view.files.iter().map(|file| file.rel.as_str()).collect();
        assert_eq!(rels, BTreeSet::from(["HUNTING.md", "CLIENT-SIDE.md"]));

        let error = preview_file_diff("skills".into(), "skill:claude:diagnose".into()).unwrap_err();
        assert!(error.contains("no conflicting or kept files"), "{error}");
        assert!(preview_file_diff("claude_rules".into(), "skill:claude:tdd".into()).is_err());
    }

    #[test]
    fn a_status_without_conflicts_carries_no_files_and_a_clean_install_is_current() {
        let env = Env::new("clean", &SKILLS);
        let status = env.status(SetupSurfaceId::Skills);
        assert_eq!(status.state, InstallationState::Current);
        assert_eq!(status.counts.kept_count, 0);
        assert!(status.surfaces[0].files.is_none());
        assert!(env.pending(&SKILLS).is_empty());
        let value = serde_json::to_value(&status).expect("serialize");
        assert!(value["surfaces"][0].get("files").is_none());
        assert_eq!(value["counts"]["kept_count"], 0);
    }
}
