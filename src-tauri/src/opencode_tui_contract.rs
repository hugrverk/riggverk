//! End-to-end contract for the managed keys of OpenCode's `tui.json`.
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
    use crate::managed_state::{
        artifact_identity, read_managed_state, write_managed_state_atomic, ManagedArtifactRecord,
        ManagedState, MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
    use crate::setup_transaction::{self, PreviousState, RollbackAction};
    use crate::test_env::{guard, set_test_user_dirs};

    const SURFACE: &str = "open_code_config";
    /// What a user keeps in tui.json beside the managed keys.
    const USER_KEYS: &str =
        r#""keybinds": {"leader": "ctrl+x"}, "plugin": ["my-tui-plugin"], "scroll_speed": 3"#;

    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        playwright_config: Option<String>,
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
            let base = std::env::temp_dir().join(format!("aw-tui-{label}-{nanos}"));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(base.join("home")).expect("home");
            fs::create_dir_all(base.join("workspace")).expect("workspace");
            set_test_user_dirs(&base.join("home"));
            let ws = base.join("workspace").canonicalize().expect("workspace");
            // The Playwright sidecar goes into the temp HOME, never to a path set for the real one.
            let playwright_config = std::env::var("PLAYWRIGHT_MCP_CONFIG_PATH").ok();
            unsafe {
                std::env::set_var("RIGGVERK_WORKSPACE_PATH", &ws);
                std::env::set_var("RIGGVERK_BACKUP_DIR", base.join("backups"));
                std::env::remove_var("CODEX_HOME");
                std::env::remove_var("PLAYWRIGHT_MCP_CONFIG_PATH");
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
                playwright_config,
                _restore: restore,
                _lock: lock,
            }
        }

        fn tui(&self) -> PathBuf {
            self.home.join(".config/opencode/tui.json")
        }

        fn write_tui(&self, text: &str) {
            fs::create_dir_all(self.tui().parent().unwrap()).unwrap();
            fs::write(self.tui(), text).unwrap();
        }

        fn read_tui(&self) -> String {
            fs::read_to_string(self.tui()).expect("tui.json")
        }

        fn planned(&self) -> setup_transaction::PlannedArtifact {
            setup_transaction::plan_artifacts_for_surfaces(
                &[SetupSurfaceId::OpenCodeConfig],
                &self.ws,
                &self.home,
            )
            .expect("plan")
            .into_iter()
            .find(|planned| planned.artifact == ArtifactId::OpenCodeTui)
            .expect("tui.json planned")
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

        fn record(&self) -> Option<String> {
            let identity = artifact_identity(&ArtifactId::OpenCodeTui);
            read_managed_state(&self.ws)?
                .artifacts
                .into_iter()
                .find(|record| record.identity == identity)
                .map(|record| record.hash)
        }

        /// Replaces the tui.json record (keeping the others), as an older app version left it.
        fn set_record(&self, hash: String) {
            let identity = artifact_identity(&ArtifactId::OpenCodeTui);
            let mut state = read_managed_state(&self.ws).unwrap_or(ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: Vec::new(),
            });
            state.artifacts.retain(|record| record.identity != identity);
            state.artifacts.push(ManagedArtifactRecord {
                identity,
                hash,
                surface: Some("open_code_config".to_string()),
            });
            state.artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
            write_managed_state_atomic(&self.ws, &state).expect("managed state");
        }

        /// Digest of the managed keys the installed file holds now.
        fn installed_managed_digest(&self) -> String {
            crate::setup_fingerprint::artifact_installed_managed_digest(
                &ArtifactId::OpenCodeTui,
                &self.ws,
                &self.home,
            )
            .expect("digest")
        }

        /// Makes the next apply of the surface do something (the Playwright sidecar is created
        /// again), so the managed state is written without touching tui.json.
        fn remove_playwright_sidecar(&self) {
            let sidecar =
                crate::commands::cursor_profile::default_playwright_mcp_config_path(&self.home);
            fs::remove_file(sidecar).expect("remove sidecar");
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            if let Some(path) = &self.playwright_config {
                unsafe { std::env::set_var("PLAYWRIGHT_MCP_CONFIG_PATH", path) };
            }
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn template_text() -> String {
        fs::read_to_string(
            crate::setup_roots::bundled_root()
                .expect("bundle")
                .join("templates/tui.json"),
        )
        .expect("bundled tui.json")
    }

    fn template() -> Map<String, Value> {
        match serde_json::from_str(&template_text()).expect("template") {
            Value::Object(map) => map,
            _ => panic!("template is not an object"),
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

    /// The bundled template with `theme` and `leader_timeout` changed and `mouse` missing: what an
    /// older app version could have shipped.
    fn older_shipped_text() -> String {
        let mut older = template();
        older.insert("theme".into(), Value::String("opencode".into()));
        older.insert("leader_timeout".into(), Value::from(1000));
        older.shift_remove("mouse");
        serde_json::to_string_pretty(&Value::Object(older)).unwrap() + "\n"
    }

    fn source_digest(env: &Env) -> String {
        crate::setup_fingerprint::artifact_source_digest(
            &ArtifactId::OpenCodeTui,
            &crate::setup_roots::bundled_root().unwrap(),
            &env.home,
        )
        .expect("source digest")
    }

    #[test]
    fn install_sets_the_managed_keys_keeps_user_keys_and_rolls_back_to_the_same_bytes() {
        let env = Env::new("install");
        let before = format!("{{\n  {USER_KEYS},\n  \"theme\": \"dark\"\n}}\n");
        env.write_tui(&before);

        let planned = env.planned();
        assert_eq!(planned.kind, OperationKind::Update);
        assert_eq!(planned.previous_state, PreviousState::MergeableConfigFile);
        assert_eq!(
            planned.rollback_action,
            RollbackAction::RestoreManagedConfigFile
        );
        let result = env.apply();

        let installed = parse(&env.read_tui());
        let user = parse(&format!("{{{USER_KEYS}}}"));
        for (key, value) in &user {
            assert_eq!(installed.get(key), Some(value), "{key} kept");
        }
        for (key, value) in &template() {
            assert_eq!(installed.get(key), Some(value), "{key} managed");
        }
        // User keys keep their place; `theme` is set where it was, the other managed keys follow.
        assert_eq!(
            &keys(&installed)[..4],
            &["keybinds", "plugin", "scroll_speed", "theme"]
        );
        assert_eq!(env.record(), Some(source_digest(&env)));

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert_eq!(env.read_tui(), before);
    }

    #[test]
    fn a_missing_file_is_created_with_the_managed_keys_only() {
        let env = Env::new("create");
        let planned = env.planned();
        assert_eq!(planned.kind, OperationKind::Create);
        env.apply();
        assert_eq!(env.read_tui(), template_text());
    }

    #[test]
    fn an_update_changes_only_managed_keys_and_its_rollback_keeps_later_user_edits() {
        let env = Env::new("update");
        env.apply();
        // An older app version wrote its own managed values and recorded them; the user added keys.
        let older = parse(&older_shipped_text());
        let mut before = older.clone();
        for (key, value) in parse(&format!("{{{USER_KEYS}}}")) {
            before.insert(key, value);
        }
        let before_text = serde_json::to_string_pretty(&Value::Object(before.clone())).unwrap();
        env.write_tui(&before_text);
        env.set_record(env.installed_managed_digest());

        assert_eq!(env.planned().kind, OperationKind::Update);
        let result = env.apply();
        let installed = parse(&env.read_tui());
        let mut expected = before.clone();
        for (key, value) in template() {
            expected.insert(key, value);
        }
        assert_eq!(
            serde_json::to_string(&installed).unwrap(),
            serde_json::to_string(&expected).unwrap(),
            "managed keys follow the bundle, user keys and the order stay"
        );

        // A user edit after the apply survives the rollback; the managed keys go back.
        let mut edited = installed.clone();
        edited.insert("scroll_speed".into(), Value::from(5));
        env.write_tui(&serde_json::to_string_pretty(&Value::Object(edited)).unwrap());
        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        let restored = parse(&env.read_tui());
        let mut expected = before;
        expected.insert("scroll_speed".into(), Value::from(5));
        assert_eq!(restored, expected);
        assert_eq!(
            restored.get("mouse"),
            None,
            "the key the update added is gone"
        );
    }

    #[test]
    fn a_managed_key_changed_after_install_is_a_conflict_that_keeps_the_file() {
        let env = Env::new("edited");
        env.apply();
        let mut edited = template();
        edited.insert("theme".into(), Value::String("dark".into()));
        let text = serde_json::to_string_pretty(&Value::Object(edited)).unwrap();
        env.write_tui(&text);

        assert_eq!(env.planned().kind, OperationKind::Conflict);
        let (_, kind, summary) = setup_transaction::detect_surface_state(
            SetupSurfaceId::OpenCodeConfig,
            &env.ws,
            &env.home,
        );
        assert_eq!(kind, OperationKind::Conflict);
        assert!(summary.contains("tui.json: theme changed"), "{summary}");
        env.remove_playwright_sidecar();
        env.apply();
        assert_eq!(env.read_tui(), text);
    }

    #[test]
    fn a_file_that_is_not_strict_json_is_refused_and_never_rewritten() {
        let env = Env::new("strict");
        env.apply();
        for (text, reason) in [
            (
                "{\n  // SECRET-MARKER\n  \"theme\": \"dark\"\n}\n",
                "the file has comments",
            ),
            (
                "{\"theme\": \"SECRET-MARKER\",}\n",
                "the file has a trailing comma",
            ),
            ("{\"theme\": SECRET-MARKER}\n", "the file is not valid JSON"),
            (
                "[\"SECRET-MARKER\"]\n",
                "the top level of the file is not an object",
            ),
        ] {
            env.write_tui(text);
            assert_eq!(env.planned().kind, OperationKind::Conflict, "{text}");
            let plan = preview_setup(vec![SURFACE.to_string()]).expect("preview");
            let shown = serde_json::to_string(&plan).unwrap();
            assert!(shown.contains(reason), "{reason}: {shown}");
            assert!(!shown.contains("SECRET-MARKER"), "{shown}");
            env.remove_playwright_sidecar();
            env.apply();
            assert_eq!(env.read_tui(), text, "never rewritten");
        }
    }

    #[test]
    fn uninstall_keeps_the_file_with_the_users_keys() {
        let env = Env::new("uninstall");
        env.write_tui(&format!("{{{USER_KEYS}}}"));
        // The rules file is removable, so the uninstall has something to remove.
        env.apply_surfaces(&[SURFACE, "open_code_rules"]);
        let installed = env.read_tui();

        let plan = preview_uninstall().expect("uninstall preview");
        let tui = env.tui().display().to_string();
        assert!(plan.merged.iter().any(|item| item.path == tui), "{tui}");
        assert!(plan.removable.iter().all(|item| item.path != tui));
        let result = apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(result.success, "uninstall: {}", result.message);
        assert_eq!(env.read_tui(), installed);
    }

    #[test]
    fn a_whole_file_record_of_an_untouched_copy_becomes_a_managed_keys_record() {
        let env = Env::new("legacy-untouched");
        env.apply();

        // Identical to the shipped file: synced, and the next apply records the managed keys.
        env.set_record(crate::stable_digest::bytes(template_text().as_bytes()));
        assert_eq!(env.planned().kind, OperationKind::NoChange);
        env.remove_playwright_sidecar();
        env.apply();
        assert_eq!(env.record(), Some(source_digest(&env)));

        // Exactly the bytes an older version copied: its record still proves the managed keys.
        let older = older_shipped_text();
        env.write_tui(&older);
        env.set_record(crate::stable_digest::bytes(older.as_bytes()));
        let planned = env.planned();
        assert_eq!(planned.kind, OperationKind::Update);
        assert_eq!(planned.previous_state, PreviousState::MergeableConfigFile);
        env.apply();
        assert_eq!(env.read_tui(), template_text());
        assert_eq!(env.record(), Some(source_digest(&env)));
    }

    #[test]
    fn a_whole_file_record_of_an_edited_copy_keeps_the_users_keys() {
        let env = Env::new("legacy-edited");
        env.apply();
        let shipped_record = crate::stable_digest::bytes(template_text().as_bytes());

        // Keys added beside the shipped values: synced, and they stay.
        let mut added = template();
        for (key, value) in parse(&format!("{{{USER_KEYS}}}")) {
            added.insert(key, value);
        }
        let added_text = serde_json::to_string_pretty(&Value::Object(added)).unwrap();
        env.write_tui(&added_text);
        env.set_record(shipped_record.clone());
        assert_eq!(env.planned().kind, OperationKind::NoChange);
        env.remove_playwright_sidecar();
        env.apply();
        assert_eq!(env.read_tui(), added_text);
        assert_eq!(env.record(), Some(source_digest(&env)));

        // A managed value the user changed is theirs to resolve: the file stays as it is.
        let mut changed = parse(&added_text);
        changed.insert("theme".into(), Value::String("dark".into()));
        let changed_text = serde_json::to_string_pretty(&Value::Object(changed)).unwrap();
        env.write_tui(&changed_text);
        env.set_record(shipped_record);
        assert_eq!(env.planned().kind, OperationKind::Conflict);
        env.remove_playwright_sidecar();
        env.apply();
        assert_eq!(env.read_tui(), changed_text);
    }

    #[test]
    fn a_whole_file_operation_from_before_the_merge_still_rolls_back() {
        let env = Env::new("legacy-rollback");
        let backups = env.base.join("legacy-transaction");
        fs::create_dir_all(backups.join("artifacts")).unwrap();
        let previous = format!("{{{USER_KEYS}}}\n");
        fs::write(backups.join("artifacts/opencode-tui"), &previous).unwrap();
        env.write_tui(&template_text());
        // An older version copied the template whole and recorded its file digest twice.
        let whole = crate::stable_digest::bytes(template_text().as_bytes());
        let op = setup_transaction::ArtifactManifestOperation {
            artifact: ArtifactId::OpenCodeTui,
            surface: SetupSurfaceId::OpenCodeConfig,
            kind: OperationKind::Update,
            previous_state: PreviousState::ManagedFile,
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some("artifacts/opencode-tui".into()),
            post_apply_digest: Some(whole.clone()),
            post_apply_full_digest: Some(whole),
            ..Default::default()
        };
        setup_transaction::restore_artifact_from_backup_for_explicit_rollback(
            &op, &backups, &env.home, &env.ws,
        )
        .expect("rollback");
        assert_eq!(env.read_tui(), previous);
    }
}
