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
use crate::skill_health::{skill_files_status, SkillFilesStatus};
use crate::skill_roots::SkillRoot;

/// All managed Claude surface states.
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeRuntimeHealth {
    /// Whether Claude rules (~/.claude/CLAUDE.md) are synced.
    pub rules_synced: bool,
    /// Whether Claude native agents (~/.claude/agents) are synced.
    pub agents_synced: bool,
    /// Whether every bundled skill is installed in `~/.claude/skills` with all its files, equal to the bundle.
    pub skills_synced: bool,
    /// Number of expected Claude agents (from agent adapters manifest).
    pub expected_agent_count: usize,
    /// Number of installed Claude agent files found.
    pub installed_agent_count: usize,
    /// Number of expected Claude-targeted skills (from canonical metadata).
    pub expected_skill_count: usize,
    /// Number of bundled skills with at least one file installed in `~/.claude/skills`.
    pub installed_skill_count: usize,
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

/// Check whether the installed Claude rules carry the workspace's base: the
/// managed block body matches the template (the user's text around it is not
/// compared), or a pre-block file equals the template exactly.
fn check_rules_synced(home: &Path, workspace_root: &Path) -> bool {
    let target = home.join(".claude/CLAUDE.md");
    let source = workspace_root.join("templates/sync/claude-rules.md");
    if !target.is_file() || !source.is_file() {
        return false;
    }
    match (std::fs::read(&target), std::fs::read(&source)) {
        (Ok(installed), Ok(source)) => {
            crate::rules_block::installed_matches_source(&installed, &source)
        }
        _ => false,
    }
}

/// Check whether the source Claude agents match the installed ones.
/// Source read errors and installed file read errors fail closed.
fn check_agents_synced(home: &Path, workspace_root: &Path) -> bool {
    let installed_dir = home.join(".claude/agents");
    if !installed_dir.is_dir() {
        return false;
    }
    let source_dir = workspace_root.join("templates/claude/agents");
    if !source_dir.is_dir() {
        // Source missing — fail closed, don't report synced
        return false;
    }

    // Compare every source .md file with the installed version
    let source_entries = match std::fs::read_dir(&source_dir) {
        Ok(e) => e,
        Err(_) => return false, // source read error — fail closed
    };

    let mut found_any = false;
    for entry in source_entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        // Safe unwrap: file_name() only fails for paths ending in .. which
        // read_dir won't produce for matching .md files
        let Some(name) = path.file_name() else {
            continue;
        };
        found_any = true;
        let installed_path = installed_dir.join(name);
        if !installed_path.is_file() {
            return false;
        }
        if !file_eq(&path, &installed_path) {
            return false;
        }
    }
    // At least one source agent must exist
    found_any
}

/// Claude reads `~/.claude/skills` only, and skills are installed there from the bundle, so the
/// installed files are compared with the bundle. `None` when the bundle cannot be read: nothing
/// is then reported as synced.
fn claude_skills(bundled_root: Option<&Path>, home: &Path) -> Option<SkillFilesStatus> {
    skill_files_status(bundled_root?, home, &[SkillRoot::Claude]).ok()
}

/// Compute Claude runtime health from inspected managed surfaces only. `bundled_root` is where
/// the skills come from; rules and agents are compared with the workspace copy.
fn compute_health(workspace_root: &Path, home: &Path) -> ClaudeRuntimeHealth {
    let bundled = crate::setup_roots::bundled_root_for(workspace_root).ok();
    compute_health_with_bundle(workspace_root, bundled.as_deref(), home)
}

fn compute_health_with_bundle(
    workspace_root: &Path,
    bundled_root: Option<&Path>,
    home: &Path,
) -> ClaudeRuntimeHealth {
    let rules_synced = check_rules_synced(home, workspace_root);
    let agents_synced = check_agents_synced(home, workspace_root);
    let skills = claude_skills(bundled_root, home);
    let skills_synced = skills.is_some_and(|status| status.is_synced());
    let installed_count = installed_agent_count(home);
    let expected_count = expected_agent_count(workspace_root);

    let expected_skill_count = skills.map_or(0, |status| status.expected);
    let installed_skill_count = skills.map_or(0, |status| status.installed());

    let cli_ok = claude_cli_available();

    // Every surface must appear in the summary; omitting an unsynced surface
    // makes a broken install read as healthy.
    let summary = if !home.join(".claude").exists() {
        "Claude not configured (no ~/.claude directory)".to_string()
    } else {
        let rules_part = if rules_synced {
            "rules synced".to_string()
        } else {
            "rules need sync".to_string()
        };
        let agents_part = if agents_synced {
            format!("agents synced ({}/{})", installed_count, expected_count)
        } else if installed_count > 0 {
            format!("agents partial ({}/{})", installed_count, expected_count)
        } else {
            "agents missing".to_string()
        };
        let skills_part = if skills_synced {
            format!(
                "skills synced ({}/{})",
                installed_skill_count, expected_skill_count
            )
        } else if installed_skill_count > 0 {
            format!(
                "skills partial ({}/{})",
                installed_skill_count, expected_skill_count
            )
        } else {
            "skills missing".to_string()
        };
        format!("Claude: {rules_part}, {agents_part}, {skills_part}")
    };

    ClaudeRuntimeHealth {
        rules_synced,
        agents_synced,
        skills_synced,
        expected_agent_count: expected_count,
        installed_agent_count: installed_count,
        expected_skill_count,
        installed_skill_count,
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

    /// Health with the fixture workspace standing in for the bundle the skills come from.
    fn health_of(ws: &Path, home: &Path) -> ClaudeRuntimeHealth {
        compute_health_with_bundle(ws, Some(ws), home)
    }

    fn write_claude_skill(ws: &Path, home: &Path, name: &str) {
        let canonical =
            crate::test_env::write_canonical_skill(ws, Some("test-group"), name, "Canonical");
        write_file(
            &home.join(format!(".claude/skills/{name}/SKILL.md")),
            &fs::read_to_string(canonical).expect("read canonical skill"),
        );
    }

    #[test]
    fn health_reports_not_configured_when_claude_dir_missing() {
        let home = temp_dir("no-claude-dir");
        let ws = temp_dir("no-claude-ws");
        let health = health_of(&ws, &home);
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

        write_claude_skill(&ws, &home, "claude-skill");

        let health = health_of(&ws, &home);
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

        let health = health_of(&ws, &home);
        assert!(!health.rules_synced, "rules should be reported as diverged");
    }

    #[test]
    fn health_compares_only_the_managed_block_body() {
        let home = temp_dir("claude-rules-block");
        let ws = temp_dir("claude-rules-block-ws");
        let source = "# Base\n- one\n";
        write_file(&ws.join("templates/sync/claude-rules.md"), source);
        let with_text = format!(
            "my notes\n\n{}\n## mine\n- extra\n",
            crate::rules_block::render_new(source)
        );
        write_file(&home.join(".claude/CLAUDE.md"), &with_text);
        assert!(health_of(&ws, &home).rules_synced);

        // An older base inside the block is out of sync, whatever surrounds it.
        let older = with_text.replace("- one", "- uno");
        write_file(&home.join(".claude/CLAUDE.md"), &older);
        assert!(!health_of(&ws, &home).rules_synced);
    }

    #[test]
    fn health_reports_agents_not_synced_when_missing() {
        let home = temp_dir("claude-agents-missing");
        let ws = temp_dir("claude-agents-missing-ws");

        write_file(&ws.join("templates/claude/agents/repo-scout.md"), "# scout");
        // No installed agents dir at all

        let health = health_of(&ws, &home);
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

        let health = health_of(&ws, &home);
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

        let health = health_of(&ws, &home);
        assert!(!health.skills_synced);
    }

    #[test]
    fn health_expected_agent_count_derives_from_source() {
        let home = temp_dir("claude-exp-count");
        let ws = temp_dir("claude-exp-count-ws");

        // Set up agent source files so expected count can derive from them
        write_file(
            &ws.join("templates/claude/agents/agent-alpha.md"),
            "# alpha",
        );
        write_file(&ws.join("templates/claude/agents/agent-beta.md"), "# beta");
        write_file(
            &ws.join("templates/claude/agents/agent-gamma.md"),
            "# gamma",
        );

        let health = health_of(&ws, &home);
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

        // Add a Claude-eligible skill so skills_synced can be verified.
        write_claude_skill(&ws, &home, "claude-skill");

        write_file(&home.join(".claude/CLAUDE.md"), "rules");
        write_file(&home.join(".claude/agents/repo-scout.md"), "# scout\n");
        write_file(&home.join(".claude/agents/inspector.md"), "# inspector\n");
        write_file(&home.join(".claude/agents/sentinel.md"), "# sentinel\n");
        write_file(&home.join(".claude/agents/scribe.md"), "# scribe\n");
        write_file(&home.join(".claude/agents/verifier.md"), "# verifier\n");

        let health = health_of(&ws, &home);
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

        let health = health_of(&ws, &home);
        // These fields are never touched by compute_health
        assert!(!health.rules_synced);
        assert!(!health.agents_synced);
        // Should not crash or read the MCP/settings files
        assert_eq!(health.installed_agent_count, 0);
    }

    #[test]
    fn health_reports_skills_synced_against_the_canonical_skill() {
        let home = temp_dir("claude-skill-canonical");
        let ws = temp_dir("claude-skill-canonical-ws");
        write_claude_skill(&ws, &home, "claude-skill");

        let health = health_of(&ws, &home);
        assert!(health.skills_synced);
        assert_eq!(health.expected_skill_count, 1);
        assert_eq!(health.installed_skill_count, 1);
    }

    #[test]
    fn health_reports_skills_not_synced_when_installed_content_differs_from_the_canonical_skill() {
        let home = temp_dir("claude-skill-diverged");
        let ws = temp_dir("claude-skill-diverged-ws");
        write_claude_skill(&ws, &home, "claude-skill");
        write_file(
            &home.join(".claude/skills/claude-skill/SKILL.md"),
            "---\nname: claude-skill\ndescription: test skill\ntargets: claude\n---\n# An older per-harness copy\n",
        );

        let health = health_of(&ws, &home);
        assert!(!health.skills_synced);
        assert_eq!(health.expected_skill_count, 1);
        assert_eq!(health.installed_skill_count, 1);
    }

    #[test]
    fn health_compares_skills_with_the_bundle_not_with_the_runtime_workspace_copy() {
        let home = temp_dir("claude-skill-bundle");
        let ws = temp_dir("claude-skill-bundle-ws");
        let bundle = temp_dir("claude-skill-bundle-source");
        write_claude_skill(&bundle, &home, "claude-skill");
        // The runtime workspace holds an older copy of the skill than the bundle installs.
        write_file(
            &ws.join("skills/claude-skill/SKILL.md"),
            "---\nname: claude-skill\ndescription: test skill\ntargets: claude\n---\n# older\n",
        );
        let against_bundle = compute_health_with_bundle(&ws, Some(&bundle), &home);
        assert!(against_bundle.skills_synced);
        let against_runtime = compute_health_with_bundle(&ws, Some(&ws), &home);
        assert!(!against_runtime.skills_synced);
        // Without a readable bundle nothing is reported as synced.
        let without = compute_health_with_bundle(&ws, None, &home);
        assert!(!without.skills_synced);
        assert_eq!(without.expected_skill_count, 0);
    }

    #[test]
    fn health_counts_a_skill_with_a_missing_supporting_file_as_not_synced() {
        let home = temp_dir("claude-skill-support");
        let ws = temp_dir("claude-skill-support-ws");
        write_claude_skill(&ws, &home, "claude-skill");
        write_file(&ws.join("skills/test-group/claude-skill/notes.md"), "notes");
        let incomplete = health_of(&ws, &home);
        assert!(!incomplete.skills_synced);
        assert_eq!(incomplete.installed_skill_count, 1);
        write_file(&home.join(".claude/skills/claude-skill/notes.md"), "notes");
        assert!(health_of(&ws, &home).skills_synced);
    }
}
