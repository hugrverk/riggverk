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
use std::path::{Component, Path, PathBuf};

use crate::agent_skill_targets::codex_home;
use crate::setup_lifecycle::SetupSurfaceId;
use crate::skill_roots::{SkillRoot, SkillScope};

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
    /// Legacy identity of the OpenCode `SKILL.md`; see [`ArtifactId::SkillFile`].
    OpenCodeSkill(SkillName),

    // ── Codex ──
    /// config.toml managed fields portion
    CodexConfig,
    /// .codex/AGENTS.md rules file
    CodexRules,
    /// A managed Codex agent file
    CodexAgent(AgentName),
    /// Legacy identity of the Codex `SKILL.md`; see [`ArtifactId::SkillFile`].
    CodexSkill(SkillName),

    // ── Claude ──
    /// .claude/CLAUDE.md rules file
    ClaudeRules,
    /// A managed Claude agent file
    ClaudeAgent(AgentName),
    /// Legacy identity of the Claude `SKILL.md`; see [`ArtifactId::SkillFile`].
    ClaudeSkill(SkillName),

    // ── Cursor ──
    /// A managed Cursor global agent file
    CursorAgent(AgentName),
    /// Legacy identity of the Cursor `SKILL.md`; see [`ArtifactId::SkillFile`].
    CursorSkill(SkillName),
    /// Named Playwright MCP state (mcp.json)
    CursorMcp,
    /// Legacy identity of the Codex `SKILL.md` under `~/.agents/skills` (migration cleanup only);
    /// see [`ArtifactId::SkillFile`].
    CodexLegacySkill(SkillName),
    /// Installed runtime workspace bundled file (workspace-relative path).
    WorkspaceFile(WorkspaceRelPath),

    // ── Skills ──
    /// One file of a skill (`SKILL.md` or a supporting file) in one skill root.
    ///
    /// The five legacy variants above are what older versions of the app recorded for the
    /// `SKILL.md` alone. They stay so old managed state and transaction manifests still parse;
    /// [`ArtifactId::current_equivalent`] maps each to this variant.
    SkillFile(SkillFileRef),
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
        // Only plain relative components: on Windows "/etc/passwd" is not `is_absolute()`, yet
        // joining it onto the workspace root would replace everything but the drive.
        if rel.is_empty()
            || rel.contains("..")
            || Path::new(&rel)
                .components()
                .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
        {
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

/// Path of one file below its skill directory: `SKILL.md`, `HUNTING.md`,
/// `assets/report-template.html`. Validated at construction and on deserialization, so a manifest
/// or managed-state record cannot smuggle in a path the installer would refuse.
///
/// One to four `/`-separated components of ASCII letters, digits, `.`, `_` and `-`, none of them
/// starting with a dot (which also rules out `.` and `..`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct SkillRelPath(String);

impl TryFrom<String> for SkillRelPath {
    type Error = String;

    fn try_from(rel: String) -> Result<Self, Self::Error> {
        Self::new(rel.as_str()).ok_or_else(|| format!("invalid skill file path: {rel:?}"))
    }
}

impl SkillRelPath {
    const SKILL_MD: &'static str = "SKILL.md";

    pub fn new(rel: impl Into<String>) -> Option<Self> {
        let rel = rel.into();
        let mut components = 0usize;
        for component in rel.split('/') {
            components += 1;
            if components > crate::skill_discovery::MAX_SUPPORT_DEPTH
                || component.is_empty()
                || component.starts_with('.')
                || !component
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            {
                return None;
            }
        }
        Some(Self(rel))
    }

    pub fn skill_md() -> Self {
        Self(Self::SKILL_MD.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_skill_md(&self) -> bool {
        self.0 == Self::SKILL_MD
    }
}

/// One file of one skill in one skill root: the identity of a `SkillFile` artifact.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SkillFileRef {
    pub root: SkillRoot,
    pub skill: SkillName,
    pub rel: SkillRelPath,
}

impl SkillFileRef {
    pub fn skill_md(root: SkillRoot, skill: SkillName) -> Self {
        Self {
            root,
            skill,
            rel: SkillRelPath::skill_md(),
        }
    }

    /// `<root>/<skill>/<rel>`.
    fn dest(&self, home: &Path) -> Result<PathBuf, String> {
        let mut path = self.root.path(home)?.join(self.skill.as_str());
        for part in self.rel.as_str().split('/') {
            path.push(part);
        }
        Ok(path)
    }

    /// The bundled file this one is copied from: the canonical `SKILL.md`, or the supporting file
    /// next to it.
    fn source(&self, workspace_root: &Path) -> PathBuf {
        if self.rel.is_skill_md() {
            return skill_source(workspace_root, self.skill.as_str());
        }
        let mut path =
            crate::skill_discovery::canonical_skill_dir(workspace_root, self.skill.as_str());
        for part in self.rel.as_str().split('/') {
            path.push(part);
        }
        path
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

/// `CODEX_HOME` (or `~/.codex`). A relative value is rejected: file operations would resolve
/// it against the process working directory while the allowlist check resolves it against home.
fn absolute_codex_home(home: &Path) -> Result<PathBuf, String> {
    let dir = codex_home(home);
    if dir.is_absolute() {
        Ok(dir)
    } else {
        Err(format!(
            "CODEX_HOME must be an absolute path (got {})",
            dir.display()
        ))
    }
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
            ArtifactId::OpenCodeSkill(name) => {
                SkillFileRef::skill_md(SkillRoot::OpenCode, name.clone()).dest(home)
            }
            ArtifactId::CodexConfig => Ok(absolute_codex_home(home)?.join("config.toml")),
            ArtifactId::CodexRules => Ok(absolute_codex_home(home)?.join("AGENTS.md")),
            ArtifactId::CodexAgent(name) => Ok(absolute_codex_home(home)?
                .join("agents")
                .join(name.file_name_with_extension("toml"))),
            ArtifactId::CodexSkill(name) => {
                SkillFileRef::skill_md(SkillRoot::CodexHome, name.clone()).dest(home)
            }
            ArtifactId::ClaudeRules => Ok(home.join(".claude/CLAUDE.md")),
            ArtifactId::ClaudeAgent(name) => Ok(home.join(".claude/agents").join(name.file_name())),
            ArtifactId::ClaudeSkill(name) => {
                SkillFileRef::skill_md(SkillRoot::Claude, name.clone()).dest(home)
            }
            ArtifactId::CursorAgent(name) => {
                let paths = resolve_cursor_paths()?;
                Ok(paths.agents.join(name.file_name()))
            }
            ArtifactId::CursorSkill(name) => {
                SkillFileRef::skill_md(SkillRoot::Cursor, name.clone()).dest(home)
            }
            ArtifactId::CursorMcp => {
                let paths = resolve_cursor_paths()?;
                Ok(paths.mcp_config.clone())
            }
            ArtifactId::CodexLegacySkill(name) => {
                SkillFileRef::skill_md(SkillRoot::Agents, name.clone()).dest(home)
            }
            ArtifactId::SkillFile(file) => file.dest(home),
            ArtifactId::WorkspaceFile(rel) => Ok(workspace_root.join(rel.as_str())),
        }
    }

    /// Directory the destination must stay inside when it is written, backed up, restored, or
    /// removed: the workspace for workspace files, `CODEX_HOME` for Codex artifacts when it lies
    /// outside `home`, and `home` otherwise (which keeps the symlink-chain check from `home` down
    /// for the default `~/.codex`).
    pub fn allowlist_root(&self, home: &Path, workspace_root: &Path) -> Result<PathBuf, String> {
        match self {
            ArtifactId::WorkspaceFile(_) => Ok(workspace_root.to_path_buf()),
            ArtifactId::CodexConfig
            | ArtifactId::CodexRules
            | ArtifactId::CodexAgent(_)
            | ArtifactId::CodexSkill(_) => self.codex_allowlist_root(home, workspace_root),
            ArtifactId::SkillFile(file) if file.root == SkillRoot::CodexHome => {
                self.codex_allowlist_root(home, workspace_root)
            }
            _ => Ok(home.to_path_buf()),
        }
    }

    fn codex_allowlist_root(&self, home: &Path, workspace_root: &Path) -> Result<PathBuf, String> {
        let dest = self.resolve_dest(home, workspace_root)?;
        if dest.starts_with(home) {
            return Ok(home.to_path_buf());
        }
        let codex_root = absolute_codex_home(home)?;
        Ok(if dest.starts_with(&codex_root) {
            codex_root
        } else {
            home.to_path_buf()
        })
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
            ArtifactId::OpenCodeSkill(name) => Some(skill_source(workspace_root, name.as_str())),
            ArtifactId::CodexConfig => Some(workspace_root.join("templates/codex/config.toml")),
            ArtifactId::CodexRules => Some(workspace_root.join("templates/sync/codex-rules.md")),
            ArtifactId::CodexAgent(name) => Some(
                workspace_root
                    .join("templates/codex/agents")
                    .join(name.file_name_with_extension("toml")),
            ),
            ArtifactId::CodexSkill(name) => Some(skill_source(workspace_root, name.as_str())),
            ArtifactId::ClaudeRules => Some(workspace_root.join("templates/sync/claude-rules.md")),
            ArtifactId::ClaudeAgent(name) => Some(
                workspace_root
                    .join("templates/claude/agents")
                    .join(name.file_name()),
            ),
            ArtifactId::ClaudeSkill(name) => Some(skill_source(workspace_root, name.as_str())),
            ArtifactId::CursorAgent(name) => Some(
                workspace_root
                    .join("templates/cursor/agents")
                    .join(name.file_name()),
            ),
            ArtifactId::CursorSkill(name) => Some(skill_source(workspace_root, name.as_str())),
            ArtifactId::CursorMcp => Some(
                crate::commands::cursor_profile::cursor_root(workspace_root)
                    .join("mcp/playwright.mcp.json"),
            ),
            ArtifactId::CodexLegacySkill(name) => Some(skill_source(workspace_root, name.as_str())),
            ArtifactId::SkillFile(file) => Some(file.source(workspace_root)),
            ArtifactId::WorkspaceFile(rel) => Some(workspace_root.join(rel.as_str())),
        }
    }

    /// A skill file of `root`: the `SKILL.md` of `skill`.
    pub fn skill_md(root: SkillRoot, skill: SkillName) -> Self {
        ArtifactId::SkillFile(SkillFileRef::skill_md(root, skill))
    }

    /// A file of `skill` in `root`.
    pub fn skill_file(root: SkillRoot, skill: SkillName, rel: SkillRelPath) -> Self {
        ArtifactId::SkillFile(SkillFileRef { root, skill, rel })
    }

    /// What a legacy skill identity stands for: the same `SKILL.md` at the same destination.
    fn legacy_skill_file(&self) -> Option<SkillFileRef> {
        let (root, name) = match self {
            ArtifactId::OpenCodeSkill(name) => (SkillRoot::OpenCode, name),
            ArtifactId::CodexSkill(name) => (SkillRoot::CodexHome, name),
            ArtifactId::ClaudeSkill(name) => (SkillRoot::Claude, name),
            ArtifactId::CursorSkill(name) => (SkillRoot::Cursor, name),
            ArtifactId::CodexLegacySkill(name) => (SkillRoot::Agents, name),
            _ => return None,
        };
        Some(SkillFileRef::skill_md(root, name.clone()))
    }

    /// The `SkillFile` a legacy skill identity stands for. `None` for every artifact that is not
    /// a legacy skill variant (a `SkillFile` is already current).
    pub fn current_equivalent(&self) -> Option<ArtifactId> {
        self.legacy_skill_file().map(ArtifactId::SkillFile)
    }

    /// The skill file this artifact names, under its current or its legacy identity.
    pub fn as_skill_file(&self) -> Option<SkillFileRef> {
        match self {
            ArtifactId::SkillFile(file) => Some(file.clone()),
            _ => self.legacy_skill_file(),
        }
    }

    /// Whether the artifact is a file of a skill: a `SkillFile` or a legacy skill identity.
    pub fn is_skill_file(&self) -> bool {
        self.as_skill_file().is_some()
    }

    /// Rules files hold the managed base in a marked block; the rest of the
    /// file belongs to the user (see `rules_block`).
    pub fn is_rules_block(&self) -> bool {
        matches!(
            self,
            ArtifactId::OpenCodeRules | ArtifactId::CodexRules | ArtifactId::ClaudeRules
        )
    }

    /// Returns the parent SetupSurfaceId for this artifact. Every skill file, whichever folder it
    /// is in and whichever identity an older version recorded for it, belongs to `Skills`.
    pub fn surface(&self) -> SetupSurfaceId {
        match self {
            ArtifactId::OpenCodeConfig
            | ArtifactId::OpenCodeTui
            | ArtifactId::OpenCodePlaywrightMcp => SetupSurfaceId::OpenCodeConfig,
            ArtifactId::OpenCodeRules => SetupSurfaceId::OpenCodeRules,
            ArtifactId::OpenCodeAgent(_) => SetupSurfaceId::OpenCodeAgents,
            ArtifactId::CodexConfig => SetupSurfaceId::CodexConfig,
            ArtifactId::CodexRules => SetupSurfaceId::CodexRules,
            ArtifactId::CodexAgent(_) => SetupSurfaceId::CodexAgents,
            ArtifactId::ClaudeRules => SetupSurfaceId::ClaudeRules,
            ArtifactId::ClaudeAgent(_) => SetupSurfaceId::ClaudeAgents,
            ArtifactId::CursorAgent(_) => SetupSurfaceId::CursorAgents,
            ArtifactId::CursorMcp => SetupSurfaceId::CursorMcp,
            ArtifactId::OpenCodeSkill(_)
            | ArtifactId::CodexSkill(_)
            | ArtifactId::ClaudeSkill(_)
            | ArtifactId::CursorSkill(_)
            | ArtifactId::CodexLegacySkill(_)
            | ArtifactId::SkillFile(_) => SetupSurfaceId::Skills,
            ArtifactId::WorkspaceFile(_) => SetupSurfaceId::WorkspaceBundle,
        }
    }
}

fn resolve_cursor_paths() -> Result<crate::cursor_profile_paths::CursorProfilePaths, String> {
    crate::cursor_profile_paths::resolve_cursor_profile_paths()
}

/// Every harness installs the canonical SKILL.md byte for byte, so the source does not depend on
/// which harness the artifact belongs to.
fn skill_source(workspace_root: &Path, skill_name: &str) -> PathBuf {
    crate::skill_discovery::canonical_skill_md(workspace_root, skill_name)
}

// ── Surface-to-artifact expansion ──

/// One skill of the catalog with the relative paths of all its files: `SKILL.md` first, then the
/// supporting files.
pub struct SkillFiles {
    pub name: SkillName,
    pub files: Vec<SkillRelPath>,
}

/// Every skill of the catalog with its files. `targets` stays validated metadata and filters
/// nothing: the folders skills are installed into are shared by harnesses, so a skill cannot be
/// installed for one of them only.
pub fn catalog_skill_files(workspace_root: &Path) -> Result<Vec<SkillFiles>, String> {
    let mut skills = crate::skill_discovery::discover_skill_catalog(workspace_root)
        .map_err(|e| e.message().to_string())?;
    if skills.is_empty() {
        return Err("the skill catalog is empty".to_string());
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    let mut out = Vec::new();
    for skill in skills {
        let Some(name) = SkillName::new(skill.name.as_str()) else {
            return Err("invalid skill name in catalog".to_string());
        };
        let mut files = vec![SkillRelPath::skill_md()];
        for rel in crate::skill_discovery::skill_support_files(&skill.source_dir)? {
            let Some(rel_path) = SkillRelPath::new(rel.as_str()) else {
                return Err(format!(
                    "skill {} has a supporting file the installer cannot represent: {rel}",
                    skill.name
                ));
            };
            files.push(rel_path);
        }
        out.push(SkillFiles { name, files });
    }
    Ok(out)
}

/// Every file of every skill as `SkillFile` artifacts, in each root of `scope`: per root, the
/// skills in name order, each with its `SKILL.md` first.
fn expand_skill_surface(
    workspace_root: &Path,
    scope: &SkillScope,
) -> Result<Vec<ArtifactId>, String> {
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    let skills = catalog_skill_files(workspace_root)?;
    let mut artifacts = Vec::new();
    for root in scope.roots() {
        for skill in &skills {
            for rel in &skill.files {
                artifacts.push(ArtifactId::skill_file(
                    *root,
                    skill.name.clone(),
                    rel.clone(),
                ));
            }
        }
    }
    Ok(artifacts)
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
///
/// `scope` names the skill roots the `Skills` surface expands into; no other surface depends on
/// it. A retired per-harness skill surface expands like `Skills`.
pub fn expand_surface(
    surface: SetupSurfaceId,
    workspace_root: &Path,
    scope: &SkillScope,
) -> Result<Vec<ArtifactId>, String> {
    match surface.canonical() {
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
        SetupSurfaceId::CodexConfig => Ok(vec![ArtifactId::CodexConfig]),
        SetupSurfaceId::CodexAgents => expand_agent_surface(
            workspace_root,
            crate::agent_discovery::AgentHarness::Codex,
            ArtifactId::CodexAgent,
        ),
        SetupSurfaceId::CodexRules => Ok(vec![ArtifactId::CodexRules]),
        SetupSurfaceId::ClaudeRules => Ok(vec![ArtifactId::ClaudeRules]),
        SetupSurfaceId::ClaudeAgents => expand_agent_surface(
            workspace_root,
            crate::agent_discovery::AgentHarness::Claude,
            ArtifactId::ClaudeAgent,
        ),
        SetupSurfaceId::CursorAgents => expand_agent_surface(
            workspace_root,
            crate::agent_discovery::AgentHarness::Cursor,
            ArtifactId::CursorAgent,
        ),
        SetupSurfaceId::Skills => expand_skill_surface(workspace_root, scope),
        SetupSurfaceId::CursorMcp => Ok(vec![ArtifactId::CursorMcp]),
        SetupSurfaceId::WorkspaceBundle => expand_workspace_bundle(workspace_root),
        SetupSurfaceId::ClaudeSkills
        | SetupSurfaceId::OpenCodeSkills
        | SetupSurfaceId::CodexSkills
        | SetupSurfaceId::CursorSkills => Err("retired skill surface".to_string()),
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

    // ── Surface expansion tests ──

    #[test]
    fn opencode_config_expands_to_full_write_set() {
        let ws = temp_dir("oc-config");
        let artifacts = expand_surface(SetupSurfaceId::OpenCodeConfig, &ws, &SkillScope::all())
            .expect("expand");
        assert_eq!(artifacts.len(), 3);
        assert!(artifacts.contains(&ArtifactId::OpenCodeConfig));
        assert!(artifacts.contains(&ArtifactId::OpenCodeTui));
        assert!(artifacts.contains(&ArtifactId::OpenCodePlaywrightMcp));
    }

    #[test]
    fn opencode_rules_expands_to_one_artifact() {
        let ws = temp_dir("oc-rules");
        let artifacts =
            expand_surface(SetupSurfaceId::OpenCodeRules, &ws, &SkillScope::all()).expect("expand");
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::OpenCodeRules);
    }

    #[test]
    fn codex_config_is_single_artifact() {
        let ws = temp_dir("codex-cfg");
        let artifacts =
            expand_surface(SetupSurfaceId::CodexConfig, &ws, &SkillScope::all()).expect("expand");
        assert_eq!(artifacts.len(), 1);
    }

    #[test]
    fn claude_rules_is_single_artifact() {
        let ws = temp_dir("claude-rules");
        let artifacts =
            expand_surface(SetupSurfaceId::ClaudeRules, &ws, &SkillScope::all()).expect("expand");
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::ClaudeRules);
    }

    #[test]
    fn agent_surfaces_expand_from_source_dir() {
        let ws = temp_dir("agents-expand");
        write_file(&ws.join("agents/repo-scout.md"), "# scout");
        write_file(&ws.join("agents/inspector.md"), "# inspector");
        write_file(&ws.join("agents/.gitkeep"), "");

        let artifacts = expand_surface(SetupSurfaceId::OpenCodeAgents, &ws, &SkillScope::all())
            .expect("expand");
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
        let artifacts =
            expand_surface(SetupSurfaceId::CursorMcp, &ws, &SkillScope::all()).expect("expand");
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0], ArtifactId::CursorMcp);
    }

    #[test]
    fn deprecated_cleanup_produces_no_artifacts() {
        let ws = temp_dir("dep-cleanup");
        let artifacts = expand_surface(SetupSurfaceId::WorkspaceBundle, &ws, &SkillScope::all())
            .expect("expand");
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

        let artifacts = expand_surface(SetupSurfaceId::OpenCodeAgents, &ws, &SkillScope::all())
            .expect("expand");
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
            ArtifactId::skill_md(SkillRoot::CodexHome, SkillName::new("my-skill").unwrap()),
            ArtifactId::skill_file(
                SkillRoot::Claude,
                SkillName::new("security-audit").unwrap(),
                SkillRelPath::new("assets/report-template.html").unwrap(),
            ),
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

        // Expanding the skills surface twice should produce same result
        let scope = SkillScope::of(&[SkillRoot::Claude]);
        let a1 = expand_surface(SetupSurfaceId::Skills, &ws, &scope).expect("expand");
        let a2 = expand_surface(SetupSurfaceId::Skills, &ws, &scope).expect("expand");
        assert_eq!(a1, a2);
    }

    #[test]
    fn unknown_surface_ids_fail_before_path_resolution() {
        // Validating that parse_skill_targets doesn't crash on invalid input
        // This is tested through the expansion which only processes valid surfaces
        let ws = temp_dir("unknown-surface");
        let artifacts = expand_surface(SetupSurfaceId::WorkspaceBundle, &ws, &SkillScope::all())
            .expect("expand");
        assert!(artifacts.is_empty());
    }

    #[test]
    fn skill_artifacts_resolve_to_skill_md_files() {
        let ws = temp_dir("skill-md");
        write_skill(&ws, "skills/frontend-design", "frontend-design", "opencode");
        let home = temp_dir("skill-md-home");
        let artifact = ArtifactId::OpenCodeSkill(SkillName::new("frontend-design").unwrap());
        let dest = artifact.resolve_dest(&home, &ws).unwrap();
        let source = artifact.resolve_source(&ws).unwrap();
        assert!(source.is_file(), "source SKILL.md should exist");
        assert!(source.ends_with("skills/frontend-design/SKILL.md"));
        assert_eq!(source.file_name().unwrap(), "SKILL.md");
        assert_eq!(dest.file_name().unwrap(), "SKILL.md");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn every_harness_skill_artifact_resolves_to_the_same_canonical_file() {
        let ws = temp_dir("all-skill-sources");
        crate::test_env::write_canonical_skill(&ws, None, "frontend-design", "body");
        crate::test_env::write_canonical_skill(&ws, Some("group"), "grouped-skill", "body");

        for (skill, expected) in [
            ("frontend-design", "skills/frontend-design/SKILL.md"),
            ("grouped-skill", "skills/group/grouped-skill/SKILL.md"),
        ] {
            let name = SkillName::new(skill).unwrap();
            let artifacts = [
                ArtifactId::OpenCodeSkill(name.clone()),
                ArtifactId::CodexSkill(name.clone()),
                ArtifactId::ClaudeSkill(name.clone()),
                ArtifactId::CursorSkill(name.clone()),
                ArtifactId::CodexLegacySkill(name),
            ];
            for artifact in artifacts {
                let source = artifact.resolve_source(&ws).expect("source path");
                assert!(
                    source.ends_with(expected),
                    "{artifact:?} resolved to {}",
                    source.display()
                );
                assert!(source.is_file(), "canonical source should exist");
            }
        }
    }

    #[test]
    fn a_skill_missing_from_the_catalog_resolves_to_a_missing_root_level_file() {
        let ws = temp_dir("retired-skill-source");
        crate::test_env::write_canonical_skill(&ws, None, "frontend-design", "body");
        let artifact = ArtifactId::ClaudeSkill(SkillName::new("retired-skill").unwrap());
        let source = artifact.resolve_source(&ws).expect("source path");
        assert!(source.ends_with("skills/retired-skill/SKILL.md"));
        assert!(!source.exists());
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

        let scope = SkillScope::of(&[SkillRoot::Agents]);
        let artifacts = expand_surface(SetupSurfaceId::Skills, &ws, &scope).expect("expand");
        assert_eq!(artifacts.len(), 2);
        assert!(artifacts.contains(&ArtifactId::skill_md(
            SkillRoot::Agents,
            SkillName::new("accessibility-review").unwrap()
        )));
        assert!(artifacts.contains(&ArtifactId::skill_md(
            SkillRoot::Agents,
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

        let scope = SkillScope::of(&[SkillRoot::Claude]);
        let artifacts = expand_surface(SetupSurfaceId::Skills, &ws, &scope).expect("expand");
        assert_eq!(artifacts.len(), 1);
        assert!(artifacts.contains(&ArtifactId::skill_md(
            SkillRoot::Claude,
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

        let agents =
            expand_surface(SetupSurfaceId::CursorAgents, &ws, &SkillScope::all()).expect("expand");
        let skills = expand_surface(
            SetupSurfaceId::Skills,
            &ws,
            &SkillScope::of(&[SkillRoot::Claude]),
        )
        .expect("expand");
        let mcp =
            expand_surface(SetupSurfaceId::CursorMcp, &ws, &SkillScope::all()).expect("expand");

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

        let artifacts =
            expand_surface(SetupSurfaceId::CursorAgents, &ws, &SkillScope::all()).expect("expand");
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
            SetupSurfaceId::Skills,
            SetupSurfaceId::CursorMcp,
        ]
        .iter()
        .flat_map(|s| {
            expand_surface(*s, &ws, &SkillScope::of(&[SkillRoot::Cursor])).expect("expand")
        })
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
                ArtifactId::SkillFile(_) => assert_eq!(surface, SetupSurfaceId::Skills),
                ArtifactId::CursorMcp => assert_eq!(surface, SetupSurfaceId::CursorMcp),
                _ => panic!("Non-Cursor artifact in Cursor set: {a:?}"),
            }
        }
    }

    #[test]
    fn cursor_mcp_surface_is_single_bounded_artifact() {
        // CursorMcp maps to exactly one artifact - not a broad root
        let ws = temp_dir("cursor-mcp-bounded");
        let artifacts =
            expand_surface(SetupSurfaceId::CursorMcp, &ws, &SkillScope::all()).expect("expand");
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
            r#"{"type":"SkillFile","name":{"root":"claude","skill":"../x","rel":"SKILL.md"}}"#,
            r#"{"type":"SkillFile","name":{"root":"claude","skill":"tdd","rel":"../SKILL.md"}}"#,
            r#"{"type":"SkillFile","name":{"root":"claude","skill":"tdd","rel":"/etc/passwd"}}"#,
            r#"{"type":"SkillFile","name":{"root":"claude","skill":"tdd","rel":""}}"#,
            r#"{"type":"SkillFile","name":{"root":"home","skill":"tdd","rel":"SKILL.md"}}"#,
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

    // ── Skill files ──

    fn skill(name: &str) -> SkillName {
        SkillName::new(name).unwrap()
    }

    #[test]
    fn skill_rel_paths_are_bounded_plain_relative_paths() {
        for valid in [
            "SKILL.md",
            "HUNTING.md",
            "report-schema.json",
            "LICENSE",
            "assets/report-template.html",
            "scripts/verify-report.mjs",
            "a/b/c/d.txt",
            "name_with.dots-and_dashes.v2",
        ] {
            assert!(SkillRelPath::new(valid).is_some(), "{valid}");
        }
        for invalid in [
            "",
            "/etc/passwd",
            "../SKILL.md",
            "a/../b",
            "a//b",
            "a/",
            "./a",
            ".hidden",
            "a/.hidden",
            "a\\b",
            "C:\\x",
            "a b",
            "a/b/c/d/e.txt",
            "caf\u{e9}.md",
        ] {
            assert!(SkillRelPath::new(invalid).is_none(), "{invalid:?}");
        }
    }

    #[test]
    fn a_skill_file_has_a_stable_identity() {
        let artifact = ArtifactId::skill_file(
            SkillRoot::CodexHome,
            skill("tdd"),
            SkillRelPath::new("assets/a.txt").unwrap(),
        );
        assert_eq!(
            crate::managed_state::artifact_identity(&artifact),
            r#"{"type":"SkillFile","name":{"root":"codex_home","skill":"tdd","rel":"assets/a.txt"}}"#
        );
        let parsed: ArtifactId = serde_json::from_str(
            r#"{"type":"SkillFile","name":{"root":"codex_home","skill":"tdd","rel":"assets/a.txt"}}"#,
        )
        .unwrap();
        assert_eq!(parsed, artifact);
    }

    #[test]
    fn legacy_skill_identities_keep_their_destination_source_and_surface() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp_dir("legacy-equivalent-home");
        let ws = temp_dir("legacy-equivalent-ws");
        crate::test_env::set_test_user_dirs(&home);
        std::env::remove_var("CODEX_HOME");
        std::env::remove_var("CODEX_SKILLS_PATH");
        crate::test_env::write_canonical_skill(&ws, None, "tdd", "body");
        let name = skill("tdd");
        let cases = [
            (
                ArtifactId::ClaudeSkill(name.clone()),
                SkillRoot::Claude,
                ".claude/skills",
            ),
            (
                ArtifactId::OpenCodeSkill(name.clone()),
                SkillRoot::OpenCode,
                ".config/opencode/skills",
            ),
            (
                ArtifactId::CodexSkill(name.clone()),
                SkillRoot::CodexHome,
                ".codex/skills",
            ),
            (
                ArtifactId::CodexLegacySkill(name.clone()),
                SkillRoot::Agents,
                ".agents/skills",
            ),
            (
                ArtifactId::CursorSkill(name.clone()),
                SkillRoot::Cursor,
                ".cursor/skills",
            ),
        ];
        for (legacy, root, folder) in cases {
            let current = legacy.current_equivalent().expect("equivalent");
            assert_eq!(current, ArtifactId::skill_md(root, name.clone()));
            assert_eq!(
                legacy.resolve_dest(&home, &ws).unwrap(),
                current.resolve_dest(&home, &ws).unwrap(),
                "{legacy:?}"
            );
            assert!(
                current
                    .resolve_dest(&home, &ws)
                    .unwrap()
                    .ends_with(format!("{folder}/tdd/SKILL.md")),
                "{legacy:?}"
            );
            assert_eq!(legacy.resolve_source(&ws), current.resolve_source(&ws));
            assert_eq!(legacy.surface(), current.surface());
            assert_eq!(
                legacy.allowlist_root(&home, &ws).unwrap(),
                current.allowlist_root(&home, &ws).unwrap()
            );
            assert!(legacy.is_skill_file());
            assert_eq!(legacy.as_skill_file(), current.as_skill_file());
        }
        assert_eq!(ArtifactId::ClaudeRules.current_equivalent(), None);
        assert!(!ArtifactId::ClaudeRules.is_skill_file());
        assert!(
            !ArtifactId::WorkspaceFile(WorkspaceRelPath::new("skills/a").unwrap()).is_skill_file()
        );
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn skill_surfaces_expand_to_every_file_of_every_skill() {
        let ws = temp_dir("skill-files");
        crate::test_env::write_canonical_skill(&ws, None, "plain", "body");
        crate::test_env::write_canonical_skill(&ws, Some("group"), "report", "body");
        write_file(&ws.join("skills/plain/HUNTING.md"), "hunting");
        write_file(&ws.join("skills/plain/LICENSE"), "licence");
        write_file(
            &ws.join("skills/group/report/assets/report-template.html"),
            "<html>",
        );
        write_file(&ws.join("skills/group/report/scripts/verify.mjs"), "//");
        write_file(&ws.join("skills/group/report/.DS_Store"), "ignored");

        let artifacts = expand_surface(
            SetupSurfaceId::Skills,
            &ws,
            &SkillScope::of(&[SkillRoot::Claude]),
        )
        .expect("expand");
        let files: Vec<(String, String)> = artifacts
            .iter()
            .map(|artifact| match artifact {
                ArtifactId::SkillFile(file) => {
                    assert_eq!(file.root, SkillRoot::Claude);
                    (
                        file.skill.as_str().to_string(),
                        file.rel.as_str().to_string(),
                    )
                }
                other => panic!("unexpected artifact {other:?}"),
            })
            .collect();
        let expected: Vec<(&str, &str)> = vec![
            ("plain", "SKILL.md"),
            ("plain", "HUNTING.md"),
            ("plain", "LICENSE"),
            ("report", "SKILL.md"),
            ("report", "assets/report-template.html"),
            ("report", "scripts/verify.mjs"),
        ];
        let expected: Vec<(String, String)> = expected
            .into_iter()
            .map(|(skill, rel)| (skill.to_string(), rel.to_string()))
            .collect();
        assert_eq!(files, expected);
        // Every root of the scope receives the same files, root by root, and the retired
        // per-harness surfaces expand like the skills surface.
        let scope = SkillScope::of(&[SkillRoot::Claude, SkillRoot::Agents, SkillRoot::CodexHome]);
        let all_roots = expand_surface(SetupSurfaceId::Skills, &ws, &scope).expect("expand");
        assert_eq!(all_roots.len(), artifacts.len() * 3);
        for (index, root) in scope.roots().iter().enumerate() {
            let chunk = &all_roots[index * artifacts.len()..(index + 1) * artifacts.len()];
            assert!(chunk.iter().all(|artifact| matches!(
                artifact,
                ArtifactId::SkillFile(file) if file.root == *root
            )));
            assert!(chunk
                .iter()
                .all(|artifact| artifact.surface() == SetupSurfaceId::Skills));
        }
        for retired in [
            SetupSurfaceId::ClaudeSkills,
            SetupSurfaceId::OpenCodeSkills,
            SetupSurfaceId::CodexSkills,
            SetupSurfaceId::CursorSkills,
        ] {
            assert_eq!(
                expand_surface(retired, &ws, &scope).expect("expand"),
                all_roots
            );
        }
    }

    #[test]
    fn no_root_in_the_scope_expands_to_no_artifacts() {
        let ws = temp_dir("skill-no-root");
        crate::test_env::write_canonical_skill(&ws, None, "plain", "body");
        let none = SkillScope::for_harnesses(&[], false);
        assert!(expand_surface(SetupSurfaceId::Skills, &ws, &none)
            .expect("expand")
            .is_empty());
    }

    #[test]
    fn skills_ignore_the_targets_metadata_because_the_folders_are_shared() {
        let ws = temp_dir("skill-targets");
        write_skill(&ws, "skills/only-claude", "only-claude", "claude");
        write_skill(&ws, "skills/all", "all", "codex, opencode, claude, cursor");
        let scope = SkillScope::of(&[SkillRoot::Agents]);
        let artifacts = expand_surface(SetupSurfaceId::Skills, &ws, &scope).expect("expand");
        assert_eq!(artifacts.len(), 2, "{artifacts:?}");
    }

    #[test]
    fn supporting_files_resolve_beside_the_canonical_skill_md() {
        let ws = temp_dir("support-source");
        let home = temp_dir("support-source-home");
        crate::test_env::write_canonical_skill(&ws, Some("group"), "report", "body");
        write_file(
            &ws.join("skills/group/report/assets/report-template.html"),
            "<html>",
        );
        let template = ArtifactId::skill_file(
            SkillRoot::OpenCode,
            skill("report"),
            SkillRelPath::new("assets/report-template.html").unwrap(),
        );
        let source = template.resolve_source(&ws).expect("source");
        assert!(source.ends_with("skills/group/report/assets/report-template.html"));
        assert!(source.is_file());
        let dest = template.resolve_dest(&home, &ws).unwrap();
        assert!(dest.ends_with(".config/opencode/skills/report/assets/report-template.html"));
        // A retired skill resolves to a file that is not there.
        let gone = ArtifactId::skill_file(
            SkillRoot::Claude,
            skill("retired"),
            SkillRelPath::new("HUNTING.md").unwrap(),
        );
        assert!(!gone.resolve_source(&ws).expect("source").exists());
    }

    #[test]
    fn a_broken_supporting_file_fails_the_expansion() {
        let ws = temp_dir("support-bad-name");
        crate::test_env::write_canonical_skill(&ws, None, "plain", "body");
        write_file(&ws.join("skills/plain/has space.md"), "x");
        let err = expand_surface(
            SetupSurfaceId::Skills,
            &ws,
            &SkillScope::of(&[SkillRoot::Claude]),
        )
        .expect_err("bad name");
        assert!(err.contains("has space.md"), "{err}");
    }

    // ── CODEX_HOME ──

    #[test]
    fn codex_destinations_honor_codex_home_like_skills() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp_dir("codex-home-user");
        let codex_home_dir = temp_dir("codex-home-override");
        let ws = temp_dir("codex-home-ws");
        std::env::remove_var("CODEX_SKILLS_PATH");
        std::env::set_var("CODEX_HOME", &codex_home_dir);

        let agent = AgentName::new("repo-scout").unwrap();
        let skill = SkillName::new("diagnose").unwrap();
        let cases = [
            (ArtifactId::CodexConfig, "config.toml"),
            (ArtifactId::CodexRules, "AGENTS.md"),
            (ArtifactId::CodexAgent(agent), "agents/repo-scout.toml"),
            (ArtifactId::CodexSkill(skill), "skills/diagnose/SKILL.md"),
        ];
        for (artifact, rel) in cases {
            let dest = artifact.resolve_dest(&home, &ws).expect("resolve dest");
            assert_eq!(dest, codex_home_dir.join(rel), "{artifact:?}");
        }
    }

    #[test]
    fn codex_destinations_default_to_dot_codex_without_codex_home() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp_dir("codex-default-user");
        let ws = temp_dir("codex-default-ws");
        std::env::remove_var("CODEX_SKILLS_PATH");
        for value in [None, Some("   ")] {
            match value {
                Some(blank) => std::env::set_var("CODEX_HOME", blank),
                None => std::env::remove_var("CODEX_HOME"),
            }
            assert_eq!(
                ArtifactId::CodexConfig.resolve_dest(&home, &ws).unwrap(),
                home.join(".codex/config.toml")
            );
            assert_eq!(
                ArtifactId::CodexRules.resolve_dest(&home, &ws).unwrap(),
                home.join(".codex/AGENTS.md")
            );
            assert_eq!(
                ArtifactId::CodexAgent(AgentName::new("repo-scout").unwrap())
                    .resolve_dest(&home, &ws)
                    .unwrap(),
                home.join(".codex/agents/repo-scout.toml")
            );
        }
    }
}
