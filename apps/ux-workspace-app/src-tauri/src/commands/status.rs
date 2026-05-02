use serde::Serialize;
use std::path::Path;

use crate::agent_targets;
use crate::settings;

use super::process::run_cmd;
use super::workspace::workspace_root;

fn host_name() -> String {
    let output = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output();
    if let Ok(out) = output {
        if out.status.success() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    match std::env::var("HOSTNAME").or_else(|_| std::env::var("HOST")) {
        Ok(h) if !h.is_empty() => h,
        _ => "unknown".into(),
    }
}

pub(super) fn file_eq(a: &Path, b: &Path) -> bool {
    if !a.exists() || !b.exists() {
        return false;
    }
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(ac), Ok(bc)) => ac == bc,
        _ => false,
    }
}

fn sync_label(path: &Path, source: &Path) -> String {
    if !path.exists() {
        return "missing".into();
    }
    if file_eq(path, source) {
        "synced".into()
    } else {
        "diverged".into()
    }
}

#[derive(Serialize)]
pub struct StatusData {
    repo_path: String,
    branch: String,
    dirty: bool,
    latest_commit: String,
    rules_codex: String,
    rules_opencode: String,
    rules_auggie: String,
    rules_claude: String,
    rules_gemini: String,
    opencode_config: String,
    host_name: String,
    enabled_rule_target_ids: Vec<String>,
    enabled_config_target_ids: Vec<String>,
    enabled_target_ids: Vec<String>,
}

#[tauri::command]
pub fn get_status() -> Result<StatusData, String> {
    let root = workspace_root()?;
    let home = agent_targets::home_dir()?;
    let targets = agent_targets::targets();

    let (branch, dirty, latest_commit) = {
        let (_s, out, _e, _c) = run_cmd("git", &["branch", "--show-current"], &root);
        let branch = out.trim().to_string();

        let (_, dirty_out, _, _) = run_cmd("git", &["status", "--short"], &root);
        let dirty = !dirty_out.trim().is_empty();

        let (_, commit_out, _, _) = run_cmd("git", &["log", "-1", "--pretty=%h %s"], &root);
        let latest_commit = commit_out.trim().to_string();

        (branch, dirty, latest_commit)
    };

    let sync = |id: &str| -> String {
        let t = targets
            .iter()
            .find(|t| t.id == id)
            .expect("unknown agent target");
        sync_label(&home.join(t.target_rel), &root.join(t.source_rel))
    };

    let host = host_name();
    let enabled = settings::load().enabled_target_ids;

    let rule_ids: Vec<String> = agent_targets::rule_targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .map(|t| t.id.to_string())
        .collect();

    let config_ids: Vec<String> = agent_targets::config_targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .map(|t| t.id.to_string())
        .collect();

    Ok(StatusData {
        repo_path: root.to_string_lossy().into_owned(),
        branch,
        dirty,
        latest_commit,
        rules_codex: sync("codex_rules"),
        rules_opencode: sync("opencode_rules"),
        rules_auggie: sync("auggie_rules"),
        rules_claude: sync("claude_rules"),
        rules_gemini: sync("gemini_rules"),
        opencode_config: sync("opencode_config"),
        host_name: host,
        enabled_rule_target_ids: rule_ids,
        enabled_config_target_ids: config_ids,
        enabled_target_ids: enabled,
    })
}
