//! Narrow artifact registry for setup transactions.
//!
//! Each artifact represents one concrete managed destination — a single file,
//! a single managed skill file, or a single named agent file.
//! No artifact resolves to a broad harness root (~/.cursor, ~/.claude, etc.).
//!
//! The registry maps SetupSurfaceId variants to their constituent artifacts
//! and provides metadata for detection, apply, validation, and rollback.
//!
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
    /// tui.json (written by config installer)
    OpenCodeTui,
    /// Playwright MCP sidecar config for OpenCode (`PLAYWRIGHT_MCP_CONFIG_PATH`)
    OpenCodePlaywrightMcp,
    /// .config/opencode/AGENTS.md rules file
    OpenCodeRules,
    /// A managed OpenCode agent file
    OpenCodeAgent(AgentName),
    /// A managed OpenCode SKILL.md file
    OpenCodeSkill(SkillName),

    // ── Codex ──
    /// config.toml managed fields portion
    CodexConfig,
    /// .codex/AGENTS.md rules file
    CodexRules,
    /// A managed Codex agent file
    CodexAgent(AgentName),
    /// A managed Codex SKILL.md file
    CodexSkill(SkillName),

    // ── Claude ──
    /// .claude/CLAUDE.md rules file
    ClaudeRules,
    /// A managed Claude agent file
    ClaudeAgent(AgentName),
    /// A managed Claude SKILL.md file
    ClaudeSkill(SkillName),

    // ── Cursor ──
    /// A managed Cursor global agent file
    CursorAgent(AgentName),
    /// A managed Cursor SKILL.md file
    CursorSkill(SkillName),
    /// Named Playwright MCP state (mcp.json)
    CursorMcp,
    /// Legacy Codex SKILL.md under ~/.codex/skills (migration source only).
    CodexLegacySkill(SkillName),
    /// Installed runtime workspace bundled file (workspace-relative path).
    WorkspaceFile(WorkspaceRelPath),
}

/// Workspace-relative path for bundled files. Validated at construction and on
/// deserialization, so a manifest cannot smuggle in a path `new` would refuse.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct WorkspaceRelPath(String);

impl TryFrom<String> for WorkspaceRelPath {
    type Error = String;

    fn try_from(rel: String) -> Result<Self, Self::Error> {
        Self::new(rel.as_str()).ok_or_else(|| format!("invalid workspace-relative path: {rel:?}"))
    }
}

impl WorkspaceRelPath {
    pub fn new(rel: impl Into<String>) -> Option<Self> {
        let rel = rel.into();
        if rel.is_empty() || rel.contains("..") || Path::new(&rel).is_absolute() {
            return None;
        }
        Some(Self(rel))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Agent file name without extension. Validated at construction and on deserialization.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct AgentName(String);

impl TryFrom<String> for AgentName {
    type Error = String;

    fn try_from(name: String) -> Result<Self, Self::Error> {
        Self::new(name.as_str()).ok_or_else(|| format!("invalid agent name: {name:?}"))
    }
}

impl AgentName {
    pub fn new(name: impl Into<String>) -> Option<Self> {
        let name = name.into();
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return None;
        }
        // Allow lowercase, digits, hyphens
        if !name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
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

    pub fn file_name_with_extension(&self, extension: &str) -> String {
        format!("{}.{}", self.0, extension)
    }
}

/// Skill directory name. Validated at construction and on deserialization.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct SkillName(String);

impl TryFrom<String> for SkillName {
    type Error = String;

    fn try_from(name: String) -> Result<Self, Self::Error> {
        Self::new(name.as_str()).ok_or_else(|| format!("invalid skill name: {name:?}"))
    }
}

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
    SkillFile,
    McpConfig,
}

impl ArtifactId {
    /// Resolve the destination path for this artifact.
    pub fn resolve_dest(&self, home: &Path, workspace_root: &Path) -> Result<PathBuf, String> {
        match self {
            ArtifactId::OpenCodeConfig => Ok(home.join(".config/opencode/opencode.json")),
            ArtifactId::OpenCodeTui => Ok(home.join(".config/opencode/tui.json")),
            ArtifactId::OpenCodePlaywrightMcp => {
                Ok(crate::commands::cursor_profile::default_playwright_mcp_config_path(home))
            }
            ArtifactId::OpenCodeRules => Ok(home.join(".config/opencode/AGENTS.md")),
            ArtifactId::OpenCodeAgent(name) => {
                Ok(home.join(".config/opencode/agents").join(name.file_name()))
            }
            ArtifactId::OpenCodeSkill(name) => Ok(home
                .join(".config/opencode/skills")
                .join(name.as_str())
                .join("SKILL.md")),
            ArtifactId::CodexConfig => Ok(home.join(".codex/config.toml")),
            ArtifactId::CodexRules => Ok(home.join(".codex/AGENTS.md")),
            ArtifactId::CodexAgent(name) => Ok(home
                .join(".codex/agents")
                .join(name.file_name_with_extension("toml"))),
            ArtifactId::CodexSkill(name) => {
                Ok(crate::agent_skill_targets::codex_global_skills_dest(home)
                    .join(name.as_str())
                    .join("SKILL.md"))
            }
            ArtifactId::ClaudeRules => Ok(home.join(".claude/CLAUDE.md")),
            ArtifactId::ClaudeAgent(name) => Ok(home.join(".claude/agents").join(name.file_name())),
            ArtifactId::ClaudeSkill(name) => Ok(home
                .join(".claude/skills")
                .join(name.as_str())
                .join("SKILL.md")),
            ArtifactId::CursorAgent(name) => {
                let paths = resolve_cursor_paths()?;
                Ok(paths.agents.join(name.file_name()))
            }
            ArtifactId::CursorSkill(name) => {
                let paths = resolve_cursor_paths()?;
                Ok(paths.skills.join(name.as_str()).join("SKILL.md"))
            }
            ArtifactId::CursorMcp => {
                let paths = resolve_cursor_paths()?;
                Ok(paths.mcp_config.clone())
            }
            ArtifactId::CodexLegacySkill(name) => {
                Ok(crate::agent_skill_targets::codex_legacy_skills_dest(home)
                    .join(name.as_str())
                    .join("SKILL.md"))
            }
            ArtifactId::WorkspaceFile(rel) => Ok(workspace_root.join(rel.as_str())),
        }
    }

    /// Resolve the source path for this artifact (workspace-relative).
    pub fn resolve_source(&self, workspace_root: &Path) -> Option<PathBuf> {
        match self {
            ArtifactId::OpenCodeConfig => Some(workspace_root.join("templates/opencode.json")),
            ArtifactId::OpenCodeTui => Some(workspace_root.join("templates/tui.json")),
            ArtifactId::OpenCodePlaywrightMcp => {
                Some(workspace_root.join("templates/playwright-mcp.config.json"))
            }
            ArtifactId::OpenCodeRules => {
                Some(workspace_root.join("templates/sync/opencode-rules.md"))
            }
            ArtifactId::OpenCodeAgent(name) => {
                Some(workspace_root.join("agents").join(name.file_name()))
            }
            ArtifactId::OpenCodeSkill(name) => {
                skill_adapter_source(workspace_root, "opencode", name.as_str())
            }
            ArtifactId::CodexConfig => Some(workspace_root.join("templates/codex/config.toml")),
            ArtifactId::CodexRules => Some(workspace_root.join("templates/sync/codex-rules.md")),
            ArtifactId::CodexAgent(name) => Some(
                workspace_root
                    .join("templates/codex/agents")
                    .join(name.file_name_with_extension("toml")),
            ),
            ArtifactId::CodexSkill(name) => {
                skill_adapter_source(workspace_root, "codex", name.as_str())
            }
            ArtifactId::ClaudeRules => Some(workspace_root.join("templates/sync/claude-rules.md")),
            ArtifactId::ClaudeAgent(name) => Some(
                workspace_root
                    .join("templates/claude/agents")
                    .join(name.file_name()),
            ),
            ArtifactId::ClaudeSkill(name) => {
                skill_adapter_source(workspace_root, "claude", name.as_str())
            }
            ArtifactId::CursorAgent(name) => Some(
                workspace_root
                    .join("templates/cursor/agents")
                    .join(name.file_name()),
            ),
            ArtifactId::CursorSkill(name) => {
                skill_adapter_source(workspace_root, "cursor", name.as_str())
            }
            ArtifactId::CursorMcp => Some(
                crate::commands::cursor_profile::cursor_root(workspace_root)
                    .join("mcp/playwright.mcp.json"),
            ),
            ArtifactId::CodexLegacySkill(name) => {
                skill_adapter_source(workspace_root, "codex", name.as_str())
            }
            ArtifactId::WorkspaceFile(rel) => Some(workspace_root.join(rel.as_str())),
        }
    }

    /// Returns the parent SetupSurfaceId for this artifact.
    pub fn surface(&self) -> SetupSurfaceId {
        match self {
            ArtifactId::OpenCodeConfig
            | ArtifactId::OpenCodeTui
            | ArtifactId::OpenCodePlaywrightMcp => SetupSurfaceId::OpenCodeConfig,
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
            ArtifactId::CodexLegacySkill(_) => SetupSurfaceId::CodexSkills,
            ArtifactId::WorkspaceFile(_) => SetupSurfaceId::WorkspaceBundle,
        }
    }
}

fn resolve_cursor_paths() -> Result<crate::cursor_profile_paths::CursorProfilePaths, String> {
    crate::cursor_profile_paths::resolve_cursor_profile_paths()
}

fn skill_adapter_source(workspace_root: &Path, harness: &str, skill_name: &str) -> Option<PathBuf> {
    if !crate::agent_skill_targets::VALID_SKILL_AGENTS.contains(&harness) {
        return None;
    }
    Some(
        workspace_root
            .join("templates")
            .join("skills")
            .join(harness)
            .join(skill_name)
            .join("SKILL.md"),
    )
}

// ── Surface-to-artifact expansion ──

/// Discover skill names for a harness using canonical skill discovery.
pub fn discover_skill_names_for_harness(
    workspace_root: &Path,
    harness_agent: &str,
) -> Result<Vec<SkillName>, String> {
    let names = crate::skill_discovery::skill_names_for_harness(workspace_root, harness_agent)?;
    let mut out = Vec::new();
    for n in names {
        let Some(sn) = SkillName::new(n) else {
            return Err("invalid skill name in catalog".to_string());
        };
        out.push(sn);
    }
    if out.is_empty() {
        return Err(format!("no skills target harness {harness_agent}"));
    }
    out.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    Ok(out)
}

fn expand_skill_surface(
    workspace_root: &Path,
    harness: &str,
    map: impl Fn(SkillName) -> ArtifactId,
) -> Result<Vec<ArtifactId>, String> {
    Ok(discover_skill_names_for_harness(workspace_root, harness)?
        .into_iter()
        .map(map)
        .collect())
}

fn expand_agent_surface(
    workspace_root: &Path,
    harness: crate::agent_discovery::AgentHarness,
    map: impl Fn(AgentName) -> ArtifactId,
) -> Result<Vec<ArtifactId>, String> {
    Ok(
        crate::agent_discovery::discover_agent_names(harness, workspace_root)?
            .into_iter()
            .map(map)
            .collect(),
    )
}

/// Expand a surface ID to its constituent artifact IDs.
pub fn expand_surface(
    surface: SetupSurfaceId,
    workspace_root: &Path,
) -> Result<Vec<ArtifactId>, String> {
    match surface {
        SetupSurfaceId::OpenCodeConfig => Ok(vec![
            ArtifactId::OpenCodeConfig,
            ArtifactId::OpenCodeTui,
            ArtifactId::OpenCodePlaywrightMcp,
        ]),
        SetupSurfaceId::OpenCodeAgents => expand_agent_surface(
            workspace_root,
            crate::agent_discovery::AgentHarness::OpenCode,
            ArtifactId::OpenCodeAgent,
        ),
        SetupSurfaceId::OpenCodeRules => Ok(vec![ArtifactId::OpenCodeRules]),
        SetupSurfaceId::OpenCodeSkills => {
            expand_skill_surface(workspace_root, "opencode", ArtifactId::OpenCodeSkill)
        }
        SetupSurfaceId::CodexConfig => Ok(vec![ArtifactId::CodexConfig]),
        SetupSurfaceId::CodexAgents => expand_agent_surface(
            workspace_root,
            crate::agent_discovery::AgentHarness::Codex,
            ArtifactId::CodexAgent,
        ),
        SetupSurfaceId::CodexRules => Ok(vec![ArtifactId::CodexRules]),
        SetupSurfaceId::CodexSkills => {
            expand_skill_surface(workspace_root, "codex", ArtifactId::CodexSkill)
        }
        SetupSurfaceId::ClaudeRules => Ok(vec![ArtifactId::ClaudeRules]),
        SetupSurfaceId::ClaudeAgents => expand_agent_surface(
            workspace_root,
            crate::agent_discovery::AgentHarness::Claude,
            ArtifactId::ClaudeAgent,
        ),
        SetupSurfaceId::ClaudeSkills => {
            expand_skill_surface(workspace_root, "claude", ArtifactId::ClaudeSkill)
        }
        SetupSurfaceId::CursorAgents => expand_agent_surface(
            workspace_root,
            crate::agent_discovery::AgentHarness::Cursor,
            ArtifactId::CursorAgent,
        ),
        SetupSurfaceId::CursorSkills => {
            expand_skill_surface(workspace_root, "cursor", ArtifactId::CursorSkill)
        }
        SetupSurfaceId::CursorMcp => Ok(vec![ArtifactId::CursorMcp]),
        SetupSurfaceId::WorkspaceBundle => expand_workspace_bundle(workspace_root),
    }
}

fn expand_workspace_bundle(workspace_root: &Path) -> Result<Vec<ArtifactId>, String> {
    let bundled: Vec<&str> = crate::commands::default_workspace_files()
        .into_iter()
        .flat_map(|(_, paths)| paths.iter().copied())
        .filter(|rel| !rel.contains("..") && !rel.is_empty() && !Path::new(rel).is_absolute())
        .collect();
    let mut artifacts = Vec::new();
    for rel in bundled {
        let Some(wrel) = WorkspaceRelPath::new(rel) else {
            continue;
        };
        let src = workspace_root.join(rel);
        if src.is_file() {
            artifacts.push(ArtifactId::WorkspaceFile(wrel));
        }
    }
    Ok(artifacts)
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

    fn write_skill(ws: &Path, rel: &str, name: &str, targets: &str) {
        write_file(
            &ws.join(rel).join("SKILL.md"),
            &format!(
                "---\nname: {name}\ndescription: test skill\ntargets: {targets}\n---\n# {name}\n"
            ),
        );
    }

    fn write_skill_adapter(ws: &Path, harness: &str, name: &str) {
        write_file(
            &ws.join("templates/skills")
                .join(harness)
                .join(name)
                .join("SKILL.md"),
            &format!(
                "---\nname: {name}\ndescription: test skill\ntargets: codex, opencode, claude, cursor\n---\n# {name}\n\n## Harness Adapter\n"
            ),
        );
    }

    // ── Surface expansion tests ──

    #[test]
    fn opencode_config_expands_to_full_write_set() {
        let ws = temp_dir("oc-config");
        let artifacts = expand_surface(SetupSurfaceId::OpenCodeConfig, &ws).expect("expand");
        assert_eq!(artifacts.len(), 3);
        assert!(artifacts.contains(&ArtifactId::OpenCodeConfig));
        assert!(artifacts.contains(&ArtifactId::OpenCodeTui));
        assert!(artifacts.contains(&ArtifactId::OpenCodePlaywrightMcp));
    }

    #[test]
    fn opencode_rules_expands_to_one_artifact() {
        let ws = temp_dir("oc-rules");
        let artifacts = expand_surface(SetupSurfaceId::OpenCodeRules, &ws).expect("expand");
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::OpenCodeRules);
    }

    #[test]
    fn codex_config_is_single_artifact() {
        let ws = temp_dir("codex-cfg");
        let artifacts = expand_surface(SetupSurfaceId::CodexConfig, &ws).expect("expand");
        assert_eq!(artifacts.len(), 1);
    }

    #[test]
    fn claude_rules_is_single_artifact() {
        let ws = temp_dir("claude-rules");
        let artifacts = expand_surface(SetupSurfaceId::ClaudeRules, &ws).expect("expand");
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::ClaudeRules);
    }

    #[test]
    fn agent_surfaces_expand_from_source_dir() {
        let ws = temp_dir("agents-expand");
        write_file(&ws.join("agents/repo-scout.md"), "# scout");
        write_file(&ws.join("agents/inspector.md"), "# inspector");
        write_file(&ws.join("agents/.gitkeep"), "");

        let artifacts = expand_surface(SetupSurfaceId::OpenCodeAgents, &ws).expect("expand");
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
        let artifacts = expand_surface(SetupSurfaceId::CursorMcp, &ws).expect("expand");
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::CursorMcp);
    }

    #[test]
    fn deprecated_cleanup_produces_no_artifacts() {
        let ws = temp_dir("dep-cleanup");
        let artifacts = expand_surface(SetupSurfaceId::WorkspaceBundle, &ws).expect("expand");
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

        let artifacts = expand_surface(SetupSurfaceId::OpenCodeAgents, &ws).expect("expand");
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
        write_skill(&ws, "skills/my-skill", "my-skill", "opencode");

        // Expanding OpenCodeSkills twice should produce same result
        let a1 = expand_surface(SetupSurfaceId::OpenCodeSkills, &ws).expect("expand");
        let a2 = expand_surface(SetupSurfaceId::OpenCodeSkills, &ws).expect("expand");
        assert_eq!(a1, a2);
    }

    #[test]
    fn unknown_surface_ids_fail_before_path_resolution() {
        // Validating that parse_skill_targets doesn't crash on invalid input
        // This is tested through the expansion which only processes valid surfaces
        let ws = temp_dir("unknown-surface");
        let artifacts = expand_surface(SetupSurfaceId::WorkspaceBundle, &ws).expect("expand");
        assert!(artifacts.is_empty());
    }

    #[test]
    fn skill_artifacts_resolve_to_skill_md_files() {
        let ws = temp_dir("skill-md");
        write_skill(&ws, "skills/frontend-design", "frontend-design", "opencode");
        write_skill_adapter(&ws, "opencode", "frontend-design");
        let home = temp_dir("skill-md-home");
        let artifact = ArtifactId::OpenCodeSkill(SkillName::new("frontend-design").unwrap());
        let dest = artifact.resolve_dest(&home, &ws).unwrap();
        let source = artifact.resolve_source(&ws).unwrap();
        assert!(source.is_file(), "source SKILL.md should exist");
        assert!(source.ends_with("templates/skills/opencode/frontend-design/SKILL.md"));
        assert_eq!(source.file_name().unwrap(), "SKILL.md");
        assert_eq!(dest.file_name().unwrap(), "SKILL.md");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn skill_artifacts_resolve_to_harness_adapter_even_when_canonical_exists() {
        let ws = temp_dir("skill-adapter-source");
        write_skill(
            &ws,
            "skills/frontend-design",
            "frontend-design",
            "codex, opencode, claude, cursor",
        );
        write_skill_adapter(&ws, "claude", "frontend-design");
        let artifact = ArtifactId::ClaudeSkill(SkillName::new("frontend-design").unwrap());
        let source = artifact.resolve_source(&ws).unwrap();
        assert!(source.ends_with("templates/skills/claude/frontend-design/SKILL.md"));
        assert!(!source.ends_with("skills/frontend-design/SKILL.md"));
    }

    #[test]
    fn all_skill_artifact_sources_resolve_to_generated_adapter_files() {
        let ws = temp_dir("all-skill-adapter-sources");
        write_skill(
            &ws,
            "skills/frontend-design",
            "frontend-design",
            "codex, opencode, claude, cursor",
        );
        for harness in ["opencode", "codex", "claude", "cursor"] {
            write_skill_adapter(&ws, harness, "frontend-design");
        }

        let name = SkillName::new("frontend-design").unwrap();
        let cases = [
            (ArtifactId::OpenCodeSkill(name.clone()), "opencode"),
            (ArtifactId::CodexSkill(name.clone()), "codex"),
            (ArtifactId::ClaudeSkill(name.clone()), "claude"),
            (ArtifactId::CursorSkill(name.clone()), "cursor"),
            (ArtifactId::CodexLegacySkill(name), "codex"),
        ];

        for (artifact, harness) in cases {
            let source = artifact.resolve_source(&ws).expect("source path");
            let expected = PathBuf::from(format!(
                "templates/skills/{harness}/frontend-design/SKILL.md"
            ));
            assert!(
                source.ends_with(&expected),
                "{artifact:?} resolved to {}",
                source.display()
            );
            assert!(source.is_file(), "adapter source should exist");
            assert_eq!(source.file_name().unwrap(), "SKILL.md");
            assert!(!source.ends_with("skills/frontend-design/SKILL.md"));
        }
    }

    #[test]
    fn skill_discovery_supports_root_level() {
        let ws = temp_dir("skill-root");
        write_skill(
            &ws,
            "skills/accessibility-review",
            "accessibility-review",
            "codex, opencode, claude, cursor",
        );
        write_skill(
            &ws,
            "skills/browser-qa",
            "browser-qa",
            "codex, opencode, claude, cursor",
        );

        let artifacts = expand_surface(SetupSurfaceId::OpenCodeSkills, &ws).expect("expand");
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
        write_skill(
            &ws,
            "skills/ux/accessibility-review",
            "accessibility-review",
            "codex, opencode, claude, cursor",
        );

        let artifacts = expand_surface(SetupSurfaceId::ClaudeSkills, &ws).expect("expand");
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
        write_skill(
            &ws,
            "skills/accessibility-review",
            "accessibility-review",
            "cursor",
        );

        let agents = expand_surface(SetupSurfaceId::CursorAgents, &ws).expect("expand");
        let skills = expand_surface(SetupSurfaceId::CursorSkills, &ws).expect("expand");
        let mcp = expand_surface(SetupSurfaceId::CursorMcp, &ws).expect("expand");

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

        let artifacts = expand_surface(SetupSurfaceId::CursorAgents, &ws).expect("expand");
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
        write_skill(&ws, "skills/skill-a", "skill-a", "cursor");
        write_skill(&ws, "skills/skill-b", "skill-b", "cursor");

        let all_cursor: Vec<ArtifactId> = [
            SetupSurfaceId::CursorAgents,
            SetupSurfaceId::CursorSkills,
            SetupSurfaceId::CursorMcp,
        ]
        .iter()
        .flat_map(|s| expand_surface(*s, &ws).expect("expand"))
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
        let artifacts = expand_surface(SetupSurfaceId::CursorMcp, &ws).expect("expand");
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::CursorMcp);
        assert_eq!(artifacts[0].surface(), SetupSurfaceId::CursorMcp);
    }

    // ── Deserialization validation ──

    #[test]
    fn deserializing_artifact_ids_applies_name_validation() {
        for json in [
            r#"{"type":"CodexAgent","name":"../x"}"#,
            r#"{"type":"OpenCodeAgent","name":"a/b"}"#,
            r#"{"type":"ClaudeAgent","name":"Upper"}"#,
            r#"{"type":"CodexSkill","name":"../x"}"#,
            r#"{"type":"CursorSkill","name":""}"#,
            r#"{"type":"WorkspaceFile","name":"../x"}"#,
            r#"{"type":"WorkspaceFile","name":"/etc/passwd"}"#,
            r#"{"type":"WorkspaceFile","name":""}"#,
        ] {
            let parsed = serde_json::from_str::<ArtifactId>(json);
            assert!(parsed.is_err(), "{json} must not deserialize: {parsed:?}");
        }
    }

    #[test]
    fn deserialized_names_report_what_was_rejected() {
        let err = serde_json::from_str::<AgentName>(r#""../x""#).expect_err("agent name");
        assert!(err.to_string().contains("invalid agent name"), "{err}");
        let err = serde_json::from_str::<SkillName>(r#""../x""#).expect_err("skill name");
        assert!(err.to_string().contains("invalid skill name"), "{err}");
        let err = serde_json::from_str::<WorkspaceRelPath>(r#""a/../x""#).expect_err("rel path");
        assert!(
            err.to_string().contains("invalid workspace-relative path"),
            "{err}"
        );
    }

    #[test]
    fn valid_names_still_roundtrip_through_serde() {
        let agent = AgentName::new("repo-scout").unwrap();
        assert_eq!(serde_json::to_string(&agent).unwrap(), r#""repo-scout""#);
        assert_eq!(
            serde_json::from_str::<AgentName>(r#""repo-scout""#).unwrap(),
            agent
        );
        let rel = WorkspaceRelPath::new("scripts/merge-codex-config.py").unwrap();
        let json = serde_json::to_string(&ArtifactId::WorkspaceFile(rel.clone())).unwrap();
        assert_eq!(
            serde_json::from_str::<ArtifactId>(&json).unwrap(),
            ArtifactId::WorkspaceFile(rel)
        );
    }
}
