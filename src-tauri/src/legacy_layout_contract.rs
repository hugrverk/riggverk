//! Upgrade contract: an install made under the earlier technical names keeps working, with no data
//! loss and no new conflicts.
//!
//! The earlier release kept its data folder at `~/.config/agent-workspace`, its state folder at
//! `.agent-workspace/`, and wrote rules blocks between `AGENT-WORKSPACE BASE` markers. This
//! release names all three `riggverk`. Reads work on the earlier layout in place; the first
//! mutation moves the folders and rewrites the markers. This file is the only place besides the
//! `LEGACY_*` constants that spells the earlier names out, because it proves how they are handled.
//!
//! Every test runs with a temp HOME, no real profile, and a temp backup folder.

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::artifact_registry::{AgentName, ArtifactId};
    use crate::commands::setup::{
        apply_setup, preview_setup, rollback_setup_transaction, SetupResult,
    };
    use crate::commands::{
        apply_rules_conversion, get_workspace_diagnostics, preview_rules_conversion,
        reset_active_workspace_path,
    };
    use crate::kept_files::{self, KeptFiles};
    use crate::managed_state::{
        artifact_identity, read_managed_state, ManagedArtifactRecord, ManagedState,
        MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::rules_block::{self, body_digest, RulesConflict, RulesPlan};
    use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
    use crate::test_env::{guard, set_test_user_dirs};

    const LEGACY_BEGIN: &str = "<!-- BEGIN AGENT-WORKSPACE BASE: managed by Riggverk; edits inside are replaced on update; add refinements below END -->";
    const LEGACY_END: &str = "<!-- END AGENT-WORKSPACE BASE -->";
    const NEW_BEGIN: &str = "<!-- BEGIN RIGGVERK BASE: managed by Riggverk; edits inside are replaced on update; add refinements below END -->";
    const NEW_END: &str = "<!-- END RIGGVERK BASE -->";

    const LEGACY_STATE: &str = ".agent-workspace";
    const NEW_STATE: &str = ".riggverk";
    const STATE_FILES: [&str; 5] = [
        "workspace.json",
        "managed-state.json",
        "rules-preferences.json",
        "kept-files.json",
        "config-preferences.json",
    ];

    const PREFIX: &str = "# My notes\n\nAlways answer in Swedish.\n\n";
    const SUFFIX: &str = "\n## My refinements\n- prefer small diffs\n- no emoji\n";

    const MARKER_JSON: &str =
        include_str!("../../resources/default-workspace/.agent-workspace/workspace.json");

    struct Home {
        base: PathBuf,
        home: PathBuf,
        backups: PathBuf,
        // Drop order matters: restore the environment before releasing the lock.
        _restore: guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Home {
        fn new(label: &str) -> Self {
            let lock = guard::lock();
            let restore = guard::isolate_data_location_env();
            crate::workspace_layout::clear_notes_for_test();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("riggverk-legacy-{label}-{nanos}"));
            fs::create_dir_all(base.join("home")).expect("home");
            let base = base.canonicalize().expect("canonical base");
            let home = base.join("home");
            let backups = base.join("backups");
            set_test_user_dirs(&home);
            unsafe {
                std::env::remove_var("CODEX_HOME");
                std::env::set_var("RIGGVERK_BACKUP_DIR", &backups);
            }
            let home = crate::test_env::process_home();
            Self {
                base,
                home,
                backups,
                _restore: restore,
                _lock: lock,
            }
        }

        fn legacy_ws(&self) -> PathBuf {
            self.home.join(".config/agent-workspace")
        }

        fn new_ws(&self) -> PathBuf {
            self.home.join(".config/riggverk")
        }

        fn claude_file(&self) -> PathBuf {
            self.home.join(".claude/CLAUDE.md")
        }

        fn codex_file(&self) -> PathBuf {
            self.home.join(".codex/AGENTS.md")
        }

        fn write(&self, path: &Path, text: &str) {
            fs::create_dir_all(path.parent().expect("parent")).expect("folder");
            fs::write(path, text).expect("write");
        }

        /// Seeds the data folder an earlier release left: ownership records, a "leave as is"
        /// choice, a kept file, a kept Codex key, and a rules file wrapped in the earlier markers.
        /// Returns the bytes of every state file.
        fn seed_legacy_install(&self, claude_body: &str) -> BTreeMap<String, Vec<u8>> {
            let ws = self.legacy_ws();
            let state = ws.join(LEGACY_STATE);
            fs::create_dir_all(&state).expect("state folder");

            let kept_artifact = ArtifactId::ClaudeAgent(AgentName::new("inspector").unwrap());
            let kept_dest = kept_files::dest_label(&kept_artifact, &self.home, &ws).expect("dest");
            let managed = ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"an earlier bundle"),
                artifacts: vec![
                    ManagedArtifactRecord {
                        identity: artifact_identity(&ArtifactId::ClaudeRules),
                        hash: body_digest(claude_body),
                        surface: Some("claude_rules".to_string()),
                        role_models: Default::default(),
                    },
                    ManagedArtifactRecord {
                        identity: "workspace:file:.agent-workspace/workspace.json".to_string(),
                        hash: crate::stable_digest::bytes(MARKER_JSON.as_bytes()),
                        surface: None,
                        role_models: Default::default(),
                    },
                ],
            };
            let files = [
                ("workspace.json", MARKER_JSON.to_string()),
                (
                    "managed-state.json",
                    serde_json::to_string_pretty(&managed).expect("managed state"),
                ),
                (
                    "rules-preferences.json",
                    format!(
                        "{{\"schema_version\":1,\"user_managed\":[{}]}}",
                        serde_json::to_string(&artifact_identity(&ArtifactId::CodexRules))
                            .expect("identity")
                    ),
                ),
                (
                    "kept-files.json",
                    serde_json::json!({
                        "schema_version": 1,
                        "kept": [{
                            "identity": artifact_identity(&kept_artifact),
                            "dest": kept_dest,
                        }]
                    })
                    .to_string(),
                ),
                (
                    "config-preferences.json",
                    serde_json::json!({
                        "schema_version": 1,
                        "codex_config": {
                            "dest": "~/.codex/config.toml",
                            "kept": { "approvals_reviewer": "auto_review" }
                        }
                    })
                    .to_string(),
                ),
            ];
            let mut bytes = BTreeMap::new();
            for (name, text) in files {
                fs::write(state.join(name), &text).expect("state file");
                bytes.insert(name.to_string(), text.into_bytes());
            }

            self.write(
                &self.claude_file(),
                &format!("{PREFIX}{LEGACY_BEGIN}\n{claude_body}{LEGACY_END}\n{SUFFIX}"),
            );
            // An edited block the user told the app to leave as is.
            self.write(
                &self.codex_file(),
                &format!("{LEGACY_BEGIN}\n# My own codex rules\n{LEGACY_END}\n"),
            );
            bytes
        }

        fn signature(&self, surfaces: &[&str]) -> Vec<(SetupSurfaceId, OperationKind)> {
            let plan =
                preview_setup(surfaces.iter().map(|s| s.to_string()).collect()).expect("preview");
            let mut signature: Vec<_> = plan
                .operations
                .iter()
                .map(|op| (op.surface, op.kind))
                .collect();
            signature.extend(
                plan.synced
                    .iter()
                    .map(|surface| (*surface, OperationKind::NoChange)),
            );
            signature
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

        fn diagnostics(&self) -> serde_json::Value {
            serde_json::to_value(get_workspace_diagnostics().expect("diagnostics"))
                .expect("diagnostics json")
        }

        fn tree(&self, root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
            let mut files = BTreeMap::new();
            let mut stack = vec![root.to_path_buf()];
            while let Some(dir) = stack.pop() {
                for entry in fs::read_dir(&dir).expect("read folder") {
                    let entry = entry.expect("entry");
                    let kind = entry.file_type().expect("type");
                    if kind.is_dir() {
                        stack.push(entry.path());
                    } else if kind.is_file() {
                        files.insert(
                            entry
                                .path()
                                .strip_prefix(root)
                                .expect("below")
                                .to_path_buf(),
                            fs::read(entry.path()).expect("read"),
                        );
                    }
                }
            }
            files
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn current_source(file: &str) -> String {
        let bundled = crate::setup_roots::bundled_root().expect("bundled root");
        fs::read_to_string(bundled.join("templates/sync").join(file)).expect("bundled rules")
    }

    /// A base an earlier release shipped (not the current one): the owner's installed block.
    fn shipped_old_claude_base() -> String {
        let bundled = crate::setup_roots::bundled_root().expect("bundled root");
        let current = current_source("claude-rules.md");
        crate::rules_convert::known_bases(&bundled, &ArtifactId::ClaudeRules)
            .into_iter()
            .map(|base| base.text)
            .find(|text| text != &current)
            .expect("an earlier shipped base")
    }

    fn resolved(diagnostics: &serde_json::Value) -> PathBuf {
        PathBuf::from(
            diagnostics["resolved_path"]
                .as_str()
                .expect("resolved path of a usable folder"),
        )
    }

    // ── workspace folder and state folder ──

    #[test]
    fn a_legacy_default_folder_is_read_in_place_and_nothing_is_written() {
        let env = Home::new("read-only");
        let old_base = shipped_old_claude_base();
        env.seed_legacy_install(&old_base);
        let before = env.tree(&env.legacy_ws());

        let diagnostics = env.diagnostics();
        assert_eq!(diagnostics["valid"], true, "{diagnostics}");
        assert_eq!(resolved(&diagnostics), env.legacy_ws());

        // The ownership records are read from the earlier state folder: the shipped base the
        // record names is an update, and the left-as-is Codex file is not a conflict.
        let signature = env.signature(&["claude_rules", "codex_rules"]);
        assert!(
            signature.contains(&(SetupSurfaceId::ClaudeRules, OperationKind::Update)),
            "{signature:?}"
        );
        assert!(
            !signature
                .iter()
                .any(|(_, kind)| *kind == OperationKind::Conflict),
            "{signature:?}"
        );
        let kept = KeptFiles::load(&env.legacy_ws());
        let artifact = ArtifactId::ClaudeAgent(AgentName::new("inspector").unwrap());
        let dest = kept_files::dest_label(&artifact, &env.home, &env.legacy_ws()).unwrap();
        assert!(
            kept.contains(&artifact, &dest),
            "kept file is read in place"
        );
        assert!(crate::rules_preferences::is_user_managed(
            &env.legacy_ws(),
            &ArtifactId::CodexRules
        ));
        assert!(crate::config_preferences::load_codex_config(&env.legacy_ws()).is_some());

        assert!(
            !env.new_ws().exists(),
            "reading must not create the new folder"
        );
        assert_eq!(env.tree(&env.legacy_ws()), before, "reads wrote nothing");
    }

    #[test]
    fn the_first_apply_moves_the_folder_and_its_state_and_the_plan_stays_the_same() {
        let env = Home::new("first-apply");
        let old_base = shipped_old_claude_base();
        let seeded = env.seed_legacy_install(&old_base);
        let codex_before = env.signature(&["codex_rules"]);

        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);

        // The folder and the state folder moved as a whole.
        assert!(!env.legacy_ws().exists(), "the earlier folder is gone");
        assert!(env.new_ws().is_dir());
        assert!(!env.new_ws().join(LEGACY_STATE).exists());
        for name in STATE_FILES {
            assert!(
                env.new_ws().join(NEW_STATE).join(name).is_file(),
                "{name} moved to the new state folder"
            );
        }
        // Everything but the records the apply rewrote is byte for byte what it was.
        for name in STATE_FILES
            .iter()
            .filter(|name| **name != "managed-state.json")
        {
            assert_eq!(
                fs::read(env.new_ws().join(NEW_STATE).join(name)).unwrap(),
                seeded[*name],
                "{name} is unchanged by the move"
            );
        }
        assert_eq!(resolved(&env.diagnostics()), env.new_ws());

        // The ownership records still match: the base was recorded, the marker record survived.
        let state = read_managed_state(&env.new_ws()).expect("records");
        let source = current_source("claude-rules.md");
        let claude = artifact_identity(&ArtifactId::ClaudeRules);
        assert_eq!(
            state
                .artifacts
                .iter()
                .find(|r| r.identity == claude)
                .map(|r| r.hash.clone()),
            Some(body_digest(&source))
        );
        assert!(state
            .artifacts
            .iter()
            .any(|r| r.identity == "workspace:file:.agent-workspace/workspace.json"));

        // The file got the current markers; the user's text is untouched.
        assert_eq!(
            fs::read_to_string(env.claude_file()).unwrap(),
            format!("{PREFIX}{NEW_BEGIN}\n{source}{NEW_END}\n{SUFFIX}")
        );

        // Nothing new is planned, and every earlier choice still applies.
        let after = env.signature(&["claude_rules", "codex_rules"]);
        assert!(
            after.contains(&(SetupSurfaceId::ClaudeRules, OperationKind::NoChange)),
            "{after:?}"
        );
        let codex_after: Vec<_> = after
            .iter()
            .filter(|(surface, _)| *surface == SetupSurfaceId::CodexRules)
            .copied()
            .collect();
        assert_eq!(codex_after, codex_before);
        assert!(!after
            .iter()
            .any(|(_, kind)| *kind == OperationKind::Conflict));
        let artifact = ArtifactId::ClaudeAgent(AgentName::new("inspector").unwrap());
        let dest = kept_files::dest_label(&artifact, &env.home, &env.new_ws()).unwrap();
        assert!(KeptFiles::load(&env.new_ws()).contains(&artifact, &dest));
        assert!(crate::rules_preferences::is_user_managed(
            &env.new_ws(),
            &ArtifactId::CodexRules
        ));
        let kept = crate::config_preferences::load_codex_config(&env.new_ws()).expect("kept key");
        assert_eq!(
            kept.kept.get("approvals_reviewer").map(String::as_str),
            Some("auto_review")
        );
    }

    #[test]
    fn when_both_folders_exist_the_new_one_is_used_and_the_earlier_one_is_left_alone() {
        let env = Home::new("both-exist");
        let old_base = shipped_old_claude_base();
        env.seed_legacy_install(&old_base);
        let legacy_before = env.tree(&env.legacy_ws());
        // A new folder with its own (empty) records.
        let state = env.new_ws().join(NEW_STATE);
        fs::create_dir_all(&state).expect("new state folder");
        fs::write(
            state.join("managed-state.json"),
            serde_json::to_string(&ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: vec![],
            })
            .unwrap(),
        )
        .unwrap();

        assert_eq!(resolved(&env.diagnostics()), env.new_ws());
        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);

        assert_eq!(
            env.tree(&env.legacy_ws()),
            legacy_before,
            "the earlier folder is never merged or modified"
        );
        assert_eq!(resolved(&env.diagnostics()), env.new_ws());
        assert!(
            read_managed_state(&env.new_ws())
                .expect("records")
                .artifacts
                .iter()
                .any(|r| r.identity == artifact_identity(&ArtifactId::ClaudeRules)),
            "the apply recorded into the new folder"
        );
        let notes = env.diagnostics()["layout_notes"].to_string();
        assert!(
            notes.contains("agent-workspace") && notes.contains("untouched"),
            "the leftover is reported: {notes}"
        );
    }

    #[test]
    fn a_saved_custom_folder_is_never_moved_and_only_its_state_folder_is_renamed() {
        let env = Home::new("custom");
        let old_base = shipped_old_claude_base();
        env.seed_legacy_install(&old_base);
        let legacy_before = env.tree(&env.legacy_ws());

        let custom = env.base.join("custom-folder");
        fs::create_dir_all(custom.join(LEGACY_STATE)).unwrap();
        fs::write(
            custom.join(LEGACY_STATE).join("managed-state.json"),
            serde_json::to_string(&ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: vec![ManagedArtifactRecord {
                    identity: artifact_identity(&ArtifactId::ClaudeRules),
                    hash: body_digest(&shipped_old_claude_base()),
                    surface: None,
                    role_models: Default::default(),
                }],
            })
            .unwrap(),
        )
        .unwrap();
        crate::settings::mutate_settings(|settings| {
            settings.workspace_path = Some(custom.to_string_lossy().into_owned());
            Ok(crate::settings::MutationOutcome::Changed)
        })
        .expect("save the custom folder");

        assert_eq!(resolved(&env.diagnostics()), custom.canonicalize().unwrap());
        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);

        assert_eq!(
            crate::settings::load().workspace_path.as_deref(),
            Some(custom.to_string_lossy().as_ref()),
            "the saved path is never rewritten"
        );
        assert!(custom.is_dir(), "the custom folder stays where it is");
        assert!(!env.new_ws().exists(), "no default folder is created");
        assert_eq!(
            env.tree(&env.legacy_ws()),
            legacy_before,
            "the earlier default folder is not touched"
        );
        assert!(custom.join(NEW_STATE).join("managed-state.json").is_file());
        assert!(!custom.join(LEGACY_STATE).exists());
    }

    #[test]
    fn a_saved_custom_folder_known_only_by_its_marker_stays_configured_after_the_move() {
        let env = Home::new("custom-marker-only");
        env.write(
            &env.claude_file(),
            &format!(
                "{LEGACY_BEGIN}\n{}{LEGACY_END}\n",
                shipped_old_claude_base()
            ),
        );
        let custom = env.base.join("marker-folder");
        fs::create_dir_all(custom.join(LEGACY_STATE)).unwrap();
        fs::write(
            custom.join(LEGACY_STATE).join("workspace.json"),
            MARKER_JSON,
        )
        .unwrap();
        let saved = custom.to_string_lossy().into_owned();
        crate::settings::mutate_settings(|settings| {
            settings.workspace_path = Some(saved.clone());
            Ok(crate::settings::MutationOutcome::Changed)
        })
        .expect("save the custom folder");
        assert_eq!(resolved(&env.diagnostics()), custom.canonicalize().unwrap());

        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);

        assert!(custom.join(NEW_STATE).join("workspace.json").is_file());
        assert!(!custom.join(LEGACY_STATE).exists());
        assert_eq!(resolved(&env.diagnostics()), custom.canonicalize().unwrap());
        assert_eq!(
            crate::settings::load().workspace_path.as_deref(),
            Some(saved.as_str()),
            "the folder is still recognised, so the saved path is not cleared"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_move_keeps_working_in_the_earlier_folder_and_reports_it() {
        use std::os::unix::fs::PermissionsExt;
        let env = Home::new("rename-fails");
        let old_base = shipped_old_claude_base();
        env.seed_legacy_install(&old_base);
        let config = env.home.join(".config");
        fs::set_permissions(&config, fs::Permissions::from_mode(0o555)).unwrap();
        let writable = fs::File::create(config.join("probe")).is_ok();
        if writable {
            // Privileges that ignore directory modes: the failure cannot be staged.
            let _ = fs::set_permissions(&config, fs::Permissions::from_mode(0o755));
            return;
        }

        let result = env.apply("claude_rules");
        let diagnostics = env.diagnostics();
        let _ = fs::set_permissions(&config, fs::Permissions::from_mode(0o755));

        assert!(result.success, "{}", result.message);
        assert!(env.legacy_ws().is_dir(), "never a half move");
        assert!(!env.new_ws().exists());
        assert_eq!(resolved(&diagnostics), env.legacy_ws());
        assert!(
            read_managed_state(&env.legacy_ws())
                .expect("records")
                .artifacts
                .iter()
                .any(
                    |r| r.identity == artifact_identity(&ArtifactId::ClaudeRules)
                        && r.hash == body_digest(&current_source("claude-rules.md"))
                ),
            "the apply still recorded its work"
        );
        assert!(
            diagnostics["layout_notes"]
                .to_string()
                .contains("kept using"),
            "{}",
            diagnostics["layout_notes"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_earlier_folder_is_never_moved() {
        let env = Home::new("symlink");
        let target = env.base.join("elsewhere");
        fs::create_dir_all(target.join(LEGACY_STATE)).unwrap();
        fs::create_dir_all(env.home.join(".config")).unwrap();
        std::os::unix::fs::symlink(&target, env.legacy_ws()).unwrap();
        env.write(
            &env.claude_file(),
            &format!(
                "{LEGACY_BEGIN}\n{}{LEGACY_END}\n",
                shipped_old_claude_base()
            ),
        );

        let plan = preview_setup(vec!["claude_rules".to_string()]);
        let applied = plan.and_then(|plan| {
            apply_setup(
                vec!["claude_rules".to_string()],
                false,
                plan.plan_fingerprint,
                plan.preview_token,
            )
        });
        assert!(
            applied.map(|result| !result.success).unwrap_or(true),
            "the apply must refuse a linked workspace folder"
        );
        assert!(fs::symlink_metadata(env.legacy_ws())
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!env.new_ws().exists());
        assert!(target.join(LEGACY_STATE).is_dir());
    }

    #[test]
    fn an_empty_current_folder_counts_as_absent_and_the_earlier_one_replaces_it() {
        let env = Home::new("empty-current");
        let old_base = shipped_old_claude_base();
        env.seed_legacy_install(&old_base);
        fs::create_dir_all(env.new_ws()).unwrap();

        assert_eq!(
            resolved(&env.diagnostics()),
            env.legacy_ws(),
            "an empty folder holds nothing: the earlier one is read"
        );
        let notes = env.diagnostics()["layout_notes"].to_string();
        assert!(!notes.contains("still exists"), "{notes}");

        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert!(!env.legacy_ws().exists());
        assert!(env
            .new_ws()
            .join(NEW_STATE)
            .join("managed-state.json")
            .is_file());
        assert_eq!(resolved(&env.diagnostics()), env.new_ws());
    }

    #[test]
    fn a_workspace_key_maps_the_earlier_folder_only_for_the_default_origin_before_the_move() {
        use crate::setup_transaction::workspace_key;
        let env = Home::new("keys");
        let key = |path: &Path| workspace_key(path).expect("key");
        let (earlier, current) = (env.legacy_ws(), env.new_ws());
        // Without a state folder it is not Riggverk's folder: never the default workspace.
        fs::create_dir_all(&earlier).unwrap();
        assert_eq!(key(&earlier), earlier.to_string_lossy());
        fs::create_dir_all(earlier.join(LEGACY_STATE)).unwrap();

        // The default folder waiting for its first move is the same workspace as after it.
        assert_eq!(key(&earlier), key(&current));

        // An explicit override or a saved custom folder at that path is its own workspace.
        unsafe { std::env::set_var("RIGGVERK_WORKSPACE_PATH", &earlier) };
        assert_eq!(key(&earlier), earlier.to_string_lossy());
        unsafe { std::env::remove_var("RIGGVERK_WORKSPACE_PATH") };
        let saved = earlier.to_string_lossy().into_owned();
        fs::write(
            earlier.join(LEGACY_STATE).join("workspace.json"),
            MARKER_JSON,
        )
        .unwrap();
        crate::settings::mutate_settings(|settings| {
            settings.workspace_path = Some(saved.clone());
            Ok(crate::settings::MutationOutcome::Changed)
        })
        .expect("save");
        assert_eq!(key(&earlier), saved);
        crate::settings::mutate_settings(|settings| {
            settings.workspace_path = None;
            Ok(crate::settings::MutationOutcome::Changed)
        })
        .expect("clear");
        assert_eq!(key(&earlier), key(&current));

        // Both folders hold something: the earlier path is no longer the default.
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("mine.txt"), "x").unwrap();
        assert_eq!(key(&earlier), earlier.to_string_lossy());

        // After the move, a key recorded for the earlier folder names the current one.
        fs::remove_dir_all(&earlier).unwrap();
        assert_eq!(key(&earlier), key(&current));
    }

    #[test]
    fn a_dry_run_rollback_never_performs_the_move() {
        let env = Home::new("dry-run");
        let old_base = shipped_old_claude_base();
        env.seed_legacy_install(&old_base);
        let applied = env.apply("claude_rules");
        assert!(applied.success, "{}", applied.message);
        // Put the install back as the earlier release had it, with its manifest.
        fs::rename(
            env.new_ws().join(NEW_STATE),
            env.new_ws().join(LEGACY_STATE),
        )
        .unwrap();
        fs::rename(env.new_ws(), env.legacy_ws()).unwrap();
        record_as_earlier_release(&env, &applied.transaction_id);

        let dry =
            rollback_setup_transaction(applied.transaction_id.clone(), true).expect("dry run");
        assert!(dry.success, "{}", dry.message);
        assert!(
            env.legacy_ws().join(LEGACY_STATE).is_dir(),
            "a dry run moves nothing"
        );
        assert!(!env.new_ws().exists());

        let real =
            rollback_setup_transaction(applied.transaction_id.clone(), false).expect("rollback");
        assert!(real.success, "{}", real.message);
        assert!(env.new_ws().is_dir() && !env.legacy_ws().exists());
    }

    #[test]
    fn resetting_the_workspace_names_the_variable_that_is_set() {
        let env = Home::new("reset-names");
        unsafe { std::env::set_var("AGENT_WORKSPACE_PATH", env.base.join("somewhere")) };
        let error = reset_active_workspace_path().expect_err("an override blocks the reset");
        assert!(error.contains("AGENT_WORKSPACE_PATH"), "{error}");
        unsafe { std::env::set_var("RIGGVERK_WORKSPACE_PATH", env.base.join("somewhere")) };
        let error = reset_active_workspace_path().expect_err("an override blocks the reset");
        assert!(error.contains("RIGGVERK_WORKSPACE_PATH"), "{error}");
    }

    // ── environment variable aliases ──

    fn existing_folder(env: &Home, name: &str) -> PathBuf {
        let path = env.base.join(name);
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn the_workspace_path_variable_has_an_earlier_alias_and_the_new_name_wins() {
        let env = Home::new("env-path");
        let from_alias = existing_folder(&env, "from-alias");
        let from_new = existing_folder(&env, "from-new");

        unsafe { std::env::set_var("AGENT_WORKSPACE_PATH", &from_alias) };
        assert_eq!(resolved(&env.diagnostics()), from_alias, "the alias alone");

        unsafe { std::env::set_var("RIGGVERK_WORKSPACE_PATH", &from_new) };
        assert_eq!(resolved(&env.diagnostics()), from_new, "both set: new wins");

        unsafe { std::env::remove_var("AGENT_WORKSPACE_PATH") };
        assert_eq!(resolved(&env.diagnostics()), from_new, "the new name alone");
    }

    #[test]
    fn the_backup_folder_variable_has_an_earlier_alias_and_the_new_name_wins() {
        let env = Home::new("env-backup");
        let alias = env.base.join("alias-backups");
        let new = env.base.join("new-backups");
        let backup_root = |env: &Home| {
            env.diagnostics()["backup_root"]
                .as_str()
                .unwrap()
                .to_string()
        };

        unsafe {
            std::env::remove_var("RIGGVERK_BACKUP_DIR");
            std::env::set_var("AGENT_WORKSPACE_BACKUP_DIR", &alias);
        }
        assert_eq!(
            backup_root(&env),
            alias.to_string_lossy(),
            "the alias alone"
        );

        unsafe { std::env::set_var("RIGGVERK_BACKUP_DIR", &new) };
        assert_eq!(
            backup_root(&env),
            new.to_string_lossy(),
            "both set: new wins"
        );

        unsafe { std::env::remove_var("AGENT_WORKSPACE_BACKUP_DIR") };
        assert_eq!(
            backup_root(&env),
            new.to_string_lossy(),
            "the new name alone"
        );
        assert!(env.backups.to_string_lossy() != new.to_string_lossy());
    }

    // ── rules markers ──

    fn assess_text(
        text: &str,
        source: &str,
        managed: Option<&str>,
    ) -> rules_block::RulesAssessment {
        rules_block::assess(Some(text.as_bytes()), source, managed, &|_| false)
    }

    #[test]
    fn both_marker_spellings_are_detected_and_a_mixed_pair_is_malformed() {
        let body = "# Base\n\n- one\n";
        for (begin, end) in [(LEGACY_BEGIN, LEGACY_END), (NEW_BEGIN, NEW_END)] {
            let text = format!("mine\n{begin}\n{body}{end}\ntail\n");
            let file = rules_block::parse(&text)
                .expect("parses")
                .expect("has a block");
            assert_eq!(file.body, body);
            assert_eq!(file.prefix, "mine\n");
            assert_eq!(file.suffix, "tail\n");
        }
        for (begin, end) in [(LEGACY_BEGIN, NEW_END), (NEW_BEGIN, LEGACY_END)] {
            let text = format!("{begin}\n{body}{end}\n");
            let assessment = assess_text(&text, body, None);
            assert_eq!(
                assessment.plan,
                RulesPlan::Conflict(RulesConflict::MalformedMarkers),
                "{begin} with {end}"
            );
        }
        // One of each spelling is two blocks.
        let two = format!("{LEGACY_BEGIN}\nx\n{LEGACY_END}\n{NEW_BEGIN}\ny\n{NEW_END}\n");
        assert!(rules_block::parse(&two).is_err());
    }

    #[test]
    fn a_legacy_marked_block_with_a_shipped_base_updates_and_gets_both_new_markers() {
        let old = "# Old shipped base\n\n- one\n";
        let new = "# Base\n\n- one\n- two\n";
        let is_shipped = |digest: &str| digest == body_digest(old);
        for (prefix, suffix, eol) in [
            (PREFIX, SUFFIX, "\n"),
            ("\u{feff}top\r\n", "\r\nrefinement\r\n", "\r\n"),
        ] {
            let text = format!(
                "{prefix}{LEGACY_BEGIN}{eol}{}{LEGACY_END}{eol}{suffix}",
                old.replace('\n', eol)
            );
            let assessment = rules_block::assess(Some(text.as_bytes()), new, None, &is_shipped);
            assert_eq!(assessment.plan, RulesPlan::UpdateBlock, "not a conflict");
            let file = rules_block::parse(&text).unwrap().unwrap();
            assert_eq!(
                file.render_with_body(new),
                format!(
                    "{prefix}{NEW_BEGIN}{eol}{}{NEW_END}{eol}{suffix}",
                    new.replace('\n', eol)
                ),
                "refinements are kept byte for byte"
            );
        }
    }

    #[test]
    fn an_edited_legacy_block_is_a_conflict_as_before() {
        let text = format!("{LEGACY_BEGIN}\n# Old\n- my edit\n{LEGACY_END}\n");
        let assessment = assess_text(&text, "# Base\n", Some(&body_digest("# Old\n")));
        assert_eq!(
            assessment.plan,
            RulesPlan::Conflict(RulesConflict::BaseBlockEdited)
        );
    }

    #[test]
    fn a_block_with_the_current_base_keeps_its_spelling_until_the_base_changes() {
        // No churn: markers alone are not a reason to rewrite a current file.
        let base = "# Base\n";
        let text = format!("{LEGACY_BEGIN}\n{base}{LEGACY_END}\n");
        assert_eq!(assess_text(&text, base, None).plan, RulesPlan::NoChange);
    }

    #[test]
    fn convert_works_from_legacy_marked_and_plain_files_and_writes_new_markers() {
        let env = Home::new("convert");
        let source = current_source("claude-rules.md");

        // A legacy-marked file whose block the user edited.
        env.write(
            &env.claude_file(),
            &format!(
                "mine\n{LEGACY_BEGIN}\n# Base\n- edited inside\n{LEGACY_END}\n## Mine\nkept\n"
            ),
        );
        let preview = preview_rules_conversion("claude_rules".into()).expect("preview");
        assert!(preview.applicable, "{:?}", preview.reason);
        assert!(preview
            .result
            .starts_with(&format!("mine\n{NEW_BEGIN}\n{source}{NEW_END}\n")));
        assert!(preview.result.ends_with("## Mine\nkept\n"));
        let result = apply_rules_conversion(
            "claude_rules".into(),
            preview.plan_fingerprint,
            preview.preview_token,
        )
        .expect("apply");
        assert!(result.success, "{}", result.message);
        let written = fs::read_to_string(env.claude_file()).unwrap();
        assert!(written.contains(NEW_BEGIN) && written.contains(NEW_END));
        assert!(!written.contains("AGENT-WORKSPACE"), "{written}");

        // A plain file with no markers at all.
        env.write(&env.claude_file(), "# Only my own rules\n\n- be brief\n");
        let preview = preview_rules_conversion("claude_rules".into()).expect("preview");
        assert!(preview.applicable, "{:?}", preview.reason);
        assert!(preview.result.starts_with(NEW_BEGIN), "{}", preview.result);
        assert!(preview.result.contains("- be brief"));
    }

    // ── rollback of a transaction recorded before the move ──

    fn manifest_path(env: &Home, transaction_id: &str) -> PathBuf {
        env.backups
            .join("setup")
            .join(transaction_id)
            .join("manifest.json")
    }

    /// Makes the stored manifest read as the earlier release wrote it: keyed by the earlier folder.
    fn record_as_earlier_release(env: &Home, transaction_id: &str) {
        let path = manifest_path(env, transaction_id);
        let mut manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        manifest["workspace_key"] =
            serde_json::Value::String(env.legacy_ws().to_string_lossy().into_owned());
        fs::write(&path, serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
    }

    #[test]
    fn rolling_back_a_transaction_recorded_before_the_move_remaps_the_folder() {
        let env = Home::new("rollback-remap");
        let old_base = shipped_old_claude_base();
        env.seed_legacy_install(&old_base);
        let before = fs::read_to_string(env.claude_file()).unwrap();

        let applied = env.apply("claude_rules");
        assert!(applied.success, "{}", applied.message);
        assert!(env.new_ws().is_dir() && !env.legacy_ws().exists());
        record_as_earlier_release(&env, &applied.transaction_id);

        let rolled = rollback_setup_transaction(applied.transaction_id.clone(), false)
            .expect("rollback runs");
        assert!(rolled.success, "{}", rolled.message);
        assert_eq!(fs::read_to_string(env.claude_file()).unwrap(), before);
        // The previous records came back with it, into the folder as it is now.
        assert!(read_managed_state(&env.new_ws())
            .expect("records")
            .artifacts
            .iter()
            .any(
                |r| r.identity == artifact_identity(&ArtifactId::ClaudeRules)
                    && r.hash == body_digest(&old_base)
            ));
    }

    #[test]
    fn rolling_back_is_refused_when_the_earlier_folder_still_exists_next_to_the_new_one() {
        let env = Home::new("rollback-refuse");
        let old_base = shipped_old_claude_base();
        env.seed_legacy_install(&old_base);
        let applied = env.apply("claude_rules");
        assert!(applied.success, "{}", applied.message);
        record_as_earlier_release(&env, &applied.transaction_id);
        // Another folder under the earlier name appeared again: the manifest could mean either.
        fs::create_dir_all(env.legacy_ws()).unwrap();
        let after_apply = fs::read_to_string(env.claude_file()).unwrap();

        let rolled = rollback_setup_transaction(applied.transaction_id.clone(), false)
            .expect("rollback runs");
        assert!(!rolled.success, "{}", rolled.message);
        assert!(
            rolled.message.contains("still exists"),
            "a clear message: {}",
            rolled.message
        );
        assert_eq!(fs::read_to_string(env.claude_file()).unwrap(), after_apply);
    }

    // ── the end of an upgrade: nothing in the new layout names the old one ──

    #[test]
    fn a_fresh_profile_gets_only_the_new_names() {
        let env = Home::new("fresh");
        assert!(!env.new_ws().exists() && !env.legacy_ws().exists());
        let diagnostics = env.diagnostics();
        assert_eq!(diagnostics["valid"], true, "{diagnostics}");
        assert!(
            !env.new_ws().exists() && !env.legacy_ws().exists(),
            "nothing is created at launch"
        );

        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert!(env
            .new_ws()
            .join(NEW_STATE)
            .join("managed-state.json")
            .is_file());
        assert!(!env.legacy_ws().exists());
        assert_eq!(
            fs::read_to_string(env.claude_file()).unwrap(),
            rules_block::render_new(&current_source("claude-rules.md"))
        );
        assert!(fs::read_to_string(env.claude_file())
            .unwrap()
            .starts_with(NEW_BEGIN));
    }

    // ── a folder under the earlier name that Riggverk never used ──

    /// A folder at the earlier default path that another tool made: no state folder of either name.
    fn seed_foreign_folder(env: &Home) {
        env.write(&env.legacy_ws().join("config.toml"), "owner = \"other\"\n");
        env.write(&env.legacy_ws().join("data/notes.txt"), "not Riggverk's\n");
    }

    #[test]
    fn a_foreign_folder_under_the_earlier_name_is_never_read_moved_or_reported() {
        use crate::setup_transaction::workspace_key;
        let env = Home::new("foreign");
        seed_foreign_folder(&env);
        let before = env.tree(&env.legacy_ws());

        let diagnostics = env.diagnostics();
        assert_eq!(diagnostics["valid"], true, "{diagnostics}");
        assert_eq!(resolved(&diagnostics), env.new_ws(), "a fresh profile");
        assert_eq!(
            workspace_key(&env.legacy_ws()).unwrap(),
            env.legacy_ws().to_string_lossy(),
            "the other folder is not the default workspace"
        );

        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);

        assert_eq!(
            env.tree(&env.legacy_ws()),
            before,
            "the other folder is byte for byte what it was"
        );
        assert!(!env.legacy_ws().join(NEW_STATE).exists());
        assert!(!env.legacy_ws().join(LEGACY_STATE).exists());
        assert!(env
            .new_ws()
            .join(NEW_STATE)
            .join("managed-state.json")
            .is_file());
        assert!(!env.new_ws().join("config.toml").exists(), "nothing moved");
        let diagnostics = env.diagnostics();
        assert_eq!(resolved(&diagnostics), env.new_ws());
        let notes = diagnostics["layout_notes"].to_string();
        assert!(!notes.contains("agent-workspace"), "{notes}");
    }

    #[test]
    fn a_foreign_folder_under_the_earlier_name_chosen_explicitly_is_used() {
        let env = Home::new("foreign-explicit");
        seed_foreign_folder(&env);
        unsafe { std::env::set_var("RIGGVERK_WORKSPACE_PATH", env.legacy_ws()) };

        assert_eq!(resolved(&env.diagnostics()), env.legacy_ws());
        let result = env.apply("claude_rules");
        assert!(result.success, "{}", result.message);
        assert!(env
            .legacy_ws()
            .join(NEW_STATE)
            .join("managed-state.json")
            .is_file());
        assert!(env.legacy_ws().join("config.toml").is_file());
        assert!(!env.new_ws().exists(), "the chosen folder is never moved");
    }
}
