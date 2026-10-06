use std::path::Path;
use std::time::Duration;

use super::content::safe_canonical_target;
use super::process::{run_cmd_with_timeout, ActionResult};
use super::workspace::{path_arg, workspace_root};

/// `release-check.sh` builds and tests the app; allow it far more than helper spawns.
const RELEASE_CHECK_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn workspace_script_arg(root: &Path, script_rel: &str) -> Result<String, String> {
    let script = root.join(script_rel);
    let canonical = safe_canonical_target(root, &script)?;
    if !canonical.is_file() {
        return Err(format!("workspace script not found: {}", script_rel));
    }
    path_arg(&canonical)
}

#[tauri::command(async)]
pub fn run_action(action: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    run_action_at_root(&root, &action)
}

fn run_action_at_root(root: &Path, action: &str) -> Result<ActionResult, String> {
    match action {
        "release_check" => {
            let script_str = match workspace_script_arg(root, "scripts/release-check.sh") {
                Ok(path) => path,
                Err(_) => {
                    return Ok(ActionResult::new(
                        false,
                        "release_check",
                        String::new(),
                        "Release check is only available in an app development checkout. This starter workspace does not include scripts/release-check.sh.\n".into(),
                        Some(1),
                    ));
                }
            };
            if !Path::new(&script_str).is_file() {
                return Ok(ActionResult::new(
                    false,
                    "release_check",
                    String::new(),
                    "Release check is only available in an app development checkout. This starter workspace does not include scripts/release-check.sh.\n".into(),
                    Some(1),
                ));
            }
            let all_args: Vec<&str> = vec![&script_str];
            let (ok, out, err, code) =
                run_cmd_with_timeout("bash", &all_args, root, RELEASE_CHECK_TIMEOUT);
            Ok(ActionResult::new(ok, "release_check", out, err, code))
        }

        _ => Err(format!("unknown action: {}", action)),
    }
}

#[cfg(test)]
mod tests {
    use super::{run_action_at_root, workspace_script_arg};
    use std::fs;
    #[cfg(unix)]
    use std::path::Path;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("agent-workspace-actions-{name}-{nonce}"))
    }

    #[cfg(unix)]
    fn symlink_file(src: &Path, dst: &Path) {
        std::os::unix::fs::symlink(src, dst).expect("create symlink");
    }

    #[test]
    fn workspace_script_arg_accepts_workspace_script() {
        let root = temp_root("script-ok");
        let script = root.join("scripts/bootstrap.sh");
        fs::create_dir_all(script.parent().unwrap()).expect("create scripts dir");
        fs::write(&script, "#!/usr/bin/env bash\n").expect("write script");

        let result = workspace_script_arg(&root, "scripts/bootstrap.sh").expect("script accepted");
        assert_eq!(
            result,
            script
                .canonicalize()
                .expect("canonical script")
                .to_string_lossy()
        );

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_script_arg_rejects_symlink_escape() {
        let root = temp_root("script-symlink");
        let outside = temp_root("script-outside").join("bootstrap.sh");
        let script = root.join("scripts/bootstrap.sh");
        fs::create_dir_all(script.parent().unwrap()).expect("create scripts dir");
        fs::create_dir_all(outside.parent().unwrap()).expect("create outside dir");
        fs::write(&outside, "#!/usr/bin/env bash\n").expect("write outside script");
        symlink_file(&outside, &script);

        let err = workspace_script_arg(&root, "scripts/bootstrap.sh")
            .expect_err("symlink escape rejected");
        assert!(err.contains("outside workspace"), "{err}");

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside.parent().unwrap());
    }

    #[test]
    fn run_action_rejects_removed_legacy_actions() {
        let root = temp_root("legacy-actions");
        fs::create_dir_all(&root).expect("create root");
        for action in [
            "verify_state",
            "diff_agent_rules",
            "sync_agent_rules",
            "diff_configs",
            "sync_configs",
            "sync_codex_rules",
            "sync_opencode_rules",
            "sync_claude_rules",
            "sync_opencode_agents",
            "sync_claude_agents",
            "sync_codex_agents",
            "sync_codex_config",
            "sync_opencode_config",
        ] {
            let err = run_action_at_root(&root, action).expect_err(action);
            assert!(err.contains("unknown action"), "{action}: {err}");
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn release_check_reports_missing_script_without_running_anything() {
        let root = temp_root("release-check-missing");
        fs::create_dir_all(&root).expect("create root");
        let result = run_action_at_root(&root, "release_check").expect("action result");
        assert!(!result.success);
        assert_eq!(result.exit_code, Some(1));
        assert!(result.stderr.contains("app development checkout"));
        let _ = fs::remove_dir_all(root);
    }
}
