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

/// Compute opencode_config status: config file + all bundled agents must be synced for "synced" status
fn opencode_config_status(root: &Path, home: &Path) -> String {
    let config_target = home.join(".config/opencode/opencode.json");
    let config_source = root.join("templates/opencode.json");

    // Check config file
    if !config_target.exists() {
        return "missing".into();
    }
    if !config_source.exists() {
        return "missing".into();
    }
    if !file_eq(&config_target, &config_source) {
        return "diverged".into();
    }

    // Check bundled agents (agents/*.md in workspace)
    let agents_dir = root.join("agents");
    if !agents_dir.is_dir() {
        return "diverged".into();
    }

    // Read bundled agent files from workspace
    let agents_source_dir = match std::fs::read_dir(&agents_dir) {
        Ok(entries) => entries,
        Err(_) => return "diverged".into(),
    };

    let bundled_agents: Vec<String> = agents_source_dir
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().extension().map(|ext| ext == "md").unwrap_or(false)
                && e.file_type().map(|ft| ft.is_file()).unwrap_or(false)
        })
        .filter(|e| {
            let name = e.file_name();
            !name.to_string_lossy().starts_with('.')
        })
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();

    if bundled_agents.is_empty() {
        return "diverged".into();
    }

    // Check each bundled agent
    let agents_target_dir = home.join(".config/opencode/agents");
    for agent_name in bundled_agents {
        let agent_target = agents_target_dir.join(&agent_name);
        let agent_source = agents_dir.join(&agent_name);

        if !agent_target.exists() {
            return "missing".into();
        }
        if !file_eq(&agent_target, &agent_source) {
            return "diverged".into();
        }
    }

    "synced".into()
}

#[derive(Serialize)]
pub struct StatusData {
    repo_path: String,
    git_available: bool,
    branch: String,
    dirty: bool,
    latest_commit: String,
    rules_codex: String,
    rules_opencode: String,
    rules_auggie: String,
    rules_claude: String,
    rules_gemini: String,
    opencode_config: String,
    config_statuses: std::collections::HashMap<String, String>,
    host_name: String,
    enabled_rule_target_ids: Vec<String>,
    enabled_config_target_ids: Vec<String>,
    enabled_target_ids: Vec<String>,
}

fn git_available(root: &Path) -> bool {
    let (ok, out, _, _) = run_cmd("git", &["rev-parse", "--is-inside-work-tree"], root);
    ok && out.trim() == "true"
}

fn git_status(root: &Path) -> (bool, String, bool, String) {
    if !git_available(root) {
        return (false, "not git".into(), false, "not git".into());
    }

    let (_, out, _, _) = run_cmd("git", &["branch", "--show-current"], root);
    let branch = out.trim().to_string();

    let (_, dirty_out, _, _) = run_cmd("git", &["status", "--short"], root);
    let dirty = !dirty_out.trim().is_empty();

    let (_, commit_out, _, _) = run_cmd("git", &["log", "-1", "--pretty=%h %s"], root);
    let latest_commit = commit_out.trim().to_string();

    (true, branch, dirty, latest_commit)
}

#[tauri::command]
pub fn get_status() -> Result<StatusData, String> {
    let root = workspace_root()?;
    let home = agent_targets::home_dir()?;
    let targets = agent_targets::targets();
    let config_targets = agent_targets::config_targets();

    let (git_available, branch, dirty, latest_commit) = git_status(&root);

    let sync = |id: &str| -> String {
        targets
            .iter()
            .find(|t| t.id == id)
            .map(|t| sync_label(&home.join(t.target_rel), &root.join(t.source_rel)))
            .unwrap_or_else(|| "unknown".into())
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

    let mut config_statuses = std::collections::HashMap::new();
    for t in &config_targets {
        let status = if t.id == "opencode_config" {
            opencode_config_status(&root, &home)
        } else {
            sync_label(&home.join(t.target_rel), &root.join(t.source_rel))
        };
        config_statuses.insert(t.id.to_string(), status);
    }

    let opencode_config_val = config_statuses
        .get("opencode_config")
        .cloned()
        .unwrap_or_else(|| "—".into());

    Ok(StatusData {
        repo_path: root.to_string_lossy().into_owned(),
        git_available,
        branch,
        dirty,
        latest_commit,
        rules_codex: sync("codex_rules"),
        rules_opencode: sync("opencode_rules"),
        rules_auggie: sync("auggie_rules"),
        rules_claude: sync("claude_rules"),
        rules_gemini: sync("gemini_rules"),
        opencode_config: opencode_config_val,
        config_statuses,
        host_name: host,
        enabled_rule_target_ids: rule_ids,
        enabled_config_target_ids: config_ids,
        enabled_target_ids: enabled,
    })
}

#[cfg(test)]
mod tests {
    use super::{git_available, git_status};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("agent-workspace-status-{name}-{nonce}"))
    }

    #[test]
    fn non_git_workspace_is_reported_as_not_git() {
        let root = temp_root("non-git");
        fs::create_dir_all(&root).expect("create temp dir");

        let available = git_available(&root);
        let status = git_status(&root);
        let _ = fs::remove_dir_all(&root);

        assert!(!available);
        assert_eq!(status, (false, "not git".into(), false, "not git".into()));
    }
}
