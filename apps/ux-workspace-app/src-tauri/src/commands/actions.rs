use crate::agent_targets;
use crate::settings;

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

fn enabled_rule_flags() -> Vec<&'static str> {
    let enabled = settings::load().enabled_target_ids;
    agent_targets::targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()) && t.script_flag().is_some())
        .map(|t| t.script_flag().unwrap())
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
        .collect()
}

#[tauri::command]
pub fn run_action(action: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;

    match action.as_str() {
        "git_pull" => {
            let (ok, out, err, code) = run_cmd("git", &["pull", "--ff-only"], &root);
            Ok(ActionResult::new(ok, "git_pull", out, err, code))
        }

        "bootstrap_preview" => {
            let script = root.join("scripts/bootstrap.sh");
            let rule_args = bootstrap_rule_args();
            let script_str = path_arg(&script)?;
            let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--skip-skills"];
            all_args.extend(&rule_args);
            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "bootstrap_preview", out, err, code))
        }

        "bootstrap_diff" => {
            let script = root.join("scripts/bootstrap.sh");
            let rule_args = bootstrap_rule_args();
            let script_str = path_arg(&script)?;
            let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--diff", "--skip-skills"];
            all_args.extend(&rule_args);
            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "bootstrap_diff", out, err, code))
        }

        "bootstrap_apply" => {
            let script = root.join("scripts/bootstrap.sh");
            let rule_args = bootstrap_rule_args();
            let script_str = path_arg(&script)?;
            let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--apply", "--skip-skills"];
            all_args.extend(&rule_args);
            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "bootstrap_apply", out, err, code))
        }

        "verify_state" => {
            let home = agent_targets::home_dir()?;
            let targets = enabled_rule_targets();

            if targets.is_empty() {
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

            if rule_flags.is_empty() {
                return Ok(ActionResult::new(
                    true,
                    "diff_agent_rules",
                    "no enabled rule targets\n".into(),
                    String::new(),
                    Some(0),
                ));
            }

            let script = root.join("scripts/install-agent-rules.sh");
            let script_str = path_arg(&script)?;
            let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--diff"];
            all_args.extend(&rule_flags);

            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "diff_agent_rules", out, err, code))
        }

        "sync_agent_rules" => {
            let rule_flags = enabled_rule_flags();

            if rule_flags.is_empty() {
                return Ok(ActionResult::new(
                    true,
                    "sync_agent_rules",
                    "no enabled rule targets\n".into(),
                    String::new(),
                    Some(0),
                ));
            }

            let script = root.join("scripts/install-agent-rules.sh");
            let script_str = path_arg(&script)?;
            let mut all_args: Vec<&str> = vec![&script_str, "--quiet", "--apply"];
            all_args.extend(&rule_flags);

            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "sync_agent_rules", out, err, code))
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
                let script = root.join(r.script_rel);
                let script_str = path_arg(&script)?;
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
                let script = root.join(r.script_rel);
                let script_str = path_arg(&script)?;
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
            let script = root.join("scripts/release-check.sh");
            let script_str = path_arg(&script)?;
            let all_args: Vec<&str> = vec![&script_str];
            let (ok, out, err, code) = run_cmd("bash", &all_args, &root);
            Ok(ActionResult::new(ok, "release_check", out, err, code))
        }

        _ => Err(format!("unknown action: {}", action)),
    }
}
