//! Contract tests for app-owned shipped file versions.
//!
//! A skill or agent file whose bytes are exactly a version the app shipped is
//! app-owned even when managed-state.json has no matching record. Uses temp HOME
//! and AGENT_WORKSPACE_PATH only, with injected shipped-digest metadata, so no
//! test depends on git history except the one that replays a real old version.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::MutexGuard;

    use crate::artifact_registry::{AgentName, ArtifactId, SkillName, WorkspaceRelPath};
    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, rollback_setup_transaction,
        SetupResult,
    };
    use crate::managed_bootstrap::REMOVED_SKILL_NAMES;
    use crate::managed_state::{
        artifact_identity, read_managed_state, write_managed_state_atomic, ManagedArtifactRecord,
    };
    use crate::setup_lifecycle::{OperationKind, SetupPlan, SetupSurfaceId};
    use crate::setup_transaction::{plan_artifacts_for_surfaces, PreviousState, RollbackAction};
    use crate::shipped_digests::test_override;
    use crate::skill_roots::SkillRoot;
    use crate::stable_digest;
    use crate::test_env::{guard, guard::EnvRestore, set_test_user_dirs};

    /// The canonical SKILL.md every harness installs; also the generic shipped-digest key.
    const SKILL_SOURCE: &str = "skills/tdd/SKILL.md";
    const AGENT_SOURCE: &str = "templates/claude/agents/verifier.md";
    /// Source keys of the per-harness adapters the app shipped before the canonical file.
    const LEGACY_CLAUDE_SKILL_SOURCE: &str = "templates/skills/claude/tdd/SKILL.md";
    const LEGACY_CODEX_SKILL_SOURCE: &str = "templates/skills/codex/tdd/SKILL.md";
    /// The last commit that shipped one SKILL.md adapter per harness.
    const LAST_PER_HARNESS_ADAPTERS_COMMIT: &str = "fa9e0b48";

    fn surface_name(surface: SetupSurfaceId) -> String {
        serde_json::to_value(surface)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("{surface:?}"))
    }

    fn skill(name: &str) -> SkillName {
        SkillName::new(name).expect("skill name")
    }

    fn bundled() -> PathBuf {
        crate::setup_roots::bundled_root().expect("bundled root")
    }

    /// Metadata that lists `bytes` as a shipped version of each source key.
    fn shipped_json(entries: &[(&str, &[u8])]) -> String {
        let mut sources = serde_json::Map::new();
        for (key, bytes) in entries {
            sources.insert(
                (*key).to_string(),
                serde_json::json!([stable_digest::bytes(bytes)]),
            );
        }
        serde_json::json!({"schema": 1, "sources": sources}).to_string()
    }

    /// Surfaces most tests install. Every apply persists a fsynced manifest per
    /// artifact, so each test installs only the surfaces it needs.
    const FILE_SURFACES: &[SetupSurfaceId] =
        &[SetupSurfaceId::ClaudeSkills, SetupSurfaceId::ClaudeAgents];

    /// An installed profile in a temp HOME and workspace.
    struct Installed {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        // Drop order matters: restore the environment before releasing the lock.
        _restore: EnvRestore,
        _guard: MutexGuard<'static, ()>,
    }

    impl Installed {
        fn new(label: &str, surfaces: &[SetupSurfaceId]) -> Self {
            let guard = guard::lock();
            let restore = EnvRestore::capture();
            // A real profile path override must never leak into these tests.
            for key in [
                "CODEX_HOME",
                "CODEX_SKILLS_PATH",
                "CURSOR_SKILLS_PATH",
                "OPENCODE_SKILLS_PATH",
                "CLAUDE_SKILLS_PATH",
            ] {
                unsafe { std::env::remove_var(key) };
            }
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-shipped-{label}-{n}"));
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
            let installed = Self {
                base,
                home,
                ws,
                _restore: restore,
                _guard: guard,
            };
            let plan = installed.preview(surfaces);
            let result = apply_from(&plan);
            assert!(result.success, "install: {}", result.message);
            installed
        }

        fn path(&self, artifact: &ArtifactId) -> PathBuf {
            artifact.resolve_dest(&self.home, &self.ws).expect("dest")
        }

        fn write(&self, artifact: &ArtifactId, bytes: &[u8]) {
            fs::write(self.path(artifact), bytes).expect("write installed file");
        }

        fn read(&self, artifact: &ArtifactId) -> Vec<u8> {
            fs::read(self.path(artifact)).expect("read installed file")
        }

        fn record(&self, artifact: &ArtifactId) -> Option<String> {
            let identity = artifact_identity(artifact);
            read_managed_state(&self.ws)?
                .artifacts
                .into_iter()
                .find(|record| record.identity == identity)
                .map(|record| record.hash)
        }

        fn set_record(&self, artifact: &ArtifactId, hash: Option<&[u8]>) {
            let mut state = read_managed_state(&self.ws).expect("managed state");
            let identity = artifact_identity(artifact);
            state.artifacts.retain(|record| record.identity != identity);
            if let Some(hash) = hash {
                state.artifacts.push(ManagedArtifactRecord {
                    identity,
                    hash: stable_digest::bytes(hash),
                    surface: serde_json::to_value(artifact.surface())
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_string)),
                });
            }
            state.artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
            write_managed_state_atomic(&self.ws, &state).expect("write managed state");
        }

        fn planned(&self, surface: SetupSurfaceId, artifact: &ArtifactId) -> OperationKind {
            plan_artifacts_for_surfaces(&[surface], &self.ws, &self.home)
                .expect("plan")
                .into_iter()
                .find(|planned| &planned.artifact == artifact)
                .unwrap_or_else(|| panic!("artifact not planned: {artifact:?}"))
                .kind
        }

        fn preview(&self, surfaces: &[SetupSurfaceId]) -> SetupPlan {
            preview_setup(surfaces.iter().copied().map(surface_name).collect()).expect("preview")
        }
    }

    impl Drop for Installed {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn apply_from(plan: &SetupPlan) -> SetupResult {
        let mut surfaces: Vec<String> = plan
            .operations
            .iter()
            .filter(|op| op.kind.needs_apply())
            .map(|op| surface_name(op.surface))
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

    /// A bundled file as it was committed at `commit`.
    fn git_show(commit: &str, rel: &str) -> Vec<u8> {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let output = Command::new("git")
            .args([
                "show",
                &format!("{commit}:resources/default-workspace/{rel}"),
            ])
            .current_dir(&repo)
            .output()
            .expect("run git show");
        assert!(
            output.status.success(),
            "old shipped file missing: {rel}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    #[test]
    fn shipped_versions_update_despite_a_stale_record_and_roll_back() {
        let env = Installed::new(
            "update",
            &[
                SetupSurfaceId::ClaudeSkills,
                SetupSurfaceId::CodexSkills,
                SetupSurfaceId::ClaudeAgents,
            ],
        );
        let claude_skill = ArtifactId::skill_md(SkillRoot::Claude, skill("tdd"));
        let codex_skill = ArtifactId::skill_md(SkillRoot::CodexHome, skill("tdd"));
        let agent = ArtifactId::ClaudeAgent(AgentName::new("verifier").expect("agent"));
        let old_skill = b"an older claude tdd skill\n";
        let old_codex = b"an older codex tdd skill\n";
        let old_agent = b"an older verifier agent\n";
        let stale = b"the hash an unrecorded sync left behind";
        for (artifact, bytes) in [
            (&claude_skill, &old_skill[..]),
            (&codex_skill, &old_codex[..]),
            (&agent, &old_agent[..]),
        ] {
            env.write(artifact, bytes);
            env.set_record(artifact, Some(stale));
        }
        let surfaces = [
            SetupSurfaceId::ClaudeSkills,
            SetupSurfaceId::CodexSkills,
            SetupSurfaceId::ClaudeAgents,
        ];

        // Nothing shipped proves these files, so today's conflict stands.
        let _none = test_override::inject("{ not json");
        assert_eq!(
            env.planned(SetupSurfaceId::ClaudeSkills, &claude_skill),
            OperationKind::Conflict
        );
        drop(_none);

        let _inject = test_override::inject(&shipped_json(&[
            (LEGACY_CLAUDE_SKILL_SOURCE, old_skill),
            (LEGACY_CODEX_SKILL_SOURCE, old_codex),
            (AGENT_SOURCE, old_agent),
        ]));
        let planned =
            plan_artifacts_for_surfaces(&surfaces, &env.ws, &env.home).expect("plan shipped");
        for artifact in [&claude_skill, &codex_skill, &agent] {
            let found = planned
                .iter()
                .find(|planned| &planned.artifact == artifact)
                .expect("planned");
            assert_eq!(found.kind, OperationKind::Update, "{artifact:?}");
            assert_eq!(found.previous_state, PreviousState::ManagedFile);
            assert_eq!(found.rollback_action, RollbackAction::RestoreFile);
        }

        let plan = env.preview(&surfaces);
        assert!(
            plan.has_pending_changes && plan.conflicts.is_empty(),
            "{plan:?}"
        );
        let applied = apply_from(&plan);
        assert!(applied.success, "apply: {}", applied.message);
        for (artifact, source) in [
            (&claude_skill, SKILL_SOURCE),
            (&codex_skill, SKILL_SOURCE),
            (&agent, AGENT_SOURCE),
        ] {
            let current = fs::read(bundled().join(source)).expect("current source");
            assert_eq!(env.read(artifact), current, "{artifact:?} is the source");
            assert_eq!(
                env.record(artifact),
                Some(stable_digest::bytes(&current)),
                "{artifact:?} records the new hash"
            );
        }

        let rolled = rollback_setup_transaction(applied.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert_eq!(env.read(&claude_skill), old_skill);
        assert_eq!(env.read(&codex_skill), old_codex);
        assert_eq!(env.read(&agent), old_agent);
        assert_eq!(env.record(&claude_skill), Some(stable_digest::bytes(stale)));
    }

    #[test]
    fn edited_content_stays_a_conflict_and_is_never_overwritten() {
        let env = Installed::new("edited", FILE_SURFACES);
        let artifact = ArtifactId::skill_md(SkillRoot::Claude, skill("tdd"));
        let shipped = b"an older claude tdd skill\n";
        let edited = b"the user edited an older claude tdd skill\n";
        env.write(&artifact, edited);
        env.set_record(&artifact, Some(b"a stale recorded hash"));
        let _inject = test_override::inject(&shipped_json(&[(SKILL_SOURCE, shipped)]));

        assert_eq!(
            env.planned(SetupSurfaceId::ClaudeSkills, &artifact),
            OperationKind::Conflict
        );
        let plan = env.preview(&[SetupSurfaceId::ClaudeSkills]);
        assert!(
            !plan.has_pending_changes && !plan.conflicts.is_empty(),
            "{plan:?}"
        );
        assert!(apply_setup(
            vec![surface_name(SetupSurfaceId::ClaudeSkills)],
            true,
            None,
            None
        )
        .is_err());
        assert_eq!(env.read(&artifact), edited);
    }

    #[test]
    fn a_shipped_version_without_a_record_updates() {
        let env = Installed::new("no-record", FILE_SURFACES);
        let artifact = ArtifactId::skill_md(SkillRoot::Claude, skill("tdd"));
        let shipped = b"an older claude tdd skill\n";
        env.write(&artifact, shipped);
        env.set_record(&artifact, None);

        // The real metadata lists no such version: unproven updates stay conflicts.
        assert_eq!(
            env.planned(SetupSurfaceId::ClaudeSkills, &artifact),
            OperationKind::Conflict
        );
        let _inject = test_override::inject(&shipped_json(&[(SKILL_SOURCE, shipped)]));
        assert_eq!(
            env.planned(SetupSurfaceId::ClaudeSkills, &artifact),
            OperationKind::Update
        );
        let applied = apply_from(&env.preview(&[SetupSurfaceId::ClaudeSkills]));
        assert!(applied.success, "apply: {}", applied.message);
        let current = fs::read(bundled().join(SKILL_SOURCE)).expect("source");
        assert_eq!(env.read(&artifact), current);
        assert_eq!(env.record(&artifact), Some(stable_digest::bytes(&current)));
    }

    #[test]
    fn a_stale_retired_skill_is_removed_only_when_it_is_a_shipped_version() {
        let env = Installed::new("retired", FILE_SURFACES);
        // Two skills the app no longer ships.
        let retired_name = REMOVED_SKILL_NAMES[0];
        let retired = ArtifactId::skill_md(SkillRoot::Claude, skill(retired_name));
        let edited = ArtifactId::skill_md(SkillRoot::Claude, skill(REMOVED_SKILL_NAMES[1]));
        let shipped = b"the last shipped version of a retired skill\n";
        let user_text = b"the user rewrote a retired skill\n";
        for (artifact, bytes) in [(&retired, &shipped[..]), (&edited, &user_text[..])] {
            fs::create_dir_all(env.path(artifact).parent().expect("parent")).expect("dir");
            env.write(artifact, bytes);
            let mut state = read_managed_state(&env.ws).expect("state");
            state.artifacts.push(ManagedArtifactRecord {
                identity: artifact_identity(artifact),
                hash: stable_digest::bytes(b"a stale recorded hash"),
                surface: Some("claude_skills".into()),
            });
            write_managed_state_atomic(&env.ws, &state).expect("write state");
        }
        let key = format!("skills/{retired_name}/SKILL.md");
        let _inject = test_override::inject(&shipped_json(&[(key.as_str(), shipped)]));

        assert_eq!(
            env.planned(SetupSurfaceId::ClaudeSkills, &retired),
            OperationKind::Remove
        );
        assert_eq!(
            env.planned(SetupSurfaceId::ClaudeSkills, &edited),
            OperationKind::Conflict
        );
        let applied = apply_from(&env.preview(&[SetupSurfaceId::ClaudeSkills]));
        assert!(applied.success, "apply: {}", applied.message);
        assert!(
            !env.path(&retired).exists(),
            "shipped retired skill is removed"
        );
        assert_eq!(env.read(&edited), user_text, "edited retired skill is kept");
        assert_eq!(env.record(&retired), None);

        let rolled = rollback_setup_transaction(applied.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert_eq!(env.read(&retired), shipped);
        assert_eq!(env.read(&edited), user_text);
    }

    #[test]
    fn uninstall_removes_a_shipped_version_and_preserves_an_edit() {
        let env = Installed::new("uninstall", FILE_SURFACES);
        let shipped_artifact = ArtifactId::skill_md(SkillRoot::Claude, skill("tdd"));
        let edited_artifact = ArtifactId::skill_md(SkillRoot::Claude, skill("diagnose"));
        let shipped = b"an older claude tdd skill\n";
        env.write(&shipped_artifact, shipped);
        env.set_record(&shipped_artifact, Some(b"a stale recorded hash"));
        env.write(&edited_artifact, b"the user edited diagnose\n");
        let _inject = test_override::inject(&shipped_json(&[(SKILL_SOURCE, shipped)]));

        let plan = preview_uninstall().expect("uninstall preview");
        let listed = |items: &[crate::commands::setup::UninstallItem], artifact: &ArtifactId| {
            let path = env.path(artifact).display().to_string();
            items.iter().any(|item| item.path == path)
        };
        assert!(
            listed(&plan.removable, &shipped_artifact),
            "{:?}",
            plan.summary
        );
        assert!(listed(&plan.preserved, &edited_artifact));
        assert!(!listed(&plan.removable, &edited_artifact));

        let result = apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(result.success, "uninstall: {}", result.message);
        assert!(!env.path(&shipped_artifact).exists());
        assert_eq!(env.read(&edited_artifact), b"the user edited diagnose\n");
    }

    #[test]
    fn rules_configs_and_workspace_files_are_never_proven_by_shipped_digests() {
        let env = Installed::new(
            "scope",
            &[
                SetupSurfaceId::WorkspaceBundle,
                SetupSurfaceId::ClaudeAgents,
            ],
        );
        let workspace_doc = ArtifactId::WorkspaceFile(
            WorkspaceRelPath::new("docs/USING_THE_APP.md").expect("doc path"),
        );
        let edited_doc = b"an older shipped doc\n";
        let edited_rules = b"my own claude rules\n";
        let edited_codex = b"approval_policy = \"never\"\n";
        let edited_opencode = b"{}\n";
        env.write(&workspace_doc, edited_doc);
        for (artifact, bytes) in [
            (ArtifactId::ClaudeRules, &edited_rules[..]),
            (ArtifactId::CodexConfig, &edited_codex[..]),
            (ArtifactId::OpenCodeConfig, &edited_opencode[..]),
        ] {
            fs::create_dir_all(env.path(&artifact).parent().expect("parent")).expect("dir");
            env.write(&artifact, bytes);
        }
        for artifact in [
            &workspace_doc,
            &ArtifactId::ClaudeRules,
            &ArtifactId::CodexConfig,
            &ArtifactId::OpenCodeConfig,
        ] {
            env.set_record(artifact, Some(b"a stale recorded hash"));
        }
        let surfaces = [
            SetupSurfaceId::ClaudeRules,
            SetupSurfaceId::CodexConfig,
            SetupSurfaceId::OpenCodeConfig,
            SetupSurfaceId::WorkspaceBundle,
        ];
        let plan_of = || -> Vec<(ArtifactId, OperationKind, PreviousState)> {
            plan_artifacts_for_surfaces(&surfaces, &env.ws, &env.home)
                .expect("plan")
                .into_iter()
                .map(|planned| (planned.artifact, planned.kind, planned.previous_state))
                .collect()
        };

        let baseline = {
            let _none = test_override::inject("{ not json");
            plan_of()
        };
        let _inject = test_override::inject(&shipped_json(&[
            ("templates/sync/claude-rules.md", edited_rules),
            ("docs/USING_THE_APP.md", edited_doc),
            ("templates/codex/config.toml", edited_codex),
            ("templates/opencode.json", edited_opencode),
        ]));
        let with_digests = plan_of();

        assert_eq!(with_digests, baseline);
        for artifact in [
            &workspace_doc,
            &ArtifactId::CodexConfig,
            &ArtifactId::OpenCodeConfig,
        ] {
            assert!(
                with_digests
                    .iter()
                    .any(|(planned, kind, _)| planned == artifact
                        && *kind == OperationKind::Conflict),
                "{artifact:?} must stay a conflict: {with_digests:?}"
            );
        }
        assert_eq!(env.read(&ArtifactId::ClaudeRules), edited_rules);
    }

    #[test]
    fn unparsable_metadata_keeps_every_recorded_mismatch_a_conflict() {
        let env = Installed::new("malformed", FILE_SURFACES);
        let artifact = ArtifactId::skill_md(SkillRoot::Claude, skill("tdd"));
        env.write(&artifact, b"an older claude tdd skill\n");
        env.set_record(&artifact, Some(b"a stale recorded hash"));
        for raw in ["", "{ not json", r#"{"schema": 1, "sources": {}}"#] {
            let _inject = test_override::inject(raw);
            assert_eq!(
                env.planned(SetupSurfaceId::ClaudeSkills, &artifact),
                OperationKind::Conflict,
                "{raw:?}"
            );
        }
    }

    #[test]
    fn a_file_changed_after_preview_fails_the_apply_untouched() {
        let env = Installed::new("changed-after-preview", FILE_SURFACES);
        let artifact = ArtifactId::skill_md(SkillRoot::Claude, skill("tdd"));
        let shipped = b"an older claude tdd skill\n";
        env.write(&artifact, shipped);
        env.set_record(&artifact, Some(b"a stale recorded hash"));
        let _inject = test_override::inject(&shipped_json(&[(SKILL_SOURCE, shipped)]));

        let plan = env.preview(&[SetupSurfaceId::ClaudeSkills]);
        assert!(plan.has_pending_changes, "{plan:?}");
        let edited = b"edited between preview and apply\n";
        env.write(&artifact, edited);
        let error = apply_setup(
            vec![surface_name(SetupSurfaceId::ClaudeSkills)],
            true,
            plan.plan_fingerprint,
            plan.preview_token,
        )
        .expect_err("a changed file invalidates the preview");
        assert!(error.contains("fingerprint mismatch"), "{error}");
        assert_eq!(env.read(&artifact), edited);
    }

    /// The owner's case with the real embedded metadata: files the app shipped
    /// at commit 0e042154 that differ from today's source.
    #[test]
    fn versions_shipped_at_an_old_commit_update_with_the_real_metadata() {
        let env = Installed::new("real-history", FILE_SURFACES);
        let show = |rel: &str| git_show("0e042154", rel);
        let mut replayed = 0;
        for name in ["frontend-design", "diagnose", "tdd", "security-review"] {
            let old = show(&format!("templates/skills/claude/{name}/SKILL.md"));
            let current = fs::read(bundled().join(format!("skills/{name}/SKILL.md")))
                .expect("current source");
            if old == current {
                continue;
            }
            let artifact = ArtifactId::skill_md(SkillRoot::Claude, skill(name));
            env.write(&artifact, &old);
            env.set_record(&artifact, Some(b"a stale recorded hash"));
            assert_eq!(
                env.planned(SetupSurfaceId::ClaudeSkills, &artifact),
                OperationKind::Update,
                "{name}"
            );
            replayed += 1;
        }
        let verifier = ArtifactId::ClaudeAgent(AgentName::new("verifier").expect("agent"));
        let old = show(AGENT_SOURCE);
        if old != fs::read(bundled().join(AGENT_SOURCE)).expect("current agent") {
            env.write(&verifier, &old);
            env.set_record(&verifier, None);
            assert_eq!(
                env.planned(SetupSurfaceId::ClaudeAgents, &verifier),
                OperationKind::Update
            );
            replayed += 1;
        }
        assert!(
            replayed > 0,
            "no old version differs from the current source"
        );

        let applied =
            apply_from(&env.preview(&[SetupSurfaceId::ClaudeSkills, SetupSurfaceId::ClaudeAgents]));
        assert!(applied.success, "apply: {}", applied.message);
        let current = fs::read(bundled().join(AGENT_SOURCE)).expect("current agent");
        assert_eq!(env.read(&verifier), current);
    }

    /// The per-harness adapters the app shipped before every harness installed the canonical
    /// SKILL.md are still app-owned, with the real embedded metadata and no managed-state at all.
    /// A hand-edited copy of the same file stays a conflict.
    #[test]
    fn old_per_harness_variants_update_without_managed_state_and_an_edit_conflicts() {
        let env = Installed::new("old-variants", FILE_SURFACES);
        std::fs::remove_file(crate::managed_state::managed_state_path(&env.ws))
            .expect("remove managed state");
        assert!(read_managed_state(&env.ws).is_none());
        let name = skill("release-check");
        let current = fs::read(bundled().join("skills/release-check/SKILL.md")).expect("current");
        let cases = [
            (
                ArtifactId::skill_md(SkillRoot::Claude, name.clone()),
                SetupSurfaceId::ClaudeSkills,
                "claude",
            ),
            (
                ArtifactId::skill_md(SkillRoot::CodexHome, name.clone()),
                SetupSurfaceId::CodexSkills,
                "codex",
            ),
            (
                ArtifactId::skill_md(SkillRoot::OpenCode, name.clone()),
                SetupSurfaceId::OpenCodeSkills,
                "opencode",
            ),
            (
                ArtifactId::skill_md(SkillRoot::Cursor, name),
                SetupSurfaceId::CursorSkills,
                "cursor",
            ),
        ];
        for (artifact, surface, harness) in &cases {
            let old = git_show(
                LAST_PER_HARNESS_ADAPTERS_COMMIT,
                &format!("templates/skills/{harness}/release-check/SKILL.md"),
            );
            assert_ne!(
                old, current,
                "{harness}: the old adapter differs from the shared file"
            );
            let dest = env.path(artifact);
            fs::create_dir_all(dest.parent().expect("parent")).expect("skill dir");

            fs::write(&dest, &old).expect("install old variant");
            assert_eq!(
                env.planned(*surface, artifact),
                OperationKind::Update,
                "{harness}: an old per-harness variant is app-owned"
            );

            let mut edited = old.clone();
            edited.extend_from_slice(b"\nmy own note\n");
            fs::write(&dest, &edited).expect("install edited variant");
            assert_eq!(
                env.planned(*surface, artifact),
                OperationKind::Conflict,
                "{harness}: a hand-edited variant is not"
            );
        }

        // An old Claude variant is replaced by the shared file and recorded.
        let claude = &cases[0].0;
        let dest = env.path(claude);
        fs::write(
            &dest,
            git_show(
                LAST_PER_HARNESS_ADAPTERS_COMMIT,
                "templates/skills/claude/release-check/SKILL.md",
            ),
        )
        .expect("install old variant");
        let applied = apply_from(&env.preview(&[SetupSurfaceId::ClaudeSkills]));
        assert!(applied.success, "apply: {}", applied.message);
        assert_eq!(env.read(claude), current);
        assert_eq!(env.record(claude), Some(stable_digest::bytes(&current)));
    }

    /// One shared SKILL.md: every harness folder receives the canonical file byte for byte.
    #[test]
    fn every_harness_installs_identical_bytes_for_the_same_skill() {
        let env = Installed::new(
            "identical-bytes",
            &[
                SetupSurfaceId::ClaudeSkills,
                SetupSurfaceId::CodexSkills,
                SetupSurfaceId::OpenCodeSkills,
                SetupSurfaceId::CursorSkills,
            ],
        );
        let names =
            crate::artifact_registry::discover_skill_names_for_harness(&bundled(), "claude")
                .expect("bundled skills");
        assert!(!names.is_empty());
        for name in names {
            let canonical = fs::read(crate::skill_discovery::canonical_skill_md(
                &bundled(),
                name.as_str(),
            ))
            .expect("canonical skill");
            for artifact in [
                ArtifactId::skill_md(SkillRoot::Claude, name.clone()),
                ArtifactId::skill_md(SkillRoot::CodexHome, name.clone()),
                ArtifactId::skill_md(SkillRoot::OpenCode, name.clone()),
                ArtifactId::skill_md(SkillRoot::Cursor, name.clone()),
            ] {
                assert_eq!(env.read(&artifact), canonical, "{artifact:?}");
            }
        }
    }
}
