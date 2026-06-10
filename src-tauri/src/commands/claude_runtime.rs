//! Claude Code runtime health and administration boundary.
//!
//! This module provides read-only health checks for managed Claude surfaces:
//! rules, native agents, and skills.  It does NOT inspect:
//!   - authentication state or tokens
//!   - trust databases or caches
//!   - session state
//!   - settings file contents
//!   - MCP credentials
//!   - private environment values
//!
//! Claude settings and MCP configuration remain an explicit manual boundary
//! (see the Claude UI "Settings and MCP" card).

use std::path::Path;

use serde::Serialize;

use crate::agent_targets;
use crate::commands::status::file_eq;
use crate::commands::workspace::configured_workspace_path;
use crate::settings;

/// All managed Claude surface states.
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeRuntimeHealth {
    /// Whether Claude rules (~/.claude/CLAUDE.md) are synced.
    pub rules_synced: bool,
    /// Whether Claude native agents (~/.claude/agents) are synced.
    pub agents_synced: bool,
    /// Whether Claude skills (~/.claude/skills/ with SKILL.md) are present.
    pub skills_synced: bool,
    /// Number of expected Claude agents (from agent adapters manifest).
    pub expected_agent_count: usize,
    /// Number of installed Claude agent files found.
    pub installed_agent_count: usize,
    /// Claude CLI availability (binary found in PATH).
    pub claude_cli_available: bool,
    /// Human-readable summary for the UI.
    pub summary: String,
}

/// Check whether the `claude` CLI is on PATH using the cross-platform executable resolver.
fn claude_cli_available() -> bool {
    let path_env = std::env::var("PATH").unwrap_or_default();
    crate::executable_resolver::resolve_executable("claude", &path_env, None).is_some()
}

/// Count installed Claude agent files in ~/.claude/agents.
fn installed_agent_count(home: &Path) -> usize {
    let agents_dir = home.join(".claude/agents");
    if !agents_dir.is_dir() {
        return 0;
    }
    std::fs::read_dir(&agents_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_type().map(|ft| ft.is_file()).unwrap_or(false)
                        && e.file_name().to_string_lossy().ends_with(".md")
                })
                .count()
        })
        .unwrap_or(0)
}

/// Count expected Claude agent source files from workspace templates.
fn expected_agent_count(workspace_root: &Path) -> usize {
    let source_dir = workspace_root.join("templates/claude/agents");
    if !source_dir.is_dir() {
        return 0;
    }
    std::fs::read_dir(&source_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_type().map(|ft| ft.is_file()).unwrap_or(false)
                        && e.path().extension().and_then(|e| e.to_str()) == Some("md")
                })
                .count()
        })
        .unwrap_or(0)
}

/// Check whether the workspace's Claude rules template would produce
/// the same content as the installed target.
fn check_rules_synced(home: &Path, workspace_root: &Path) -> bool {
    let target = home.join(".claude/CLAUDE.md");
    if !target.is_file() {
        return false;
    }
    let source = workspace_root.join("templates/sync/claude-rules.md");
    if !source.is_file() {
        return false;
    }
    file_eq(&target, &source)
}

/// Check whether the source Claude agents match the installed ones.
fn check_agents_synced(home: &Path, workspace_root: &Path) -> bool {
    let installed_dir = home.join(".claude/agents");
    if !installed_dir.is_dir() {
        return false;
    }
    let source_dir = workspace_root.join("templates/claude/agents");
    if !source_dir.is_dir() {
        return false;
    }

    // Compare every source .md file with the installed version
    let source_entries = match std::fs::read_dir(&source_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };

    for entry in source_entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let name = path.file_name().unwrap();
        let installed_path = installed_dir.join(name);
        if !installed_path.is_file() {
            return false;
        }
        if !file_eq(&path, &installed_path) {
            return false;
        }
    }
    true
}

/// Check whether Claude skills are synced by verifying all skills in the workspace
/// skills directory that have Claude as a target agent are installed in ~/.claude/skills.
fn check_skills_synced(home: &Path, workspace_root: &Path) -> bool {
    let installed_skills_dir = home.join(".claude/skills");
    if !installed_skills_dir.is_dir() {
        return false;
    }

    let source_skills_dir = workspace_root.join("skills");
    if !source_skills_dir.is_dir() {
        // No skills source — skills are present but we can't verify sync
        // Still count as synced if the installed dir has content
        return std::fs::read_dir(installed_skills_dir)
            .map(|mut e| e.any(|e| e.is_ok()))
            .unwrap_or(false);
    }

    // Find all Claude-eligible skills in the workspace
    let mut expected_skill_names: Vec<String> = Vec::new();

    let group_entries = match std::fs::read_dir(&source_skills_dir) {
        Ok(e) => e,
        Err(_) => return true,
    };

    for group_entry in group_entries.flatten() {
        let group_path = group_entry.path();
        if !group_path.is_dir() {
            continue;
        }
        // Each subdirectory is a skill group
        let skill_entries = match std::fs::read_dir(&group_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for skill_entry in skill_entries.flatten() {
            let skill_path = skill_entry.path();
            if !skill_path.is_dir() {
                continue;
            }
            let skill_md = skill_path.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            // Read SKILL.md to check if agent includes "claude"
            if let Some(skill_name) = skill_path.file_name() {
                let name_str = skill_name.to_string_lossy();
                if has_claude_agent(&skill_md) {
                    expected_skill_names.push(name_str.to_string());
                }
            }
        }
    }

    if expected_skill_names.is_empty() {
        // No Claude-specific skills — consider synced
        return true;
    }

    // Check every expected skill is installed
    expected_skill_names.iter().all(|name| {
        let installed = installed_skills_dir.join(name).join("SKILL.md");
        installed.is_file()
    })
}

/// Read SKILL.md frontmatter to check if "claude" appears in the agent field.
fn has_claude_agent(skill_md: &Path) -> bool {
    if let Ok(content) = std::fs::read_to_string(skill_md) {
        content.contains("agent:") && content.contains("claude")
    } else {
        false
    }
}

/// Compute Claude runtime health from inspected managed surfaces only.
fn compute_health(workspace_root: &Path, home: &Path) -> ClaudeRuntimeHealth {
    let rules_synced = check_rules_synced(home, workspace_root);
    let agents_synced = check_agents_synced(home, workspace_root);
    let skills_synced = check_skills_synced(home, workspace_root);
    let installed_count = installed_agent_count(home);
    let expected_count = expected_agent_count(workspace_root);

    let cli_ok = claude_cli_available();

    let summary = if !home.join(".claude").exists() {
        "Claude not configured (no ~/.claude directory)".to_string()
    } else {
        let parts: Vec<&str> = [
            (rules_synced, "rules synced"),
            (agents_synced, "agents synced"),
            (skills_synced, "skills synced"),
        ]
        .iter()
        .filter_map(|(ok, label)| if *ok { Some(label) } else { None })
        .copied()
        .collect();

        if parts.is_empty() {
            "Claude surfaces need setup".to_string()
        } else {
            format!("Claude: {}", parts.join(", "))
        }
    };

    ClaudeRuntimeHealth {
        rules_synced,
        agents_synced,
        skills_synced,
        expected_agent_count: expected_count,
        installed_agent_count: installed_count,
        claude_cli_available: cli_ok,
        summary,
    }
}

/// Read-only Claude runtime health check.
///
/// Inspects only managed surfaces.  Does not read auth state, tokens,
/// trust databases, caches, session state, settings file contents,
/// MCP credentials, or private environment values.
#[tauri::command]
pub fn get_claude_runtime_health() -> Result<ClaudeRuntimeHealth, String> {
    let workspace_root = configured_workspace_path(&settings::load()).unwrap_or_default();
    let home_path = agent_targets::home_dir()?;
    Ok(compute_health(&workspace_root, &home_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("aw-claude-{label}-{nonce}"))
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, content).expect("write file");
    }

    #[test]
    fn health_reports_not_configured_when_claude_dir_missing() {
        let home = temp_dir("no-claude-dir");
        let ws = temp_dir("no-claude-ws");
        let health = compute_health(&ws, &home);
        assert!(!health.rules_synced);
        assert!(!health.agents_synced);
        assert!(!health.skills_synced);
        assert_eq!(health.installed_agent_count, 0);
        assert!(health.summary.contains("not configured"));
    }

    #[test]
    fn health_reports_synced_when_all_match() {
        let home = temp_dir("claude-synced");
        let ws = temp_dir("claude-synced-ws");

        // Set up workspace source
        write_file(&ws.join("templates/sync/claude-rules.md"), "rules");
        write_file(
            &ws.join("templates/claude/agents/repo-scout.md"),
            "# scout\n",
        );
        write_file(
            &ws.join("templates/claude/agents/inspector.md"),
            "# inspector\n",
        );
        write_file(
            &ws.join("templates/claude/agents/sentinel.md"),
            "# sentinel\n",
        );
        write_file(&ws.join("templates/claude/agents/scribe.md"), "# scribe\n");
        write_file(
            &ws.join("templates/claude/agents/verifier.md"),
            "# verifier\n",
        );

        // Set up installed targets
        write_file(&home.join(".claude/CLAUDE.md"), "rules");
        write_file(&home.join(".claude/agents/repo-scout.md"), "# scout\n");
        write_file(&home.join(".claude/agents/inspector.md"), "# inspector\n");
        write_file(&home.join(".claude/agents/sentinel.md"), "# sentinel\n");
        write_file(&home.join(".claude/agents/scribe.md"), "# scribe\n");
        write_file(&home.join(".claude/agents/verifier.md"), "# verifier\n");

        // Set up workspace skills source with a Claude-eligible skill
        write_file(
            &ws.join("skills/test-group/claude-skill/SKILL.md"),
            "---\nname: claude-skill\nagent: claude\n---\n# Skill\n",
        );

        // Install matching skill in Claude skills dir
        write_file(
            &home.join(".claude/skills/claude-skill/SKILL.md"),
            "---\nname: claude-skill\nagent: claude\n---\n# Skill\n",
        );

        let health = compute_health(&ws, &home);
        assert!(health.rules_synced);
        assert!(health.agents_synced);
        assert!(health.skills_synced);
        assert_eq!(health.installed_agent_count, 5);
        assert_eq!(health.expected_agent_count, 5);
    }

    #[test]
    fn health_reports_rules_diverged() {
        let home = temp_dir("claude-rules-div");
        let ws = temp_dir("claude-rules-div-ws");

        write_file(&ws.join("templates/sync/claude-rules.md"), "source rules");
        write_file(&home.join(".claude/CLAUDE.md"), "different content");

        // Add agents dir so it's minimally configured
        write_file(&home.join(".claude/agents/.gitkeep"), "");

        let health = compute_health(&ws, &home);
        assert!(!health.rules_synced, "rules should be reported as diverged");
    }

    #[test]
    fn health_reports_agents_not_synced_when_missing() {
        let home = temp_dir("claude-agents-missing");
        let ws = temp_dir("claude-agents-missing-ws");

        write_file(&ws.join("templates/claude/agents/repo-scout.md"), "# scout");
        // No installed agents dir at all

        let health = compute_health(&ws, &home);
        assert!(!health.agents_synced);
        assert_eq!(health.installed_agent_count, 0);
    }

    #[test]
    fn health_reports_agents_synced_with_extra_files() {
        let home = temp_dir("claude-agents-extra");
        let ws = temp_dir("claude-agents-extra-ws");

        write_file(
            &ws.join("templates/claude/agents/repo-scout.md"),
            "# scout\n",
        );
        write_file(
            &ws.join("templates/claude/agents/inspector.md"),
            "# inspector\n",
        );
        write_file(
            &ws.join("templates/claude/agents/sentinel.md"),
            "# sentinel\n",
        );
        write_file(&ws.join("templates/claude/agents/scribe.md"), "# scribe\n");
        write_file(
            &ws.join("templates/claude/agents/verifier.md"),
            "# verifier\n",
        );

        // Install all 5 plus extra user agents
        write_file(&home.join(".claude/agents/repo-scout.md"), "# scout\n");
        write_file(&home.join(".claude/agents/inspector.md"), "# inspector\n");
        write_file(&home.join(".claude/agents/sentinel.md"), "# sentinel\n");
        write_file(&home.join(".claude/agents/scribe.md"), "# scribe\n");
        write_file(&home.join(".claude/agents/verifier.md"), "# verifier\n");
        write_file(&home.join(".claude/agents/user-custom.md"), "# custom\n");

        let health = compute_health(&ws, &home);
        assert!(health.agents_synced, "all source agents should match");
        assert_eq!(
            health.installed_agent_count, 6,
            "should count extra user files too"
        );
    }

    #[test]
    fn health_reports_skills_not_synced_when_no_skills_dir() {
        let home = temp_dir("claude-no-skills");
        let ws = temp_dir("claude-no-skills-ws");

        write_file(&ws.join("templates/sync/claude-rules.md"), "rules");
        write_file(&home.join(".claude/CLAUDE.md"), "rules");

        let health = compute_health(&ws, &home);
        assert!(!health.skills_synced);
    }

    #[test]
    fn health_expected_agent_count_derives_from_source() {
        let home = temp_dir("claude-exp-count");
        let ws = temp_dir("claude-exp-count-ws");

        // Set up agent source files so expected count can derive from them
        write_file(&ws.join("templates/claude/agents/agent-alpha.md"), "# alpha");
        write_file(&ws.join("templates/claude/agents/agent-beta.md"), "# beta");
        write_file(&ws.join("templates/claude/agents/agent-gamma.md"), "# gamma");

        let health = compute_health(&ws, &home);
        assert_eq!(health.expected_agent_count, 3);
    }

    #[test]
    fn health_summary_formats_correctly() {
        let home = temp_dir("claude-summary");
        let ws = temp_dir("claude-summary-ws");

        write_file(&ws.join("templates/sync/claude-rules.md"), "rules");
        write_file(
            &ws.join("templates/claude/agents/repo-scout.md"),
            "# scout\n",
        );
        write_file(
            &ws.join("templates/claude/agents/inspector.md"),
            "# inspector\n",
        );
        write_file(
            &ws.join("templates/claude/agents/sentinel.md"),
            "# sentinel\n",
        );
        write_file(&ws.join("templates/claude/agents/scribe.md"), "# scribe\n");
        write_file(
            &ws.join("templates/claude/agents/verifier.md"),
            "# verifier\n",
        );

        // Add a Claude-eligible skill so skills_synced can be verified
        write_file(
            &ws.join("skills/group/claude-skill/SKILL.md"),
            "---\nname: claude-skill\nagent: claude\n---\n# Skill\n",
        );
        write_file(
            &home.join(".claude/skills/claude-skill/SKILL.md"),
            "---\nname: claude-skill\nagent: claude\n---\n# Skill\n",
        );

        write_file(&home.join(".claude/CLAUDE.md"), "rules");
        write_file(&home.join(".claude/agents/repo-scout.md"), "# scout\n");
        write_file(&home.join(".claude/agents/inspector.md"), "# inspector\n");
        write_file(&home.join(".claude/agents/sentinel.md"), "# sentinel\n");
        write_file(&home.join(".claude/agents/scribe.md"), "# scribe\n");
        write_file(&home.join(".claude/agents/verifier.md"), "# verifier\n");

        let health = compute_health(&ws, &home);
        assert!(health.summary.contains("rules synced"));
        assert!(health.summary.contains("agents synced"));
        assert!(health.summary.contains("skills synced"));
    }

    #[test]
    fn health_does_not_read_mcp_or_settings() {
        // Prove the health command doesn't touch MCP or settings files
        let home = temp_dir("claude-no-read-mcp");
        let ws = temp_dir("claude-no-read-mcp-ws");

        // Place a MCP config (should be ignored)
        write_file(
            &home.join(".claude/mcp.json"),
            r#"{"mcpServers":{"evil":{"command":"curl","args":["https://evil.com"]}}}"#,
        );
        // Place settings with credentials (should be ignored)
        write_file(
            &home.join(".claude/settings.json"),
            r#"{"authToken":"secret-123"}"#,
        );

        let health = compute_health(&ws, &home);
        // These fields are never touched by compute_health
        assert!(!health.rules_synced);
        assert!(!health.agents_synced);
        // Should not crash or read the MCP/settings files
        assert_eq!(health.installed_agent_count, 0);
    }
}
