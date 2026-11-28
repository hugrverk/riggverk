//! Claude Code runtime health and administration boundary.
//!
//! This module provides read-only health checks for managed Claude surfaces:
//! rules, native agents, and skills. Of every skill in `~/.claude/skills` it also reads the
//! frontmatter, to count how large Claude Code's skill listing is; only counts leave it.
//! It does NOT inspect:
//!   - authentication state or tokens
//!   - trust databases or caches
//!   - session state
//!   - settings file contents
//!   - MCP credentials
//!   - private environment values
//!
//! Claude settings and MCP configuration remain an explicit manual boundary
//! (see the Claude UI "Settings and MCP" card).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::agent_targets;
use crate::commands::status::file_eq;
use crate::skill_discovery::{frontmatter_fields, read_skill_md_capped};
use crate::skill_health::{skill_files_status, SkillFilesStatus};
use crate::skill_roots::SkillRoot;
use crate::skill_sources::SkillSources;

/// All managed Claude surface states.
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeRuntimeHealth {
    pub checked_version: Option<String>,
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
    /// How large the listing of the skills in `~/.claude/skills` is; `None` without that folder.
    pub skill_listing: Option<SkillListing>,
    /// Human-readable summary for the UI.
    pub summary: String,
}

/// The size of what Claude Code tells the model about the skills in `~/.claude/skills`. Counts
/// only: no text of a skill is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SkillListing {
    /// Skills the model is told about (not those with `disable-model-invocation: true`).
    pub skills: usize,
    /// Characters of their frontmatter `name`, `description` and `when_to_use`, summed.
    pub characters: usize,
}

/// A directory itself, not a link to one.
fn real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// The folders directly below `dir` that are real directories, dot folders left out.
fn child_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect()
}

/// The characters this skill adds to the listing, or `None` when Claude Code does not list it to
/// the model (`disable-model-invocation: true`) or its `SKILL.md` is not a regular file that can
/// be read. Frontmatter the strict reader refuses counts as empty, so the skill still counts with
/// its folder name: Claude Code names a skill without `name` after its folder.
fn listing_characters(dir: &Path) -> Option<usize> {
    let skill_md = dir.join("SKILL.md");
    if !std::fs::symlink_metadata(&skill_md).is_ok_and(|meta| meta.is_file()) {
        return None;
    }
    let fields = frontmatter_fields(&read_skill_md_capped(&skill_md).ok()?).unwrap_or_default();
    let field = |key: &str| fields.get(key).filter(|value| !value.is_empty());
    if field("disable-model-invocation").is_some_and(|value| value.eq_ignore_ascii_case("true")) {
        return None;
    }
    let name = field("name").map_or_else(
        || {
            dir.file_name()
                .map_or(0, |name| name.to_string_lossy().chars().count())
        },
        |name| name.chars().count(),
    );
    let rest: usize = ["description", "when_to_use"]
        .iter()
        .filter_map(|key| field(key))
        .map(|value| value.chars().count())
        .sum();
    Some(name + rest)
}

/// The listing of `~/.claude/skills/<name>` and `~/.claude/skills/synced/<name>` (and, for
/// skills synced per account, `synced/<account>/<name>`). No link is followed, at any level.
fn skill_listing(home: &Path) -> Option<SkillListing> {
    let root = home.join(".claude/skills");
    if !real_dir(&root) || std::fs::read_dir(&root).is_err() {
        return None;
    }
    let mut dirs = child_dirs(&root);
    let synced = root.join("synced");
    if real_dir(&synced) {
        for dir in child_dirs(&synced) {
            if std::fs::symlink_metadata(dir.join("SKILL.md")).is_ok() {
                dirs.push(dir);
            } else {
                dirs.extend(child_dirs(&dir));
            }
        }
    }
    let counted: Vec<usize> = dirs
        .iter()
        .filter_map(|dir| listing_characters(dir))
        .collect();
    Some(SkillListing {
        skills: counted.len(),
        characters: counted.iter().sum(),
    })
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

/// Count expected Claude agent source files in the bundle.
fn expected_agent_count(bundled_root: &Path) -> usize {
    let source_dir = bundled_root.join("templates/claude/agents");
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

/// Check whether the installed Claude rules carry the bundled base: the
/// managed block body matches the template (the user's text around it is not
/// compared), or a pre-block file equals the template exactly.
fn check_rules_synced(home: &Path, bundled_root: &Path, workspace_root: Option<&Path>) -> bool {
    let target = home.join(".claude/CLAUDE.md");
    target.is_file()
        && crate::pack_routing::health_rules_synced(
            &crate::artifact_registry::ArtifactId::ClaudeRules,
            &target,
            bundled_root,
            workspace_root,
        )
}

/// Check whether the bundled Claude agents match the installed ones.
/// Source read errors and installed file read errors fail closed.
fn check_agents_synced(home: &Path, bundled_root: &Path) -> bool {
    let installed_dir = home.join(".claude/agents");
    if !installed_dir.is_dir() {
        return false;
    }
    let source_dir = bundled_root.join("templates/claude/agents");
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
fn claude_skills(
    bundled_root: Option<&Path>,
    workspace_root: Option<&Path>,
    home: &Path,
) -> Option<SkillFilesStatus> {
    skill_files_status(
        &SkillSources::for_health(bundled_root?, workspace_root),
        home,
        &[SkillRoot::Claude],
    )
    .ok()
}

/// Compute Claude runtime health from inspected managed surfaces, plus the skill listing counts.
/// Rules, agents and skills are installed from the app's bundle, so that is what the installed
/// files are compared with; the workspace folder plays no part.
fn compute_health(home: &Path, workspace_root: Option<&Path>) -> ClaudeRuntimeHealth {
    let bundled = crate::setup_roots::bundled_root().ok();
    compute_health_with_bundle(bundled.as_deref(), workspace_root, home)
}

/// `None` when the bundle cannot be read: nothing is then reported as synced.
fn compute_health_with_bundle(
    bundled_root: Option<&Path>,
    workspace_root: Option<&Path>,
    home: &Path,
) -> ClaudeRuntimeHealth {
    let rules_synced =
        bundled_root.is_some_and(|root| check_rules_synced(home, root, workspace_root));
    let agents_synced = bundled_root.is_some_and(|root| check_agents_synced(home, root));
    let skills = claude_skills(bundled_root, workspace_root, home);
    let skills_synced = skills.is_some_and(|status| status.is_synced());
    let installed_count = installed_agent_count(home);
    let expected_count = bundled_root.map_or(0, expected_agent_count);

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
        checked_version: crate::harness_versions::get(crate::agent_targets::HarnessId::Claude)
            .checked_version
            .clone(),
        rules_synced,
        agents_synced,
        skills_synced,
        expected_agent_count: expected_count,
        installed_agent_count: installed_count,
        expected_skill_count,
        installed_skill_count,
        claude_cli_available: cli_ok,
        skill_listing: skill_listing(home),
        summary,
    }
}

/// Read-only Claude runtime health check.
///
/// Inspects managed surfaces, and the frontmatter of the skills in `~/.claude/skills` for the
/// listing counts.  Does not read auth state, tokens,
/// trust databases, caches, session state, settings file contents,
/// MCP credentials, or private environment values.
#[tauri::command]
pub fn get_claude_runtime_health() -> Result<ClaudeRuntimeHealth, String> {
    let home_path = agent_targets::home_dir()?;
    // The data folder only adds the packs' skills to what the install is compared with.
    let workspace_root = super::workspace::setup_workspace_target_path().ok();
    Ok(compute_health(&home_path, workspace_root.as_deref()))
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

    /// Health with the fixture standing in for the bundle everything is installed from.
    fn health_of(ws: &Path, home: &Path) -> ClaudeRuntimeHealth {
        compute_health_with_bundle(Some(ws), None, home)
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
        let against_bundle = compute_health_with_bundle(Some(&bundle), None, &home);
        assert!(against_bundle.skills_synced);
        let against_runtime = compute_health_with_bundle(Some(&ws), None, &home);
        assert!(!against_runtime.skills_synced);
        // Without a readable bundle nothing is reported as synced.
        let without = compute_health_with_bundle(None, None, &home);
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

    #[test]
    fn health_counts_the_skill_listing_of_the_personal_skills_folder() {
        let home = temp_dir("claude-listing");
        let ws = temp_dir("claude-listing-ws");
        let skills = home.join(".claude/skills");
        // name 5 + description 7 ("Ünicode" is seven characters, eight bytes).
        write_file(
            &skills.join("alpha/SKILL.md"),
            "---\nname: alpha\ndescription: Ünicode\n---\n# Alpha body is not counted\n",
        );
        // name 5 + description 4 + when_to_use 10.
        write_file(
            &skills.join("gamma/SKILL.md"),
            "---\nname: gamma\ndescription: Does\nwhen_to_use: When asked\n---\nbody\n",
        );
        // Below synced/: name 4 + description 6.
        write_file(
            &skills.join("synced/beta/SKILL.md"),
            "---\nname: beta\ndescription: Synced\n---\n",
        );
        // Synced per account, one level deeper: name 5 + description 7.
        write_file(
            &skills.join("synced/account/delta/SKILL.md"),
            "---\nname: delta\ndescription: Account\n---\n",
        );
        // Without `name`, the folder name: 7 + description 7.
        write_file(
            &skills.join("epsilon/SKILL.md"),
            "---\ndescription: No name\n---\n",
        );
        // Not listed to the model.
        write_file(
            &skills.join("manual/SKILL.md"),
            "---\nname: manual\ndescription: Only by hand\ndisable-model-invocation: true\n---\n",
        );
        // No SKILL.md: not a skill.
        write_file(&skills.join("notes/README.md"), "notes");

        let listing = health_of(&ws, &home).skill_listing;
        assert_eq!(
            listing,
            Some(SkillListing {
                skills: 5,
                characters: 12 + 19 + 10 + 12 + 14,
            })
        );
    }

    #[test]
    fn health_has_no_skill_listing_without_a_skills_folder() {
        let home = temp_dir("claude-listing-none");
        let ws = temp_dir("claude-listing-none-ws");
        fs::create_dir_all(home.join(".claude")).expect("create .claude");
        assert_eq!(health_of(&ws, &home).skill_listing, None);
    }

    #[cfg(unix)]
    #[test]
    fn health_skill_listing_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let home = temp_dir("claude-listing-link");
        let ws = temp_dir("claude-listing-link-ws");
        let outside = temp_dir("claude-listing-link-outside");
        write_file(
            &outside.join("linked/SKILL.md"),
            "---\nname: linked\ndescription: Outside\n---\n",
        );
        let skills = home.join(".claude/skills");
        write_file(
            &skills.join("real/SKILL.md"),
            "---\nname: real\ndescription: Here\n---\n",
        );
        symlink(outside.join("linked"), skills.join("linked")).expect("link a skill folder");
        fs::create_dir_all(skills.join("file-link")).expect("create folder");
        symlink(
            outside.join("linked/SKILL.md"),
            skills.join("file-link/SKILL.md"),
        )
        .expect("link a SKILL.md");

        assert_eq!(
            health_of(&ws, &home).skill_listing,
            Some(SkillListing {
                skills: 1,
                characters: 8,
            })
        );
    }
}
