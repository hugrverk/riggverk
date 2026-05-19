use crate::agent_targets;
use crate::settings;

use super::content::safe_canonical_target;
use super::process::{run_cmd, ActionResult};
use super::status::file_eq;
use super::workspace::{path_arg, workspace_root};

#[allow(dead_code)]
struct ConfigRun {
    label: &'static str,
    script_rel: &'static str,
    args: Vec<&'static str>,
}

fn enabled_config_runs(mode: agent_targets::ConfigScriptMode) -> Vec<ConfigRun> {
    let enabled = settings::load().enabled_target_ids;
    agent_targets::config_sync_targets()
        .into_iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .map(|t| {
            let (script_rel, args) = t.script_rel_and_args(mode);
            ConfigRun {
                label: t.label,
                script_rel,
                args,
            }
        })
        .collect()
}

fn no_enabled_config_targets(action: &str) -> ActionResult {
    ActionResult::new(
        true,
        action,
        "no enabled config targets\n".into(),
        String::new(),
        Some(0),
    )
}

fn cursor_is_selected() -> bool {
    let enabled = settings::load().enabled_target_ids;
    enabled.contains(&"cursor_setup".to_string())
}

fn enabled_rule_flags() -> Vec<&'static str> {
    let enabled = settings::load().enabled_target_ids;
    agent_targets::targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .filter_map(|t| t.script_flag())
        .filter(|f| *f != "--cursor") // cursor handled separately, not passed to install-agent-rules.sh
        .collect()
}

fn bootstrap_rule_args() -> Vec<&'static str> {
    let flags = enabled_rule_flags();
    if flags.is_empty() {
        vec!["--skip-rules"]
    } else {
        flags
    }
}

fn enabled_rule_targets() -> Vec<agent_targets::AgentSyncTarget> {
    let enabled = settings::load().enabled_target_ids;
    agent_targets::rule_targets()
        .into_iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .filter(|t| t.id != "cursor_setup") // cursor handled separately
        .collect()
}

fn git_available(root: &std::path::Path) -> bool {
    let (ok, out, _, _) = run_cmd("git", &["rev-parse", "--is-inside-work-tree"], root);
    ok && out.trim() == "true"
}

fn workspace_script_arg(root: &std::path::Path, script_rel: &str) -> Result<String, String> {
    let script = root.join(script_rel);
    let canonical = safe_canonical_target(root, &script)?;
    if !canonical.is_file() {
        return Err(format!("workspace script not found: {}", script_rel));
    }
    path_arg(&canonical)
}

#[tauri::command]
pub fn run_action(action: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;

    match action.as_str() {
        "git_pull" => {
            if !git_available(&root) {
                return Ok(ActionResult::new(
                    false,
                    "git_pull",
                    String::new(),
                    "Git pull is unavailable because this workspace is not a git checkout.\n"
                        .into(),
                    Some(1),
                ));
            }
            let (ok, out, err, code) = run_cmd("git", &["pull", "--ff-only"], &root);
            Ok(ActionResult::new(ok, "git_pull", out, err, code))
        }

        "bootstrap_preview" => {
            let rule_args = bootstrap_rule_args();
            let script_str = workspace_script_arg(&root, "scripts/bootstrap.sh")?;
            let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--skip-skills"];
            all_args.extend(&rule_args);
            if cursor_is_selected() {
                all_args.push("--cursor");
            }
            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "bootstrap_preview", out, err, code))
        }

        "bootstrap_diff" => {
            let rule_args = bootstrap_rule_args();
            let script_str = workspace_script_arg(&root, "scripts/bootstrap.sh")?;
            let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--diff", "--skip-skills"];
            all_args.extend(&rule_args);
            if cursor_is_selected() {
                all_args.push("--cursor");
            }
            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "bootstrap_diff", out, err, code))
        }

        "bootstrap_apply" => {
            let rule_args = bootstrap_rule_args();
            let script_str = workspace_script_arg(&root, "scripts/bootstrap.sh")?;
            let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--apply", "--skip-skills"];
            all_args.extend(&rule_args);
            if cursor_is_selected() {
                all_args.push("--cursor");
            }
            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "bootstrap_apply", out, err, code))
        }

        "verify_state" => {
            let home = agent_targets::home_dir()?;
            let targets = enabled_rule_targets();
            let cursor_on = cursor_is_selected();

            if targets.is_empty() && !cursor_on {
                return Ok(ActionResult::new(
                    true,
                    "verify_state",
                    "no enabled rule targets\n".into(),
                    String::new(),
                    Some(0),
                ));
            }

            let mut out = String::new();
            let mut err = String::new();
            let mut all_ok = true;

            for t in &targets {
                let target_path = home.join(t.target_rel);
                let source_path = root.join(t.source_rel);
                let status = if !target_path.exists() {
                    "missing"
                } else if file_eq(&target_path, &source_path) {
                    "synced"
                } else {
                    "diverged"
                };
                out.push_str(&format!("{}: {}\n", t.label, status));
                if status != "synced" {
                    all_ok = false;
                    err.push_str(&format!("{}: {}\n", t.label, status));
                }
            }

            if cursor_on {
                let agents_target = home.join(".cursor/agents");
                let cursor_status = if agents_target.exists() {
                    super::status::cursor_setup_status(&root, &home)
                } else {
                    "missing".to_string()
                };
                out.push_str(&format!("cursor setup: {}\n", cursor_status));
                if cursor_status != "synced" {
                    all_ok = false;
                    err.push_str(&format!("cursor setup: {}\n", cursor_status));
                }
            }

            Ok(ActionResult::new(
                all_ok,
                "verify_state",
                out,
                if err.is_empty() { String::new() } else { err },
                if all_ok { Some(0) } else { Some(1) },
            ))
        }

        "diff_agent_rules" => {
            let rule_flags = enabled_rule_flags();
            let cursor_on = cursor_is_selected();

            if rule_flags.is_empty() && !cursor_on {
                return Ok(ActionResult::new(
                    true,
                    "diff_agent_rules",
                    "no enabled rule targets\n".into(),
                    String::new(),
                    Some(0),
                ));
            }

            let mut all_ok = true;
            let mut out = String::new();
            let mut err = String::new();
            let mut last_code = Some(0);

            if !rule_flags.is_empty() {
                let script_str = workspace_script_arg(&root, "scripts/install-agent-rules.sh")?;
                let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--diff"];
                all_args.extend(&rule_flags);
                let (ok, o, e, code) = run_cmd("bash", &all_args, &root);
                if !ok {
                    all_ok = false;
                }
                last_code = code;
                out.push_str(&o);
                err.push_str(&e);
            }

            if cursor_on {
                let script_str =
                    workspace_script_arg(&root, "scripts/install-cursor-workspace.sh")?;
                let all_args: Vec<&str> = vec![&script_str, "--quiet", "--global-agents"];
                let (ok, o, e, code) = run_cmd("bash", &all_args, &root);
                if !ok {
                    all_ok = false;
                }
                last_code = code;
                out.push_str(&o);
                err.push_str(&e);
            }

            Ok(ActionResult::new(
                all_ok,
                "diff_agent_rules",
                out,
                err,
                last_code,
            ))
        }

        "sync_agent_rules" => {
            let rule_flags = enabled_rule_flags();
            let cursor_on = cursor_is_selected();

            if rule_flags.is_empty() && !cursor_on {
                return Ok(ActionResult::new(
                    true,
                    "sync_agent_rules",
                    "no enabled rule targets\n".into(),
                    String::new(),
                    Some(0),
                ));
            }

            let mut all_ok = true;
            let mut out = String::new();
            let mut err = String::new();
            let mut last_code = Some(0);

            let agent_rules_script = "scripts/install-agent-rules.sh";
            let cursor_script = "scripts/install-cursor-workspace.sh";

            let mut subsets_attempted: Vec<&str> = Vec::new();

            if !rule_flags.is_empty() {
                subsets_attempted.push("install-agent-rules");
                let script_str = workspace_script_arg(&root, agent_rules_script)?;
                let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--apply"];
                all_args.extend(&rule_flags);
                let (ok, o, e, code) = run_cmd("bash", &all_args, &root);
                if !ok {
                    all_ok = false;
                }
                last_code = code;
                out.push_str(&o);
                err.push_str(&e);
            }

            if cursor_on {
                subsets_attempted.push("install-cursor-workspace");
                let script_str = workspace_script_arg(&root, cursor_script)?;
                let all_args: Vec<&str> =
                    vec![&script_str, "--quiet", "--apply", "--global-agents"];
                let (ok, o, e, code) = run_cmd("bash", &all_args, &root);
                if !ok {
                    all_ok = false;
                }
                last_code = code;
                out.push_str(&o);
                err.push_str(&e);
            }

            // When a subcommand fails with empty stdout+stderr, emit synthetic
            // diagnostics so the user sees actionable information.
            if !all_ok && out.trim().is_empty() && err.trim().is_empty() {
                let subsets = subsets_attempted.join(", ");
                err = format!(
                    "Action 'sync_agent_rules' failed (exit code {:?}) with no output. \
                     Attempted subsets: {}. Scripts: {}, {}.\n",
                    last_code, subsets, agent_rules_script, cursor_script,
                );
            }

            Ok(ActionResult::new(
                all_ok,
                "sync_agent_rules",
                out,
                err,
                last_code,
            ))
        }

        "diff_configs" => {
            let runs = enabled_config_runs(agent_targets::ConfigScriptMode::Diff);
            if runs.is_empty() {
                return Ok(no_enabled_config_targets("diff_configs"));
            }

            let mut all_ok = true;
            let mut out = String::new();
            let mut err = String::new();
            let mut last_code = Some(0);

            for r in &runs {
                let script_str = workspace_script_arg(&root, r.script_rel)?;
                let mut all_args: Vec<&str> = vec![&script_str];
                all_args.extend(r.args.iter().copied());
                let (ok, o, e, code) = run_cmd("bash", &all_args, &root);
                if !ok {
                    all_ok = false;
                }
                last_code = code;
                out.push_str(&o);
                err.push_str(&e);
            }

            Ok(ActionResult::new(
                all_ok,
                "diff_configs",
                out,
                err,
                last_code,
            ))
        }

        "sync_configs" => {
            let runs = enabled_config_runs(agent_targets::ConfigScriptMode::Apply);
            if runs.is_empty() {
                return Ok(no_enabled_config_targets("sync_configs"));
            }

            let mut all_ok = true;
            let mut out = String::new();
            let mut err = String::new();
            let mut last_code = Some(0);

            for r in &runs {
                let script_str = workspace_script_arg(&root, r.script_rel)?;
                let mut all_args: Vec<&str> = vec![&script_str];
                all_args.extend(r.args.iter().copied());
                let (ok, o, e, code) = run_cmd("bash", &all_args, &root);
                if !ok {
                    all_ok = false;
                }
                last_code = code;
                out.push_str(&o);
                err.push_str(&e);
            }

            Ok(ActionResult::new(
                all_ok,
                "sync_configs",
                out,
                err,
                last_code,
            ))
        }

        "release_check" => {
            let script_str = match workspace_script_arg(&root, "scripts/release-check.sh") {
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
            if !std::path::Path::new(&script_str).is_file() {
                return Ok(ActionResult::new(
                    false,
                    "release_check",
                    String::new(),
                    "Release check is only available in an app development checkout. This starter workspace does not include scripts/release-check.sh.\n".into(),
                    Some(1),
                ));
            }
            let all_args: Vec<&str> = vec![&script_str];
            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "release_check", out, err, code))
        }

        _ => Err(format!("unknown action: {}", action)),
    }
}

#[cfg(test)]
mod tests {
    use super::workspace_script_arg;
    use std::fs;
    use std::path::{Path, PathBuf};
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
}
