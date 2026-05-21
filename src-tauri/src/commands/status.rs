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

fn opencode_config_status(root: &Path, home: &Path) -> String {
    let config_target = home.join(".config/opencode/opencode.json");
    let config_source = root.join("templates/opencode.json");
    sync_label(&config_target, &config_source)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RuntimeAgentsHarness {
    Opencode,
    Claude,
    Auggie,
}

fn runtime_agents_harness_for_target_rel(target_rel: &str) -> RuntimeAgentsHarness {
    if target_rel.contains("opencode") {
        RuntimeAgentsHarness::Opencode
    } else if target_rel.contains(".claude/agents") {
        RuntimeAgentsHarness::Claude
    } else if target_rel.contains(".augment/agents") {
        RuntimeAgentsHarness::Auggie
    } else {
        RuntimeAgentsHarness::Opencode
    }
}

fn frontmatter_has_name_field(front: &str) -> bool {
    front
        .lines()
        .any(|line| line.trim_start().starts_with("name:"))
}

/// Expected installed bytes for a bundled runtime agent (matches install-runtime-agents.sh staging).
fn expected_runtime_agent_content(
    source: &str,
    stem: &str,
    harness: RuntimeAgentsHarness,
) -> String {
    if harness == RuntimeAgentsHarness::Opencode {
        return source.to_string();
    }

    if !source.starts_with("---") {
        return source.to_string();
    }

    let Some(rest) = source.get(3..) else {
        return source.to_string();
    };
    let Some(end_rel) = rest.find("\n---") else {
        return source.to_string();
    };
    let end = 3 + end_rel;
    let front = &source[..end + 4];
    let body = &source[end + 4..];

    if frontmatter_has_name_field(front) {
        return source.to_string();
    }

    let Some(close) = front.rfind("\n---") else {
        return source.to_string();
    };

    let mut expected = String::with_capacity(source.len() + stem.len() + 16);
    expected.push_str(&front[..close]);
    expected.push_str("\nname: ");
    expected.push_str(stem);
    expected.push('\n');
    expected.push_str(&front[close..]);
    expected.push_str(body);
    expected
}

fn runtime_agent_matches_installed(source: &Path, target: &Path, target_rel: &str) -> bool {
    let Ok(source_bytes) = std::fs::read(source) else {
        return false;
    };
    let Ok(target_bytes) = std::fs::read(target) else {
        return false;
    };

    let harness = runtime_agents_harness_for_target_rel(target_rel);
    let source_str = String::from_utf8_lossy(&source_bytes);
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let expected = expected_runtime_agent_content(&source_str, stem, harness);
    target_bytes == expected.as_bytes()
}

fn shared_runtime_agents_status(root: &Path, home: &Path, target_rel: &str) -> String {
    let agents_dir = root.join("agents");
    if !agents_dir.is_dir() {
        return "diverged".into();
    }

    let bundled_agents: Vec<String> = match std::fs::read_dir(&agents_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path().extension().map(|ext| ext == "md").unwrap_or(false)
                    && e.file_type().map(|ft| ft.is_file()).unwrap_or(false)
            })
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => return "diverged".into(),
    };

    if bundled_agents.is_empty() {
        return "diverged".into();
    }

    let agents_target_dir = home.join(target_rel);
    for agent_name in bundled_agents {
        let agent_target = agents_target_dir.join(&agent_name);
        let agent_source = agents_dir.join(&agent_name);
        if !agent_target.exists() {
            return "missing".into();
        }
        if !runtime_agent_matches_installed(&agent_source, &agent_target, target_rel) {
            return "diverged".into();
        }
    }

    "synced".into()
}

pub(super) fn cursor_setup_status(root: &Path, home: &Path) -> String {
    let agents_dir = root.join("templates/cursor/agents");
    if !agents_dir.is_dir() {
        return "diverged".into();
    }

    let entries = match std::fs::read_dir(&agents_dir) {
        Ok(entries) => entries,
        Err(_) => return "diverged".into(),
    };

    let agents: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().extension().map(|ext| ext == "md").unwrap_or(false)
                && e.file_type().map(|ft| ft.is_file()).unwrap_or(false)
        })
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();

    if agents.is_empty() {
        return "diverged".into();
    }

    let target_dir = home.join(".cursor/agents");
    for agent_name in agents {
        let source = agents_dir.join(&agent_name);
        let target = target_dir.join(&agent_name);
        if !target.exists() {
            return "missing".into();
        }
        if !file_eq(&target, &source) {
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
    opencode_config: String,
    opencode_agents: String,
    claude_agents: String,
    auggie_agents: String,
    config_statuses: std::collections::HashMap<String, String>,
    agents_statuses: std::collections::HashMap<String, String>,
    host_name: String,
    enabled_rule_target_ids: Vec<String>,
    enabled_config_target_ids: Vec<String>,
    enabled_agent_target_ids: Vec<String>,
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

    let agent_target_ids: Vec<String> = agent_targets::runtime_agent_targets()
        .iter()
        .chain(
            agent_targets::targets()
                .iter()
                .filter(|t| t.id == "cursor_setup"),
        )
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

    let mut agents_statuses = std::collections::HashMap::new();
    for t in agent_targets::targets()
        .iter()
        .filter(|t| matches!(t.kind, agent_targets::TargetKind::Agents))
    {
        let status = if t.id == "cursor_setup" {
            cursor_setup_status(&root, &home)
        } else {
            shared_runtime_agents_status(&root, &home, t.target_rel)
        };
        agents_statuses.insert(t.id.to_string(), status);
    }

    let opencode_config_val = config_statuses
        .get("opencode_config")
        .cloned()
        .unwrap_or_else(|| "—".into());
    let opencode_agents_val = agents_statuses
        .get("opencode_agents")
        .cloned()
        .unwrap_or_else(|| "—".into());
    let claude_agents_val = agents_statuses
        .get("claude_agents")
        .cloned()
        .unwrap_or_else(|| "—".into());
    let auggie_agents_val = agents_statuses
        .get("auggie_agents")
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
        opencode_config: opencode_config_val,
        opencode_agents: opencode_agents_val,
        claude_agents: claude_agents_val,
        auggie_agents: auggie_agents_val,
        config_statuses,
        agents_statuses,
        host_name: host,
        enabled_rule_target_ids: rule_ids,
        enabled_config_target_ids: config_ids,
        enabled_agent_target_ids: agent_target_ids,
        enabled_target_ids: enabled,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        expected_runtime_agent_content, git_available, git_status, opencode_config_status,
        shared_runtime_agents_status, RuntimeAgentsHarness,
    };
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

    fn write_file(path: &PathBuf, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent dir");
        }
        fs::write(path, content).expect("write file");
    }

    // ── opencode_config_status tests ──

    #[test]
    fn opencode_config_status_synced_when_config_matches() {
        let root = temp_root("opencode-synced");
        let home = temp_root("home-synced");

        write_file(&root.join("templates/opencode.json"), r#"{"key":"val"}"#);
        write_file(
            &home.join(".config/opencode/opencode.json"),
            r#"{"key":"val"}"#,
        );

        let status = opencode_config_status(&root, &home);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "synced");
    }

    #[test]
    fn opencode_config_status_missing_when_config_target_absent() {
        let root = temp_root("opencode-no-target");
        let home = temp_root("home-no-target");

        write_file(&root.join("templates/opencode.json"), r#"{"key":"val"}"#);
        // No config target in home

        let status = opencode_config_status(&root, &home);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "missing");
    }

    #[test]
    fn opencode_config_status_missing_when_config_source_absent() {
        let root = temp_root("opencode-no-source");
        let home = temp_root("home-no-source");

        // No templates/opencode.json in root
        write_file(
            &home.join(".config/opencode/opencode.json"),
            r#"{"key":"val"}"#,
        );

        let status = opencode_config_status(&root, &home);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "diverged");
    }

    #[test]
    fn opencode_config_status_diverged_when_config_differs() {
        let root = temp_root("opencode-div-cfg");
        let home = temp_root("home-div-cfg");

        write_file(&root.join("templates/opencode.json"), r#"{"updated":true}"#);
        write_file(
            &home.join(".config/opencode/opencode.json"),
            r#"{"updated":false}"#,
        );

        let status = opencode_config_status(&root, &home);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "diverged");
    }

    #[test]
    fn runtime_agents_status_missing_when_an_agent_is_missing() {
        let root = temp_root("opencode-agent-missing");
        let home = temp_root("home-agent-missing");

        write_file(&root.join("agents/architect.md"), "architect");
        write_file(&root.join("agents/scout.md"), "scout");
        write_file(
            &home.join(".config/opencode/agents/architect.md"),
            "architect",
        );

        let status = shared_runtime_agents_status(&root, &home, ".config/opencode/agents");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "missing");
    }

    #[test]
    fn runtime_agents_status_diverged_when_agent_content_differs() {
        let root = temp_root("opencode-agent-div");
        let home = temp_root("home-agent-div");

        write_file(&root.join("agents/architect.md"), "updated agent");
        write_file(
            &home.join(".config/opencode/agents/architect.md"),
            "old agent",
        );

        let status = shared_runtime_agents_status(&root, &home, ".config/opencode/agents");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "diverged");
    }

    #[test]
    fn runtime_agents_status_diverged_when_no_agents_dir() {
        let root = temp_root("opencode-no-agents-dir");
        let home = temp_root("home-no-agents-dir");

        let status = shared_runtime_agents_status(&root, &home, ".config/opencode/agents");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "diverged");
    }

    #[test]
    fn runtime_agents_status_diverged_when_agents_dir_empty() {
        let root = temp_root("opencode-empty-agents");
        let home = temp_root("home-empty-agents");

        fs::create_dir_all(root.join("agents")).expect("create agents dir");

        let status = shared_runtime_agents_status(&root, &home, ".config/opencode/agents");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "diverged");
    }

    #[test]
    fn runtime_agents_status_ignores_dotfiles_in_agents() {
        let root = temp_root("opencode-dotfile");
        let home = temp_root("home-dotfile");

        write_file(&root.join("agents/architect.md"), "architect");
        write_file(&root.join("agents/.DS_Store"), "garbage");
        write_file(
            &home.join(".config/opencode/agents/architect.md"),
            "architect",
        );

        let status = shared_runtime_agents_status(&root, &home, ".config/opencode/agents");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "synced");
    }

    #[test]
    fn expected_runtime_agent_content_injects_name_for_claude() {
        let source = "---\ndescription: test agent\nmode: subagent\n---\n# body\n";
        let expected =
            expected_runtime_agent_content(source, "scout", RuntimeAgentsHarness::Claude);
        assert_eq!(
            expected,
            "---\ndescription: test agent\nmode: subagent\nname: scout\n\n---\n# body\n"
        );
    }

    #[test]
    fn runtime_agents_status_synced_for_claude_name_staging() {
        let root = temp_root("claude-agent-staged");
        let home = temp_root("home-claude-agent-staged");

        let source = "---\ndescription: test agent\nmode: subagent\n---\n# body\n";
        write_file(&root.join("agents/scout.md"), source);
        let stemmed = "---\ndescription: test agent\nmode: subagent\nname: scout\n\n---\n# body\n";
        write_file(&home.join(".claude/agents/scout.md"), stemmed);

        let status = shared_runtime_agents_status(&root, &home, ".claude/agents");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "synced");
    }

    #[test]
    fn runtime_agents_status_diverged_when_claude_staging_differs() {
        let root = temp_root("claude-agent-staged-div");
        let home = temp_root("home-claude-agent-staged-div");

        write_file(
            &root.join("agents/scout.md"),
            "---\ndescription: test agent\nmode: subagent\n---\n# body\n",
        );
        write_file(
            &home.join(".claude/agents/scout.md"),
            "---\nname: scout\n---\nold\n",
        );

        let status = shared_runtime_agents_status(&root, &home, ".claude/agents");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "diverged");
    }

    #[test]
    fn runtime_agents_status_ignores_non_md_files_in_agents() {
        let root = temp_root("opencode-nonmd");
        let home = temp_root("home-nonmd");

        write_file(&root.join("agents/architect.md"), "architect");
        write_file(&root.join("agents/notes.txt"), "not an agent");
        write_file(
            &home.join(".config/opencode/agents/architect.md"),
            "architect",
        );

        let status = shared_runtime_agents_status(&root, &home, ".config/opencode/agents");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(status, "synced");
    }

    // ── git tests ──

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
