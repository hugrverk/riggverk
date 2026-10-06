//! End-to-end contract for rules files with a managed base block.
//!
//! Drives the real preview, apply, rollback, status, and uninstall paths
//! against a temp HOME and workspace; never touches the real profile.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::artifact_registry::ArtifactId;
    use crate::commands::setup::{
        apply_setup, preview_setup, rollback_setup_transaction, SetupResult,
    };
    use crate::installation_status::{status_for_surfaces, InstallationState};
    use crate::managed_state::{
        artifact_identity, read_managed_state, write_managed_state_atomic, ManagedArtifactRecord,
        ManagedState, MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::rules_block::{
        body_digest, MalformedReason, RulesConflict, RulesLayout, RulesPlan, BEGIN_MARKER,
        END_MARKER,
    };
    use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
    use crate::setup_transaction::{self, PreviousState, RollbackAction};
    use crate::test_env::{guard, set_test_user_dirs};

    const OLD_BASE: &str = "# Old base\n\n## Priority\n- be careful\n";

    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        _restore: guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(label: &str) -> Self {
            let lock = guard::lock();
            let restore = guard::EnvRestore::capture();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-rules-{label}-{nanos}"));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(base.join("home")).expect("home");
            fs::create_dir_all(base.join("workspace")).expect("workspace");
            set_test_user_dirs(&base.join("home"));
            let ws = base.join("workspace").canonicalize().expect("workspace");
            unsafe {
                std::env::set_var("AGENT_WORKSPACE_PATH", &ws);
                std::env::set_var("AGENT_WORKSPACE_BACKUP_DIR", base.join("backups"));
                std::env::remove_var("CODEX_HOME");
            }
            let home = crate::platform_paths::resolve_user_home(
                &crate::platform_paths::PlatformEnv::from_process_env(),
                crate::platform_paths::Platform::current(),
            )
            .expect("resolved home");
            Self {
                base,
                home,
                ws,
                _restore: restore,
                _lock: lock,
            }
        }

        fn claude_file(&self) -> PathBuf {
            self.home.join(".claude/CLAUDE.md")
        }

        fn write_claude(&self, content: &str) {
            let path = self.claude_file();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn read_claude(&self) -> String {
            fs::read_to_string(self.claude_file()).unwrap()
        }

        fn record(&self, artifact: &ArtifactId, hash: &str) {
            write_managed_state_atomic(
                &self.ws,
                &ManagedState {
                    schema_version: MANAGED_STATE_SCHEMA_VERSION,
                    bundled_version: crate::stable_digest::bytes(b"bundle"),
                    artifacts: vec![ManagedArtifactRecord {
                        identity: artifact_identity(artifact),
                        hash: hash.to_string(),
                        surface: None,
                    }],
                },
            )
            .expect("managed state");
        }

        fn recorded_hash(&self, artifact: &ArtifactId) -> Option<String> {
            let identity = artifact_identity(artifact);
            read_managed_state(&self.ws)?
                .artifacts
                .into_iter()
                .find(|record| record.identity == identity)
                .map(|record| record.hash)
        }

        fn plan(&self, surface: SetupSurfaceId) -> setup_transaction::PlannedArtifact {
            setup_transaction::plan_artifacts_for_surfaces(&[surface], &self.ws, &self.home)
                .expect("plan")
                .into_iter()
                .next()
                .expect("planned artifact")
        }

        fn apply(&self, surface: &str) -> SetupResult {
            let plan = preview_setup(vec![surface.to_string()]).expect("preview");
            apply_setup(
                vec![surface.to_string()],
                false,
                plan.plan_fingerprint,
                plan.preview_token,
            )
            .expect("apply")
        }

        fn backup_entries(&self) -> usize {
            fs::read_dir(self.base.join("backups/setup"))
                .map(|entries| entries.count())
                .unwrap_or(0)
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn source_of(file: &str) -> String {
        let bundled = crate::setup_roots::bundled_root().expect("bundled root");
        fs::read_to_string(bundled.join("templates/sync").join(file)).expect("bundled rules")
    }

    fn block(body: &str) -> String {
        format!("{BEGIN_MARKER}\n{body}{END_MARKER}\n")
    }

    fn crlf(text: &str) -> String {
        text.replace('\n', "\r\n")
    }

    const PREFIX: &str = "# My notes\n\nAlways answer in Swedish.\n\n";
    const SUFFIX: &str = "\n## My refinements\n- prefer small diffs\n- no emoji\n";

    #[test]
    fn fresh_install_writes_a_block_and_is_then_current() {
        let env = Env::new("fresh");
        let source = source_of("claude-rules.md");
        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Create);

        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert_eq!(env.read_claude(), crate::rules_block::render_new(&source));
        assert_eq!(
            env.recorded_hash(&ArtifactId::ClaudeRules),
            Some(body_digest(&source))
        );
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::NoChange
        );
    }

    #[test]
    fn base_update_keeps_prefix_and_suffix_byte_for_byte() {
        let env = Env::new("update-lf");
        let source = source_of("claude-rules.md");
        env.write_claude(&format!("{PREFIX}{}{SUFFIX}", block(OLD_BASE)));
        env.record(&ArtifactId::ClaudeRules, &body_digest(OLD_BASE));

        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Update);
        assert_eq!(planned.previous_state, PreviousState::MergeableConfigFile);
        assert_eq!(
            planned.rollback_action,
            RollbackAction::RestoreManagedConfigFile
        );
        assert_eq!(planned.rules.unwrap().plan, RulesPlan::UpdateBlock);

        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert_eq!(
            env.read_claude(),
            format!("{PREFIX}{}{SUFFIX}", block(&source))
        );
        assert_eq!(
            env.recorded_hash(&ArtifactId::ClaudeRules),
            Some(body_digest(&source))
        );
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::NoChange
        );
    }

    #[test]
    fn base_update_keeps_bom_and_crlf_exactly() {
        let env = Env::new("update-crlf");
        let source = source_of("claude-rules.md");
        let wrap = |body: &str| {
            format!(
                "\u{feff}{}{}{}",
                crlf(PREFIX),
                crlf(&block(body)),
                crlf(SUFFIX)
            )
        };
        env.write_claude(&wrap(OLD_BASE));
        env.record(&ArtifactId::ClaudeRules, &body_digest(OLD_BASE));

        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::Update
        );
        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert_eq!(env.read_claude(), wrap(&source));
    }

    #[test]
    fn base_update_without_trailing_newline_after_end_is_preserved() {
        let env = Env::new("update-eof");
        let source = source_of("claude-rules.md");
        env.write_claude(&format!("{BEGIN_MARKER}\n{OLD_BASE}{END_MARKER}"));
        env.record(&ArtifactId::ClaudeRules, &body_digest(OLD_BASE));

        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert_eq!(
            env.read_claude(),
            format!("{BEGIN_MARKER}\n{source}{END_MARKER}")
        );
    }

    #[test]
    fn status_reports_an_update_with_preserved_refinements_not_a_conflict() {
        let env = Env::new("status-update");
        env.write_claude(&format!("{PREFIX}{}{SUFFIX}", block(OLD_BASE)));
        env.record(&ArtifactId::ClaudeRules, &body_digest(OLD_BASE));

        let status =
            status_for_surfaces(&[SetupSurfaceId::ClaudeRules], &env.ws, &env.home).unwrap();
        assert_eq!(status.state, InstallationState::UpdateAvailable);
        assert_eq!(status.counts.conflict_count, 0);
        let surface = &status.surfaces[0];
        assert_eq!(surface.state, InstallationState::UpdateAvailable);
        // PREFIX has two non-blank lines, SUFFIX three.
        assert_eq!(
            surface.detail,
            "base update available; refinements: 5 lines preserved"
        );
        let rules = surface.rules.as_ref().expect("rules status");
        assert_eq!(rules.layout, RulesLayout::Block);
        assert_eq!(rules.refinement_lines, 5);
        assert_eq!(rules.conflict_reason, None);
    }

    #[test]
    fn edited_base_block_is_a_conflict_and_nothing_changes() {
        let env = Env::new("edited-block");
        let edited = format!(
            "{PREFIX}{}{SUFFIX}",
            block("# Old base\n- my edit inside\n")
        );
        env.write_claude(&edited);
        env.record(&ArtifactId::ClaudeRules, &body_digest(OLD_BASE));

        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Conflict);
        assert_eq!(
            planned.rules.unwrap().plan,
            RulesPlan::Conflict(RulesConflict::BaseBlockEdited)
        );
        let status =
            status_for_surfaces(&[SetupSurfaceId::ClaudeRules], &env.ws, &env.home).unwrap();
        assert_eq!(status.state, InstallationState::Conflict);
        let rules = status.surfaces[0].rules.as_ref().unwrap();
        assert_eq!(rules.conflict_reason, Some(RulesConflict::BaseBlockEdited));

        assert!(setup_transaction::ensure_rules_apply_allowed(
            &ArtifactId::ClaudeRules,
            &env.ws,
            &env.home
        )
        .is_err());
        let plan = preview_setup(vec!["claude_rules".into()]).unwrap();
        assert!(!plan.has_pending_changes);
        assert!(plan.plan_fingerprint.is_none());
        assert!(apply_setup(vec!["claude_rules".into()], false, None, None).is_err());
        assert_eq!(env.read_claude(), edited);
        assert_eq!(env.backup_entries(), 0);
    }

    #[test]
    fn block_matching_a_shipped_base_updates_without_a_record() {
        // Pre-manifest ownership lists every base the app shipped, so a block
        // carrying one is not an edit even when no record exists.
        let env = Env::new("shipped-block");
        let source = source_of("claude-rules.md");
        let shipped = historical_claude_base();
        assert_ne!(body_digest(&shipped), body_digest(&source));
        env.write_claude(&format!("{PREFIX}{}", block(&shipped)));

        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Update);
        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert_eq!(env.read_claude(), format!("{PREFIX}{}", block(&source)));
    }

    /// A claude base the app shipped before, read from the pre-manifest
    /// ownership commit.
    fn historical_claude_base() -> String {
        let output = std::process::Command::new("git")
            .args([
                "show",
                "2d85d94b6f2f1dc06f45f6ec52a22ae97e499588:resources/default-workspace/templates/sync/claude-rules.md",
            ])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
            .output()
            .expect("run git show");
        assert!(output.status.success(), "historical rules source missing");
        String::from_utf8(output.stdout).expect("utf-8 rules")
    }

    #[test]
    fn pristine_legacy_file_is_wrapped_and_rolls_back_whole() {
        let env = Env::new("wrap-legacy");
        let source = source_of("claude-rules.md");
        env.write_claude(OLD_BASE);
        env.record(
            &ArtifactId::ClaudeRules,
            &crate::stable_digest::bytes(OLD_BASE.as_bytes()),
        );

        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Update);
        assert_eq!(planned.previous_state, PreviousState::ManagedFile);
        assert_eq!(planned.rules.unwrap().plan, RulesPlan::WrapLegacy);

        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert_eq!(env.read_claude(), crate::rules_block::render_new(&source));

        let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
        assert!(rolled.success, "{}", rolled.message);
        assert_eq!(env.read_claude(), OLD_BASE);
    }

    #[test]
    fn legacy_file_matching_the_source_is_wrapped_without_a_record() {
        let env = Env::new("wrap-source");
        let source = source_of("claude-rules.md");
        env.write_claude(&source);

        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Update);
        assert_eq!(planned.rules.unwrap().plan, RulesPlan::WrapLegacy);
        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert_eq!(env.read_claude(), crate::rules_block::render_new(&source));
    }

    #[test]
    fn diverged_legacy_file_is_left_alone() {
        let env = Env::new("diverged-legacy");
        let edited = OLD_BASE.replace("be careful", "be very careful");
        env.write_claude(&edited);
        env.record(
            &ArtifactId::ClaudeRules,
            &crate::stable_digest::bytes(OLD_BASE.as_bytes()),
        );

        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Conflict);
        assert_eq!(
            planned.rules.unwrap().plan,
            RulesPlan::Conflict(RulesConflict::LegacyDiverged)
        );
        let status =
            status_for_surfaces(&[SetupSurfaceId::ClaudeRules], &env.ws, &env.home).unwrap();
        assert_eq!(status.state, InstallationState::Conflict);
        assert_eq!(
            status.surfaces[0].rules.as_ref().unwrap().conflict_reason,
            Some(RulesConflict::LegacyDiverged)
        );
        assert!(setup_transaction::ensure_rules_apply_allowed(
            &ArtifactId::ClaudeRules,
            &env.ws,
            &env.home
        )
        .is_err());
        assert!(apply_setup(vec!["claude_rules".into()], false, None, None).is_err());
        assert_eq!(env.read_claude(), edited);
        assert_eq!(env.backup_entries(), 0);
    }

    #[test]
    fn malformed_markers_are_refused_with_zero_mutation() {
        let cases = [
            (
                format!("{}{}", block("a\n"), block("b\n")),
                MalformedReason::DuplicateBegin,
            ),
            (
                format!("{BEGIN_MARKER}\nno end\n"),
                MalformedReason::MissingEnd,
            ),
            (
                format!("mine\n{END_MARKER}\n"),
                MalformedReason::MissingBegin,
            ),
            (
                format!("{END_MARKER}\nmid\n{BEGIN_MARKER}\n"),
                MalformedReason::EndBeforeBegin,
            ),
        ];
        for (index, (content, reason)) in cases.into_iter().enumerate() {
            let env = Env::new(&format!("malformed-{index}"));
            env.write_claude(&content);
            // Even a record that matches the whole file must not unlock a write.
            env.record(
                &ArtifactId::ClaudeRules,
                &crate::stable_digest::bytes(content.as_bytes()),
            );

            let planned = env.plan(SetupSurfaceId::ClaudeRules);
            assert_eq!(planned.kind, OperationKind::Conflict, "{reason:?}");
            let assessment = planned.rules.unwrap();
            assert_eq!(
                assessment.plan,
                RulesPlan::Conflict(RulesConflict::MalformedMarkers)
            );
            assert_eq!(assessment.malformed, Some(reason));
            assert!(setup_transaction::ensure_rules_apply_allowed(
                &ArtifactId::ClaudeRules,
                &env.ws,
                &env.home
            )
            .is_err());
            let plan = preview_setup(vec!["claude_rules".into()]).unwrap();
            assert!(!plan.has_pending_changes);
            assert!(apply_setup(vec!["claude_rules".into()], false, None, None).is_err());
            assert_eq!(env.read_claude(), content, "{reason:?}");
            assert_eq!(env.backup_entries(), 0, "{reason:?}");
        }
    }

    #[test]
    fn rollback_restores_the_old_base_and_keeps_text_added_after_apply() {
        let env = Env::new("rollback-keeps-suffix");
        env.write_claude(&format!("{PREFIX}{}{SUFFIX}", block(OLD_BASE)));
        env.record(&ArtifactId::ClaudeRules, &body_digest(OLD_BASE));
        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);

        // The user keeps refining after the update.
        let later = format!("{}- a later refinement\n", env.read_claude());
        env.write_claude(&later);

        let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
        assert!(rolled.success, "{}", rolled.message);
        assert_eq!(
            env.read_claude(),
            format!("{PREFIX}{}{SUFFIX}- a later refinement\n", block(OLD_BASE))
        );
    }

    #[test]
    fn rollback_refuses_when_the_block_changed_after_apply() {
        let env = Env::new("rollback-block-changed");
        env.write_claude(&format!("{PREFIX}{}{SUFFIX}", block(OLD_BASE)));
        env.record(&ArtifactId::ClaudeRules, &body_digest(OLD_BASE));
        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);

        let edited = env
            .read_claude()
            .replacen("## Priority", "## Priority (mine)", 1);
        env.write_claude(&edited);

        let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
        assert!(!rolled.success, "{}", rolled.message);
        assert_eq!(env.read_claude(), edited);
    }

    #[test]
    fn uninstall_keeps_files_that_hold_user_content() {
        let env = Env::new("uninstall-user-content");
        let source = source_of("claude-rules.md");
        let content = format!("{PREFIX}{}{SUFFIX}", block(&source));
        env.write_claude(&content);
        env.record(&ArtifactId::ClaudeRules, &body_digest(&source));

        let plan = setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home).unwrap();
        assert!(plan.merged.contains(&ArtifactId::ClaudeRules));
        assert!(plan
            .removals
            .iter()
            .all(|planned| planned.artifact != ArtifactId::ClaudeRules));
        assert!(!plan.preserved.contains(&ArtifactId::ClaudeRules));
        assert_eq!(env.read_claude(), content);
    }

    #[test]
    fn uninstall_removes_a_file_that_holds_only_the_base_block() {
        let env = Env::new("uninstall-only-block");
        let source = source_of("claude-rules.md");
        env.write_claude(&format!("\n{}\n", block(&source)));
        env.record(&ArtifactId::ClaudeRules, &body_digest(&source));

        let plan = setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home).unwrap();
        assert!(plan
            .removals
            .iter()
            .any(|planned| planned.artifact == ArtifactId::ClaudeRules));
        assert!(!plan.merged.contains(&ArtifactId::ClaudeRules));
    }

    #[test]
    fn uninstall_preserves_a_block_only_file_whose_base_was_edited() {
        let env = Env::new("uninstall-edited");
        let source = source_of("claude-rules.md");
        env.write_claude(&block(&format!("{source}- sneaky edit\n")));
        env.record(&ArtifactId::ClaudeRules, &body_digest(&source));

        let plan = setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home).unwrap();
        assert!(plan.preserved.contains(&ArtifactId::ClaudeRules));
        assert!(plan
            .removals
            .iter()
            .all(|planned| planned.artifact != ArtifactId::ClaudeRules));
    }

    #[test]
    fn codex_and_opencode_rules_get_the_same_block_semantics() {
        let env = Env::new("other-harnesses");
        let codex = source_of("codex-rules.md");
        let opencode = source_of("opencode-rules.md");
        let codex_file = env.home.join(".codex/AGENTS.md");
        let opencode_file = env.home.join(".config/opencode/AGENTS.md");
        for file in [&codex_file, &opencode_file] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
        }
        fs::write(&codex_file, format!("{PREFIX}{}", block(OLD_BASE))).unwrap();
        fs::write(&opencode_file, format!("{}{SUFFIX}", block(OLD_BASE))).unwrap();
        write_managed_state_atomic(
            &env.ws,
            &ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: vec![
                    ManagedArtifactRecord {
                        identity: artifact_identity(&ArtifactId::CodexRules),
                        hash: body_digest(OLD_BASE),
                        surface: None,
                    },
                    ManagedArtifactRecord {
                        identity: artifact_identity(&ArtifactId::OpenCodeRules),
                        hash: body_digest(OLD_BASE),
                        surface: None,
                    },
                ],
            },
        )
        .unwrap();

        for surface in ["codex_rules", "open_code_rules"] {
            let result = env.apply(surface);
            assert!(result.success, "{surface}: {}", result.message);
        }
        assert_eq!(
            fs::read_to_string(&codex_file).unwrap(),
            format!("{PREFIX}{}", block(&codex))
        );
        assert_eq!(
            fs::read_to_string(&opencode_file).unwrap(),
            format!("{}{SUFFIX}", block(&opencode))
        );
    }

    #[test]
    fn rules_under_a_custom_codex_home_use_the_same_block() {
        let env = Env::new("codex-home");
        let codex_home = env.home.join("custom-codex");
        fs::create_dir_all(&codex_home).unwrap();
        unsafe { std::env::set_var("CODEX_HOME", &codex_home) };
        let codex = source_of("codex-rules.md");
        fs::write(
            codex_home.join("AGENTS.md"),
            format!("{PREFIX}{}", block(OLD_BASE)),
        )
        .unwrap();
        env.record(&ArtifactId::CodexRules, &body_digest(OLD_BASE));

        let result = env.apply("codex_rules");
        assert!(result.success, "{}", result.message);
        assert_eq!(
            fs::read_to_string(codex_home.join("AGENTS.md")).unwrap(),
            format!("{PREFIX}{}", block(&codex))
        );
        assert!(!Path::new(&env.home.join(".codex/AGENTS.md")).exists());
    }
}
