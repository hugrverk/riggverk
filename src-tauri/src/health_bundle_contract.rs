//! Health, the status sync fields and uninstall ownership compare installed files with the app's
//! bundle, never with the workspace copy.
//!
//! Drives the real commands against a temp HOME and workspace; never touches the real profile.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::Value;

    use crate::artifact_registry::{AgentName, ArtifactId};
    use crate::commands::{
        apply_setup, get_claude_runtime_health, get_codex_runtime_health,
        get_cursor_profile_health, get_status, preview_setup,
    };
    use crate::setup_lifecycle::OperationKind;
    use crate::setup_transaction::plan_artifacts_for_uninstall;
    use crate::test_env::{guard, set_test_user_dirs};

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
            let base = std::env::temp_dir().join(format!("aw-health-{label}-{nanos}"));
            fs::create_dir_all(base.join("home")).expect("home");
            let base = base.canonicalize().expect("base");
            set_test_user_dirs(&base.join("home"));
            let ws = base.join("workspace");
            unsafe {
                std::env::set_var("AGENT_WORKSPACE_PATH", &ws);
                std::env::set_var("AGENT_WORKSPACE_BACKUP_DIR", base.join("backups"));
                for key in [
                    "CODEX_HOME",
                    "CODEX_SKILLS_PATH",
                    "CLAUDE_SKILLS_PATH",
                    "CURSOR_SKILLS_PATH",
                    "OPENCODE_SKILLS_PATH",
                ] {
                    std::env::remove_var(key);
                }
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

        /// The workspace holds a full copy of the bundle, the way earlier versions installed it.
        fn copy_bundle_into_workspace(&self) {
            let bundle = crate::setup_roots::bundled_root().expect("bundled root");
            crate::safe_filesystem::copy_dir_no_symlinks(&bundle, &self.ws, &self.base)
                .expect("copy the bundle into the workspace");
        }

        /// Installs every surface of the harnesses that are on by default, from the bundle.
        fn install_everything(&self) {
            let plan = preview_setup(vec![]).expect("preview");
            let mut surfaces: Vec<String> = plan
                .operations
                .iter()
                .filter(|operation| operation.kind.needs_apply())
                .map(|operation| {
                    serde_json::to_value(operation.surface)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_string))
                        .expect("surface id")
                })
                .collect();
            surfaces.sort();
            surfaces.dedup();
            let result = apply_setup(surfaces, true, plan.plan_fingerprint, plan.preview_token)
                .expect("apply");
            assert!(result.success, "install: {}", result.message);
        }

        /// Every file of the workspace copy under `templates/` and `agents/`, edited by hand.
        fn edit_workspace_copies(&self) {
            for dir in ["templates", "agents"] {
                overwrite_files(&self.ws.join(dir));
            }
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn overwrite_files(dir: &Path) {
        for entry in fs::read_dir(dir).expect("read workspace dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                overwrite_files(&path);
            } else {
                fs::write(&path, "edited outside the app\n").expect("edit workspace copy");
            }
        }
    }

    fn json<T: serde::Serialize>(value: T) -> Value {
        serde_json::to_value(value).expect("serialize")
    }

    /// The health commands that need no workspace folder.
    fn health() -> Vec<(&'static str, Value)> {
        vec![
            (
                "claude",
                json(get_claude_runtime_health().expect("claude health")),
            ),
            (
                "codex",
                json(get_codex_runtime_health().expect("codex health")),
            ),
            (
                "cursor",
                json(get_cursor_profile_health().expect("cursor health")),
            ),
        ]
    }

    fn assert_same(before: &[(&str, Value)], after: &[(&str, Value)]) {
        for ((name, before), (_, after)) in before.iter().zip(after) {
            assert_eq!(before, after, "{name} health changed");
        }
    }

    #[test]
    fn an_edited_workspace_copy_changes_neither_health_nor_status() {
        let env = Env::new("edited-copy");
        env.copy_bundle_into_workspace();
        env.install_everything();
        let health_before = health();
        let status_before = json(get_status().expect("status"));

        // The install is current, so a comparison with an edited copy would show.
        let claude = &health_before[0].1;
        assert_eq!(claude["rules_synced"], true, "{claude}");
        assert_eq!(claude["agents_synced"], true, "{claude}");
        let cursor = &health_before[2].1;
        assert_eq!(cursor["global_agents_status"], "synced", "{cursor}");
        assert_eq!(cursor["workspace_resources_status"], "current", "{cursor}");
        for id in ["claude_agents", "opencode_agents", "cursor_setup"] {
            assert_eq!(
                status_before["agents_statuses"][id], "synced",
                "{status_before}"
            );
        }

        env.edit_workspace_copies();
        assert_same(&health_before, &health());
        assert_eq!(status_before, json(get_status().expect("status")));
    }

    #[test]
    fn health_needs_no_workspace_folder() {
        let env = Env::new("no-folder");
        env.copy_bundle_into_workspace();
        env.install_everything();
        let with_copy = health();

        unsafe { std::env::set_var("AGENT_WORKSPACE_PATH", env.base.join("missing")) };
        let without = health();
        assert_same(&with_copy, &without);
        assert_eq!(without[0].1["rules_synced"], true);
        assert_eq!(without[1].1["rules_status"], "synced", "{}", without[1].1);
        assert_eq!(without[2].1["global_agents_status"], "synced");
    }

    #[test]
    fn uninstall_owns_a_harness_file_equal_to_the_bundled_source_without_workspace_templates() {
        let env = Env::new("uninstall");
        // A workspace folder with no templates in it.
        fs::create_dir_all(&env.ws).expect("workspace");
        let bundle = crate::setup_roots::bundled_root().expect("bundled root");
        let artifact = ArtifactId::ClaudeAgent(AgentName::new("verifier").expect("agent"));
        let dest = artifact.resolve_dest(&env.home, &env.ws).expect("dest");
        let source = artifact.resolve_source(&bundle).expect("source");
        fs::create_dir_all(dest.parent().expect("agents dir")).expect("agents dir");
        fs::copy(&source, &dest).expect("install the bundled agent");
        // No managed record and no shipped version of these bytes: only the current bundled
        // source can prove the file is the app's.
        let _shipped = crate::shipped_digests::test_override::inject(
            &crate::shipped_digests::test_override::json_for(
                "templates/claude/agents/verifier.md",
                &[crate::stable_digest::bytes(b"an older verifier\n")],
            ),
        );

        let plan = plan_artifacts_for_uninstall(&env.ws, &env.home).expect("plan");
        assert!(
            plan.removals.iter().any(
                |planned| planned.artifact == artifact && planned.kind == OperationKind::Remove
            ),
            "a file equal to the bundled source is removable"
        );
        assert!(!plan.preserved.contains(&artifact));

        fs::write(&dest, "edited by the user\n").expect("edit");
        let plan = plan_artifacts_for_uninstall(&env.ws, &env.home).expect("plan");
        assert!(plan.preserved.contains(&artifact));
        assert!(plan
            .removals
            .iter()
            .all(|planned| planned.artifact != artifact));
    }
}
