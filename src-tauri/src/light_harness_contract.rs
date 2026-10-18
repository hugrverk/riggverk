//! End-to-end contract for the managed rules block of the light harnesses (Copilot, Pi, Kilo).
//!
//! Drives the real preview, apply, rollback, status, conversion and health paths against a temp
//! HOME and workspace, once per harness; never touches the real profile or any real folder of a
//! harness. The block semantics themselves are pinned for Claude in `rules_block_contract`; this
//! file proves the descriptor-driven artifacts get the same ones, plus what is specific to the
//! tier: Pi's masking and peer files, Kilo's `XDG_CONFIG_HOME`, owner-only folders for Pi, the
//! health row and the review note.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use crate::agent_targets::HarnessId;
    use crate::artifact_registry::ArtifactId;
    use crate::commands::setup::{
        apply_setup, preview_setup, rollback_setup_transaction, SetupResult,
    };
    use crate::commands::{
        apply_rules_conversion, get_light_runtime_health, preview_rules_conversion,
        set_rules_user_managed,
    };
    use crate::installation_status::{status_for_surfaces, InstallationState};
    use crate::light_harness::{self, LightHarnessId, LightRules};
    use crate::managed_state::{
        artifact_identity, read_managed_state, write_managed_state_atomic, ManagedArtifactRecord,
        ManagedState, MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::rules_block::{
        body_digest, MalformedReason, RulesConflict, RulesPlan, BEGIN_MARKER, END_MARKER,
    };
    use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
    use crate::setup_transaction::{self, PreviousState, RollbackAction};
    use crate::test_env::{guard, set_test_user_dirs};

    const LIGHT: [HarnessId; 3] = [HarnessId::Copilot, HarnessId::Pi, HarnessId::Kilo];
    const OLD_BASE: &str = "# Old base\n\n## Priority\n- be careful\n";
    const PREFIX: &str = "# My notes\n\nAlways answer in Swedish.\n\n";
    const SUFFIX: &str = "\n## My refinements\n- prefer small diffs\n- no emoji\n";
    /// A file the user wrote by hand, with sections the base does not have.
    const USER_FILE: &str =
        "# My rules\n\nAlways answer in Swedish.\n\n## Style\n- prefer small diffs\n- no emoji\n\n## Tools\n- use rg for search\n";

    fn rules_of(harness: HarnessId) -> &'static LightRules {
        &light_harness::descriptor(harness)
            .expect("light harness")
            .rules
    }

    fn artifact_of(harness: HarnessId) -> ArtifactId {
        ArtifactId::HarnessRules(LightHarnessId::new(harness).expect("light"))
    }

    fn surface_of(harness: HarnessId) -> SetupSurfaceId {
        rules_of(harness).surface
    }

    fn wire(harness: HarnessId) -> String {
        format!("{}_rules", harness.as_str())
    }

    fn block(body: &str) -> String {
        format!("{BEGIN_MARKER}\n{body}{END_MARKER}\n")
    }

    fn crlf(text: &str) -> String {
        text.replace('\n', "\r\n")
    }

    fn enable_every_harness() {
        let settings = crate::settings::AppSettings {
            enabled_harness_ids: HarnessId::ALL.to_vec(),
            ..crate::settings::AppSettings::default()
        };
        crate::settings::save_with_revision_check(settings, None).expect("settings");
    }

    struct Env {
        harness: HarnessId,
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        _restore: guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(label: &str, harness: HarnessId) -> Self {
            let lock = guard::lock();
            let restore = guard::EnvRestore::capture();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base =
                std::env::temp_dir().join(format!("aw-light-{label}-{}-{nanos}", harness.as_str()));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(base.join("home")).expect("home");
            fs::create_dir_all(base.join("workspace")).expect("workspace");
            set_test_user_dirs(&base.join("home"));
            let ws = base.join("workspace").canonicalize().expect("workspace");
            std::env::set_var("AGENT_WORKSPACE_PATH", &ws);
            std::env::set_var("AGENT_WORKSPACE_BACKUP_DIR", base.join("backups"));
            std::env::remove_var("CODEX_HOME");
            let home = crate::platform_paths::resolve_user_home(
                &crate::platform_paths::PlatformEnv::from_process_env(),
                crate::platform_paths::Platform::current(),
            )
            .expect("resolved home");
            enable_every_harness();
            Self {
                harness,
                base,
                home,
                ws,
                _restore: restore,
                _lock: lock,
            }
        }

        fn rules(&self) -> &'static LightRules {
            rules_of(self.harness)
        }

        fn artifact(&self) -> ArtifactId {
            artifact_of(self.harness)
        }

        fn surface(&self) -> SetupSurfaceId {
            surface_of(self.harness)
        }

        fn wire(&self) -> String {
            wire(self.harness)
        }

        fn dest(&self) -> PathBuf {
            self.rules().resolve_dest(&self.home)
        }

        fn write(&self, content: &str) {
            let path = self.dest();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn read(&self) -> String {
            fs::read_to_string(self.dest()).unwrap()
        }

        fn exists(&self) -> bool {
            self.dest().exists()
        }

        /// A file next to the rules file.
        fn sibling(&self, name: &str) -> PathBuf {
            self.dest().parent().unwrap().join(name)
        }

        fn source(&self) -> String {
            let bundled = crate::setup_roots::bundled_root().expect("bundled root");
            fs::read_to_string(bundled.join(&self.rules().source_rel)).expect("bundled rules")
        }

        fn record(&self, hash: &str) {
            write_managed_state_atomic(
                &self.ws,
                &ManagedState {
                    schema_version: MANAGED_STATE_SCHEMA_VERSION,
                    bundled_version: crate::stable_digest::bytes(b"bundle"),
                    artifacts: vec![ManagedArtifactRecord {
                        identity: artifact_identity(&self.artifact()),
                        hash: hash.to_string(),
                        surface: None,
                    }],
                },
            )
            .expect("managed state");
        }

        fn recorded_hash(&self) -> Option<String> {
            let identity = artifact_identity(&self.artifact());
            read_managed_state(&self.ws)?
                .artifacts
                .into_iter()
                .find(|record| record.identity == identity)
                .map(|record| record.hash)
        }

        fn plan(&self) -> setup_transaction::PlannedArtifact {
            setup_transaction::plan_artifacts_for_surfaces(&[self.surface()], &self.ws, &self.home)
                .expect("plan")
                .into_iter()
                .next()
                .expect("planned artifact")
        }

        fn apply(&self) -> SetupResult {
            let plan = preview_setup(vec![self.wire()]).expect("preview");
            apply_setup(
                vec![self.wire()],
                false,
                plan.plan_fingerprint,
                plan.preview_token,
            )
            .expect("apply")
        }

        fn status(&self) -> crate::installation_status::InstallationStatus {
            status_for_surfaces(&[self.surface()], &self.ws, &self.home).expect("status")
        }

        fn backup_entries(&self) -> usize {
            fs::read_dir(self.base.join("backups/setup"))
                .map(|entries| entries.count())
                .unwrap_or(0)
        }

        /// The apply must be refused and leave no trace.
        fn assert_refused(&self, unchanged: Option<&str>) {
            assert!(setup_transaction::ensure_rules_apply_allowed(
                &self.artifact(),
                &self.ws,
                &self.home
            )
            .is_err());
            let plan = preview_setup(vec![self.wire()]).unwrap();
            assert!(!plan.has_pending_changes, "{}", self.harness.as_str());
            assert!(plan.plan_fingerprint.is_none());
            assert!(apply_setup(vec![self.wire()], false, None, None).is_err());
            match unchanged {
                Some(content) => assert_eq!(self.read(), content),
                None => assert!(!self.exists(), "nothing may be created"),
            }
            assert_eq!(self.backup_entries(), 0);
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn each(label: &str, body: impl Fn(&Env)) {
        for harness in LIGHT {
            let env = Env::new(label, harness);
            body(&env);
        }
    }

    // ── The descriptor, the surface and the artifact agree ──

    #[test]
    fn each_harness_has_one_target_one_surface_and_one_artifact() {
        for harness in LIGHT {
            let rules = rules_of(harness);
            assert_eq!(rules.target_id, wire(harness));
            assert_eq!(rules.surface.harness(), Some(harness));
            assert_eq!(
                serde_json::to_value(rules.surface).unwrap(),
                serde_json::json!(wire(harness))
            );
            assert_eq!(artifact_of(harness).surface(), rules.surface);
            assert_eq!(
                crate::agent_targets::target_surfaces(&rules.target_id),
                [rules.surface]
            );
            assert_eq!(
                crate::agent_targets::surface_target_id(rules.surface),
                Some(rules.target_id.as_str())
            );
            assert!(crate::setup_lifecycle::SetupSurfaceId::ALL.contains(&rules.surface));
            assert!(crate::agent_targets::default_enabled_ids().contains(&rules.target_id));
            assert!(
                !harness_is_on_by_default(harness),
                "the light tier is opt-in"
            );
        }
    }

    fn harness_is_on_by_default(harness: HarnessId) -> bool {
        crate::agent_targets::default_enabled_harness_ids().contains(&harness)
    }

    // ── Create and current ──

    #[test]
    fn a_missing_file_is_created_with_the_block_and_is_then_current() {
        each("create", |env| {
            let source = env.source();
            let planned = env.plan();
            assert_eq!(planned.kind, OperationKind::Create);
            assert_eq!(planned.previous_state, PreviousState::Absent);
            assert_eq!(planned.rollback_action, RollbackAction::RemoveCreatedFile);
            assert_eq!(planned.rules.unwrap().plan, RulesPlan::Create);

            let result = env.apply();
            assert!(result.success, "{}", result.message);
            assert_eq!(env.read(), crate::rules_block::render_new(&source));
            assert_eq!(env.recorded_hash(), Some(body_digest(&source)));
            assert_eq!(env.plan().kind, OperationKind::NoChange);
            assert_eq!(env.status().state, InstallationState::Current);

            let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
            assert!(rolled.success, "{}", rolled.message);
            assert!(
                !env.exists(),
                "a rollback removes the file the apply created"
            );
        });
    }

    #[test]
    fn a_block_carrying_the_current_base_needs_no_record_to_be_current() {
        each("current", |env| {
            env.write(&format!("{PREFIX}{}{SUFFIX}", block(&env.source())));
            assert_eq!(env.plan().kind, OperationKind::NoChange);
            let status = env.status();
            assert_eq!(status.state, InstallationState::Current);
            assert_eq!(
                status.surfaces[0].rules.as_ref().unwrap().refinement_lines,
                5
            );
        });
    }

    #[cfg(unix)]
    #[test]
    fn pi_creates_its_folders_owner_only_and_the_others_do_not() {
        use std::os::unix::fs::PermissionsExt;
        let mode =
            |path: &std::path::Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let env = Env::new("modes", HarnessId::Pi);
        assert!(env.apply().success);
        assert_eq!(mode(&env.home.join(".pi")), 0o700);
        assert_eq!(mode(&env.home.join(".pi/agent")), 0o700);
        drop(env);

        for harness in [HarnessId::Copilot, HarnessId::Kilo] {
            let env = Env::new("modes", harness);
            assert!(env.apply().success);
            let folder = env.dest().parent().unwrap().to_path_buf();
            assert_ne!(mode(&folder), 0o700, "{}", harness.as_str());
        }
    }

    // ── Updates keep the user's text ──

    #[test]
    fn a_base_update_keeps_prefix_and_suffix_byte_for_byte() {
        each("update", |env| {
            let source = env.source();
            env.write(&format!("{PREFIX}{}{SUFFIX}", block(OLD_BASE)));
            env.record(&body_digest(OLD_BASE));

            let planned = env.plan();
            assert_eq!(planned.kind, OperationKind::Update);
            assert_eq!(planned.previous_state, PreviousState::MergeableConfigFile);
            assert_eq!(planned.rules.unwrap().plan, RulesPlan::UpdateBlock);
            let status = env.status();
            assert_eq!(status.state, InstallationState::UpdateAvailable);
            assert_eq!(status.counts.conflict_count, 0);
            assert_eq!(
                status.surfaces[0].detail,
                "base update available; refinements: 5 lines preserved"
            );

            let result = env.apply();
            assert!(result.success, "{}", result.message);
            assert_eq!(env.read(), format!("{PREFIX}{}{SUFFIX}", block(&source)));
            assert_eq!(env.recorded_hash(), Some(body_digest(&source)));
            assert_eq!(env.plan().kind, OperationKind::NoChange);

            // A rollback restores the block and keeps what was added after the apply.
            env.write(&format!("{}- a later refinement\n", env.read()));
            let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
            assert!(rolled.success, "{}", rolled.message);
            assert_eq!(
                env.read(),
                format!("{PREFIX}{}{SUFFIX}- a later refinement\n", block(OLD_BASE))
            );
        });
    }

    /// A rules file in one of the shapes an editor leaves behind, around a block of `body`.
    fn shaped(shape: &str, body: &str) -> String {
        match shape {
            "lf" => format!("{PREFIX}{}{SUFFIX}", block(body)),
            "bom+crlf" => format!(
                "\u{feff}{}{}{}",
                crlf(PREFIX),
                crlf(&block(body)),
                crlf(SUFFIX)
            ),
            _ => format!("{BEGIN_MARKER}\n{body}{END_MARKER}"),
        }
    }

    #[test]
    fn bom_crlf_and_a_missing_trailing_newline_survive_an_update() {
        each("shapes", |env| {
            let source = env.source();
            for shape in ["lf", "bom+crlf", "no newline after END"] {
                env.write(&shaped(shape, OLD_BASE));
                env.record(&body_digest(OLD_BASE));
                assert_eq!(env.plan().kind, OperationKind::Update, "{shape}");
                let result = env.apply();
                assert!(result.success, "{shape}: {}", result.message);
                assert_eq!(env.read(), shaped(shape, &source), "{shape}");
                assert_eq!(env.plan().kind, OperationKind::NoChange, "{shape}");
            }
        });
    }

    // ── Conflicts ──

    #[test]
    fn an_edited_base_block_is_a_conflict_and_nothing_changes() {
        each("edited", |env| {
            let edited = format!(
                "{PREFIX}{}{SUFFIX}",
                block("# Old base\n- my edit inside\n")
            );
            env.write(&edited);
            env.record(&body_digest(OLD_BASE));

            let planned = env.plan();
            assert_eq!(planned.kind, OperationKind::Conflict);
            assert_eq!(
                planned.rules.unwrap().plan,
                RulesPlan::Conflict(RulesConflict::BaseBlockEdited)
            );
            let status = env.status();
            assert_eq!(status.state, InstallationState::Conflict);
            assert_eq!(
                status.surfaces[0].rules.as_ref().unwrap().conflict_reason,
                Some(RulesConflict::BaseBlockEdited)
            );
            env.assert_refused(Some(&edited));
        });
    }

    #[test]
    fn a_file_without_markers_is_a_legacy_conflict_and_conversion_keeps_the_user_sections() {
        each("legacy", |env| {
            let source = env.source();
            env.write(USER_FILE);

            let planned = env.plan();
            assert_eq!(planned.kind, OperationKind::Conflict);
            assert_eq!(
                planned.rules.unwrap().plan,
                RulesPlan::Conflict(RulesConflict::LegacyDiverged)
            );
            let status = env.status();
            assert_eq!(status.state, InstallationState::Conflict);
            assert_eq!(
                status.surfaces[0].rules.as_ref().unwrap().conflict_reason,
                Some(RulesConflict::LegacyDiverged)
            );
            env.assert_refused(Some(USER_FILE));

            let preview = preview_rules_conversion(env.wire()).unwrap();
            assert!(preview.applicable, "{:?}", preview.reason);
            assert!(preview.result.starts_with(BEGIN_MARKER));
            let parsed = crate::rules_block::parse(&preview.result).unwrap().unwrap();
            assert_eq!(parsed.body_digest(), body_digest(&source));
            for kept in [
                "Always answer in Swedish.",
                "## Style",
                "- no emoji",
                "## Tools",
            ] {
                assert!(parsed.suffix.contains(kept), "{kept}: {}", parsed.suffix);
                assert!(!parsed.body.contains(kept), "{kept} is not in the base");
            }
            assert_eq!(env.read(), USER_FILE, "a preview never writes");

            let result = apply_rules_conversion(
                env.wire(),
                preview.plan_fingerprint.clone(),
                preview.preview_token.clone(),
            )
            .unwrap();
            assert!(result.success, "{}", result.message);
            assert_eq!(env.read(), preview.result, "exactly the previewed file");
            assert_eq!(env.plan().kind, OperationKind::NoChange);
            assert_eq!(env.recorded_hash(), Some(body_digest(&source)));
            assert_eq!(env.backup_entries(), 1);

            let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
            assert!(rolled.success, "{}", rolled.message);
            assert_eq!(env.read(), USER_FILE, "a rollback restores the user's file");
        });
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
        for harness in LIGHT {
            for (index, (content, reason)) in cases.iter().enumerate() {
                let env = Env::new(&format!("malformed-{index}"), harness);
                env.write(content);
                // Even a record that matches the whole file must not unlock a write.
                env.record(&crate::stable_digest::bytes(content.as_bytes()));

                let planned = env.plan();
                assert_eq!(planned.kind, OperationKind::Conflict, "{reason:?}");
                let assessment = planned.rules.unwrap();
                assert_eq!(
                    assessment.plan,
                    RulesPlan::Conflict(RulesConflict::MalformedMarkers)
                );
                assert_eq!(assessment.malformed, Some(*reason));
                env.assert_refused(Some(content));
                let conversion = preview_rules_conversion(env.wire()).unwrap();
                assert!(!conversion.applicable && conversion.reason.unwrap().contains("malformed"));
                assert_eq!(env.read(), *content);
            }
        }
    }

    #[test]
    fn leaving_a_conflict_as_is_plans_manual_and_can_be_undone() {
        each("manual", |env| {
            env.write(USER_FILE);
            assert_eq!(env.plan().kind, OperationKind::Conflict);

            set_rules_user_managed(env.wire(), true).unwrap();
            assert_eq!(env.plan().kind, OperationKind::Manual);
            let status = env.status();
            assert_ne!(status.state, InstallationState::Conflict);
            let rules = status.surfaces[0].rules.as_ref().unwrap();
            assert!(rules.user_managed);
            assert_eq!(rules.conflict_reason, Some(RulesConflict::LegacyDiverged));
            let plan = preview_setup(vec![env.wire()]).unwrap();
            assert!(!plan.is_blocked && !plan.has_pending_changes);
            assert_eq!(plan.manual_steps.len(), 1);
            assert_eq!(env.read(), USER_FILE);

            set_rules_user_managed(env.wire(), false).unwrap();
            assert_eq!(env.plan().kind, OperationKind::Conflict);
        });
    }

    #[test]
    fn a_symlinked_rules_file_is_never_written_through() {
        #[cfg(unix)]
        each("symlink", |env| {
            let elsewhere = env.base.join("elsewhere.md");
            fs::write(&elsewhere, "not yours").unwrap();
            fs::create_dir_all(env.dest().parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&elsewhere, env.dest()).unwrap();
            assert_eq!(env.plan().kind, OperationKind::Conflict);
            assert!(apply_setup(vec![env.wire()], false, None, None).is_err());
            assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "not yours");
        });
    }

    // ── Pi: a file next to the rules file decides what Pi reads ──

    #[test]
    fn pi_with_an_override_file_is_masked_and_nothing_is_written() {
        let env = Env::new("masked", HarnessId::Pi);
        let override_file = env.sibling("AGENTS.override.md");

        // No AGENTS.md yet.
        fs::create_dir_all(override_file.parent().unwrap()).unwrap();
        fs::write(&override_file, "my override").unwrap();
        let planned = env.plan();
        assert_eq!(planned.kind, OperationKind::Conflict);
        assert_eq!(
            planned.rules.unwrap().plan,
            RulesPlan::Conflict(RulesConflict::MaskedByOverride)
        );
        env.assert_refused(None);
        assert_eq!(fs::read_to_string(&override_file).unwrap(), "my override");

        // A current block does not help: Pi never reads it.
        let current = crate::rules_block::render_new(&env.source());
        env.write(&current);
        let planned = env.plan();
        assert_eq!(planned.kind, OperationKind::Conflict);
        let status = env.status();
        assert_eq!(status.state, InstallationState::Conflict);
        assert_eq!(
            status.surfaces[0].rules.as_ref().unwrap().conflict_reason,
            Some(RulesConflict::MaskedByOverride)
        );
        assert!(
            status.surfaces[0].detail.contains("masks"),
            "{}",
            status.surfaces[0].detail
        );
        env.assert_refused(Some(&current));

        // The conversion is not offered: it cannot make Pi read the file.
        let conversion = preview_rules_conversion(env.wire()).unwrap();
        assert!(!conversion.applicable);
        assert!(conversion.reason.unwrap().contains("masks"));
        assert!(conversion.preview_token.is_none());

        // Removing the override clears it.
        fs::remove_file(&override_file).unwrap();
        assert_eq!(env.plan().kind, OperationKind::NoChange);
    }

    #[test]
    fn a_conversion_is_refused_when_an_override_appears_after_its_preview() {
        let env = Env::new("convert-masked", HarnessId::Pi);
        env.write(USER_FILE);
        let preview = preview_rules_conversion(env.wire()).unwrap();
        assert!(preview.applicable, "{:?}", preview.reason);

        fs::write(env.sibling("AGENTS.override.md"), "x").unwrap();
        let error = apply_rules_conversion(
            env.wire(),
            preview.plan_fingerprint.clone(),
            preview.preview_token.clone(),
        )
        .map(|result| result.message)
        .unwrap_or_else(|error| error);
        assert!(
            error.contains("masks") || error.contains("mismatch") || error.contains("refusing"),
            "{error}"
        );
        assert_eq!(env.read(), USER_FILE, "nothing was written");
        assert_eq!(env.backup_entries(), 0);

        fs::remove_file(env.sibling("AGENTS.override.md")).unwrap();
        let fresh = preview_rules_conversion(env.wire()).unwrap();
        let result =
            apply_rules_conversion(env.wire(), fresh.plan_fingerprint, fresh.preview_token)
                .unwrap();
        assert!(result.success, "{}", result.message);
    }

    #[test]
    fn pi_with_a_claude_md_and_no_agents_md_is_not_given_a_file_that_would_hide_it() {
        let env = Env::new("peer", HarnessId::Pi);
        let peer = env.sibling("CLAUDE.md");
        fs::create_dir_all(peer.parent().unwrap()).unwrap();
        fs::write(&peer, "my pi context").unwrap();

        let planned = env.plan();
        assert_eq!(planned.kind, OperationKind::Conflict);
        assert_eq!(
            planned.rules.unwrap().plan,
            RulesPlan::Conflict(RulesConflict::PeerContextFile)
        );
        assert_eq!(
            env.status().surfaces[0]
                .rules
                .as_ref()
                .unwrap()
                .conflict_reason,
            Some(RulesConflict::PeerContextFile)
        );
        env.assert_refused(None);
        assert_eq!(fs::read_to_string(&peer).unwrap(), "my pi context");
        assert!(!preview_rules_conversion(env.wire()).unwrap().applicable);

        // With an AGENTS.md of the user's, Pi already reads that one: the usual rules apply.
        env.write(USER_FILE);
        assert_eq!(
            env.plan().rules.unwrap().plan,
            RulesPlan::Conflict(RulesConflict::LegacyDiverged)
        );
        env.write(&crate::rules_block::render_new(&env.source()));
        assert_eq!(env.plan().kind, OperationKind::NoChange);
        assert_eq!(fs::read_to_string(&peer).unwrap(), "my pi context");
    }

    #[test]
    fn copilot_and_kilo_have_no_masking_or_peer_files() {
        for harness in [HarnessId::Copilot, HarnessId::Kilo] {
            let env = Env::new("not-pi", harness);
            for name in ["AGENTS.override.md", "CLAUDE.md", "AGENTS.md"] {
                let path = env.sibling(name);
                if path == env.dest() {
                    continue;
                }
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, "other").unwrap();
            }
            assert_eq!(
                env.plan().kind,
                OperationKind::Create,
                "{}",
                harness.as_str()
            );
            assert!(env.apply().success);
        }
    }

    // ── Kilo: the config folder follows XDG_CONFIG_HOME ──

    #[test]
    fn the_kilo_rules_file_follows_xdg_config_home_outside_and_inside_home() {
        let env = Env::new("xdg", HarnessId::Kilo);
        let source = env.source();
        let default = env.home.join(".config/kilo/AGENTS.md");
        let moved = env.base.join("xdg-config");
        fs::create_dir_all(&moved).unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &moved);
        enable_every_harness();

        assert_eq!(env.dest(), moved.join("kilo/AGENTS.md"));
        assert_eq!(env.plan().kind, OperationKind::Create);
        let result = env.apply();
        assert!(result.success, "{}", result.message);
        assert_eq!(
            fs::read_to_string(moved.join("kilo/AGENTS.md")).unwrap(),
            crate::rules_block::render_new(&source)
        );
        assert!(!default.exists(), "the default location is not touched");
        assert!(!env.home.join(".config/kilo").exists());
        assert_eq!(env.plan().kind, OperationKind::NoChange);
        assert_eq!(env.status().state, InstallationState::Current);

        let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
        assert!(rolled.success, "{}", rolled.message);
        assert!(!moved.join("kilo/AGENTS.md").exists());

        // Inside the home folder the home stays the allowlisted root.
        let inside = env.home.join("dotfiles");
        std::env::set_var("XDG_CONFIG_HOME", &inside);
        enable_every_harness();
        assert!(env.apply().success);
        assert!(inside.join("kilo/AGENTS.md").is_file());

        // Without the variable, or with a blank one, it is ~/.config again.
        std::env::set_var("XDG_CONFIG_HOME", "  ");
        enable_every_harness();
        assert_eq!(env.dest(), default);
        assert!(env.apply().success);
        assert!(default.is_file());
    }

    #[test]
    fn a_relative_xdg_config_home_is_ignored_and_only_kilo_follows_the_variable() {
        // Per the XDG Base Directory specification a relative value is invalid: the default
        // location is used, and no other plan or uninstall is blocked by it.
        let env = Env::new("xdg-relative", HarnessId::Kilo);
        std::env::set_var("XDG_CONFIG_HOME", "relative/config");
        enable_every_harness();
        assert_eq!(env.dest(), env.home.join(".config/kilo/AGENTS.md"));
        assert_eq!(env.plan().kind, OperationKind::Create);
        assert!(setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home).is_ok());
        assert!(env.apply().success);
        assert!(!std::path::Path::new("relative").exists());
        drop(env);

        for harness in [HarnessId::Copilot, HarnessId::Pi] {
            let env = Env::new("xdg-other", harness);
            std::env::set_var("XDG_CONFIG_HOME", env.base.join("xdg-config"));
            enable_every_harness();
            assert!(env.dest().starts_with(&env.home), "{}", harness.as_str());
            assert!(env.apply().success);
        }
    }

    // ── Gating ──

    #[test]
    fn a_disabled_harness_or_a_switched_off_target_is_never_planned_or_written() {
        for harness in LIGHT {
            let env = Env::new("gating", harness);
            // The harness off: the request is refused.
            let mut settings = crate::settings::load();
            settings.enabled_harness_ids.retain(|id| *id != harness);
            crate::settings::save_with_revision_check(settings, None).unwrap();
            let error = preview_setup(vec![env.wire()]).unwrap_err();
            assert!(error.contains("Harness disabled"), "{error}");
            assert!(apply_setup(vec![env.wire()], false, None, None).is_err());
            assert!(!env.exists());

            // The harness on, the target off: nothing is planned.
            enable_every_harness();
            let mut settings = crate::settings::load();
            settings
                .enabled_target_ids
                .retain(|id| *id != env.rules().target_id);
            crate::settings::save_with_revision_check(settings, None).unwrap();
            let plan = preview_setup(vec![env.wire()]).unwrap();
            assert!(plan.operations.is_empty() && !plan.has_pending_changes);
            assert!(!env.exists());
        }
    }

    // ── Review note ──

    #[test]
    fn the_review_of_a_new_kilo_file_says_it_stops_kilo_reading_claude_md() {
        for harness in LIGHT {
            let env = Env::new("review", harness);
            let plan = preview_setup(vec![env.wire()]).unwrap();
            let details = &plan.operations[0].details;
            if harness == HarnessId::Kilo {
                assert_eq!(
                    details,
                    &["+ ~/.config/kilo/AGENTS.md (Kilo stops reading ~/.claude/CLAUDE.md while this file exists)"],
                );
                // The note is for the file that is created: an update of an existing file has none.
                env.write(&block(OLD_BASE));
                env.record(&body_digest(OLD_BASE));
                assert!(preview_setup(vec![env.wire()]).unwrap().operations[0]
                    .details
                    .is_empty());
            } else {
                assert!(details.is_empty(), "{}: {details:?}", harness.as_str());
            }
        }
    }

    // ── Uninstall ──

    #[test]
    fn uninstall_removes_a_block_only_file_and_keeps_user_content() {
        each("uninstall", |env| {
            let source = env.source();
            env.write(&format!("\n{}\n", block(&source)));
            env.record(&body_digest(&source));
            let plan = setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home).unwrap();
            assert!(plan.removals.iter().any(|op| op.artifact == env.artifact()));
            assert!(!plan.merged.contains(&env.artifact()));

            let with_user = format!("{PREFIX}{}{SUFFIX}", block(&source));
            env.write(&with_user);
            let plan = setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home).unwrap();
            assert!(plan.merged.contains(&env.artifact()));
            assert!(plan.removals.iter().all(|op| op.artifact != env.artifact()));
            assert_eq!(env.read(), with_user);

            let edited = block(&format!("{source}- sneaky edit\n"));
            env.write(&edited);
            let plan = setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home).unwrap();
            assert!(plan.preserved.contains(&env.artifact()));
        });
    }

    // ── Several surfaces in one transaction ──

    #[test]
    fn the_three_rules_files_are_one_transaction_with_distinct_backups() {
        let env = Env::new("together", HarnessId::Copilot);
        let wires: Vec<String> = LIGHT.iter().map(|harness| wire(*harness)).collect();
        let plan = preview_setup(wires.clone()).unwrap();
        assert_eq!(plan.operations.len(), 3);
        let result = apply_setup(wires, false, plan.plan_fingerprint, plan.preview_token).unwrap();
        assert!(result.success, "{}", result.message);
        for harness in LIGHT {
            let path = rules_of(harness).resolve_dest(&env.home);
            assert!(path.is_file(), "{}", harness.as_str());
        }
        let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
        assert!(rolled.success, "{}", rolled.message);
        for harness in LIGHT {
            let path = rules_of(harness).resolve_dest(&env.home);
            assert!(!path.exists(), "{}", harness.as_str());
        }
    }

    #[test]
    fn labels_and_backup_names_are_distinct_per_harness() {
        let mut backups = std::collections::HashSet::new();
        for harness in LIGHT {
            let artifact = artifact_of(harness);
            assert!(backups.insert(setup_transaction::artifact_backup_rel(&artifact)));
            assert_eq!(
                setup_transaction::artifact_backup_rel(&artifact),
                format!("{}-rules", harness.as_str())
            );
            assert_eq!(
                crate::installation_status::artifact_label(&artifact),
                format!("{} rules", light_harness::display_name(harness))
            );
        }
    }

    // ── Health ──

    fn health(env: &Env) -> crate::commands::light_runtime::LightRuntimeHealth {
        // No real CLI is looked up or run.
        let empty = env.base.join("empty-path");
        fs::create_dir_all(&empty).unwrap();
        std::env::set_var("PATH", &empty);
        get_light_runtime_health(env.harness).expect("health")
    }

    #[test]
    fn the_health_rules_row_follows_the_file() {
        each("health", |env| {
            let path = env.rules().display_path(&env.home);
            let missing = health(env);
            assert_eq!(missing.rules.status, "missing");
            assert_eq!(missing.rules.path, path);
            assert!(
                missing.next_action.contains("Install"),
                "{}",
                missing.next_action
            );

            assert!(env.apply().success);
            let synced = health(env);
            assert_eq!(synced.rules.status, "synced");
            assert_eq!(synced.rules.detail, "installed and current");

            env.write(&format!("{PREFIX}{}{SUFFIX}", block(OLD_BASE)));
            env.record(&body_digest(OLD_BASE));
            let stale = health(env);
            assert_eq!(stale.rules.status, "stale");
            assert_eq!(stale.rules.refinement_lines, 5);
            assert_eq!(stale.status, health_status_after_skills(&stale));

            env.write(USER_FILE);
            let diverged = health(env);
            assert_eq!(diverged.rules.status, "diverged");
            assert_eq!(
                diverged.rules.conflict_reason,
                Some(RulesConflict::LegacyDiverged)
            );
            assert!(diverged.next_action.contains("conflict") || diverged.status != "synced");

            // The health never carries file text.
            let secret = "sk-live-not-a-real-secret";
            env.write(&format!("{USER_FILE}\n- {secret}\n"));
            let json = serde_json::to_string(&health(env)).unwrap();
            assert!(
                !json.contains(secret) && !json.contains("Swedish"),
                "{json}"
            );
        });
    }

    /// The overall status is the skills' while they are not synced; the rules row alone decides
    /// it otherwise.
    fn health_status_after_skills(
        health: &crate::commands::light_runtime::LightRuntimeHealth,
    ) -> String {
        if health.skills.status == "synced" {
            health.rules.status.clone()
        } else {
            health.skills.status.clone()
        }
    }

    #[test]
    fn the_health_rules_row_is_off_when_the_target_is_switched_off() {
        each("health-off", |env| {
            let mut settings = crate::settings::load();
            settings
                .enabled_target_ids
                .retain(|id| *id != env.rules().target_id);
            crate::settings::save_with_revision_check(settings, None).unwrap();
            env.write(USER_FILE);
            let off = health(env);
            assert_eq!(off.rules.status, "off");
            assert_ne!(
                off.status, "off",
                "the overall status ignores a switched-off target"
            );
            assert!(off
                .warnings
                .iter()
                .all(|w| !w.contains("global rules file")));
        });
    }

    #[test]
    fn the_health_warns_about_the_masking_file_the_peer_and_kilos_shadowing() {
        let pi = Env::new("health-pi", HarnessId::Pi);
        pi.write(&crate::rules_block::render_new(&pi.source()));
        fs::write(pi.sibling("AGENTS.override.md"), "x").unwrap();
        let masked = health(&pi);
        assert_eq!(masked.rules.status, "diverged");
        let warning = masked
            .warnings
            .iter()
            .find(|w| w.contains("AGENTS.override.md"))
            .expect("warning");
        assert!(
            warning.contains("~/.pi/agent") && warning.contains("AGENTS.md"),
            "{warning}"
        );
        fs::remove_file(pi.sibling("AGENTS.override.md")).unwrap();
        fs::remove_file(pi.dest()).unwrap();
        fs::write(pi.sibling("CLAUDE.md"), "mine").unwrap();
        let peer = health(&pi);
        assert_eq!(peer.rules.status, "diverged");
        assert!(
            peer.warnings
                .iter()
                .any(|w| w.contains("CLAUDE.md") && w.contains("one context file per folder")),
            "{:?}",
            peer.warnings
        );
        drop(pi);

        let kilo = Env::new("health-kilo", HarnessId::Kilo);
        let note = health(&kilo)
            .warnings
            .into_iter()
            .find(|w| w.contains("~/.claude/CLAUDE.md"))
            .expect("shadowing warning");
        assert!(
            note.contains("~/.config/kilo/AGENTS.md") && note.contains("Kilo"),
            "{note}"
        );
        drop(kilo);

        // The VS Code note appears with Claude's rules managed, and only then.
        let copilot = Env::new("health-copilot", HarnessId::Copilot);
        let vscode = |w: &String| w.contains("VS Code");
        assert!(health(&copilot).warnings.iter().any(vscode));
        let mut settings = crate::settings::load();
        settings
            .enabled_target_ids
            .retain(|id| id != "claude_rules");
        crate::settings::save_with_revision_check(settings, None).unwrap();
        assert!(!health(&copilot).warnings.iter().any(vscode));
        enable_every_harness();
        let mut settings = crate::settings::load();
        settings
            .enabled_harness_ids
            .retain(|id| *id != HarnessId::Claude);
        crate::settings::save_with_revision_check(settings, None).unwrap();
        assert!(!health(&copilot).warnings.iter().any(vscode));
    }
}
