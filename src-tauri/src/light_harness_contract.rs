//! End-to-end contract for the managed rules block and the managed Playwright MCP entry of the
//! light harnesses (Copilot, Pi, Kilo).
//!
//! Drives the real preview, apply, rollback, status, conversion and health paths against a temp
//! HOME and workspace, once per harness; never touches the real profile or any real folder of a
//! harness. The block semantics themselves are pinned for Claude in `rules_block_contract`; this
//! file proves the descriptor-driven artifacts get the same ones, plus what is specific to the
//! tier: Pi's masking and peer files, Kilo's `XDG_CONFIG_HOME`, owner-only folders for Pi, the
//! health row and the review note. The `mcp` module does the same for the MCP entry: a strict JSON
//! merge of one key that leaves the user's other servers and their order alone, and refuses, with
//! zero mutation and no file text in any message, what it cannot read as strict JSON.

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

    const LIGHT: [HarnessId; 4] = [
        HarnessId::Copilot,
        HarnessId::Pi,
        HarnessId::Kilo,
        HarnessId::Antigravity,
    ];
    const OLD_BASE: &str = "# Old base\n\n## Priority\n- be careful\n";
    const PREFIX: &str = "# My notes\n\nAlways answer in Swedish.\n\n";
    const SUFFIX: &str = "\n## My refinements\n- prefer small diffs\n- no emoji\n";
    /// A file the user wrote by hand, with sections the base does not have.
    const USER_FILE: &str =
        "# My rules\n\nAlways answer in Swedish.\n\n## Style\n- prefer small diffs\n- no emoji\n\n## Tools\n- use rg for search\n";

    fn rules_of(harness: HarnessId) -> &'static LightRules {
        light_harness::descriptor(harness)
            .expect("light harness")
            .rules
            .as_ref()
            .expect("a rules file of its own")
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
            std::env::set_var("RIGGVERK_WORKSPACE_PATH", &ws);
            std::env::set_var("RIGGVERK_BACKUP_DIR", base.join("backups"));
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
                        role_models: Default::default(),
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
                &self.home,
                &crate::skill_sources::SkillSources::for_workspace(&self.ws).unwrap()
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

        for harness in [HarnessId::Copilot, HarnessId::Kilo, HarnessId::Antigravity] {
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

    // ── Antigravity: ~/.gemini/AGENTS.md, at most 24,000 bytes ──

    /// Refinements that bring a file holding a block of `body` to at most `total` bytes (and
    /// less than one line short of it).
    fn padding_to(body: &str, total: usize) -> String {
        let used = crate::rules_block::render_new(body).len();
        let line = "- keep answers short and check the diff before you commit\n";
        let mut suffix = String::from("\n## Mine\n");
        while used + suffix.len() + line.len() <= total {
            suffix.push_str(line);
        }
        suffix
    }

    #[test]
    fn antigravity_writes_agents_md_and_never_touches_gemini_md() {
        let env = Env::new("antigravity-gemini", HarnessId::Antigravity);
        assert_eq!(env.dest(), env.home.join(".gemini/AGENTS.md"));
        let gemini = env.home.join(".gemini/GEMINI.md");
        fs::create_dir_all(gemini.parent().unwrap()).unwrap();
        fs::write(&gemini, "my gemini cli rules\n").unwrap();
        assert_eq!(env.plan().kind, OperationKind::Create);
        assert!(env.apply().success);
        assert_eq!(env.read(), crate::rules_block::render_new(&env.source()));
        assert_eq!(
            fs::read_to_string(&gemini).unwrap(),
            "my gemini cli rules\n"
        );
        assert_eq!(
            rules_of(HarnessId::Antigravity).max_file_bytes,
            Some(24_000)
        );
    }

    #[test]
    fn an_antigravity_update_that_would_pass_24000_bytes_is_a_conflict_with_zero_mutation() {
        let env = Env::new("antigravity-limit", HarnessId::Antigravity);
        let source = env.source();
        // The old block is shorter than the new one, so the same refinements fit today and
        // would not after the update.
        let suffix = padding_to(OLD_BASE, 24_000);
        let content = format!("{}{suffix}", block(OLD_BASE));
        assert!(content.len() <= 24_000);
        env.write(&content);
        env.record(&body_digest(OLD_BASE));
        let planned = env.plan();
        assert_eq!(planned.kind, OperationKind::Conflict);
        assert_eq!(
            planned.rules.unwrap().plan,
            RulesPlan::Conflict(RulesConflict::ExceedsHarnessLimit)
        );
        let status = env.status();
        assert_eq!(status.state, InstallationState::Conflict);
        assert_eq!(
            status.surfaces[0].rules.as_ref().unwrap().conflict_reason,
            Some(RulesConflict::ExceedsHarnessLimit)
        );
        assert!(
            status.surfaces[0].detail.contains("size limit"),
            "{}",
            status.surfaces[0].detail
        );
        env.assert_refused(Some(&content));

        // Shorter refinements fit again and the update goes through.
        let short = format!("{}{SUFFIX}", block(OLD_BASE));
        env.write(&short);
        assert_eq!(env.plan().kind, OperationKind::Update);
        assert!(env.apply().success);
        assert_eq!(
            env.read(),
            format!("{}{SUFFIX}", block(&source)),
            "the user's text is kept byte for byte"
        );
    }

    #[test]
    fn the_same_file_is_written_for_a_harness_without_a_limit() {
        let env = Env::new("no-limit", HarnessId::Pi);
        let content = format!("{}{}", block(OLD_BASE), padding_to(OLD_BASE, 30_000));
        env.write(&content);
        env.record(&body_digest(OLD_BASE));
        assert_eq!(env.plan().kind, OperationKind::Update);
    }

    #[test]
    fn antigravity_refinements_and_conversions_past_the_limit_are_refused() {
        let env = Env::new("antigravity-refinements", HarnessId::Antigravity);
        let source = env.source();
        assert!(env.apply().success);
        let read = crate::commands::read_rules_file(env.wire()).expect("read");
        let revision = read.revision.expect("revision");
        let too_long = padding_to(&source, 24_100);
        let before = env.read();
        let error = crate::commands::save_rules_refinements(env.wire(), too_long, revision.clone())
            .unwrap_err();
        assert!(error.contains("size limit"), "{error}");
        assert_eq!(env.read(), before, "nothing written");
        let fits =
            crate::commands::save_rules_refinements(env.wire(), SUFFIX.to_string(), revision)
                .expect("save");
        assert!(fits.success);

        // A hand-written file that the conversion would grow past the limit.
        let mut legacy = String::from("# My rules\n\n");
        while legacy.len() < 23_000 {
            legacy.push_str("- answer in Swedish and keep the diff small\n");
        }
        env.write(&legacy);
        let preview = preview_rules_conversion(env.wire()).unwrap();
        assert!(!preview.applicable);
        assert!(
            preview
                .reason
                .as_deref()
                .unwrap_or("")
                .contains("size limit"),
            "{:?}",
            preview.reason
        );
        assert_eq!(env.read(), legacy);
    }

    #[test]
    fn copilot_kilo_and_antigravity_have_no_masking_or_peer_files() {
        for harness in [HarnessId::Copilot, HarnessId::Kilo, HarnessId::Antigravity] {
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
    fn the_light_rules_files_are_one_transaction_with_distinct_backups() {
        let env = Env::new("together", HarnessId::Copilot);
        let wires: Vec<String> = LIGHT.iter().map(|harness| wire(*harness)).collect();
        let plan = preview_setup(wires.clone()).unwrap();
        assert_eq!(plan.operations.len(), LIGHT.len());
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

    // ═════════════════════════════════════════════════════════════════════════════════════════════
    // The managed Playwright MCP entry
    // ═════════════════════════════════════════════════════════════════════════════════════════════

    mod mcp {
        use std::ops::Deref;
        use std::path::Path;

        use serde_json::{json, Value};

        use super::*;
        use crate::light_harness::LightMcp;
        use crate::light_mcp::{EntryState, Refusal};

        /// What the user keeps in an MCP file; neither may ever show up in a message of the app.
        const SECRET: &str = "sk-live-not-a-real-secret";
        const PRIVATE_NAME: &str = "my-private-server";

        fn spec_of(harness: HarnessId) -> &'static LightMcp {
            &light_harness::descriptor(harness)
                .expect("light harness")
                .mcp
        }

        fn mcp_artifact(harness: HarnessId) -> ArtifactId {
            ArtifactId::HarnessMcp(LightHarnessId::new(harness).expect("light"))
        }

        fn mcp_wire(harness: HarnessId) -> String {
            format!("{}_mcp", harness.as_str())
        }

        /// Every harness and every target on (the Kilo MCP target is off by default).
        fn enable_everything() {
            let mut targets = crate::agent_targets::default_enabled_ids();
            targets.push("kilo_mcp".to_string());
            targets.push("antigravity_mcp".to_string());
            targets.push("grok_mcp".to_string());
            let settings = crate::settings::AppSettings {
                enabled_harness_ids: HarnessId::ALL.to_vec(),
                enabled_target_ids: crate::agent_targets::normalize_enabled_ids(&targets),
                ..crate::settings::AppSettings::default()
            };
            crate::settings::save_with_revision_check(settings, None).expect("settings");
        }

        struct M(Env);

        impl Deref for M {
            type Target = Env;
            fn deref(&self) -> &Env {
                &self.0
            }
        }

        fn mcp_env(label: &str, harness: HarnessId) -> M {
            let env = Env::new(label, harness);
            enable_everything();
            M(env)
        }

        fn each_mcp(label: &str, body: impl Fn(&M)) {
            for harness in LIGHT {
                let env = mcp_env(label, harness);
                body(&env);
            }
        }

        impl M {
            fn spec(&self) -> &'static LightMcp {
                spec_of(self.harness)
            }

            fn artifact(&self) -> ArtifactId {
                mcp_artifact(self.harness)
            }

            fn surface(&self) -> SetupSurfaceId {
                self.spec().surface
            }

            fn wire(&self) -> String {
                mcp_wire(self.harness)
            }

            fn root_key(&self) -> &'static str {
                self.spec().root_key.as_str()
            }

            fn dest(&self) -> PathBuf {
                self.spec().resolve_dest(&self.home)
            }

            fn put(&self, content: impl AsRef<[u8]>) {
                let path = self.dest();
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, content).unwrap();
            }

            fn bytes(&self) -> Vec<u8> {
                fs::read(self.dest()).unwrap()
            }

            fn json(&self) -> Value {
                serde_json::from_slice(&self.bytes()).expect("the file is JSON")
            }

            fn expected(&self) -> Value {
                let bundled = crate::setup_roots::bundled_root().expect("bundled root");
                crate::light_mcp::expected_entry(self.spec(), &bundled, &self.home).expect("entry")
            }

            /// A file of the user's: other servers (one with a literal token, one with an
            /// authorization header), other top-level keys, no Playwright entry.
            fn user_file(&self) -> String {
                let mut root = serde_json::Map::new();
                root.insert("theme".into(), json!("dark"));
                root.insert(
                    self.root_key().into(),
                    json!({
                        "github": {"command": "npx", "env": {"GITHUB_TOKEN": SECRET}},
                        "docs": {"url": "https://example.com/mcp", "headers": {"Authorization": "Bearer abc"}},
                    }),
                );
                root.insert("last".into(), json!([1, 2, 3]));
                serde_json::to_string_pretty(&Value::Object(root)).unwrap() + "\n"
            }

            fn plan_mcp(&self) -> setup_transaction::PlannedArtifact {
                setup_transaction::plan_artifacts_for_surfaces(
                    &[self.surface()],
                    &self.ws,
                    &self.home,
                )
                .expect("plan")
                .into_iter()
                .next()
                .expect("planned artifact")
            }

            fn apply_mcp(&self) -> SetupResult {
                let plan = preview_setup(vec![self.wire()]).expect("preview");
                apply_setup(
                    vec![self.wire()],
                    false,
                    plan.plan_fingerprint,
                    plan.preview_token,
                )
                .expect("apply")
            }

            fn status_mcp(&self) -> crate::installation_status::InstallationStatus {
                status_for_surfaces(&[self.surface()], &self.ws, &self.home).expect("status")
            }

            fn record_mcp(&self, hash: &str) {
                write_managed_state_atomic(
                    &self.ws,
                    &ManagedState {
                        schema_version: MANAGED_STATE_SCHEMA_VERSION,
                        bundled_version: crate::stable_digest::bytes(b"bundle"),
                        artifacts: vec![ManagedArtifactRecord {
                            identity: artifact_identity(&self.artifact()),
                            hash: hash.to_string(),
                            surface: None,
                            role_models: Default::default(),
                        }],
                    },
                )
                .expect("managed state");
            }

            fn recorded_mcp(&self) -> Option<String> {
                let identity = artifact_identity(&self.artifact());
                read_managed_state(&self.ws)?
                    .artifacts
                    .into_iter()
                    .find(|record| record.identity == identity)
                    .map(|record| record.hash)
            }

            /// The digest the app records for the entry the file holds now.
            fn entry_digest(&self) -> String {
                crate::setup_fingerprint::artifact_installed_managed_digest(
                    &self.artifact(),
                    &self.ws,
                    &self.home,
                )
                .unwrap()
            }

            fn health_mcp(&self) -> crate::commands::light_runtime::LightRuntimeHealth {
                super::health(self)
            }

            /// The names of the files in the folder of the MCP file.
            fn folder_listing(&self) -> Vec<String> {
                let mut names: Vec<String> = fs::read_dir(self.dest().parent().unwrap())
                    .map(|entries| {
                        entries
                            .flatten()
                            .map(|entry| entry.file_name().to_string_lossy().into_owned())
                            .collect()
                    })
                    .unwrap_or_default();
                names.sort();
                names
            }

            /// Every sentence the app says about the file, to prove none carries its text.
            fn everything_said(&self) -> String {
                let mut said = Vec::new();
                let plan = preview_setup(vec![self.wire()]).unwrap();
                for op in plan.operations.iter().chain(&plan.conflicts) {
                    said.push(op.summary.clone());
                    said.extend(op.conflict_description.clone());
                    said.extend(op.details.clone());
                }
                said.push(plan.summary.clone());
                let status = self.status_mcp();
                said.push(status.summary.clone());
                said.extend(status.conflict_details.clone());
                for surface in &status.surfaces {
                    said.push(surface.detail.clone());
                }
                said.push(
                    setup_transaction::ensure_mcp_apply_allowed(
                        &self.artifact(),
                        &self.ws,
                        &self.home,
                    )
                    .err()
                    .unwrap_or_default(),
                );
                said.push(
                    apply_setup(vec![self.wire()], false, None, None)
                        .err()
                        .unwrap_or_default(),
                );
                said.push(serde_json::to_string(&self.health_mcp()).unwrap());
                said.join("\n")
            }

            /// The file must be left exactly as it was, with nothing written anywhere.
            fn assert_refused(&self, before: &[u8]) {
                assert!(setup_transaction::ensure_mcp_apply_allowed(
                    &self.artifact(),
                    &self.ws,
                    &self.home
                )
                .is_err());
                let folder = self.folder_listing();
                let backups = self.backup_entries();
                let plan = preview_setup(vec![self.wire()]).unwrap();
                assert!(!plan.has_pending_changes, "{}", self.harness.as_str());
                assert!(plan.is_blocked);
                assert!(plan.plan_fingerprint.is_none());
                assert!(apply_setup(vec![self.wire()], false, None, None).is_err());
                assert_eq!(self.bytes(), before, "the file is untouched");
                assert_eq!(self.folder_listing(), folder, "nothing else is written");
                assert_eq!(self.backup_entries(), backups, "no transaction is started");
            }
        }

        // ── The descriptor, the surface, the target and the artifact agree ──

        #[test]
        fn each_harness_has_one_mcp_target_one_surface_and_one_artifact() {
            for harness in LIGHT {
                let mcp = spec_of(harness);
                assert_eq!(mcp.target_id, mcp_wire(harness));
                assert_eq!(mcp.surface.harness(), Some(harness));
                assert_eq!(
                    serde_json::to_value(mcp.surface).unwrap(),
                    json!(mcp_wire(harness))
                );
                assert_eq!(mcp_artifact(harness).surface(), mcp.surface);
                assert!(!mcp_artifact(harness).is_rules_block());
                assert_eq!(
                    crate::agent_targets::target_surfaces(&mcp.target_id),
                    [mcp.surface]
                );
                assert_eq!(
                    crate::agent_targets::surface_target_id(mcp.surface),
                    Some(mcp.target_id.as_str())
                );
                assert!(SetupSurfaceId::ALL.contains(&mcp.surface));
                let target = crate::agent_targets::targets()
                    .into_iter()
                    .find(|target| target.id == mcp.target_id)
                    .expect("target");
                assert!(matches!(target.kind, crate::agent_targets::TargetKind::Mcp));
                assert_eq!(target.source_rel, mcp.template_rel);
                assert_eq!(
                    crate::agent_targets::default_enabled_ids().contains(&mcp.target_id),
                    !matches!(harness, HarnessId::Kilo | HarnessId::Antigravity),
                    "every MCP target is on by default but Kilo's, whose config file may hold provider keys, and Antigravity's"
                );
                let identity = artifact_identity(&mcp_artifact(harness));
                assert_eq!(
                    identity,
                    format!(r#"{{"type":"HarnessMcp","name":"{}"}}"#, harness.as_str())
                );
                assert_eq!(
                    serde_json::from_str::<ArtifactId>(&identity).unwrap(),
                    mcp_artifact(harness)
                );
            }
            for central in ["claude", "codex", "cursor", "opencode", "../pi", ""] {
                let json = format!(r#"{{"type":"HarnessMcp","name":"{central}"}}"#);
                assert!(serde_json::from_str::<ArtifactId>(&json).is_err(), "{json}");
            }
        }

        #[test]
        fn labels_and_backup_names_are_distinct_per_harness_and_per_artifact() {
            let mut backups = std::collections::HashSet::new();
            for harness in LIGHT {
                let mcp = mcp_artifact(harness);
                let rules = artifact_of(harness);
                for artifact in [&mcp, &rules] {
                    assert!(backups.insert(setup_transaction::artifact_backup_rel(artifact)));
                }
                assert_eq!(
                    setup_transaction::artifact_backup_rel(&mcp),
                    format!("{}-mcp", harness.as_str())
                );
                assert_eq!(
                    crate::installation_status::artifact_label(&mcp),
                    format!(
                        "{} Playwright MCP entry",
                        light_harness::display_name(harness)
                    )
                );
            }
        }

        // ── Create ──

        #[test]
        fn a_missing_file_is_created_with_only_the_entry_and_is_then_current() {
            each_mcp("create", |env| {
                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Create);
                assert_eq!(planned.previous_state, PreviousState::Absent);
                assert_eq!(planned.rollback_action, RollbackAction::RemoveCreatedFile);
                assert_eq!(planned.mcp, Some(EntryState::Absent));
                assert_eq!(env.status_mcp().state, InstallationState::NotInstalled);

                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                let mut root = serde_json::Map::new();
                root.insert(
                    env.root_key().into(),
                    json!({ "playwright": env.expected() }),
                );
                assert_eq!(
                    env.json(),
                    Value::Object(root),
                    "the file holds the entry and nothing else"
                );
                // The folder the entry passes to `npx --prefix` exists, owner-only and empty.
                let prefix = crate::commands::cursor_profile::npx_prefix_path(&env.home)
                    .expect("npx prefix");
                assert!(prefix.starts_with(&env.home), "{}", prefix.display());
                assert_eq!(fs::read_dir(&prefix).expect("npx prefix").count(), 0);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = fs::metadata(&prefix).unwrap().permissions().mode() & 0o777;
                    assert_eq!(mode, 0o700);
                }
                assert!(String::from_utf8(env.bytes()).unwrap().ends_with("}\n"));
                assert_eq!(env.recorded_mcp(), Some(env.entry_digest()));
                assert_eq!(
                    env.recorded_mcp(),
                    Some(
                        crate::setup_fingerprint::artifact_source_digest(
                            &env.artifact(),
                            &crate::setup_roots::bundled_root().unwrap(),
                            &env.home
                        )
                        .unwrap()
                    )
                );
                assert_eq!(env.plan_mcp().kind, OperationKind::NoChange);
                let status = env.status_mcp();
                assert_eq!(status.state, InstallationState::Current);
                assert_eq!(status.surfaces[0].detail, "installed and current");

                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert!(
                    !env.dest().exists(),
                    "a rollback removes the file the apply created"
                );
            });
        }

        #[cfg(unix)]
        #[test]
        fn a_new_mcp_file_is_owner_only_and_only_pis_folders_are() {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            for harness in LIGHT {
                let env = mcp_env("modes", harness);
                assert!(env.apply_mcp().success);
                assert_eq!(mode(&env.dest()), 0o600, "{}", harness.as_str());
                let folder = env.dest().parent().unwrap().to_path_buf();
                if harness == HarnessId::Pi {
                    assert_eq!(mode(&env.home.join(".pi")), 0o700);
                    assert_eq!(mode(&folder), 0o700);
                } else {
                    assert_ne!(mode(&folder), 0o700, "{}", harness.as_str());
                }
            }
        }

        #[cfg(unix)]
        #[test]
        fn an_existing_mcp_file_keeps_its_permissions() {
            use std::os::unix::fs::PermissionsExt;
            each_mcp("keep-mode", |env| {
                env.put(env.user_file());
                fs::set_permissions(env.dest(), fs::Permissions::from_mode(0o644)).unwrap();
                assert!(env.apply_mcp().success);
                assert_eq!(
                    fs::metadata(env.dest()).unwrap().permissions().mode() & 0o777,
                    0o644
                );
            });
        }

        // ── Merge into a file with other servers ──

        #[test]
        fn a_file_with_other_servers_gets_the_entry_and_every_other_value_and_key_order_is_kept() {
            each_mcp("merge", |env| {
                let original = env.user_file();
                env.put(&original);
                let planned = env.plan_mcp();
                // Never a create over the user's file, so a rollback cannot delete it.
                assert_eq!(planned.kind, OperationKind::Update);
                assert_eq!(planned.previous_state, PreviousState::MergeableConfigFile);
                assert_eq!(
                    planned.rollback_action,
                    RollbackAction::RestoreManagedConfigFile
                );
                assert_eq!(planned.mcp, Some(EntryState::EntryMissing));
                let status = env.status_mcp();
                assert_eq!(status.state, InstallationState::UpdateAvailable);
                assert_eq!(status.counts.conflict_count, 0);
                assert!(status.surfaces[0].detail.contains("will be added"));
                assert!(status.surfaces[0]
                    .detail
                    .contains("your other servers stay"));

                // The user's tokens and headers are theirs: the merge is not refused for them.
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                let before: Value = serde_json::from_str(&original).unwrap();
                let after = env.json();
                let keys = |value: &Value| -> Vec<String> {
                    value.as_object().unwrap().keys().cloned().collect()
                };
                assert_eq!(keys(&after), keys(&before), "top-level key order");
                let servers_before = &before[env.root_key()];
                let servers_after = &after[env.root_key()];
                let mut expected_servers = keys(servers_before);
                expected_servers.push("playwright".into());
                assert_eq!(
                    keys(servers_after),
                    expected_servers,
                    "the entry is appended"
                );
                for server in ["github", "docs"] {
                    assert_eq!(servers_after[server], servers_before[server], "{server}");
                }
                assert_eq!(servers_after["github"]["env"]["GITHUB_TOKEN"], SECRET);
                assert_eq!(after["theme"], before["theme"]);
                assert_eq!(after["last"], before["last"]);
                assert_eq!(servers_after["playwright"], env.expected());
                assert_eq!(env.plan_mcp().kind, OperationKind::NoChange);
                assert_eq!(env.recorded_mcp(), Some(env.entry_digest()));

                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert_eq!(
                    String::from_utf8(env.bytes()).unwrap(),
                    original,
                    "a rollback restores the user's file byte for byte"
                );
            });
        }

        #[test]
        fn a_rollback_after_later_edits_takes_out_only_the_added_entry() {
            each_mcp("rollback-merge", |env| {
                env.put(env.user_file());
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);

                // The user adds a server and a key after the apply.
                let mut edited = env.json();
                edited[env.root_key()]["later"] = json!({"command": "later"});
                edited["added"] = json!(true);
                env.put(serde_json::to_string_pretty(&edited).unwrap());

                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                let after = env.json();
                assert!(after[env.root_key()].get("playwright").is_none());
                assert_eq!(after[env.root_key()]["later"], json!({"command": "later"}));
                assert_eq!(after["added"], json!(true));
                assert_eq!(
                    after[env.root_key()]["github"]["env"]["GITHUB_TOKEN"],
                    SECRET
                );
            });
        }

        #[test]
        fn a_rollback_never_overwrites_an_entry_the_user_edited_after_the_apply() {
            each_mcp("rollback-edited", |env| {
                env.put(env.user_file());
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                let mut edited = env.json();
                edited[env.root_key()]["playwright"]["mine"] = json!(true);
                let text = serde_json::to_string_pretty(&edited).unwrap();
                env.put(&text);
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(!rolled.success, "the user's edit is preserved");
                assert_eq!(String::from_utf8(env.bytes()).unwrap(), text);
            });
        }

        #[test]
        fn a_servers_key_the_apply_created_goes_with_the_entry_on_a_rollback() {
            each_mcp("rollback-key", |env| {
                env.put("{\n  \"theme\": \"dark\"\n}\n");
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                assert!(env.json().get(env.root_key()).is_some());
                // A later edit elsewhere forces the projection restore.
                let mut edited = env.json();
                edited["later"] = json!(1);
                env.put(serde_json::to_string_pretty(&edited).unwrap());
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert_eq!(env.json(), json!({"theme": "dark", "later": 1}));
            });
        }

        #[test]
        fn an_empty_file_counts_as_no_servers_and_is_restored_empty() {
            each_mcp("empty", |env| {
                env.put("");
                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Update);
                assert_eq!(planned.mcp, Some(EntryState::EntryMissing));
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                assert_eq!(
                    env.json()[env.root_key()]["playwright"],
                    env.expected(),
                    "the write repairs a file Pi would refuse"
                );
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert_eq!(env.bytes(), b"");
            });
        }

        #[test]
        fn an_entry_that_is_already_current_needs_no_change() {
            each_mcp("equal", |env| {
                let mut file: Value = serde_json::from_str(&env.user_file()).unwrap();
                file[env.root_key()]["playwright"] = env.expected();
                let text = serde_json::to_string(&file).unwrap();
                env.put(&text);
                assert_eq!(env.plan_mcp().kind, OperationKind::NoChange);
                assert_eq!(env.plan_mcp().mcp, Some(EntryState::Equal));
                assert_eq!(env.status_mcp().state, InstallationState::Current);
                let plan = preview_setup(vec![env.wire()]).unwrap();
                assert!(!plan.has_pending_changes && plan.plan_fingerprint.is_none());
                assert_eq!(String::from_utf8(env.bytes()).unwrap(), text);
            });
        }

        // ── An entry named playwright that is not the managed one ──

        #[test]
        fn a_differing_entry_without_a_record_is_the_users_own_and_stays_untouched() {
            each_mcp("differs", |env| {
                let mut file: Value = serde_json::from_str(&env.user_file()).unwrap();
                file[env.root_key()]["playwright"] =
                    json!({"command": "my-own-playwright", "args": ["--headless"]});
                let text = serde_json::to_string_pretty(&file).unwrap();
                env.put(&text);

                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Conflict);
                assert_eq!(planned.previous_state, PreviousState::Conflict);
                assert_eq!(planned.rollback_action, RollbackAction::NoAction);
                assert_eq!(planned.mcp, Some(EntryState::Differs));
                let status = env.status_mcp();
                assert_eq!(status.state, InstallationState::Conflict);
                assert!(
                    status.surfaces[0].detail.contains("already exists"),
                    "{}",
                    status.surfaces[0].detail
                );
                assert_eq!(
                    status.conflict_details,
                    [format!(
                        "{} Playwright MCP entry",
                        light_harness::display_name(env.harness)
                    )]
                );
                env.assert_refused(text.as_bytes());
                let said = env.everything_said();
                assert!(
                    !said.contains("my-own-playwright") && !said.contains(SECRET),
                    "{said}"
                );
            });
        }

        #[test]
        fn an_entry_the_app_wrote_and_the_user_then_edited_is_a_conflict() {
            each_mcp("edited-after", |env| {
                env.put(env.user_file());
                assert!(env.apply_mcp().success);
                let recorded = env.recorded_mcp();
                assert!(recorded.is_some());
                let mut edited = env.json();
                edited[env.root_key()]["playwright"]["args"] = json!(["--my-flag"]);
                let text = serde_json::to_string_pretty(&edited).unwrap();
                env.put(&text);

                assert_eq!(env.plan_mcp().kind, OperationKind::Conflict);
                env.assert_refused(text.as_bytes());
                assert_eq!(env.recorded_mcp(), recorded);
            });
        }

        #[test]
        fn an_entry_the_app_wrote_earlier_is_updated_when_the_bundled_one_moves_on() {
            each_mcp("moves-on", |env| {
                // The entry an older version wrote, recorded when it did.
                let mut file: Value = serde_json::from_str(&env.user_file()).unwrap();
                let mut old = env.expected();
                old["description"] = json!("an older entry");
                file[env.root_key()]["playwright"] = old.clone();
                let original = serde_json::to_string_pretty(&file).unwrap() + "\n";
                env.put(&original);
                env.record_mcp(&env.entry_digest());

                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Update);
                assert_eq!(planned.previous_state, PreviousState::MergeableConfigFile);
                assert_eq!(planned.mcp, Some(EntryState::Differs));
                assert!(env.status_mcp().surfaces[0]
                    .detail
                    .contains("update available"));

                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                assert_eq!(env.json()[env.root_key()]["playwright"], env.expected());
                assert_eq!(env.json()[env.root_key()]["github"]["command"], "npx");
                assert_eq!(env.recorded_mcp(), Some(env.entry_digest()));

                // A rollback of a replaced entry brings the old one back.
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert_eq!(String::from_utf8(env.bytes()).unwrap(), original);

                // And with an edit elsewhere in between, only the entry goes back.
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                let mut edited = env.json();
                edited["added"] = json!(true);
                env.put(serde_json::to_string_pretty(&edited).unwrap());
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert_eq!(env.json()[env.root_key()]["playwright"], old);
                assert_eq!(env.json()["added"], json!(true));
            });
        }

        #[test]
        fn an_entry_pinning_the_previous_playwright_version_is_updated_not_a_conflict() {
            each_mcp("old-pin", |env| {
                // What the app wrote while it pinned 0.0.48 (`--browser chrome --isolated`, no
                // `--no-webmcp`), recorded when it did.
                let pin = crate::commands::cursor_profile::PLAYWRIGHT_MCP_VERSION;
                let old =
                    crate::commands::cursor_profile::as_the_previous_app_wrote_it(&env.expected());
                assert_ne!(old, env.expected());
                assert!(old.to_string().contains("@playwright/mcp@0.0.48"));
                assert!(!old.to_string().contains("--no-webmcp"));
                let mut file: Value = serde_json::from_str(&env.user_file()).unwrap();
                file[env.root_key()]["playwright"] = old.clone();
                env.put(serde_json::to_string_pretty(&file).unwrap() + "\n");
                env.record_mcp(&env.entry_digest());

                // The row names the old pin and says an update waits.
                let health = env.health_mcp();
                assert_eq!(health.mcp.status, "stale");
                assert_eq!(health.mcp.playwright_version.as_deref(), Some("0.0.48"));

                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Update);
                assert_eq!(planned.mcp, Some(EntryState::Differs));

                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                assert_eq!(env.json()[env.root_key()]["playwright"], env.expected());
                assert_eq!(
                    env.health_mcp().mcp.playwright_version.as_deref(),
                    Some(pin)
                );
            });
        }

        #[test]
        fn a_user_who_removed_the_entry_after_the_app_wrote_it_gets_it_back_without_a_conflict() {
            each_mcp("removed", |env| {
                env.put(env.user_file());
                assert!(env.apply_mcp().success);
                let mut edited = env.json();
                edited[env.root_key()]
                    .as_object_mut()
                    .unwrap()
                    .shift_remove("playwright");
                env.put(serde_json::to_string_pretty(&edited).unwrap());
                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Update);
                assert_eq!(planned.mcp, Some(EntryState::EntryMissing));
                assert!(env.apply_mcp().success);
                assert_eq!(env.plan_mcp().kind, OperationKind::NoChange);
            });
        }

        // ── Files the app does not edit ──

        fn refused_cases(root_key: &str) -> Vec<(&'static str, Vec<u8>, Refusal)> {
            vec![
                (
                    "line comment",
                    format!("// {SECRET}\n{{\"{root_key}\":{{}}}}\n").into_bytes(),
                    Refusal::Comments,
                ),
                (
                    "block comment",
                    format!("{{/* {SECRET} */ \"{root_key}\":{{}}}}").into_bytes(),
                    Refusal::Comments,
                ),
                (
                    "trailing comma",
                    format!(
                        "{{\"{root_key}\":{{\"{PRIVATE_NAME}\":{{\"env\":{{\"TOKEN\":\"{SECRET}\"}}}}}},}}"
                    )
                    .into_bytes(),
                    Refusal::TrailingComma,
                ),
                (
                    "byte order mark",
                    [&[0xEF, 0xBB, 0xBF][..], b"{}"].concat(),
                    Refusal::ByteOrderMark,
                ),
                (
                    "array at the top",
                    format!("[\"{SECRET}\"]").into_bytes(),
                    Refusal::RootNotObject,
                ),
                (
                    "servers key that is not an object",
                    format!("{{\"{root_key}\":[\"{SECRET}\"]}}").into_bytes(),
                    Refusal::KeyNotObject,
                ),
                (
                    "not UTF-8",
                    b"{\"a\":\"\xFF\xFE\"}".to_vec(),
                    Refusal::NotUtf8,
                ),
                (
                    "truncated",
                    format!("{{\"{root_key}\":{{\"{PRIVATE_NAME}\":\"{SECRET}").into_bytes(),
                    Refusal::NotJson,
                ),
                (
                    "too large",
                    format!("{{\"pad\":\"{}\"}}", "a".repeat(1024 * 1024)).into_bytes(),
                    Refusal::TooLarge,
                ),
            ]
        }

        #[test]
        fn files_the_app_does_not_edit_are_refused_with_zero_mutation_and_no_file_text() {
            for harness in LIGHT {
                for (name, content, refusal) in refused_cases(spec_of(harness).root_key.as_str()) {
                    let env = mcp_env("refused", harness);
                    env.put(&content);
                    let label = format!("{} {name}", harness.as_str());

                    let planned = env.plan_mcp();
                    assert_eq!(planned.kind, OperationKind::Conflict, "{label}");
                    assert_eq!(planned.previous_state, PreviousState::Conflict, "{label}");
                    assert_eq!(planned.rollback_action, RollbackAction::NoAction, "{label}");
                    assert_eq!(planned.mcp, Some(EntryState::Refused(refusal)), "{label}");
                    let status = env.status_mcp();
                    assert_eq!(status.state, InstallationState::Conflict, "{label}");
                    assert!(
                        status.surfaces[0].detail.contains(refusal.message()),
                        "{label}: {}",
                        status.surfaces[0].detail
                    );
                    assert!(
                        status.surfaces[0].detail.contains("strict JSON"),
                        "{label}: {}",
                        status.surfaces[0].detail
                    );
                    env.assert_refused(&content);
                    let said = env.everything_said();
                    for text in [SECRET, PRIVATE_NAME, "sk-live"] {
                        assert!(!said.contains(text), "{label}: {said}");
                    }
                    // The same file stays refused after a record is written: it never unlocks.
                    env.record_mcp(&crate::stable_digest::bytes(&content));
                    assert_eq!(env.plan_mcp().kind, OperationKind::Conflict, "{label}");
                }
            }
        }

        #[cfg(unix)]
        #[test]
        fn a_symlink_or_a_folder_in_place_of_the_file_is_never_written_through() {
            each_mcp("not-a-file", |env| {
                let elsewhere = env.base.join("elsewhere.json");
                fs::write(&elsewhere, "{}").unwrap();
                fs::create_dir_all(env.dest().parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(&elsewhere, env.dest()).unwrap();
                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Conflict);
                assert_eq!(
                    planned.mcp,
                    Some(EntryState::Refused(Refusal::NotRegularFile))
                );
                assert!(apply_setup(vec![env.wire()], false, None, None).is_err());
                assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "{}");
                fs::remove_file(env.dest()).unwrap();

                fs::create_dir(env.dest()).unwrap();
                assert_eq!(env.plan_mcp().kind, OperationKind::Conflict);
                assert!(apply_setup(vec![env.wire()], false, None, None).is_err());
                assert!(env.dest().is_dir());
            });
        }

        // ── Kilo: which of its files ──

        #[test]
        fn kilo_uses_an_existing_kilo_jsonc_then_an_existing_kilo_json_else_creates_kilo_jsonc() {
            let env = mcp_env("kilo-files", HarnessId::Kilo);
            let folder = env.home.join(".config/kilo");
            let jsonc = folder.join("kilo.jsonc");
            let json_file = folder.join("kilo.json");

            // Neither exists: kilo.jsonc is created, kilo.json is not.
            assert_eq!(env.dest(), jsonc);
            let result = env.apply_mcp();
            assert!(result.success, "{}", result.message);
            assert!(jsonc.is_file() && !json_file.exists());
            assert_eq!(env.json()["mcp"]["playwright"], env.expected());
            let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
            assert!(rolled.success, "{}", rolled.message);
            assert!(!jsonc.exists());

            // Only kilo.json: it gets the entry; no kilo.jsonc appears.
            fs::create_dir_all(&folder).unwrap();
            fs::write(&json_file, "{\"model\": \"x\"}\n").unwrap();
            assert_eq!(env.dest(), json_file);
            let result = env.apply_mcp();
            assert!(result.success, "{}", result.message);
            assert!(!jsonc.exists());
            assert_eq!(env.json()["mcp"]["playwright"], env.expected());
            assert_eq!(env.json()["model"], "x");
            let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
            assert!(rolled.success, "{}", rolled.message);
            assert_eq!(
                fs::read_to_string(&json_file).unwrap(),
                "{\"model\": \"x\"}\n"
            );

            // Both: kilo.jsonc, which Kilo merges over kilo.json; kilo.json is not touched.
            fs::write(
                &jsonc,
                "{\n  \"$schema\": \"https://app.kilo.ai/config.json\"\n}\n",
            )
            .unwrap();
            assert_eq!(env.dest(), jsonc);
            assert_eq!(env.plan_mcp().mcp, Some(EntryState::EntryMissing));
            let result = env.apply_mcp();
            assert!(result.success, "{}", result.message);
            let after = env.json();
            let keys: Vec<&String> = after.as_object().unwrap().keys().collect();
            assert_eq!(
                keys,
                ["$schema", "mcp"],
                "the first-run file keeps its schema"
            );
            assert_eq!(
                fs::read_to_string(&json_file).unwrap(),
                "{\"model\": \"x\"}\n"
            );
            assert!(result.success);
        }

        #[test]
        fn the_kilo_mcp_file_follows_xdg_config_home() {
            let env = mcp_env("kilo-xdg", HarnessId::Kilo);
            let moved = env.base.join("xdg-config");
            fs::create_dir_all(&moved).unwrap();
            std::env::set_var("XDG_CONFIG_HOME", &moved);
            // On Linux the app's own settings move with the variable too.
            enable_everything();
            assert_eq!(env.dest(), moved.join("kilo/kilo.jsonc"));
            assert_eq!(
                env.spec().allowlist_root(&env.home),
                moved,
                "outside the home folder the moved folder is the allowlisted root"
            );
            let result = env.apply_mcp();
            assert!(result.success, "{}", result.message);
            assert!(moved.join("kilo/kilo.jsonc").is_file());
            assert!(!env.home.join(".config/kilo").exists());
            let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
            assert!(rolled.success, "{}", rolled.message);
            assert!(!moved.join("kilo/kilo.jsonc").exists());
        }

        // ── Gating ──

        #[test]
        fn the_kilo_and_antigravity_mcp_targets_are_off_in_a_fresh_profile_and_the_others_are_on() {
            // Every harness on, every target at its default.
            let env = Env::new("mcp-defaults", HarnessId::Kilo);
            // Their entries are dropped silently: nothing is planned, nothing is written.
            for harness in [HarnessId::Kilo, HarnessId::Antigravity] {
                let plan = preview_setup(vec![mcp_wire(harness)]).unwrap();
                assert!(plan.operations.is_empty() && !plan.has_pending_changes);
                assert!(!spec_of(harness).resolve_dest(&env.home).exists());
            }
            for harness in [HarnessId::Copilot, HarnessId::Pi] {
                let plan = preview_setup(vec![mcp_wire(harness)]).unwrap();
                assert_eq!(plan.operations.len(), 1, "{}", harness.as_str());
                assert_eq!(plan.operations[0].kind, OperationKind::Create);
            }
        }

        #[test]
        fn a_disabled_harness_or_a_switched_off_target_is_never_planned_or_written_for_mcp() {
            for harness in LIGHT {
                let env = mcp_env("mcp-gating", harness);
                let mut settings = crate::settings::load();
                settings.enabled_harness_ids.retain(|id| *id != harness);
                crate::settings::save_with_revision_check(settings, None).unwrap();
                let error = preview_setup(vec![env.wire()]).unwrap_err();
                assert!(error.contains("Harness disabled"), "{error}");
                assert!(apply_setup(vec![env.wire()], false, None, None).is_err());
                assert!(!env.dest().exists());

                enable_everything();
                let mut settings = crate::settings::load();
                settings
                    .enabled_target_ids
                    .retain(|id| *id != env.spec().target_id);
                crate::settings::save_with_revision_check(settings, None).unwrap();
                let plan = preview_setup(vec![env.wire()]).unwrap();
                assert!(plan.operations.is_empty() && !plan.has_pending_changes);
                assert!(!env.dest().exists());
            }
        }

        // ── Preview, fingerprint ──

        #[test]
        fn the_review_names_the_file_the_entry_goes_into() {
            each_mcp("review", |env| {
                let shown = env.spec().display_path(&env.home);
                let plan = preview_setup(vec![env.wire()]).unwrap();
                assert_eq!(
                    plan.operations[0].details,
                    [format!(
                        "+ {shown} (new file, owner-only; adds the playwright entry)"
                    )]
                );
                env.put(env.user_file());
                let plan = preview_setup(vec![env.wire()]).unwrap();
                assert_eq!(
                    plan.operations[0].details,
                    [format!(
                        "~ {shown} (adds or updates the playwright entry; your other servers stay)"
                    )]
                );
            });
        }

        #[test]
        fn the_fingerprint_changes_only_when_the_managed_entry_changes() {
            each_mcp("fingerprint", |env| {
                let fingerprint = |env: &M| {
                    let planned = setup_transaction::plan_artifacts_for_surfaces(
                        &[env.surface()],
                        &env.ws,
                        &env.home,
                    )
                    .unwrap();
                    setup_transaction::compute_plan_fingerprint(
                        &env.ws,
                        &[env.surface()],
                        &planned,
                        &env.home,
                    )
                    .unwrap()
                };
                let mut file: Value = serde_json::from_str(&env.user_file()).unwrap();
                env.put(serde_json::to_string_pretty(&file).unwrap());
                let base = fingerprint(env);

                file["theme"] = json!("light");
                env.put(serde_json::to_string_pretty(&file).unwrap());
                assert_eq!(fingerprint(env), base, "an unrelated key");
                file[env.root_key()]["third"] = json!({"command": "third"});
                env.put(serde_json::to_string_pretty(&file).unwrap());
                assert_eq!(fingerprint(env), base, "another server");
                env.put(serde_json::to_string(&file).unwrap());
                assert_eq!(fingerprint(env), base, "the layout");

                file[env.root_key()]["playwright"] = json!({"command": "mine"});
                env.put(serde_json::to_string_pretty(&file).unwrap());
                let other = fingerprint(env);
                assert_ne!(other, base, "an entry of the user's own");
                file[env.root_key()]["playwright"] = json!({"command": "mine too"});
                env.put(serde_json::to_string_pretty(&file).unwrap());
                assert_ne!(fingerprint(env), other, "another entry");

                fs::remove_file(env.dest()).unwrap();
                assert_ne!(fingerprint(env), base, "no file");
            });
        }

        #[test]
        fn a_file_that_changes_after_the_preview_is_refused_at_apply() {
            each_mcp("changed", |env| {
                env.put(env.user_file());
                let plan = preview_setup(vec![env.wire()]).unwrap();
                assert!(plan.plan_fingerprint.is_some());

                // The user adds an entry of their own, or a comment, in between.
                let mut file = env.json();
                file[env.root_key()]["playwright"] = json!({"command": "mine"});
                let edited = serde_json::to_string_pretty(&file).unwrap();
                env.put(&edited);
                let error = apply_setup(
                    vec![env.wire()],
                    false,
                    plan.plan_fingerprint.clone(),
                    plan.preview_token.clone(),
                )
                .map(|result| result.message)
                .unwrap_or_else(|error| error);
                assert!(
                    error.contains("mismatch") || error.contains("blocked"),
                    "{error}"
                );
                assert_eq!(String::from_utf8(env.bytes()).unwrap(), edited);

                env.put(format!("// {SECRET}\n{{}}"));
                let error = apply_setup(
                    vec![env.wire()],
                    false,
                    plan.plan_fingerprint,
                    plan.preview_token,
                )
                .map(|result| result.message)
                .unwrap_or_else(|error| error);
                assert!(!error.contains(SECRET), "{error}");
                assert_eq!(
                    String::from_utf8(env.bytes()).unwrap(),
                    format!("// {SECRET}\n{{}}")
                );
                assert_eq!(env.backup_entries(), 0);
            });
        }

        // ── Uninstall ──

        #[test]
        fn uninstall_keeps_the_mcp_file_and_never_lists_it_as_removable() {
            each_mcp("uninstall", |env| {
                env.put(env.user_file());
                assert!(env.apply_mcp().success);
                let plan =
                    setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home).unwrap();
                assert!(plan.merged.contains(&env.artifact()));
                assert!(plan.removals.iter().all(|op| op.artifact != env.artifact()));
                assert!(!plan.preserved.contains(&env.artifact()));
                assert_eq!(env.json()[env.root_key()]["playwright"], env.expected());

                // Even a file that only the app wrote is kept: the user may have added to it.
                fs::remove_file(env.dest()).unwrap();
                assert!(env.apply_mcp().success);
                let plan =
                    setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home).unwrap();
                assert!(plan.merged.contains(&env.artifact()));
                assert!(plan.removals.iter().all(|op| op.artifact != env.artifact()));

                // A file the app never wrote into is the user's alone: it is not reported at all.
                for content in [env.user_file(), format!("// {SECRET}\n{{}}"), String::new()] {
                    env.put(&content);
                    let plan = setup_transaction::plan_artifacts_for_uninstall(&env.ws, &env.home)
                        .unwrap();
                    for listed in [
                        plan.merged.contains(&env.artifact()),
                        plan.preserved.contains(&env.artifact()),
                        plan.removals.iter().any(|op| op.artifact == env.artifact()),
                    ] {
                        assert!(!listed, "{content:?}");
                    }
                    assert_eq!(String::from_utf8(env.bytes()).unwrap(), content);
                }
            });
        }

        // ── Rules and MCP in one transaction ──

        #[test]
        fn rules_and_mcp_of_a_harness_are_one_transaction_with_distinct_backups() {
            for harness in LIGHT {
                let env = mcp_env("together", harness);
                env.put(env.user_file());
                let before = env.bytes();
                let wires = vec![wire(harness), mcp_wire(harness)];
                let plan = preview_setup(wires.clone()).unwrap();
                assert_eq!(plan.operations.len(), 2);
                let result =
                    apply_setup(wires, false, plan.plan_fingerprint, plan.preview_token).unwrap();
                assert!(result.success, "{}", result.message);
                assert!(rules_of(harness).resolve_dest(&env.home).is_file());
                assert_eq!(env.json()[env.root_key()]["playwright"], env.expected());
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert!(!rules_of(harness).resolve_dest(&env.home).exists());
                assert_eq!(env.bytes(), before);
            }
        }

        // ── Health ──

        #[test]
        fn the_health_mcp_row_follows_the_file() {
            each_mcp("health", |env| {
                let path = env.spec().display_path(&env.home);
                let missing = env.health_mcp();
                assert_eq!(missing.mcp.status, "missing");
                assert_eq!(missing.mcp.path, path);
                assert_eq!(missing.mcp.detail, "no file yet");
                assert_eq!(missing.mcp.playwright_version, None);

                env.put(env.user_file());
                let no_entry = env.health_mcp();
                assert_eq!(no_entry.mcp.status, "missing");
                assert!(no_entry.mcp.detail.contains("your other servers stay"));

                assert!(env.apply_mcp().success);
                let synced = env.health_mcp();
                assert_eq!(synced.mcp.status, "synced");
                assert_eq!(synced.mcp.detail, "installed and current");
                assert_eq!(
                    synced.mcp.playwright_version.as_deref(),
                    Some(crate::commands::cursor_profile::PLAYWRIGHT_MCP_VERSION)
                );

                // The recorded entry of an older version, still the app's: stale, not diverged.
                let mut file = env.json();
                file[env.root_key()]["playwright"]["description"] = json!("older");
                env.put(serde_json::to_string_pretty(&file).unwrap());
                env.record_mcp(&env.entry_digest());
                assert_eq!(env.health_mcp().mcp.status, "stale");

                // An entry of the user's own.
                env.record_mcp(&crate::stable_digest::bytes(b"something else"));
                let diverged = env.health_mcp();
                assert_eq!(diverged.mcp.status, "diverged");
                assert!(diverged.mcp.detail.contains("already exists"));

                // A file the app does not edit.
                env.put(format!("// {SECRET}\n{{}}"));
                let invalid = env.health_mcp();
                assert_eq!(invalid.mcp.status, "invalid");
                assert!(invalid.mcp.detail.contains("comments"));
                assert_eq!(invalid.mcp.playwright_version, None);
                let json = serde_json::to_string(&invalid).unwrap();
                assert!(
                    !json.contains(SECRET) && !json.contains("sk-live"),
                    "{json}"
                );
            });
        }

        #[test]
        fn the_health_mcp_row_is_off_when_the_target_is_switched_off() {
            each_mcp("health-off", |env| {
                let mut settings = crate::settings::load();
                settings
                    .enabled_target_ids
                    .retain(|id| *id != env.spec().target_id);
                crate::settings::save_with_revision_check(settings, None).unwrap();
                env.put(format!("// {SECRET}\n{{}}"));
                let off = env.health_mcp();
                assert_eq!(off.mcp.status, "off");
                assert_ne!(off.status, "off");
                assert!(off.warnings.iter().all(|w| !w.contains("exposure")));
            });
        }

        #[test]
        fn the_health_warns_that_pi_does_not_declare_the_tools_and_that_kilo_files_can_shadow_the_entry(
        ) {
            let pi = mcp_env("health-pi-note", HarnessId::Pi);
            let note = pi
                .health_mcp()
                .warnings
                .into_iter()
                .find(|w| w.contains("exposure"))
                .expect("exposure note");
            assert!(
                note.contains("direct") && note.contains("codemode"),
                "{note}"
            );
            drop(pi);

            for harness in [HarnessId::Copilot, HarnessId::Kilo, HarnessId::Antigravity] {
                let env = mcp_env("health-no-note", harness);
                assert!(
                    env.health_mcp()
                        .warnings
                        .iter()
                        .all(|w| !w.contains("exposure")),
                    "{}",
                    harness.as_str()
                );
            }

            let kilo = mcp_env("health-kilo-shadow", HarnessId::Kilo);
            let shadow = |w: &String| w.contains("win over");
            assert!(!kilo.health_mcp().warnings.iter().any(shadow));
            fs::create_dir_all(kilo.home.join(".kilo")).unwrap();
            fs::write(kilo.home.join(".kilo/kilo.jsonc"), format!("// {SECRET}")).unwrap();
            fs::create_dir_all(kilo.home.join(".config/kilo")).unwrap();
            fs::write(kilo.home.join(".config/kilo/opencode.json"), "{}").unwrap();
            let health = kilo.health_mcp();
            let warning = health
                .warnings
                .iter()
                .find(|w| shadow(w))
                .expect("shadow warning");
            assert!(
                warning.contains("~/.config/kilo/opencode.json")
                    && warning.contains("~/.kilo/kilo.jsonc")
                    && warning.contains("~/.config/kilo/kilo.jsonc"),
                "{warning}"
            );
            assert!(!serde_json::to_string(&health).unwrap().contains(SECRET));
        }

        // ── The bundled entries ──

        fn bundled_json(rel: &str) -> Value {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../resources/default-workspace")
                .join(rel);
            serde_json::from_str(&fs::read_to_string(path).expect("bundled file"))
                .expect("bundled JSON")
        }

        #[test]
        fn every_entry_pins_the_playwright_version_and_chooses_system_chrome_inline() {
            let home = Path::new("/home/someone");
            let bundled =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
            let browsers = crate::commands::cursor_profile::resolve_playwright_browsers_path(home)
                .expect("browsers path")
                .to_string_lossy()
                .into_owned();
            for harness in LIGHT {
                let entry =
                    crate::light_mcp::expected_entry(spec_of(harness), &bundled, home).unwrap();
                let text = entry.to_string();
                assert!(
                    text.contains(&format!(
                        "@playwright/mcp@{}",
                        crate::commands::cursor_profile::PLAYWRIGHT_MCP_VERSION
                    )),
                    "{text}"
                );
                assert!(!text.contains("@latest"), "{text}");
                // The sidecar is owned by the OpenCode config surface, and a missing file
                // crashes the server: these entries do not depend on it.
                assert!(
                    !text.contains("--config") && !text.contains("playwright-mcp"),
                    "{text}"
                );
                // System Chrome in an isolated profile, and no tools registered by a page.
                assert!(
                    text.contains(r#""--browser","chrome","--isolated","--no-webmcp""#),
                    "{text}"
                );
                assert!(!text.contains("chromium"), "{text}");
                // `text` is JSON, where a backslash is written twice.
                let escaped = serde_json::Value::String(browsers.clone()).to_string();
                assert!(text.contains(escaped.trim_matches('"')), "{text}");
                assert!(!text.contains("__PLAYWRIGHT_"), "{text}");
                // npx runs with the app's empty folder as its project, never the agent's.
                let prefix = crate::commands::cursor_profile::npx_prefix_path(home)
                    .expect("npx prefix")
                    .to_string_lossy()
                    .into_owned();
                let args = entry
                    .get("args")
                    .or_else(|| entry.get("command"))
                    .and_then(Value::as_array)
                    .expect("argument list");
                let at = args
                    .iter()
                    .position(|word| word == "--prefix")
                    .expect("--prefix");
                assert_eq!(args[at + 1], json!(prefix), "{text}");
                assert_eq!(args[at + 2], json!("-y"), "{text}");
                assert_eq!(
                    crate::light_mcp::pinned_version(&entry).as_deref(),
                    Some(crate::commands::cursor_profile::PLAYWRIGHT_MCP_VERSION)
                );
            }
        }

        #[test]
        fn the_entry_shapes_are_the_ones_each_harness_reads() {
            let copilot = bundled_json("templates/mcp/copilot.playwright.json");
            let keys = |value: &Value| -> Vec<String> {
                let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
                keys.sort();
                keys
            };
            assert_eq!(keys(&copilot), ["args", "command", "env", "tools", "type"]);
            assert_eq!(copilot["type"], "local");
            assert_eq!(copilot["command"], "npx");
            assert_eq!(copilot["tools"], json!(["*"]));

            // Pi refuses `type: "local"` and a command that is an array.
            let pi = bundled_json("templates/mcp/pi.playwright.json");
            assert_eq!(keys(&pi), ["args", "command", "description", "env"]);
            assert!(pi.get("type").is_none() && pi.get("exposure").is_none());
            assert_eq!(pi["command"], "npx");
            assert!(pi["description"]
                .as_str()
                .is_some_and(|text| !text.is_empty()));
            assert_eq!(pi["args"], copilot["args"]);
            assert_eq!(pi["env"], copilot["env"]);
            assert_eq!(
                copilot["args"].as_array().unwrap()[..3],
                [
                    json!("--prefix"),
                    json!("__PLAYWRIGHT_NPX_PREFIX_PATH__"),
                    json!("-y")
                ]
            );

            // Antigravity's stdio entry: command, args and env (its documented keys), nothing
            // the other harnesses add.
            let antigravity = bundled_json("templates/mcp/antigravity.playwright.json");
            assert_eq!(keys(&antigravity), ["args", "command", "env"]);
            assert_eq!(antigravity["command"], "npx");
            assert_eq!(antigravity["args"], copilot["args"]);
            assert_eq!(antigravity["env"], copilot["env"]);
        }

        #[test]
        fn kilos_entry_is_the_opencode_entry_apart_from_the_sidecar_flag() {
            let kilo = bundled_json("templates/mcp/kilo.playwright.json");
            let opencode = bundled_json("templates/opencode.json");
            let opencode = &opencode["mcp"]["playwright"];
            let keys = |value: &Value| -> std::collections::BTreeSet<String> {
                value.as_object().unwrap().keys().cloned().collect()
            };
            assert_eq!(keys(&kilo), keys(opencode));
            for key in ["type", "environment", "enabled"] {
                assert_eq!(kilo[key], opencode[key], "{key}");
            }
            let mut command: Vec<Value> = opencode["command"].as_array().unwrap().clone();
            let at = command
                .iter()
                .position(|word| word == "--config")
                .expect("the OpenCode entry points at the sidecar");
            assert_eq!(
                command[at + 1],
                json!("__PLAYWRIGHT_MCP_CONFIG_PATH__"),
                "the sidecar flag takes the config path"
            );
            command.drain(at..at + 2);
            assert_eq!(
                &command[command.len() - 4..],
                crate::commands::cursor_profile::PLAYWRIGHT_MCP_BROWSER_FLAGS.map(Value::from),
                "the browser flags follow the sidecar flag"
            );
            assert_eq!(kilo["command"], Value::Array(command.clone()));
            // Key order and every value too: the entry is the OpenCode one in all but the sidecar.
            let mut expected = opencode.clone();
            expected["command"] = Value::Array(command);
            assert_eq!(kilo.to_string(), expected.to_string());
        }

        #[test]
        fn the_central_harnesses_keep_the_sidecar_entries() {
            // Cursor and OpenCode are unchanged: they still point at the sidecar config.
            let cursor = bundled_json("templates/cursor/mcp/playwright.mcp.json");
            assert!(cursor
                .to_string()
                .contains("__PLAYWRIGHT_MCP_CONFIG_PATH__"));
            let opencode = bundled_json("templates/opencode.json");
            assert!(opencode["mcp"]["playwright"]
                .to_string()
                .contains("__PLAYWRIGHT_MCP_CONFIG_PATH__"));
        }

        #[test]
        fn the_bundled_templates_carry_no_credentials_and_a_poisoned_one_is_refused() {
            let home = Path::new("/home/someone");
            let bundled =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
            for harness in LIGHT {
                let text =
                    fs::read_to_string(bundled.join(&spec_of(harness).template_rel)).unwrap();
                assert!(!crate::commands::cursor_profile::json_has_unsafe_literals(
                    &text
                ));
            }
            let dir = std::env::temp_dir().join(format!(
                "aw-light-poisoned-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(dir.join("templates/mcp")).unwrap();
            let pi = spec_of(HarnessId::Pi);
            for body in [
                format!(r#"{{"command":"npx","env":{{"API_KEY":"{SECRET}"}}}}"#),
                r#"{"command":"npx","headers":{"Authorization":"Bearer abc"}}"#.to_string(),
                r#"{"command":"npx","args":["__PLAYWRIGHT_UNKNOWN__"]}"#.to_string(),
                "[]".to_string(),
                "{".to_string(),
            ] {
                fs::write(dir.join(&pi.template_rel), body).unwrap();
                assert!(
                    crate::light_mcp::expected_entry(pi, &dir, home).is_err(),
                    "a template the app would write must be clean"
                );
            }
            let _ = fs::remove_dir_all(dir);
        }

        // ═════════════════════════════════════════════════════════════════════════════════════
        // Grok Build: one table of a TOML file that may hold api keys, edited in place
        // ═════════════════════════════════════════════════════════════════════════════════════

        mod grok {
            use super::*;

            const GROK: HarnessId = HarnessId::Grok;

            /// A config of the user's: an api key with a comment, a model, another server with a
            /// token, a telemetry key and a trailing comment, in uneven formatting.
            fn user_toml() -> String {
                format!(
                    "# Grok Build\napi_key = \"{SECRET}\"   # personal\n\n[models]\ndefault  =  'grok-4'\n\n[mcp_servers.{PRIVATE_NAME}]\ncommand = \"npx\"\nargs = [ \"-y\",  \"private\" ]\nenv = {{ TOKEN = \"{SECRET}\" }}\n\n[telemetry]\nevents_api_key = '{SECRET}'\n# end\n"
                )
            }

            fn text(env: &M) -> String {
                String::from_utf8(env.bytes()).unwrap()
            }

            /// The file with the managed table (and the blank line before it) cut out.
            fn without_entry(text: &str) -> String {
                let start = text
                    .find("\n[mcp_servers.playwright]")
                    .expect("managed header");
                let end = text[start + 1..]
                    .find("\n[")
                    .map_or(text.len(), |offset| start + 1 + offset);
                format!("{}{}", &text[..start], &text[end..])
            }

            fn entry_of(env: &M) -> Option<Value> {
                crate::light_mcp::read(&env.dest(), env.spec())
                    .unwrap()
                    .and_then(|document| document.entry(env.spec()).cloned())
            }

            #[test]
            fn grok_mcp_is_off_by_default_and_the_file_is_the_toml_config() {
                let env = Env::new("grok-defaults", GROK);
                assert!(
                    !crate::agent_targets::default_enabled_ids().contains(&"grok_mcp".to_string())
                );
                assert!(!HarnessId::DEFAULT_ON.contains(&GROK));
                let plan = preview_setup(vec!["grok_mcp".into()]).unwrap();
                assert!(plan.operations.is_empty() && !plan.has_pending_changes);
                let spec = spec_of(GROK);
                assert_eq!(
                    spec.resolve_dest(&env.home),
                    env.home.join(".grok/config.toml")
                );
                assert_eq!(spec.display_path(&env.home), "~/.grok/config.toml");
                assert_eq!(spec.allowlist_root(&env.home), env.home);
                assert!(!spec.resolve_dest(&env.home).exists());
                // No rules target, surface or artifact exists for Grok.
                assert!(!crate::agent_targets::targets()
                    .iter()
                    .any(|target| target.id == "grok_rules"));
                assert_eq!(SetupSurfaceId::light_rules(GROK), None);
                assert_eq!(
                    serde_json::to_value(spec.surface).unwrap(),
                    json!("grok_mcp")
                );
                assert_eq!(
                    setup_transaction::artifact_backup_rel(&mcp_artifact(GROK)),
                    "grok-mcp"
                );
            }

            #[test]
            fn a_missing_config_is_created_owner_only_with_only_the_table() {
                let env = mcp_env("grok-create", GROK);
                assert_eq!(env.plan_mcp().kind, OperationKind::Create);
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                assert!(text(&env).starts_with("[mcp_servers.playwright]\ncommand = \"npx\"\n"));
                assert_eq!(entry_of(&env), Some(env.expected()));
                assert_eq!(env.plan_mcp().kind, OperationKind::NoChange);
                assert_eq!(env.status_mcp().state, InstallationState::Current);
                assert_eq!(env.recorded_mcp(), Some(env.entry_digest()));
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = fs::metadata(env.dest()).unwrap().permissions().mode() & 0o777;
                    assert_eq!(mode, 0o600);
                }
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert!(!env.dest().exists());
            }

            #[test]
            fn an_existing_config_gains_one_table_and_keeps_every_other_byte() {
                let env = mcp_env("grok-merge", GROK);
                let before = user_toml();
                env.put(&before);
                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Update);
                assert_eq!(planned.mcp, Some(EntryState::EntryMissing));
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                let after = text(&env);
                assert_eq!(
                    without_entry(&after),
                    before,
                    "api key, comments and layout stay"
                );
                assert_eq!(entry_of(&env), Some(env.expected()));
                assert_eq!(env.plan_mcp().kind, OperationKind::NoChange);

                // A rollback with no later edit puts the exact bytes back.
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert_eq!(text(&env), before);
            }

            #[test]
            fn a_rollback_after_later_edits_takes_out_only_the_table() {
                let env = mcp_env("grok-rollback", GROK);
                let before = user_toml();
                env.put(&before);
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                // Grok's /settings changes the model after the apply.
                env.put(text(&env).replace("'grok-4'", "'grok-5'"));
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert_eq!(text(&env), before.replace("'grok-4'", "'grok-5'"));
            }

            #[test]
            fn a_differing_entry_without_a_record_is_the_users_and_stays_untouched() {
                let env = mcp_env("grok-differs", GROK);
                let content = format!(
                    "{}\n[mcp_servers.playwright]\ncommand = \"my-own-playwright\"\n",
                    user_toml()
                );
                env.put(&content);
                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Conflict);
                assert_eq!(planned.mcp, Some(EntryState::Differs));
                env.assert_refused(content.as_bytes());
                let said = env.everything_said();
                for hidden in [SECRET, PRIVATE_NAME, "my-own-playwright", "api_key"] {
                    assert!(!said.contains(hidden), "{hidden}: {said}");
                }
            }

            #[test]
            fn an_older_entry_the_app_wrote_is_updated_in_place() {
                let env = mcp_env("grok-update", GROK);
                let older = "# Riggverk's entry\n[mcp_servers.playwright]\ncommand = \"npx\"\nargs = [\"-y\", \"@playwright/mcp@0.0.1\"]\n\n[telemetry]\nenabled = false\n";
                env.put(older);
                env.record_mcp(&env.entry_digest());
                let planned = env.plan_mcp();
                assert_eq!(planned.kind, OperationKind::Update);
                assert_eq!(planned.mcp, Some(EntryState::Differs));
                assert_eq!(env.health_mcp().mcp.status, "stale");
                let result = env.apply_mcp();
                assert!(result.success, "{}", result.message);
                let after = text(&env);
                assert!(
                    after.starts_with("# Riggverk's entry\n[mcp_servers.playwright]\n"),
                    "{after}"
                );
                assert!(
                    after.ends_with("\n[telemetry]\nenabled = false\n"),
                    "{after}"
                );
                assert_eq!(entry_of(&env), Some(env.expected()));
                let rolled = rollback_setup_transaction(result.transaction_id, false).unwrap();
                assert!(rolled.success, "{}", rolled.message);
                assert_eq!(text(&env), older);
            }

            #[test]
            fn toml_the_app_cannot_edit_in_place_is_refused_with_zero_mutation_and_no_file_text() {
                for (name, content, refusal) in [
                    (
                        "invalid",
                        format!("api_key = \"{SECRET}\"\nbroken = "),
                        Refusal::NotToml,
                    ),
                    (
                        "not a table",
                        format!("api_key = \"{SECRET}\"\nmcp_servers = \"{PRIVATE_NAME}\"\n"),
                        Refusal::KeyNotTable,
                    ),
                    (
                        "inline servers",
                        format!(
                            "mcp_servers = {{ {PRIVATE_NAME} = {{ command = \"{SECRET}\" }} }}\n"
                        ),
                        Refusal::TomlLayout,
                    ),
                    (
                        "inline entry",
                        format!("[mcp_servers]\nplaywright = {{ command = \"{SECRET}\" }}\n"),
                        Refusal::TomlLayout,
                    ),
                    (
                        "crlf",
                        format!("api_key = \"{SECRET}\"\r\n"),
                        Refusal::TomlLayout,
                    ),
                ] {
                    let env = mcp_env("grok-refused", GROK);
                    env.put(&content);
                    let planned = env.plan_mcp();
                    assert_eq!(planned.kind, OperationKind::Conflict, "{name}");
                    assert_eq!(planned.mcp, Some(EntryState::Refused(refusal)), "{name}");
                    let detail = env.status_mcp().surfaces[0].detail.clone();
                    assert!(detail.contains(refusal.message()), "{name}: {detail}");
                    assert!(detail.contains("plain TOML tables"), "{name}: {detail}");
                    env.assert_refused(content.as_bytes());
                    let said = env.everything_said();
                    for hidden in [SECRET, PRIVATE_NAME, "sk-live", "api_key"] {
                        assert!(!said.contains(hidden), "{name} {hidden}: {said}");
                    }
                    assert_eq!(env.health_mcp().mcp.status, "invalid", "{name}");
                }
            }

            #[test]
            fn the_fingerprint_follows_the_entry_not_the_rest_of_the_file() {
                let env = mcp_env("grok-fingerprint", GROK);
                let fingerprint = |env: &M| {
                    let planned = setup_transaction::plan_artifacts_for_surfaces(
                        &[env.surface()],
                        &env.ws,
                        &env.home,
                    )
                    .unwrap();
                    setup_transaction::compute_plan_fingerprint(
                        &env.ws,
                        &[env.surface()],
                        &planned,
                        &env.home,
                    )
                    .unwrap()
                };
                env.put(user_toml());
                let base = fingerprint(&env);
                env.put(user_toml().replace("'grok-4'", "'grok-5'"));
                assert_eq!(fingerprint(&env), base, "an unrelated key");
                env.put(format!(
                    "{}\n[mcp_servers.playwright]\ncommand = \"mine\"\n",
                    user_toml()
                ));
                assert_ne!(fingerprint(&env), base, "an entry of the user's own");
            }

            #[test]
            fn the_health_names_the_shared_rules_the_config_and_grok_home() {
                let env = mcp_env("grok-health", GROK);
                let health = env.health_mcp();
                assert_eq!(health.rules.status, "shared");
                assert_eq!(health.rules.path, "~/.claude/CLAUDE.md");
                assert!(
                    health.rules.detail.contains("Claude Code"),
                    "{}",
                    health.rules.detail
                );
                assert_eq!(health.mcp.path, "~/.grok/config.toml");
                assert_eq!(health.mcp.status, "missing");
                assert!(health.cli.detail.contains("grok"), "{}", health.cli.detail);
                assert_eq!(
                    health.skills.roots,
                    ["~/.claude/skills", "~/.agents/skills"]
                );

                // Without Claude Code's rules, none are installed for Grok, and the overall
                // status does not count that as something to fix.
                let mut settings = crate::settings::load();
                settings
                    .enabled_target_ids
                    .retain(|id| id != "claude_rules");
                crate::settings::save_with_revision_check(settings, None).unwrap();
                let none = env.health_mcp();
                assert_eq!(none.rules.status, "none");
                assert!(none
                    .rules
                    .detail
                    .starts_with("No rules are installed for Grok"));

                std::env::set_var("GROK_HOME", env.base.join("elsewhere"));
                let moved = env.health_mcp();
                assert!(
                    moved
                        .warnings
                        .iter()
                        .any(|warning| warning.starts_with("GROK_HOME is set")
                            && warning.contains("~/.grok/config.toml")),
                    "{:?}",
                    moved.warnings
                );
                std::env::remove_var("GROK_HOME");
            }
        }
    }
}
