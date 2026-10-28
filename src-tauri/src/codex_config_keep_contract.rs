//! End-to-end contract for "keep mine" on the enforced keys of the Codex config.
//!
//! Drives the real preview, apply and status paths against a temp HOME and workspace; never
//! touches the real `~/.codex` or the real workspace.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use crate::artifact_registry::ArtifactId;
    use crate::commands::setup::{apply_setup, preview_setup, SetupResult};
    use crate::installation_status::{status_for_surfaces, InstallationState};
    use crate::managed_state::{
        artifact_identity, read_managed_state, write_managed_state_atomic, ManagedArtifactRecord,
    };
    use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
    use crate::setup_transaction::plan_artifacts_for_surfaces;
    use crate::test_env::{guard, set_test_user_dirs};

    const SURFACE: &str = "codex_config";

    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        _restore: guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Env {
        /// A profile with the bundled Codex config installed and recorded.
        fn new(label: &str) -> Self {
            let lock = guard::lock();
            let restore = guard::EnvRestore::capture();
            unsafe { std::env::remove_var("CODEX_HOME") };
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-codex-keep-{label}-{nanos}"));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(base.join("home")).expect("home");
            fs::create_dir_all(base.join("workspace")).expect("workspace");
            set_test_user_dirs(&base.join("home"));
            let ws = base.join("workspace").canonicalize().expect("workspace");
            unsafe {
                std::env::set_var("RIGGVERK_WORKSPACE_PATH", &ws);
                std::env::set_var("RIGGVERK_BACKUP_DIR", base.join("backups"));
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
            let env = Self {
                base,
                home,
                ws,
                _restore: restore,
                _lock: lock,
            };
            let result = env.apply();
            assert!(result.success, "install: {}", result.message);
            env
        }

        fn config(&self) -> PathBuf {
            ArtifactId::CodexConfig
                .resolve_dest(&self.home, &self.ws)
                .expect("dest")
        }

        fn read(&self) -> String {
            fs::read_to_string(self.config()).expect("config.toml")
        }

        fn write(&self, text: &str) {
            fs::write(self.config(), text).expect("write config.toml");
        }

        /// Replaces the line that sets `key` (a top-level key) with `key = "value"`.
        fn set_top_level(&self, key: &str, value: &str) {
            let text = self.read();
            let replaced: Vec<String> = text
                .lines()
                .map(|line| {
                    if line.trim_start().starts_with(&format!("{key} =")) {
                        format!("{key} = \"{value}\"")
                    } else {
                        line.to_string()
                    }
                })
                .collect();
            self.write(&(replaced.join("\n") + "\n"));
        }

        fn kind(&self) -> OperationKind {
            plan_artifacts_for_surfaces(&[SetupSurfaceId::CodexConfig], &self.ws, &self.home)
                .expect("plan")
                .into_iter()
                .find(|planned| planned.artifact == ArtifactId::CodexConfig)
                .expect("config planned")
                .kind
        }

        fn status(&self) -> crate::installation_status::SurfaceInstallationStatus {
            status_for_surfaces(&[SetupSurfaceId::CodexConfig], &self.ws, &self.home)
                .expect("status")
                .surfaces
                .into_iter()
                .next()
                .expect("surface")
        }

        fn apply(&self) -> SetupResult {
            let surfaces = vec![SURFACE.to_string()];
            let plan = preview_setup(surfaces.clone()).expect("preview");
            apply_setup(surfaces, false, plan.plan_fingerprint, plan.preview_token).expect("apply")
        }

        fn plan_fingerprint(&self) -> Option<String> {
            preview_setup(vec![SURFACE.to_string()])
                .expect("preview")
                .plan_fingerprint
        }

        fn record(&self) -> Option<String> {
            let identity = artifact_identity(&ArtifactId::CodexConfig);
            read_managed_state(&self.ws)?
                .artifacts
                .into_iter()
                .find(|record| record.identity == identity)
                .map(|record| record.hash)
        }

        fn set_record(&self, hash: String) {
            let mut state = read_managed_state(&self.ws).expect("managed state");
            let identity = artifact_identity(&ArtifactId::CodexConfig);
            state.artifacts.retain(|record| record.identity != identity);
            state.artifacts.push(ManagedArtifactRecord {
                identity,
                hash,
                surface: Some(SURFACE.to_string()),
            });
            state.artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
            write_managed_state_atomic(&self.ws, &state).expect("write managed state");
        }

        fn bundled(&self) -> PathBuf {
            crate::setup_roots::bundled_root().expect("bundled root")
        }

        fn source_digest(&self) -> String {
            crate::setup_fingerprint::artifact_source_digest(
                &ArtifactId::CodexConfig,
                &self.bundled(),
                &self.home,
            )
            .expect("source digest")
        }

        fn effective_digest(&self) -> String {
            crate::setup_fingerprint::artifact_effective_source_digest(
                &ArtifactId::CodexConfig,
                &self.bundled(),
                &self.ws,
                &self.home,
            )
            .expect("effective digest")
        }

        fn installed_digest(&self) -> String {
            crate::setup_fingerprint::artifact_installed_managed_digest(
                &ArtifactId::CodexConfig,
                &self.ws,
                &self.home,
            )
            .expect("installed digest")
        }

        fn keep(&self) -> Result<Vec<String>, String> {
            crate::codex_config_keep::keep(&self.ws, &self.home)
                .map(|items| items.into_iter().map(|item| item.key).collect())
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn a_changed_value_is_a_conflict_until_kept_and_then_current() {
        let env = Env::new("owner");
        assert_eq!(env.kind(), OperationKind::NoChange);
        env.set_top_level("approvals_reviewer", "auto_review");

        // Today's behaviour: the recorded digest no longer matches, so nothing is written.
        assert_eq!(env.kind(), OperationKind::Conflict);
        let before = env.status();
        assert_eq!(before.state, InstallationState::Conflict);
        assert!(
            before.detail.contains("approvals_reviewer") && before.detail.contains("m keeps"),
            "{}",
            before.detail
        );
        assert_eq!(
            before.codex_config.as_ref().map(|c| c.differing.len()),
            Some(1)
        );

        assert_eq!(env.keep().unwrap(), vec!["approvals_reviewer".to_string()]);

        assert_eq!(env.kind(), OperationKind::NoChange);
        let after = env.status();
        assert_eq!(after.state, InstallationState::Current);
        assert_eq!(
            after.detail,
            "you keep approvals_reviewer = auto_review; other managed keys follow Riggverk"
        );
        let config = after.codex_config.expect("kept keys are reported");
        assert_eq!(config.kept.len(), 1);
        assert!(config.differing.is_empty());
        assert!(env.plan_fingerprint().is_none(), "nothing to apply");
        // The kept value was never written over.
        assert!(env.read().contains("approvals_reviewer = \"auto_review\""));
    }

    #[test]
    fn a_kept_value_changed_again_is_a_conflict_again() {
        let env = Env::new("changed-again");
        env.set_top_level("approvals_reviewer", "auto_review");
        env.keep().unwrap();
        assert_eq!(env.kind(), OperationKind::NoChange);

        env.set_top_level("approvals_reviewer", "never-heard-of-it");
        assert_eq!(env.kind(), OperationKind::Conflict);
        let status = env.status();
        assert_eq!(status.state, InstallationState::Conflict);
        let config = status.codex_config.expect("differing keys are reported");
        assert!(config.kept.is_empty());
        assert_eq!(config.differing[0].key, "approvals_reviewer");
    }

    #[test]
    fn handing_back_makes_the_key_follow_riggverk_again() {
        let env = Env::new("hand-back");
        env.set_top_level("approvals_reviewer", "auto_review");
        env.keep().unwrap();
        assert_eq!(env.kind(), OperationKind::NoChange);

        crate::codex_config_keep::hand_back(&env.ws).unwrap();
        assert_eq!(env.kind(), OperationKind::Conflict);
        assert!(crate::config_preferences::load_codex_config(&env.ws).is_none());
    }

    #[test]
    fn an_update_for_another_key_writes_only_that_key_and_keeps_the_kept_one() {
        let env = Env::new("update-other");
        env.set_top_level("approvals_reviewer", "auto_review");
        env.keep().unwrap();

        // The bundle moved on for sandbox_mode: the record describes the file as the app last
        // wrote it (an older sandbox_mode, the reviewer as the template had it).
        let template: toml::Value = fs::read_to_string(
            ArtifactId::CodexConfig
                .resolve_source(&env.bundled())
                .unwrap(),
        )
        .unwrap()
        .parse()
        .unwrap();
        env.set_top_level("sandbox_mode", "read-only");
        let mut as_last_written: toml::Value = env.read().parse().unwrap();
        as_last_written["approvals_reviewer"] = template["approvals_reviewer"].clone();
        env.set_record(crate::setup_fingerprint::codex_managed_digest(
            &as_last_written,
        ));
        let user_text = format!(
            "{}\n# my own note\n[mcp_servers.demo]\ncommand = \"demo\"\n",
            env.read().trim_end()
        );
        env.write(&user_text);

        assert_eq!(env.kind(), OperationKind::Update);
        let status = env.status();
        assert_eq!(status.state, InstallationState::UpdateAvailable);
        assert!(
            status
                .detail
                .contains("you keep approvals_reviewer = auto_review"),
            "{}",
            status.detail
        );

        let result = env.apply();
        assert!(result.success, "apply: {}", result.message);
        let written = env.read();
        assert!(
            written.contains("sandbox_mode = \"workspace-write\""),
            "{written}"
        );
        assert!(
            written.contains("approvals_reviewer = \"auto_review\""),
            "{written}"
        );
        assert!(written.contains("# my own note"), "{written}");
        assert!(written.contains("[mcp_servers.demo]"), "{written}");
        assert_eq!(env.kind(), OperationKind::NoChange);
        assert_eq!(env.record(), Some(env.installed_digest()));
    }

    #[test]
    fn the_source_and_installed_digests_agree_while_a_key_is_kept() {
        let env = Env::new("fingerprint");
        assert_eq!(env.effective_digest(), env.source_digest());
        env.set_top_level("approvals_reviewer", "auto_review");
        // Not kept yet: the template stands.
        assert_eq!(env.effective_digest(), env.source_digest());
        assert_ne!(env.installed_digest(), env.effective_digest());

        env.keep().unwrap();
        assert_ne!(env.effective_digest(), env.source_digest());
        assert_eq!(env.effective_digest(), env.installed_digest());
        // Stable: computing it again, or planning again, gives the same answer.
        assert_eq!(env.effective_digest(), env.effective_digest());
        assert_eq!(env.plan_fingerprint(), env.plan_fingerprint());
        // The version of the bundle never moves with a choice.
        let version = |env: &Env| {
            crate::managed_state::compute_bundled_version(&env.bundled(), &env.home, &env.bundled())
                .unwrap()
        };
        let kept_version = version(&env);
        crate::codex_config_keep::hand_back(&env.ws).unwrap();
        assert_eq!(kept_version, version(&env));
    }

    #[test]
    fn keeping_refuses_when_nothing_differs_or_the_config_is_unreadable() {
        let env = Env::new("refuse");
        let error = env.keep().unwrap_err();
        assert!(error.contains("nothing to keep"), "{error}");

        env.write("this is = not [valid toml");
        let error = env.keep().unwrap_err();
        assert!(error.contains("not valid TOML"), "{error}");
        assert!(crate::config_preferences::load_codex_config(&env.ws).is_none());

        fs::remove_file(env.config()).unwrap();
        let error = env.keep().unwrap_err();
        assert!(error.contains("not installed"), "{error}");
    }

    #[test]
    fn the_command_keeps_and_hands_back_and_never_writes_the_config() {
        let env = Env::new("command");
        let error = crate::commands::set_codex_config_kept(true).unwrap_err();
        assert!(error.contains("nothing to keep"), "{error}");

        env.set_top_level("approvals_reviewer", "auto_review");
        let config_before = env.read();
        crate::commands::set_codex_config_kept(true).expect("keep");
        assert_eq!(env.read(), config_before, "config.toml is never written");
        assert_eq!(env.kind(), OperationKind::NoChange);
        let prefs = fs::read_to_string(crate::workspace_layout::state_file(
            &env.ws,
            "config-preferences.json",
        ))
        .expect("preferences");
        assert!(prefs.contains("auto_review"), "{prefs}");

        crate::commands::set_codex_config_kept(false).expect("hand back");
        assert_eq!(env.read(), config_before);
        assert_eq!(env.kind(), OperationKind::Conflict);
    }
}
