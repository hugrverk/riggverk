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
    use crate::commands::setup::rollback_setup_transaction;
    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, SetupResult,
    };
    use crate::commands::{
        apply_take_bundled, preview_file_diff, preview_take_bundled, set_files_kept,
        TakeBundledPreview,
    };
    use crate::file_conflicts::{ConflictReason, DiffKind, UnitState};
    use crate::installation_status::{status_for_surfaces, InstallationState, InstallationStatus};
    use crate::kept_files::KEPT_FILES_FILE;
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
            crate::workspace_layout::state_file(&self.ws, KEPT_FILES_FILE)
        }

        /// Every file of the backup folder, to see whether an operation made a backup.
        fn backups(&self) -> BTreeSet<String> {
            files_below(&self.base.join("backups"))
        }

        /// The transactions that made a backup: an operation that refuses must add none.
        fn transactions(&self) -> BTreeSet<String> {
            fs::read_dir(self.base.join("backups/setup"))
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default()
        }

        fn preview_take(
            &self,
            surface: SetupSurfaceId,
            units: &[&str],
        ) -> Result<TakeBundledPreview, String> {
            preview_take_bundled(
                surface_name(surface),
                units.iter().map(|unit| unit.to_string()).collect(),
            )
        }

        /// Applies exactly what `preview` showed.
        fn apply_take(
            &self,
            surface: SetupSurfaceId,
            units: &[&str],
            preview: &TakeBundledPreview,
        ) -> Result<SetupResult, String> {
            self.apply_take_with(
                surface,
                units,
                Some(preview.plan_fingerprint.clone()),
                Some(preview.preview_token.clone()),
            )
        }

        fn apply_take_with(
            &self,
            surface: SetupSurfaceId,
            units: &[&str],
            fingerprint: Option<String>,
            token: Option<String>,
        ) -> Result<SetupResult, String> {
            apply_take_bundled(
                surface_name(surface),
                units.iter().map(|unit| unit.to_string()).collect(),
                fingerprint,
                token,
            )
        }

        /// The bundled bytes of a skill or agent file.
        fn bundled_bytes(&self, artifact: &ArtifactId) -> Vec<u8> {
            fs::read(artifact.resolve_source(&bundled()).expect("source")).expect("bundled file")
        }

        /// Where the transaction `id` backed up `name` (`artifacts/...`).
        fn backed_up(&self, id: &str, name: &str) -> PathBuf {
            self.base.join("backups/setup").join(id).join(name)
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
    fn workspace_files_are_never_kept_even_when_an_entry_names_them() {
        let env = Env::new("workspace", &[]);
        // An edited old copy of the bundle in the workspace folder: left in place, never kept.
        let readme = ArtifactId::WorkspaceFile(
            crate::artifact_registry::WorkspaceRelPath::new("README.md").expect("rel"),
        );
        env.write(&readme, b"my own readme\n");
        let surfaces = [SetupSurfaceId::WorkspaceBundle];
        assert_eq!(env.kind(&surfaces, &readme), OperationKind::Manual);
        assert!(env.planned(&surfaces, &readme).file.is_none());

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
        assert_eq!(planned.kind, OperationKind::Manual);
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

    // ── 8. Take bundled ──

    fn digest(bytes: &[u8]) -> String {
        stable_digest::bytes(bytes)
    }

    /// `sha256:` and twelve hex digits, as a preview shows them.
    fn short(bytes: &[u8]) -> String {
        digest(bytes).chars().take(19).collect()
    }

    #[test]
    fn take_bundled_replaces_exactly_the_chosen_files_and_backs_up_what_the_user_wrote() {
        let env = Env::new("take-happy", &SKILLS);
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);
        env.keep(SetupSurfaceId::Skills, "skill:claude:tdd")
            .expect("keep");
        // A conflict and a kept file of other skills: not chosen, so left alone.
        let diagnose = skill_file(SkillRoot::Claude, "diagnose", "SKILL.md");
        env.write(&diagnose, b"my own diagnose\n");
        let handoff = skill_file(SkillRoot::Claude, "handoff", "SKILL.md");
        env.write(&handoff, b"my own handoff\n");
        env.keep(SetupSurfaceId::Skills, "skill:claude:handoff")
            .expect("keep");
        // A safe update the regular update would apply, and take bundled must not.
        let outdated = skill_file(SkillRoot::Claude, "security-audit", "ATTACK-CLASSES.md");
        let older = b"attack classes of an older version\n";
        env.write(&outdated, older);
        env.set_record(&outdated, older);
        assert_eq!(env.kind(&SKILLS, &outdated), OperationKind::Update);

        let transactions = env.transactions();
        let preview = env
            .preview_take(SetupSurfaceId::Skills, &["skill:claude:tdd"])
            .expect("preview");
        assert_eq!(preview.surface, SetupSurfaceId::Skills);
        assert_eq!(preview.units.len(), 1);
        let unit = &preview.units[0];
        assert_eq!(
            (unit.key.as_str(), unit.name.as_str(), unit.folder.as_str()),
            ("skill:claude:tdd", "tdd", "~/.claude/skills")
        );
        assert_eq!(unit.more_files, 0);
        assert_eq!(unit.files.len(), 1);
        let file = &unit.files[0];
        let bundled_tdd = env.bundled_bytes(&tdd());
        assert_eq!(file.rel, "SKILL.md");
        assert_eq!(file.state, UnitState::Kept);
        assert_eq!(file.backup_name, "artifacts/skill-claude-tdd~SKILL.md");
        assert_eq!(file.installed_digest, short(mine));
        assert_eq!(file.bundled_digest, short(&bundled_tdd));
        assert_eq!(unit.diff.files.len(), 1);
        assert_eq!(unit.diff.files[0].kind, DiffKind::Text);
        assert!(!preview.plan_fingerprint.is_empty() && !preview.preview_token.is_empty());
        assert_eq!(
            fs::read(env.path(&tdd())).expect("file"),
            mine,
            "the preview writes nothing"
        );
        assert_eq!(env.transactions(), transactions);

        let result = env
            .apply_take(SetupSurfaceId::Skills, &["skill:claude:tdd"], &preview)
            .expect("apply");
        assert!(result.success, "apply: {}", result.message);
        assert_eq!(result.applied.len(), 1, "{:?}", result.applied);
        assert!(result.manual_steps.is_empty(), "{:?}", result.manual_steps);

        assert_eq!(fs::read(env.path(&tdd())).expect("file"), bundled_tdd);
        assert_eq!(
            fs::read(env.backed_up(&result.transaction_id, &file.backup_name)).expect("backup"),
            mine,
            "the backup holds the exact bytes the user had"
        );
        assert_eq!(
            env.record(&tdd()),
            Some(digest(&bundled_tdd)),
            "the app owns the file again"
        );
        assert_eq!(env.kind(&SKILLS, &tdd()), OperationKind::NoChange);

        // Exactly the chosen file was written.
        assert_eq!(
            fs::read(env.path(&diagnose)).expect("diagnose"),
            b"my own diagnose\n"
        );
        assert_eq!(env.kind(&SKILLS, &diagnose), OperationKind::Conflict);
        assert_eq!(
            fs::read(env.path(&handoff)).expect("handoff"),
            b"my own handoff\n"
        );
        assert_eq!(env.kind(&SKILLS, &handoff), OperationKind::Manual);
        assert_eq!(fs::read(env.path(&outdated)).expect("outdated"), older);
        assert_eq!(env.kind(&SKILLS, &outdated), OperationKind::Update);
        // The choice for the replaced file ended; the one for the other kept file did not.
        let kept = fs::read_to_string(env.kept_path()).expect("kept-files.json");
        assert!(!kept.contains("tdd"), "{kept}");
        assert!(kept.contains("handoff"), "{kept}");
    }

    #[test]
    fn take_bundled_replaces_every_conflicting_file_of_a_skill() {
        let env = Env::new("take-skill", &SKILLS);
        let unit = "skill:claude:security-audit";
        let hunting = skill_file(SkillRoot::Claude, "security-audit", "HUNTING.md");
        let client = skill_file(SkillRoot::Claude, "security-audit", "CLIENT-SIDE.md");
        let other = skill_file(SkillRoot::Claude, "security-audit", "UPSTREAM.md");
        env.write(&hunting, b"mine hunting\n");
        env.write(&client, b"mine client\n");
        // A file of the same skill that is not in conflict stays as it is.

        let preview = env
            .preview_take(SetupSurfaceId::Skills, &[unit])
            .expect("preview");
        let rels: BTreeSet<&str> = preview.units[0]
            .files
            .iter()
            .map(|file| file.rel.as_str())
            .collect();
        assert_eq!(rels, BTreeSet::from(["HUNTING.md", "CLIENT-SIDE.md"]));
        let result = env
            .apply_take(SetupSurfaceId::Skills, &[unit], &preview)
            .expect("apply");
        assert!(result.success, "apply: {}", result.message);
        assert_eq!(result.applied.len(), 2);
        for (rel, artifact, mine) in [
            ("HUNTING.md", &hunting, &b"mine hunting\n"[..]),
            ("CLIENT-SIDE.md", &client, &b"mine client\n"[..]),
        ] {
            assert_eq!(
                fs::read(env.path(artifact)).expect("replaced"),
                env.bundled_bytes(artifact)
            );
            let name = format!("artifacts/skill-claude-security-audit~{rel}");
            assert_eq!(
                fs::read(env.backed_up(&result.transaction_id, &name)).expect("backup"),
                mine
            );
        }
        assert_eq!(
            fs::read(env.path(&other)).expect("untouched"),
            env.bundled_bytes(&other)
        );
        assert!(env.pending(&SKILLS).is_empty(), "nothing is left to do");
    }

    #[test]
    fn take_bundled_replaces_the_agent_file_of_every_harness() {
        let surfaces = [
            SetupSurfaceId::ClaudeAgents,
            SetupSurfaceId::OpenCodeAgents,
            SetupSurfaceId::CursorAgents,
            SetupSurfaceId::CodexAgents,
        ];
        let env = Env::new("take-agents", &surfaces);
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
            assert_eq!(env.kind(&[surface], &agent), OperationKind::Conflict);

            let preview = env
                .preview_take(surface, &[unit.as_str()])
                .expect("preview");
            assert_eq!(preview.units[0].files.len(), 1, "{surface:?}");
            let backup = preview.units[0].files[0].backup_name.clone();
            let result = env
                .apply_take(surface, &[unit.as_str()], &preview)
                .expect("apply");
            assert!(result.success, "{surface:?}: {}", result.message);
            assert_eq!(
                fs::read(env.path(&agent)).expect("agent"),
                env.bundled_bytes(&agent),
                "{surface:?}"
            );
            assert_eq!(
                fs::read(env.backed_up(&result.transaction_id, &backup)).expect("backup"),
                mine.as_bytes(),
                "{surface:?}"
            );
            assert_eq!(env.kind(&[surface], &agent), OperationKind::NoChange);
        }
    }

    // ── 9. Take bundled refuses, and changes nothing ──

    impl Env {
        /// A refused take bundled left every named file as it was and made no backup.
        fn assert_untouched(
            &self,
            transactions: &BTreeSet<String>,
            files: &[(&ArtifactId, &[u8])],
        ) {
            assert_eq!(&self.transactions(), transactions, "a backup was made");
            for (artifact, bytes) in files {
                assert_eq!(
                    fs::read(self.path(artifact)).expect("file"),
                    *bytes,
                    "{artifact:?}"
                );
            }
        }
    }

    #[test]
    fn take_bundled_refuses_a_file_edited_after_the_preview() {
        let env = Env::new("take-edited", &SKILLS);
        env.write(&tdd(), b"my own tdd\n");
        let preview = env
            .preview_take(SetupSurfaceId::Skills, &["skill:claude:tdd"])
            .expect("preview");
        let edited = b"my own tdd, edited after the preview\n";
        env.write(&tdd(), edited);
        let transactions = env.transactions();

        let error = env
            .apply_take(SetupSurfaceId::Skills, &["skill:claude:tdd"], &preview)
            .unwrap_err();
        assert!(error.contains("mismatch"), "{error}");
        env.assert_untouched(&transactions, &[(&tdd(), &edited[..])]);
        // A fresh preview of the file as it is now applies.
        let fresh = env
            .preview_take(SetupSurfaceId::Skills, &["skill:claude:tdd"])
            .expect("fresh preview");
        assert_eq!(
            fresh.units[0].files[0].installed_digest,
            short(edited),
            "the new preview shows the new file"
        );
        let result = env
            .apply_take(SetupSurfaceId::Skills, &["skill:claude:tdd"], &fresh)
            .expect("apply");
        assert!(result.success, "{}", result.message);
    }

    #[test]
    fn take_bundled_refuses_missing_foreign_and_spent_proof() {
        let env = Env::new("take-proof", &SKILLS);
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);
        let diagnose = skill_file(SkillRoot::Claude, "diagnose", "SKILL.md");
        let mine_diagnose = b"my own diagnose\n";
        env.write(&diagnose, mine_diagnose);
        let tdd_unit = "skill:claude:tdd";
        let diagnose_unit = "skill:claude:diagnose";
        let surface = SetupSurfaceId::Skills;
        let preview = env.preview_take(surface, &[tdd_unit]).expect("preview");
        let other = env
            .preview_take(surface, &[diagnose_unit])
            .expect("preview of another skill");
        let fingerprint = Some(preview.plan_fingerprint.clone());
        let token = Some(preview.preview_token.clone());
        let transactions = env.transactions();
        let untouched = || {
            env.assert_untouched(
                &transactions,
                &[(&tdd(), &mine[..]), (&diagnose, &mine_diagnose[..])],
            )
        };

        // Proof that is missing, malformed or not from a preview.
        for (label, fp, tok) in [
            ("no fingerprint", None, token.clone()),
            ("no token", fingerprint.clone(), None),
            (
                "malformed fingerprint",
                Some("not hex!".to_string()),
                token.clone(),
            ),
            ("foreign fingerprint", Some("a".repeat(64)), token.clone()),
            ("foreign token", fingerprint.clone(), Some("f".repeat(64))),
        ] {
            let error = env
                .apply_take_with(surface, &[tdd_unit], fp, tok)
                .expect_err(label);
            assert!(!error.is_empty(), "{label}");
            untouched();
        }

        // A preview of another skill authorises nothing here.
        assert!(env
            .apply_take_with(
                surface,
                &[diagnose_unit],
                Some(other.plan_fingerprint.clone()),
                token.clone()
            )
            .is_err());
        assert!(env
            .apply_take_with(
                surface,
                &[tdd_unit],
                Some(other.plan_fingerprint.clone()),
                Some(other.preview_token.clone())
            )
            .is_err());
        assert!(env
            .apply_take_with(
                surface,
                &[tdd_unit, diagnose_unit],
                fingerprint.clone(),
                token.clone()
            )
            .is_err());
        untouched();

        // A token that outlived its time.
        crate::setup_transaction::expire_preview_tokens_for_test();
        let error = env
            .apply_take_with(surface, &[tdd_unit], fingerprint.clone(), token.clone())
            .unwrap_err();
        assert!(error.contains("expired"), "{error}");
        untouched();

        // A token that was used: the second apply of the same preview is refused.
        let again = env.preview_take(surface, &[tdd_unit]).expect("preview");
        let result = env.apply_take(surface, &[tdd_unit], &again).expect("apply");
        assert!(result.success, "{}", result.message);
        env.write(&tdd(), mine);
        let transactions_after = env.transactions();
        let error = env.apply_take(surface, &[tdd_unit], &again).unwrap_err();
        assert!(error.contains("already used"), "{error}");
        env.assert_untouched(&transactions_after, &[(&tdd(), &mine[..])]);
    }

    #[test]
    fn take_bundled_refuses_units_it_cannot_replace() {
        let env = Env::new("take-units", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);
        let transactions = env.transactions();

        // Unknown, clean, empty, too many, and the wrong surface. Errors never echo the key.
        for unit in [
            "skill:claude:no-such-skill",
            "skill:claude:diagnose",
            "../../etc/passwd",
        ] {
            let error = env.preview_take(surface, &[unit]).unwrap_err();
            assert!(error.contains("no conflicting or kept files"), "{error}");
            assert!(!error.contains("passwd"), "{error}");
        }
        assert!(env.preview_take(surface, &[]).is_err());
        let many: Vec<String> = (0..11).map(|n| format!("skill:claude:s{n}")).collect();
        assert!(preview_take_bundled("skills".into(), many).is_err());
        for wrong in [
            "claude_rules",
            "workspace_bundle",
            "codex_config",
            "claude_skills",
            "nope",
        ] {
            assert!(
                preview_take_bundled(wrong.into(), vec!["skill:claude:tdd".into()]).is_err(),
                "{wrong}"
            );
            assert!(
                apply_take_bundled(
                    wrong.into(),
                    vec!["skill:claude:tdd".into()],
                    Some("a".repeat(64)),
                    Some("t".into())
                )
                .is_err(),
                "{wrong}"
            );
        }
        assert!(env
            .preview_take(SetupSurfaceId::ClaudeAgents, &["skill:claude:tdd"])
            .is_err());
        env.assert_untouched(&transactions, &[(&tdd(), &mine[..])]);

        // A retired skill: the bundle has no copy to take.
        let retired = skill_file(SkillRoot::Claude, "retired-kept", "SKILL.md");
        env.write(&retired, b"retired skill\n");
        env.set_record(&retired, b"retired skill\n");
        let edited = b"my own copy of the retired skill\n";
        env.write(&retired, edited);
        assert!(env
            .planned(&SKILLS, &retired)
            .file
            .is_some_and(|file| !file.wanted));
        let error = env
            .preview_take(surface, &["skill:claude:retired-kept"])
            .unwrap_err();
        assert!(error.contains("no bundled copy"), "{error}");
        env.keep(surface, "skill:claude:retired-kept")
            .expect("keep");
        let error = env
            .preview_take(surface, &["skill:claude:retired-kept"])
            .unwrap_err();
        assert!(error.contains("no bundled copy"), "a kept one too: {error}");
        env.assert_untouched(&transactions, &[(&retired, &edited[..])]);
    }

    #[cfg(unix)]
    #[test]
    fn take_bundled_offers_nothing_for_a_link_or_a_folder_in_the_way() {
        let env = Env::new("take-blocked", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        let claude = env.root(SkillRoot::Claude);
        let elsewhere = env.base.join("elsewhere");
        fs::create_dir_all(&elsewhere).expect("target");
        fs::write(elsewhere.join("SKILL.md"), "mine\n").expect("target file");
        fs::remove_dir_all(claude.join("tdd")).expect("remove tdd");
        std::os::unix::fs::symlink(&elsewhere, claude.join("tdd")).expect("symlink");
        let hunting = skill_file(SkillRoot::Claude, "security-audit", "HUNTING.md");
        fs::remove_file(env.path(&hunting)).expect("remove file");
        fs::create_dir_all(env.path(&hunting)).expect("dir in the way");
        let transactions = env.transactions();

        for unit in ["skill:claude:tdd", "skill:claude:security-audit"] {
            let error = env.preview_take(surface, &[unit]).unwrap_err();
            assert!(error.contains("no conflicting or kept files"), "{error}");
        }
        assert_eq!(env.transactions(), transactions);
        assert_eq!(
            fs::read(elsewhere.join("SKILL.md")).expect("target"),
            b"mine\n",
            "nothing was written through the link"
        );
        assert!(env.path(&hunting).is_dir());
    }

    #[test]
    fn take_bundled_refuses_a_unit_that_is_no_longer_a_conflict() {
        let env = Env::new("take-resolved", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        env.write(&tdd(), b"my own tdd\n");
        let preview = env
            .preview_take(surface, &["skill:claude:tdd"])
            .expect("preview");
        // The user copies the bundled file in by hand: nothing is left to replace.
        let bundled_tdd = env.bundled_bytes(&tdd());
        env.write(&tdd(), &bundled_tdd);
        let transactions = env.transactions();

        let error = env
            .apply_take(surface, &["skill:claude:tdd"], &preview)
            .unwrap_err();
        assert!(error.contains("no conflicting or kept files"), "{error}");
        env.assert_untouched(&transactions, &[(&tdd(), &bundled_tdd[..])]);
        assert!(env.preview_take(surface, &["skill:claude:tdd"]).is_err());
    }

    #[test]
    fn take_bundled_refuses_a_file_too_large_to_back_up() {
        let env = Env::new("take-large", &SKILLS);
        // A sparse file just over the limit: nothing is read to find that out.
        let large = fs::File::create(env.path(&tdd())).expect("create");
        large.set_len(64 * 1024 * 1024 + 1).expect("set length");
        drop(large);
        let transactions = env.transactions();

        let error = env
            .preview_take(SetupSurfaceId::Skills, &["skill:claude:tdd"])
            .unwrap_err();
        assert!(error.contains("too large to back up"), "{error}");
        assert_eq!(env.transactions(), transactions);
        assert_eq!(
            fs::metadata(env.path(&tdd())).expect("file").len(),
            64 * 1024 * 1024 + 1
        );
        // The same file at the limit is replaced.
        let at_limit = fs::File::options()
            .write(true)
            .open(env.path(&tdd()))
            .expect("open");
        at_limit.set_len(64 * 1024 * 1024).expect("set length");
        drop(at_limit);
        assert!(env
            .preview_take(SetupSurfaceId::Skills, &["skill:claude:tdd"])
            .is_ok());
    }

    #[test]
    fn a_take_bundled_proof_cannot_drive_an_install_and_an_install_proof_cannot_drive_a_take_bundled(
    ) {
        let env = Env::new("take-cross", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);
        let outdated = skill_file(SkillRoot::Claude, "security-audit", "ATTACK-CLASSES.md");
        let older = b"attack classes of an older version\n";
        env.write(&outdated, older);
        env.set_record(&outdated, older);

        let install = env.preview(&SKILLS);
        let take = env
            .preview_take(surface, &["skill:claude:tdd"])
            .expect("preview");
        let transactions = env.transactions();

        let result = apply_setup(
            vec!["skills".to_string()],
            true,
            Some(take.plan_fingerprint.clone()),
            Some(take.preview_token.clone()),
        );
        assert!(
            !matches!(&result, Ok(done) if done.success),
            "a take bundled proof drove an install: {result:?}"
        );
        let error = env
            .apply_take_with(
                surface,
                &["skill:claude:tdd"],
                install.plan_fingerprint.clone(),
                install.preview_token.clone(),
            )
            .unwrap_err();
        assert!(error.contains("mismatch"), "{error}");
        env.assert_untouched(
            &transactions,
            &[(&tdd(), &mine[..]), (&outdated, &older[..])],
        );
    }

    #[cfg(unix)]
    #[test]
    fn take_bundled_refuses_a_link_swapped_in_after_the_preview() {
        let env = Env::new("take-swapped", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);
        let target = env.base.join("precious.md");
        fs::write(&target, "precious\n").expect("target");

        // The file becomes a link to a file outside the skill folders.
        let preview = env
            .preview_take(surface, &["skill:claude:tdd"])
            .expect("preview");
        fs::remove_file(env.path(&tdd())).expect("remove");
        std::os::unix::fs::symlink(&target, env.path(&tdd())).expect("symlink");
        let transactions = env.transactions();
        assert!(env
            .apply_take(surface, &["skill:claude:tdd"], &preview)
            .is_err());
        assert_eq!(fs::read(&target).expect("target"), b"precious\n");
        assert!(fs::symlink_metadata(env.path(&tdd()))
            .expect("link")
            .file_type()
            .is_symlink());
        assert_eq!(env.transactions(), transactions);

        // The folder of the skill becomes a link to a copy outside the skill folders.
        fs::remove_file(env.path(&tdd())).expect("remove link");
        env.write(&tdd(), mine);
        let preview = env
            .preview_take(surface, &["skill:claude:tdd"])
            .expect("preview");
        let skill_dir = env.root(SkillRoot::Claude).join("tdd");
        let outside = env.base.join("tdd-copy");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("SKILL.md"), mine).expect("copy");
        fs::remove_dir_all(&skill_dir).expect("remove skill dir");
        std::os::unix::fs::symlink(&outside, &skill_dir).expect("symlink dir");
        assert!(env
            .apply_take(surface, &["skill:claude:tdd"], &preview)
            .is_err());
        assert_eq!(fs::read(outside.join("SKILL.md")).expect("copy"), mine);
        assert_eq!(env.transactions(), transactions);
    }

    // ── 10. Rolling a take bundled back ──

    #[test]
    fn rolling_back_a_take_bundled_restores_the_users_file_and_the_previous_record() {
        let env = Env::new("take-rollback", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        let older = b"an older tdd the app wrote\n";
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);
        env.set_record(&tdd(), older);
        env.keep(surface, "skill:claude:tdd").expect("keep");
        assert_eq!(env.kind(&SKILLS, &tdd()), OperationKind::Manual);

        let preview = env
            .preview_take(surface, &["skill:claude:tdd"])
            .expect("preview");
        let result = env
            .apply_take(surface, &["skill:claude:tdd"], &preview)
            .expect("apply");
        assert!(result.success, "{}", result.message);
        assert_eq!(env.record(&tdd()), Some(digest(&env.bundled_bytes(&tdd()))));

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "{}", rolled.message);
        assert_eq!(fs::read(env.path(&tdd())).expect("file"), mine);
        assert_eq!(
            env.record(&tdd()),
            Some(digest(older)),
            "the previous managed state is back"
        );
        // The choice to keep it is not restored (documented): the file is a conflict again.
        assert_eq!(env.kind(&SKILLS, &tdd()), OperationKind::Conflict);
    }

    #[test]
    fn rolling_back_a_take_bundled_keeps_an_edit_made_after_it() {
        let env = Env::new("take-rollback-edited", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        env.write(&tdd(), b"my own tdd\n");
        let preview = env
            .preview_take(surface, &["skill:claude:tdd"])
            .expect("preview");
        let result = env
            .apply_take(surface, &["skill:claude:tdd"], &preview)
            .expect("apply");
        assert!(result.success, "{}", result.message);

        let later = b"my own tdd, written again after take bundled\n";
        env.write(&tdd(), later);
        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(!rolled.success, "{}", rolled.message);
        assert!(
            rolled.message.contains("changed since apply"),
            "{}",
            rolled.message
        );
        assert_eq!(
            fs::read(env.path(&tdd())).expect("file"),
            later,
            "the later edit is preserved"
        );
    }

    // ── 12. Keeping or handing back after a preview makes the apply stale ──

    #[test]
    fn keeping_or_handing_back_after_a_take_bundled_preview_makes_it_stale() {
        let env = Env::new("take-stale", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);

        // Previewed as a conflict; kept before the apply.
        let preview = env
            .preview_take(surface, &["skill:claude:tdd"])
            .expect("preview");
        env.keep(surface, "skill:claude:tdd").expect("keep");
        let transactions = env.transactions();
        let error = env
            .apply_take(surface, &["skill:claude:tdd"], &preview)
            .unwrap_err();
        assert!(error.contains("mismatch"), "{error}");
        env.assert_untouched(&transactions, &[(&tdd(), &mine[..])]);

        // Previewed as a kept file; handed back before the apply.
        let preview = env
            .preview_take(surface, &["skill:claude:tdd"])
            .expect("preview");
        assert_eq!(preview.units[0].files[0].state, UnitState::Kept);
        env.hand_back(surface, "skill:claude:tdd")
            .expect("hand back");
        let error = env
            .apply_take(surface, &["skill:claude:tdd"], &preview)
            .unwrap_err();
        assert!(error.contains("mismatch"), "{error}");
        env.assert_untouched(&transactions, &[(&tdd(), &mine[..])]);
    }

    #[test]
    fn handing_back_after_an_install_preview_makes_that_apply_stale() {
        let env = Env::new("setup-stale", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        let mine = b"my own tdd\n";
        env.write(&tdd(), mine);
        env.keep(surface, "skill:claude:tdd").expect("keep");
        // Something to apply, so the install preview is not empty.
        let outdated = skill_file(SkillRoot::Claude, "security-audit", "ATTACK-CLASSES.md");
        let older = b"attack classes of an older version\n";
        env.write(&outdated, older);
        env.set_record(&outdated, older);
        let plan = env.preview(&SKILLS);
        assert!(!plan.is_blocked);

        env.hand_back(surface, "skill:claude:tdd")
            .expect("hand back");
        let transactions = env.transactions();
        let result = apply_setup(
            vec!["skills".to_string()],
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        );
        let error = result.expect_err("the stale preview is refused");
        assert!(error.contains("mismatch"), "{error}");
        env.assert_untouched(
            &transactions,
            &[(&tdd(), &mine[..]), (&outdated, &older[..])],
        );
    }

    // ── A kept choice that has become inert ──

    #[test]
    fn a_kept_file_that_became_the_bundled_file_by_hand_loses_its_choice_at_the_next_apply() {
        let env = Env::new("inert", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        env.write(&tdd(), b"my own tdd\n");
        env.keep(surface, "skill:claude:tdd").expect("keep");

        // The user copies the bundled file in by hand: no app write ends the choice.
        let bundled_tdd = env.bundled_bytes(&tdd());
        env.write(&tdd(), &bundled_tdd);
        assert_eq!(env.kind(&SKILLS, &tdd()), OperationKind::NoChange);
        assert!(
            fs::read_to_string(env.kept_path())
                .expect("kept-files.json")
                .contains("tdd"),
            "the entry is inert but still there"
        );

        // Any apply that completes ends it, whichever files it writes.
        let missing = skill_file(SkillRoot::Claude, "diagnose", "SKILL.md");
        fs::remove_file(env.path(&missing)).expect("remove");
        let result = env.apply(&SKILLS);
        assert!(result.success, "apply: {}", result.message);
        assert!(result.manual_steps.is_empty(), "{:?}", result.manual_steps);
        let kept: serde_json::Value =
            serde_json::from_slice(&fs::read(env.kept_path()).expect("kept-files.json"))
                .expect("json");
        assert_eq!(kept["kept"], serde_json::json!([]));

        // A later edit is a new conflict, not silently a file the user keeps.
        env.write(&tdd(), b"edited again\n");
        let planned = env.planned(&SKILLS, &tdd());
        assert_eq!(planned.kind, OperationKind::Conflict);
        assert!(planned.file.is_some_and(|file| file.kept.is_none()));
    }

    #[test]
    fn an_apply_keeps_the_choice_of_a_file_that_still_differs_from_the_bundle() {
        let env = Env::new("inert-not", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        env.write(&tdd(), b"my own tdd\n");
        env.keep(surface, "skill:claude:tdd").expect("keep");
        let missing = skill_file(SkillRoot::Claude, "diagnose", "SKILL.md");
        fs::remove_file(env.path(&missing)).expect("remove");

        let result = env.apply(&SKILLS);
        assert!(result.success, "apply: {}", result.message);
        assert_eq!(env.kind(&SKILLS, &tdd()), OperationKind::Manual);
        assert!(fs::read_to_string(env.kept_path())
            .expect("kept-files.json")
            .contains("tdd"));
    }

    #[test]
    fn a_choice_for_another_folder_is_not_ended_by_a_file_that_matches_elsewhere() {
        let env = Env::new("inert-dest", &SKILLS);
        let surface = SetupSurfaceId::Skills;
        env.write(&tdd(), b"my own tdd\n");
        env.keep(surface, "skill:claude:tdd").expect("keep");
        // The entry was made for another destination (the folder moved): it is inert for this one
        // and must not be touched by the matching rule either way.
        let raw = fs::read_to_string(env.kept_path())
            .expect("kept-files.json")
            .replace(
                "~/.claude/skills/tdd/SKILL.md",
                "~/elsewhere/skills/tdd/SKILL.md",
            );
        fs::write(env.kept_path(), &raw).expect("rewrite");
        let bundled_tdd = env.bundled_bytes(&tdd());
        env.write(&tdd(), &bundled_tdd);
        let missing = skill_file(SkillRoot::Claude, "diagnose", "SKILL.md");
        fs::remove_file(env.path(&missing)).expect("remove");

        let result = env.apply(&SKILLS);
        assert!(result.success, "apply: {}", result.message);
        assert_eq!(
            fs::read_to_string(env.kept_path()).expect("kept-files.json"),
            raw,
            "an entry for another destination is left as it is"
        );
    }
}
