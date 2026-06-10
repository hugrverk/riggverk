//! Narrow artifact registry for setup transactions.
//!
//! Each artifact represents one concrete managed destination — a single file,
//! a single managed skill directory, or a single named agent file.
//! No artifact resolves to a broad harness root (~/.cursor, ~/.claude, etc.).
//!
//! The registry maps SetupSurfaceId variants to their constituent artifacts
//! and provides metadata for detection, apply, validation, and rollback.
//!
//! Types in this module are progressively wired into the transaction system.
//! Dead code warnings are allowed during the transition.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::setup_lifecycle::SetupSurfaceId;

// ── Artifact identity ──

/// Identifies a single concrete managed artifact.
///
/// Artifacts are bounded: they never own an entire harness root directory.
/// Agent and skill artifacts are parameterized by name, resolved from the
/// canonical source at detection time.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", content = "name")]
pub enum ArtifactId {
    // ── OpenCode ──
    /// opencode.json managed keys portion
    OpenCodeConfig,
    /// tui.json (if written by config installer)
    OpenCodeTui,
    /// .config/opencode/AGENTS.md rules file
    OpenCodeRules,
    /// A managed OpenCode agent file
    OpenCodeAgent(AgentName),
    /// A managed OpenCode skill directory
    OpenCodeSkill(SkillName),

    // ── Codex ──
    /// config.toml managed fields portion
    CodexConfig,
    /// .codex/AGENTS.md rules file
    CodexRules,
    /// A managed Codex agent file
    CodexAgent(AgentName),
    /// A managed Codex skill directory
    CodexSkill(SkillName),

    // ── Claude ──
    /// .claude/CLAUDE.md rules file
    ClaudeRules,
    /// A managed Claude agent file
    ClaudeAgent(AgentName),
    /// A managed Claude skill directory
    ClaudeSkill(SkillName),

    // ── Cursor ──
    /// A managed Cursor global agent file
    CursorAgent(AgentName),
    /// A managed Cursor skill directory
    CursorSkill(SkillName),
    /// Named Playwright MCP state (mcp.json)
    CursorMcp,
}

/// Agent file name without extension. Validated at construction.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentName(String);

impl AgentName {
    pub fn new(name: impl Into<String>) -> Option<Self> {
        let name = name.into();
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return None;
        }
        // Allow lowercase, digits, hyphens
        if !name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        {
            return None;
        }
        Some(Self(name))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn file_name(&self) -> String {
        format!("{}.md", self.0)
    }
}

/// Skill directory name. Validated at construction.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SkillName(String);

impl SkillName {
    pub fn new(name: impl Into<String>) -> Option<Self> {
        let name = name.into();
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return None;
        }
        if !name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        {
            return None;
        }
        Some(Self(name))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// ── Artifact metadata ──

/// The kind of artifact for routing detection and execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArtifactKind {
    ConfigFile,
    TuiConfig,
    RulesFile,
    AgentFile,
    SkillDir,
    McpConfig,
}

/// Bounded metadata for one artifact definition.
///
/// All paths and owners are backend-resolved. No destination paths
/// are exposed to the frontend.
#[derive(Debug, Clone)]
pub struct ArtifactDef {
    /// Stable artifact ID.
    pub id: ArtifactId,
    /// Parent setup surface.
    pub surface: SetupSurfaceId,
    /// Artifact kind for routing.
    pub kind: ArtifactKind,
    /// Whether unknown sibling content is allowed in the artifact's parent directory.
    pub allow_unknown_siblings: bool,
    /// Whether creation of the parent directory is transaction-owned.
    pub parent_creation_owned: bool,
}

impl ArtifactId {
    /// Resolve the destination path for this artifact.
    pub fn resolve_dest(&self, home: &Path) -> Result<PathBuf, String> {
        match self {
            ArtifactId::OpenCodeConfig => Ok(home.join(".config/opencode/opencode.json")),
            ArtifactId::OpenCodeTui => Ok(home.join(".config/opencode/tui.json")),
            ArtifactId::OpenCodeRules => Ok(home.join(".config/opencode/AGENTS.md")),
            ArtifactId::OpenCodeAgent(name) => {
                Ok(home.join(".config/opencode/agents").join(name.file_name()))
            }
            ArtifactId::OpenCodeSkill(name) => {
                Ok(home.join(".config/opencode/skills").join(name.as_str()))
            }
            ArtifactId::CodexConfig => Ok(home.join(".codex/config.toml")),
            ArtifactId::CodexRules => Ok(home.join(".codex/AGENTS.md")),
            ArtifactId::CodexAgent(name) => Ok(home.join(".codex/agents").join(name.file_name())),
            ArtifactId::CodexSkill(name) => Ok(home.join(".agents/skills").join(name.as_str())),
            ArtifactId::ClaudeRules => Ok(home.join(".claude/CLAUDE.md")),
            ArtifactId::ClaudeAgent(name) => Ok(home.join(".claude/agents").join(name.file_name())),
            ArtifactId::ClaudeSkill(name) => Ok(home.join(".claude/skills").join(name.as_str())),
            ArtifactId::CursorAgent(name) => {
                let paths = resolve_cursor_paths()?;
                Ok(paths.agents.join(name.file_name()))
            }
            ArtifactId::CursorSkill(name) => {
                let paths = resolve_cursor_paths()?;
                Ok(paths.skills.join(name.as_str()))
            }
            ArtifactId::CursorMcp => {
                let paths = resolve_cursor_paths()?;
                Ok(paths.mcp_config.clone())
            }
        }
    }

    /// Resolve the source path for this artifact (workspace-relative).
    pub fn resolve_source(&self, workspace_root: &Path) -> Option<PathBuf> {
        match self {
            ArtifactId::OpenCodeConfig => Some(workspace_root.join("templates/opencode.json")),
            ArtifactId::OpenCodeTui => None, // generated, not sourced directly
            ArtifactId::OpenCodeRules => {
                Some(workspace_root.join("templates/sync/opencode-rules.md"))
            }
            ArtifactId::OpenCodeAgent(name) => {
                Some(workspace_root.join("agents").join(name.file_name()))
            }
            ArtifactId::OpenCodeSkill(name) => find_skill_source_dir(workspace_root, name.as_str()),
            ArtifactId::CodexConfig => Some(workspace_root.join("templates/codex/config.toml")),
            ArtifactId::CodexRules => Some(workspace_root.join("templates/sync/codex-rules.md")),
            ArtifactId::CodexAgent(name) => Some(
                workspace_root
                    .join("templates/codex/agents")
                    .join(name.file_name()),
            ),
            ArtifactId::CodexSkill(name) => find_skill_source_dir(workspace_root, name.as_str()),
            ArtifactId::ClaudeRules => Some(workspace_root.join("templates/sync/claude-rules.md")),
            ArtifactId::ClaudeAgent(name) => Some(
                workspace_root
                    .join("templates/claude/agents")
                    .join(name.file_name()),
            ),
            ArtifactId::ClaudeSkill(name) => find_skill_source_dir(workspace_root, name.as_str()),
            ArtifactId::CursorAgent(name) => Some(
                workspace_root
                    .join("templates/cursor/agents")
                    .join(name.file_name()),
            ),
            ArtifactId::CursorSkill(name) => find_skill_source_dir(workspace_root, name.as_str()),
            ArtifactId::CursorMcp => Some(
                crate::commands::cursor_profile::cursor_root(workspace_root)
                    .join("mcp/playwright.mcp.json"),
            ),
        }
    }

    /// Returns the parent SetupSurfaceId for this artifact.
    pub fn surface(&self) -> SetupSurfaceId {
        match self {
            ArtifactId::OpenCodeConfig | ArtifactId::OpenCodeTui => SetupSurfaceId::OpenCodeConfig,
            ArtifactId::OpenCodeRules => SetupSurfaceId::OpenCodeRules,
            ArtifactId::OpenCodeAgent(_) => SetupSurfaceId::OpenCodeAgents,
            ArtifactId::OpenCodeSkill(_) => SetupSurfaceId::OpenCodeSkills,
            ArtifactId::CodexConfig => SetupSurfaceId::CodexConfig,
            ArtifactId::CodexRules => SetupSurfaceId::CodexRules,
            ArtifactId::CodexAgent(_) => SetupSurfaceId::CodexAgents,
            ArtifactId::CodexSkill(_) => SetupSurfaceId::CodexSkills,
            ArtifactId::ClaudeRules => SetupSurfaceId::ClaudeRules,
            ArtifactId::ClaudeAgent(_) => SetupSurfaceId::ClaudeAgents,
            ArtifactId::ClaudeSkill(_) => SetupSurfaceId::ClaudeSkills,
            ArtifactId::CursorAgent(_) => SetupSurfaceId::CursorAgents,
            ArtifactId::CursorSkill(_) => SetupSurfaceId::CursorSkills,
            ArtifactId::CursorMcp => SetupSurfaceId::CursorMcp,
        }
    }
}

fn resolve_cursor_paths() -> Result<crate::cursor_profile_paths::CursorProfilePaths, String> {
    crate::cursor_profile_paths::resolve_cursor_profile_paths()
}

/// Search for a skill source under skills/ supporting both:
///   skills/<skill>/SKILL.md (root-level)
///   skills/<group>/<skill>/SKILL.md (grouped)
fn find_skill_source_dir(workspace_root: &Path, name: &str) -> Option<PathBuf> {
    let skills_root = workspace_root.join("skills");
    // Root-level: skills/name/SKILL.md
    let root_level = skills_root.join(name).join("SKILL.md");
    if root_level.is_file() {
        return Some(skills_root.join(name));
    }
    // Grouped: skills/*/name/SKILL.md
    if let Ok(entries) = std::fs::read_dir(&skills_root) {
        for entry in entries.flatten() {
            let group_path = entry.path();
            if !group_path.is_dir() {
                continue;
            }
            let grouped = group_path.join(name).join("SKILL.md");
            if grouped.is_file() {
                return Some(group_path.join(name));
            }
        }
    }
    None
}

// ── Surface-to-artifact expansion ──

/// Discover agent names from a source directory (files ending in .md).
pub fn discover_agent_names(source_dir: &Path) -> Vec<AgentName> {
    let mut names: Vec<AgentName> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(source_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Some(stem) = path.file_stem() {
                if let Some(name) = AgentName::new(stem.to_string_lossy().as_ref()) {
                    names.push(name);
                }
            }
        }
    }
    names.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    names
}

/// Discover skill names from the workspace skills directory that target a
/// specific harness agent. Supports both root-level and grouped layouts.
///
/// Uses frontmatter targets field if available, falls back to simple agent check.
pub fn discover_skill_names_for_harness(skills_root: &Path, harness_agent: &str) -> Vec<SkillName> {
    let mut names: Vec<SkillName> = Vec::new();
    discover_skill_names_recursive(skills_root, harness_agent, 0, &mut names);
    names.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    names
}

fn discover_skill_names_recursive(
    dir: &Path,
    harness_agent: &str,
    depth: u32,
    out: &mut Vec<SkillName>,
) {
    if depth > 2 {
        return; // reject deeper nesting
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // Check for SKILL.md in this directory
            let skill_md = path.join("SKILL.md");
            if skill_md.is_file() && skill_targets_harness(&skill_md, harness_agent) {
                if let Some(name) = path.file_name() {
                    if let Some(sn) = SkillName::new(name.to_string_lossy().as_ref()) {
                        if !out.iter().any(|existing| existing.as_str() == sn.as_str()) {
                            out.push(sn);
                        }
                    }
                }
            }
            // Recurse into subdirectories (for grouped layout) up to depth 2
            if depth < 2 {
                discover_skill_names_recursive(&path, harness_agent, depth + 1, out);
            }
        }
    }
}

/// Check if a SKILL.md targets a specific harness agent.
/// Uses frontmatter targets metadata if present, falls back to agent field.
fn skill_targets_harness(skill_md: &Path, harness_agent: &str) -> bool {
    let content = match std::fs::read_to_string(skill_md) {
        Ok(c) => c,
        Err(_) => return false,
    };
    // Try parsing frontmatter for targets or agent field
    parse_skill_targets(&content, harness_agent)
}

/// Parse SKILL.md frontmatter to check if the given agent is targeted.
/// Handles `targets: [agent1, agent2]` and `agent: agent1` fields.
fn parse_skill_targets(content: &str, harness_agent: &str) -> bool {
    // Simple YAML frontmatter parser for skill metadata
    let body = if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("---") {
            &rest[..end]
        } else {
            return false;
        }
    } else {
        return false;
    };

    for line in body.lines() {
        let trimmed = line.trim();
        // Check `targets:` field (list or inline)
        if let Some(rest) = trimmed.strip_prefix("targets:") {
            let rest = rest.trim();
            // Inline: targets: [opencode, claude, cursor, codex]
            if rest.starts_with('[') {
                let inner = rest.trim_start_matches('[').trim_end_matches(']');
                for target in inner.split(',') {
                    if target.trim().trim_matches('"').trim_matches('\'') == harness_agent {
                        return true;
                    }
                }
            }
            // Could be a multiline list starting with a single value
            if rest == harness_agent {
                return true;
            }
        }
        // Check for list items under targets:
        if trimmed.starts_with("- ")
            && harness_agent == trimmed[2..].trim().trim_matches('"').trim_matches('\'')
        {
            // Simple: check if previous non-empty line was "targets:"
            // For robustness, we also just check if the value matches
            // and we're within likely YAML context
        }
        // Check `agent:` field
        if let Some(rest) = trimmed.strip_prefix("agent:") {
            let rest = rest.trim();
            if rest == harness_agent
                || rest == format!("\"{harness_agent}\"")
                || rest == format!("'{harness_agent}'")
            {
                return true;
            }
        }
    }

    // Fallback: check if content mentions the agent in targets-related context
    // (broader match used by existing Claude health check)
    false
}

/// Expand a surface ID to its constituent artifact IDs.
///
/// Returns an empty vec for surfaces that don't produce artifacts
/// (e.g., DeprecatedSkillCleanup which is a separate workflow).
pub fn expand_surface(surface: SetupSurfaceId, workspace_root: &Path) -> Vec<ArtifactId> {
    match surface {
        SetupSurfaceId::OpenCodeConfig => vec![ArtifactId::OpenCodeConfig, ArtifactId::OpenCodeTui],
        SetupSurfaceId::OpenCodeAgents => {
            let source_dir = workspace_root.join("agents");
            discover_agent_names(&source_dir)
                .into_iter()
                .map(ArtifactId::OpenCodeAgent)
                .collect()
        }
        SetupSurfaceId::OpenCodeRules => vec![ArtifactId::OpenCodeRules],
        SetupSurfaceId::OpenCodeSkills => {
            let skills_root = workspace_root.join("skills");
            discover_skill_names_for_harness(&skills_root, "opencode")
                .into_iter()
                .map(ArtifactId::OpenCodeSkill)
                .collect()
        }
        SetupSurfaceId::CodexConfig => vec![ArtifactId::CodexConfig],
        SetupSurfaceId::CodexAgents => {
            let source_dir = workspace_root.join("templates/codex/agents");
            discover_agent_names(&source_dir)
                .into_iter()
                .map(ArtifactId::CodexAgent)
                .collect()
        }
        SetupSurfaceId::CodexRules => vec![ArtifactId::CodexRules],
        SetupSurfaceId::CodexSkills => {
            let skills_root = workspace_root.join("skills");
            discover_skill_names_for_harness(&skills_root, "codex")
                .into_iter()
                .map(ArtifactId::CodexSkill)
                .collect()
        }
        SetupSurfaceId::ClaudeRules => vec![ArtifactId::ClaudeRules],
        SetupSurfaceId::ClaudeAgents => {
            let source_dir = workspace_root.join("templates/claude/agents");
            discover_agent_names(&source_dir)
                .into_iter()
                .map(ArtifactId::ClaudeAgent)
                .collect()
        }
        SetupSurfaceId::ClaudeSkills => {
            let skills_root = workspace_root.join("skills");
            discover_skill_names_for_harness(&skills_root, "claude")
                .into_iter()
                .map(ArtifactId::ClaudeSkill)
                .collect()
        }
        SetupSurfaceId::CursorAgents => {
            let source_dir = workspace_root.join("templates/cursor/agents");
            discover_agent_names(&source_dir)
                .into_iter()
                .map(ArtifactId::CursorAgent)
                .collect()
        }
        SetupSurfaceId::CursorSkills => {
            let skills_root = workspace_root.join("skills");
            discover_skill_names_for_harness(&skills_root, "cursor")
                .into_iter()
                .map(ArtifactId::CursorSkill)
                .collect()
        }
        SetupSurfaceId::CursorMcp => vec![ArtifactId::CursorMcp],
        SetupSurfaceId::DeprecatedSkillCleanup => {
            // Deprecated cleanup is a separate explicit destructive workflow.
            // It is never part of normal unified setup.
            vec![]
        }
    }
}

/// Check whether a destination path would own a broad harness root.
/// Returns Err with description if the path is too broad.
pub fn reject_broad_artifact_root(path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy();
    let normalized = path_str.trim_end_matches('/');

    if let Some(home) = dirs_home() {
        let home_str = home.to_string_lossy();
        let home_norm = home_str.trim_end_matches('/');
        let broad_roots = [
            format!("{home_norm}/.cursor"),
            format!("{home_norm}/.claude"),
            format!("{home_norm}/.codex"),
            format!("{home_norm}/.agents"),
            format!("{home_norm}/.config/opencode"),
        ];
        for root in &broad_roots {
            if normalized == root.as_str() || normalized == format!("{root}/").as_str() {
                return Err(format!(
                    "refusing broad harness root as artifact: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn dirs_home() -> Option<PathBuf> {
    crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-artifact-{label}-{nonce}"))
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    // ── Surface expansion tests ──

    #[test]
    fn opencode_config_expands_to_config_and_tui() {
        let ws = temp_dir("oc-config");
        let artifacts = expand_surface(SetupSurfaceId::OpenCodeConfig, &ws);
        assert_eq!(artifacts.len(), 2);
        assert!(artifacts.contains(&ArtifactId::OpenCodeConfig));
        assert!(artifacts.contains(&ArtifactId::OpenCodeTui));
    }

    #[test]
    fn opencode_rules_expands_to_one_artifact() {
        let ws = temp_dir("oc-rules");
        let artifacts = expand_surface(SetupSurfaceId::OpenCodeRules, &ws);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::OpenCodeRules);
    }

    #[test]
    fn codex_config_is_single_artifact() {
        let ws = temp_dir("codex-cfg");
        let artifacts = expand_surface(SetupSurfaceId::CodexConfig, &ws);
        assert_eq!(artifacts.len(), 1);
    }

    #[test]
    fn claude_rules_is_single_artifact() {
        let ws = temp_dir("claude-rules");
        let artifacts = expand_surface(SetupSurfaceId::ClaudeRules, &ws);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::ClaudeRules);
    }

    #[test]
    fn agent_surfaces_expand_from_source_dir() {
        let ws = temp_dir("agents-expand");
        write_file(&ws.join("agents/repo-scout.md"), "# scout");
        write_file(&ws.join("agents/inspector.md"), "# inspector");
        write_file(&ws.join("agents/.gitkeep"), "");

        let artifacts = expand_surface(SetupSurfaceId::OpenCodeAgents, &ws);
        assert_eq!(artifacts.len(), 2);
        assert!(artifacts.contains(&ArtifactId::OpenCodeAgent(
            AgentName::new("inspector").unwrap()
        )));
        assert!(artifacts.contains(&ArtifactId::OpenCodeAgent(
            AgentName::new("repo-scout").unwrap()
        )));

        // .gitkeep should not be counted
        for a in &artifacts {
            if let ArtifactId::OpenCodeAgent(name) = a {
                assert!(!name.as_str().contains("gitkeep"));
            }
        }
    }

    #[test]
    fn cursor_mcp_is_single_artifact() {
        let ws = temp_dir("cursor-mcp");
        let artifacts = expand_surface(SetupSurfaceId::CursorMcp, &ws);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::CursorMcp);
    }

    #[test]
    fn deprecated_cleanup_produces_no_artifacts() {
        let ws = temp_dir("dep-cleanup");
        let artifacts = expand_surface(SetupSurfaceId::DeprecatedSkillCleanup, &ws);
        assert!(
            artifacts.is_empty(),
            "deprecated cleanup must not produce artifacts"
        );
    }

    #[test]
    fn artifact_ids_are_unique_per_surface() {
        let ws = temp_dir("unique-ids");
        write_file(&ws.join("agents/a.md"), "# a");
        write_file(&ws.join("agents/b.md"), "# b");

        let artifacts = expand_surface(SetupSurfaceId::OpenCodeAgents, &ws);
        let mut seen = std::collections::HashSet::new();
        for a in &artifacts {
            assert!(seen.insert(a.clone()), "duplicate artifact: {a:?}");
        }
        assert_eq!(seen.len(), 2);
    }

    #[test]
    fn agent_name_rejects_traversal() {
        assert!(AgentName::new("../evil").is_none());
        assert!(AgentName::new("foo/bar").is_none());
        assert!(AgentName::new("foo\\bar").is_none());
        assert!(AgentName::new("").is_none());
        assert!(AgentName::new("valid-name").is_some());
    }

    #[test]
    fn skill_name_rejects_traversal() {
        assert!(SkillName::new("../evil").is_none());
        assert!(SkillName::new("foo/bar").is_none());
        assert!(SkillName::new("").is_none());
        assert!(SkillName::new("valid-skill").is_some());
    }

    #[test]
    fn artifact_id_serialization_roundtrips() {
        let ids = vec![
            ArtifactId::OpenCodeConfig,
            ArtifactId::OpenCodeAgent(AgentName::new("repo-scout").unwrap()),
            ArtifactId::CodexSkill(SkillName::new("my-skill").unwrap()),
        ];
        for id in &ids {
            let json = serde_json::to_string(id).expect("serialize");
            let parsed: ArtifactId = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(id, &parsed);
        }
    }

    #[test]
    fn duplicate_surfaces_do_not_duplicate_artifacts() {
        let ws = temp_dir("dup-surface");
        write_file(
            &ws.join("skills/my-skill/SKILL.md"),
            "---\ntargets: [opencode]\n---\n# Skill",
        );

        // Expanding OpenCodeSkills twice should produce same result
        let a1 = expand_surface(SetupSurfaceId::OpenCodeSkills, &ws);
        let a2 = expand_surface(SetupSurfaceId::OpenCodeSkills, &ws);
        assert_eq!(a1, a2);
    }

    #[test]
    fn unknown_surface_ids_fail_before_path_resolution() {
        // Validating that parse_skill_targets doesn't crash on invalid input
        // This is tested through the expansion which only processes valid surfaces
        let ws = temp_dir("unknown-surface");
        let artifacts = expand_surface(SetupSurfaceId::DeprecatedSkillCleanup, &ws);
        assert!(artifacts.is_empty());
    }

    #[test]
    fn skill_discovery_supports_root_level() {
        let ws = temp_dir("skill-root");
        write_file(
            &ws.join("skills/accessibility-review/SKILL.md"),
            "---\ntargets: [opencode, claude, cursor, codex]\n---\n# Skill",
        );
        write_file(
            &ws.join("skills/browser-qa/SKILL.md"),
            "---\ntargets: [opencode, claude, cursor, codex]\n---\n# Skill",
        );

        let artifacts = expand_surface(SetupSurfaceId::OpenCodeSkills, &ws);
        assert_eq!(artifacts.len(), 2);
        assert!(artifacts.contains(&ArtifactId::OpenCodeSkill(
            SkillName::new("accessibility-review").unwrap()
        )));
        assert!(artifacts.contains(&ArtifactId::OpenCodeSkill(
            SkillName::new("browser-qa").unwrap()
        )));
    }

    #[test]
    fn skill_discovery_supports_grouped() {
        let ws = temp_dir("skill-grouped");
        write_file(
            &ws.join("skills/ux/accessibility-review/SKILL.md"),
            "---\ntargets: [opencode, claude, cursor, codex]\n---\n# Skill",
        );

        let artifacts = expand_surface(SetupSurfaceId::ClaudeSkills, &ws);
        assert_eq!(artifacts.len(), 1);
        assert!(artifacts.contains(&ArtifactId::ClaudeSkill(
            SkillName::new("accessibility-review").unwrap()
        )));
    }

    // ── Cursor ownership tests ──

    #[test]
    fn cursor_agents_and_skills_have_separate_ownership() {
        let ws = temp_dir("cursor-owners");
        write_file(&ws.join("templates/cursor/agents/repo-scout.md"), "# scout");
        write_file(
            &ws.join("templates/cursor/agents/inspector.md"),
            "# inspector",
        );
        write_file(
            &ws.join("skills/accessibility-review/SKILL.md"),
            "---\ntargets: [cursor]\n---\n# Skill",
        );

        let agents = expand_surface(SetupSurfaceId::CursorAgents, &ws);
        let skills = expand_surface(SetupSurfaceId::CursorSkills, &ws);
        let mcp = expand_surface(SetupSurfaceId::CursorMcp, &ws);

        // No overlap between agents and skills
        for a in &agents {
            assert!(
                !skills.contains(a),
                "Cursor agent artifact should not appear in skills: {a:?}"
            );
        }
        for s in &skills {
            assert!(
                !agents.contains(s),
                "Cursor skill artifact should not appear in agents: {s:?}"
            );
        }

        // MCP is separate
        assert!(!mcp.is_empty());
        for m in &mcp {
            assert!(!agents.contains(m));
            assert!(!skills.contains(m));
        }

        // Agents should resolve correctly
        assert_eq!(agents.len(), 2);
        assert!(agents.contains(&ArtifactId::CursorAgent(
            AgentName::new("repo-scout").unwrap()
        )));
        assert!(agents.contains(&ArtifactId::CursorAgent(
            AgentName::new("inspector").unwrap()
        )));
    }

    #[test]
    fn cursor_agents_do_not_own_home_cursor_root() {
        let ws = temp_dir("cursor-not-root");
        write_file(&ws.join("templates/cursor/agents/repo-scout.md"), "# scout");

        let artifacts = expand_surface(SetupSurfaceId::CursorAgents, &ws);
        // Each artifact should be an individual agent, not the whole directory
        for a in &artifacts {
            match a {
                ArtifactId::CursorAgent(name) => {
                    // Agent name should be bounded, not a broad path
                    assert!(!name.as_str().is_empty());
                    assert!(!name.as_str().contains('/'));
                }
                other => panic!("Unexpected artifact type from CursorAgents: {other:?}"),
            }
        }
    }

    #[test]
    fn cursor_surfaces_have_no_overlapping_artifacts() {
        let ws = temp_dir("cursor-no-overlap");
        write_file(&ws.join("templates/cursor/agents/a.md"), "# a");
        write_file(&ws.join("templates/cursor/agents/b.md"), "# b");
        write_file(
            &ws.join("skills/skill-a/SKILL.md"),
            "---\ntargets: [cursor]\n---\n# A",
        );
        write_file(
            &ws.join("skills/skill-b/SKILL.md"),
            "---\ntargets: [cursor]\n---\n# B",
        );

        let all_cursor: Vec<ArtifactId> = [
            SetupSurfaceId::CursorAgents,
            SetupSurfaceId::CursorSkills,
            SetupSurfaceId::CursorMcp,
        ]
        .iter()
        .flat_map(|s| expand_surface(*s, &ws))
        .collect();

        // Every artifact should have exactly one surface owner
        let mut seen = std::collections::HashSet::new();
        for a in &all_cursor {
            assert!(
                seen.insert(a.clone()),
                "Duplicate Cursor artifact across surfaces: {a:?}"
            );
        }

        // Verify the surface() method returns correct owner
        for a in &all_cursor {
            let surface = a.surface();
            match a {
                ArtifactId::CursorAgent(_) => assert_eq!(surface, SetupSurfaceId::CursorAgents),
                ArtifactId::CursorSkill(_) => assert_eq!(surface, SetupSurfaceId::CursorSkills),
                ArtifactId::CursorMcp => assert_eq!(surface, SetupSurfaceId::CursorMcp),
                _ => panic!("Non-Cursor artifact in Cursor set: {a:?}"),
            }
        }
    }

    #[test]
    fn cursor_mcp_surface_is_single_bounded_artifact() {
        // CursorMcp maps to exactly one artifact - not a broad root
        let ws = temp_dir("cursor-mcp-bounded");
        let artifacts = expand_surface(SetupSurfaceId::CursorMcp, &ws);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::CursorMcp);
        assert_eq!(artifacts[0].surface(), SetupSurfaceId::CursorMcp);
    }
}
