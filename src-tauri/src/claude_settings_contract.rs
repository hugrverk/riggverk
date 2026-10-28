//! End-to-end contract for the attribution values of Claude Code's `settings.json`.
//!
//! Drives the real preview, apply, rollback and uninstall paths against a temp HOME and
//! workspace; never touches the real profile.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use serde_json::{Map, Value};

    use crate::artifact_registry::ArtifactId;
    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, rollback_setup_transaction,
        SetupResult,
    };
    use crate::managed_state::{artifact_identity, read_managed_state};
    use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
    use crate::setup_transaction::{self, PreviousState, RollbackAction};
    use crate::test_env::{guard, set_test_user_dirs};

    const SURFACE: &str = "claude_config";
    /// What a user keeps in settings.json, in an order worth keeping.
    const USER_FILE: &str = "{\n  \"env\": {\n    \"FOO\": \"1\"\n  },\n  \"permissions\": {\n    \"allow\": [\n      \"Bash(ls)\"\n    ]\n  },\n  \"hooks\": {\n    \"PreToolUse\": []\n  },\n  \"model\": \"opus\"\n}\n";

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
            let base = std::env::temp_dir().join(format!("aw-claude-settings-{label}-{nanos}"));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(base.join("home")).expect("home");
            fs::create_dir_all(base.join("workspace")).expect("workspace");
            set_test_user_dirs(&base.join("home"));
            let ws = base.join("workspace").canonicalize().expect("workspace");
            unsafe {
                std::env::set_var("AGENT_WORKSPACE_PATH", &ws);
                std::env::set_var("AGENT_WORKSPACE_BACKUP_DIR", base.join("backups"));
            }
            let home = crate::platform_paths::resolve_user_home(
                &crate::platform_paths::PlatformEnv::from_process_env(),
                crate::platform_paths::Platform::current(),
            )
            .expect("resolved home");
            // The target is off by default; these tests are about it being on.
            let mut settings = crate::settings::load();
            settings.enabled_target_ids.push(SURFACE.to_string());
            settings.enabled_target_ids =
                crate::agent_targets::normalize_enabled_ids(&settings.enabled_target_ids);
            crate::settings::save_with_revision_check(settings, None).expect("settings");
            Self {
                base,
                home,
                ws,
                _restore: restore,
                _lock: lock,
            }
        }

        fn settings(&self) -> PathBuf {
            self.home.join(".claude/settings.json")
        }

        fn write_settings(&self, text: &str) {
            fs::create_dir_all(self.settings().parent().unwrap()).unwrap();
            fs::write(self.settings(), text).unwrap();
        }

        fn read_settings(&self) -> String {
            fs::read_to_string(self.settings()).expect("settings.json")
        }

        fn planned(&self) -> setup_transaction::PlannedArtifact {
            setup_transaction::plan_artifacts_for_surfaces(
                &[SetupSurfaceId::ClaudeConfig],
                &self.ws,
                &self.home,
            )
            .expect("plan")
            .into_iter()
            .find(|planned| planned.artifact == ArtifactId::ClaudeSettings)
            .expect("settings.json planned")
        }

        fn apply(&self) -> SetupResult {
            self.apply_surfaces(&[SURFACE])
        }

        fn apply_surfaces(&self, surfaces: &[&str]) -> SetupResult {
            let surfaces: Vec<String> = surfaces.iter().map(|s| s.to_string()).collect();
            let plan = preview_setup(surfaces.clone()).expect("preview");
            let result = apply_setup(surfaces, false, plan.plan_fingerprint, plan.preview_token)
                .expect("apply");
            assert!(result.success, "apply: {}", result.message);
            result
        }

        /// Applies the Claude rules file alone: the managed state is written, and settings.json,
        /// which the review shows as nothing to apply, stays out of it.
        fn apply_rules(&self) -> SetupResult {
            self.apply_surfaces(&["claude_rules"])
        }

        /// The surface has nothing to apply: no pending change, no fingerprint to apply with.
        fn assert_nothing_to_apply(&self) {
            let plan = preview_setup(vec![SURFACE.to_string()]).expect("preview");
            assert!(!plan.has_pending_changes);
            assert!(plan.plan_fingerprint.is_none());
            assert!(apply_setup(
                vec![SURFACE.to_string()],
                false,
                plan.plan_fingerprint,
                plan.preview_token
            )
            .is_err());
        }

        fn record(&self) -> Option<String> {
            let identity = artifact_identity(&ArtifactId::ClaudeSettings);
            read_managed_state(&self.ws)?
                .artifacts
                .into_iter()
                .find(|record| record.identity == identity)
                .map(|record| record.hash)
        }

        fn source_digest(&self) -> String {
            crate::setup_fingerprint::artifact_source_digest(
                &ArtifactId::ClaudeSettings,
                &crate::setup_roots::bundled_root().unwrap(),
                &self.home,
            )
            .expect("source digest")
        }

        fn plan_text(&self) -> String {
            serde_json::to_string(&preview_setup(vec![SURFACE.to_string()]).expect("preview"))
                .unwrap()
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn parse(text: &str) -> Map<String, Value> {
        match serde_json::from_str(text).expect("json") {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }

    fn keys(config: &Map<String, Value>) -> Vec<&str> {
        config.keys().map(String::as_str).collect()
    }

    fn hidden() -> Value {
        serde_json::json!({"commit": "", "pr": ""})
    }

    #[test]
    fn a_missing_file_is_created_with_the_two_values_only() {
        let env = Env::new("create");
        let planned = env.planned();
        assert_eq!(planned.kind, OperationKind::Create);
        assert_eq!(planned.previous_state, PreviousState::Absent);
        assert_eq!(planned.rollback_action, RollbackAction::RemoveCreatedFile);
        let review = env.plan_text();
        assert!(
            review
                .contains("+ ~/.claude/settings.json (new file; hides commit and PR attribution)"),
            "{review}"
        );

        let result = env.apply();
        assert_eq!(
            env.read_settings(),
            "{\n  \"attribution\": {\n    \"commit\": \"\",\n    \"pr\": \"\"\n  }\n}\n"
        );
        assert_eq!(env.record(), Some(env.source_digest()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(env.settings()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "a new file is owner-only");
        }
        // Owned and hidden: nothing left to do.
        assert_eq!(env.planned().kind, OperationKind::NoChange);

        // Undo removes the file the apply created.
        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert!(!env.settings().exists());
        assert_eq!(env.record(), None);
    }

    #[test]
    fn the_users_keys_and_their_order_survive_install_and_undo_restores_the_exact_bytes() {
        let env = Env::new("preserve");
        env.write_settings(USER_FILE);

        let planned = env.planned();
        assert_eq!(planned.kind, OperationKind::Update);
        assert_eq!(planned.previous_state, PreviousState::MergeableConfigFile);
        assert_eq!(
            planned.rollback_action,
            RollbackAction::RestoreManagedConfigFile
        );
        let review = env.plan_text();
        assert!(
            review.contains(
                "~ ~/.claude/settings.json (hides commit and PR attribution; other keys stay)"
            ),
            "{review}"
        );
        let result = env.apply();

        let installed = parse(&env.read_settings());
        let before = parse(USER_FILE);
        for (key, value) in &before {
            assert_eq!(installed.get(key), Some(value), "{key} kept");
        }
        assert_eq!(
            keys(&installed),
            ["env", "permissions", "hooks", "model", "attribution"]
        );
        assert_eq!(installed.get("attribution"), Some(&hidden()));
        assert_eq!(env.record(), Some(env.source_digest()));

        // The backup holds the whole file as it was.
        let backup = env
            .base
            .join("backups/setup")
            .join(&result.transaction_id)
            .join("artifacts/claude-settings");
        assert_eq!(fs::read_to_string(backup).expect("backup"), USER_FILE);

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert_eq!(env.read_settings(), USER_FILE);
    }

    #[test]
    fn an_edit_after_install_survives_undo_and_only_the_two_values_go() {
        let env = Env::new("undo-later");
        env.write_settings(USER_FILE);
        let result = env.apply();

        let mut edited = parse(&env.read_settings());
        edited.insert("model".into(), Value::String("sonnet".into()));
        edited.insert("theme".into(), Value::String("dark".into()));
        env.write_settings(&serde_json::to_string_pretty(&Value::Object(edited)).unwrap());

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        let restored = parse(&env.read_settings());
        assert_eq!(
            keys(&restored),
            ["env", "permissions", "hooks", "model", "theme"],
            "the attribution object the apply created is gone"
        );
        assert_eq!(restored.get("model"), Some(&Value::String("sonnet".into())));
    }

    #[test]
    fn an_attribution_object_the_user_had_keeps_its_other_keys_through_install_and_undo() {
        let env = Env::new("object");
        let before =
            "{\n  \"attribution\": {\n    \"sessionUrl\": true\n  },\n  \"model\": \"x\"\n}\n";
        env.write_settings(before);
        assert_eq!(env.planned().kind, OperationKind::Update);
        let result = env.apply();
        let installed = parse(&env.read_settings());
        assert_eq!(
            installed.get("attribution"),
            Some(&serde_json::json!({"sessionUrl": true, "commit": "", "pr": ""}))
        );
        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert_eq!(env.read_settings(), before);
    }

    #[test]
    fn attribution_the_user_set_is_left_as_it_is_and_never_recorded() {
        let env = Env::new("user-set");
        // The managed state exists (the rules file is new), so a missing record means something.
        env.apply_rules();
        assert!(read_managed_state(&env.ws).is_some());
        for text in [
            // custom text
            "{\"attribution\":{\"commit\":\"Co-authored by me\",\"pr\":\"\"}}\n",
            "{\"attribution\":{\"commit\":\"\",\"pr\":\"Mine\"}}\n",
            // only one key
            "{\"attribution\":{\"commit\":\"\"}}\n",
            "{\"attribution\":{\"pr\":\"\"}}\n",
            // the older switches
            "{\"attribution\":false}\n",
            "{\"includeCoAuthoredBy\":false}\n",
            "{\"includeCoAuthoredBy\":false,\"attribution\":{}}\n",
        ] {
            env.write_settings(text);
            assert_eq!(env.planned().kind, OperationKind::Manual, "{text}");
            let status = crate::installation_status::status_for_surfaces(
                &[SetupSurfaceId::ClaudeConfig],
                &env.ws,
                &env.home,
            )
            .expect("status");
            assert_eq!(
                status.surfaces[0].detail, "you set attribution yourself; Riggverk leaves it as is",
                "{text}"
            );
            env.assert_nothing_to_apply();
            assert_eq!(env.read_settings(), text, "never rewritten");
            assert_eq!(env.record(), None, "{text}");
        }
    }

    #[test]
    fn hidden_attribution_without_a_record_is_the_users_own_and_is_not_adopted() {
        let env = Env::new("own-empty");
        let text = "{\"attribution\":{\"commit\":\"\",\"pr\":\"\"},\"model\":\"x\"}\n";
        env.write_settings(text);
        assert_eq!(env.planned().kind, OperationKind::Manual);
        // The managed state is written (the rules file is new), and still holds no record for it.
        env.apply_rules();
        assert!(read_managed_state(&env.ws).is_some());
        assert_eq!(env.record(), None);
        assert_eq!(env.planned().kind, OperationKind::Manual);
        assert_eq!(env.read_settings(), text);

        // Nor is it listed as something Riggverk merged into when the app is uninstalled.
        let plan = preview_uninstall().expect("uninstall preview");
        let path = env.settings().display().to_string();
        assert!(plan.merged.iter().all(|item| item.path != path), "{path}");
        assert!(plan.removable.iter().all(|item| item.path != path));
    }

    #[test]
    fn hidden_attribution_the_app_wrote_is_current_and_comes_back_when_removed() {
        let env = Env::new("owned");
        env.write_settings(USER_FILE);
        env.apply();
        assert_eq!(env.planned().kind, OperationKind::NoChange);
        let status = crate::installation_status::status_for_surfaces(
            &[SetupSurfaceId::ClaudeConfig],
            &env.ws,
            &env.home,
        )
        .expect("status");
        assert_eq!(
            status.surfaces[0].detail,
            "attribution hidden by Riggverk · a project's .claude/settings.json or managed settings can override it"
        );

        // The user takes the keys out again: the target is still on, so they are written back.
        let mut config = parse(&env.read_settings());
        config.shift_remove("attribution");
        env.write_settings(&serde_json::to_string_pretty(&Value::Object(config)).unwrap());
        assert_eq!(env.planned().kind, OperationKind::Update);
        env.apply();
        assert_eq!(
            parse(&env.read_settings()).get("attribution"),
            Some(&hidden())
        );

        // Custom text over the app's value is the user's choice from then on.
        let mut config = parse(&env.read_settings());
        config.insert(
            "attribution".into(),
            serde_json::json!({"commit": "mine", "pr": ""}),
        );
        let custom = serde_json::to_string_pretty(&Value::Object(config)).unwrap();
        env.write_settings(&custom);
        assert_eq!(env.planned().kind, OperationKind::Manual);
        env.assert_nothing_to_apply();
        assert_eq!(env.read_settings(), custom);
    }

    #[test]
    fn a_file_the_app_does_not_edit_is_a_conflict_that_is_never_written_or_shown() {
        let env = Env::new("strict");
        env.apply_rules();
        for (text, reason) in [
            (
                "{\n  // SECRET-MARKER\n  \"model\": \"x\"\n}\n".to_string(),
                "the file has comments",
            ),
            (
                "{\"model\": \"SECRET-MARKER\",}\n".to_string(),
                "the file has a trailing comma",
            ),
            (
                "{\"model\": SECRET-MARKER}\n".to_string(),
                "the file is not valid JSON",
            ),
            (
                "[\"SECRET-MARKER\"]\n".to_string(),
                "the top level of the file is not an object",
            ),
            (
                "\u{feff}{\"model\": \"SECRET-MARKER\"}\n".to_string(),
                "the file starts with a byte order mark",
            ),
            (
                format!(
                    "{{\"model\": \"SECRET-MARKER\", \"pad\": \"{}\"}}",
                    "x".repeat(1_100_000)
                ),
                "the file is larger than 1 MiB",
            ),
            (
                "{\"attribution\": \"SECRET-MARKER\"}\n".to_string(),
                "attribution has an unexpected type",
            ),
            (
                "{\"attribution\": null}\n".to_string(),
                "attribution has an unexpected type",
            ),
        ] {
            env.write_settings(&text);
            assert_eq!(env.planned().kind, OperationKind::Conflict, "{reason}");
            let review = env.plan_text();
            assert!(review.contains(reason), "{reason}: {review}");
            assert!(!review.contains("SECRET-MARKER"), "{review}");
            let status = crate::installation_status::status_for_surfaces(
                &[SetupSurfaceId::ClaudeConfig],
                &env.ws,
                &env.home,
            )
            .expect("status");
            let shown = serde_json::to_string(&status).unwrap();
            assert!(shown.contains(reason), "{reason}: {shown}");
            assert!(!shown.contains("SECRET-MARKER"), "{shown}");
            env.assert_nothing_to_apply();
            assert_eq!(env.read_settings(), text, "never rewritten");
            assert_eq!(env.record(), None);
        }
        // Not a regular file: a folder in the place of the file.
        fs::remove_file(env.settings()).unwrap();
        fs::create_dir_all(env.settings()).unwrap();
        assert_eq!(env.planned().kind, OperationKind::Conflict);
    }

    #[test]
    fn a_moved_config_folder_is_a_conflict_and_nothing_is_written() {
        let env = Env::new("config-dir");
        let _moved = crate::claude_settings::test_override::set();
        assert_eq!(env.planned().kind, OperationKind::Conflict);
        let review = env.plan_text();
        assert!(
            review
                .contains("CLAUDE_CONFIG_DIR is set; Riggverk only edits ~/.claude/settings.json"),
            "{review}"
        );
        env.assert_nothing_to_apply();
        assert!(!env.settings().exists());
        assert_eq!(env.record(), None);
    }

    #[test]
    fn a_symlinked_file_is_a_conflict_and_is_not_followed() {
        #[cfg(unix)]
        {
            let env = Env::new("symlink");
            let target = env.base.join("elsewhere.json");
            fs::write(&target, "{}\n").unwrap();
            fs::create_dir_all(env.settings().parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&target, env.settings()).unwrap();
            assert_eq!(env.planned().kind, OperationKind::Conflict);
            env.assert_nothing_to_apply();
            assert_eq!(fs::read_to_string(&target).unwrap(), "{}\n");
        }
    }

    #[test]
    fn uninstall_keeps_the_file_with_the_users_keys() {
        let env = Env::new("uninstall");
        env.write_settings(USER_FILE);
        // The rules file is removable, so the uninstall has something to remove.
        env.apply_surfaces(&[SURFACE, "claude_rules"]);
        let installed = env.read_settings();

        let plan = preview_uninstall().expect("uninstall preview");
        let path = env.settings().display().to_string();
        assert!(plan.merged.iter().any(|item| item.path == path), "{path}");
        assert!(plan.removable.iter().all(|item| item.path != path));
        let result = apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(result.success, "uninstall: {}", result.message);
        assert_eq!(env.read_settings(), installed);
    }

    #[test]
    fn a_target_that_is_off_plans_nothing() {
        let env = Env::new("off");
        let mut settings = crate::settings::load();
        settings.enabled_target_ids.retain(|id| id != SURFACE);
        crate::settings::save_with_revision_check(settings, None).unwrap();
        env.write_settings(USER_FILE);
        let plan = preview_setup(vec![SURFACE.to_string()]).unwrap();
        assert!(plan.operations.is_empty() && !plan.has_pending_changes);
        assert_eq!(env.read_settings(), USER_FILE);
    }
}
