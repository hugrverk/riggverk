//! Harness-native agent discovery for setup and health checks.
//!
//! Single owner for discovering bundled agent sources with correct native extensions.

use std::fs;
use std::path::{Path, PathBuf};

use crate::artifact_registry::AgentName;
use crate::path_safety::reject_symlink;

/// Harness identifier for agent source discovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentHarness {
    OpenCode,
    Codex,
    Claude,
    Cursor,
}

impl AgentHarness {
    pub fn source_dir(&self, workspace_root: &Path) -> PathBuf {
        match self {
            Self::OpenCode => workspace_root.join("agents"),
            Self::Codex => workspace_root.join("templates/codex/agents"),
            Self::Claude => workspace_root.join("templates/claude/agents"),
            Self::Cursor => workspace_root.join("templates/cursor/agents"),
        }
    }

    pub fn native_extension(&self) -> &'static str {
        match self {
            Self::Codex => "toml",
            Self::OpenCode | Self::Claude | Self::Cursor => "md",
        }
    }
}

/// One discovered agent from a harness source directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredAgent {
    pub name: AgentName,
    pub source_path: PathBuf,
    pub harness: AgentHarness,
}

/// Discover agents for a harness from its canonical source directory.
///
/// Fails closed when the source directory is missing or unreadable.
pub fn discover_agents(
    harness: AgentHarness,
    workspace_root: &Path,
) -> Result<Vec<DiscoveredAgent>, String> {
    let source_dir = harness.source_dir(workspace_root);
    if !source_dir.is_dir() {
        return Err(format!(
            "agent source directory missing: {}",
            source_dir.display()
        ));
    }
    reject_symlink(&source_dir, "agent source directory")?;

    let ext = harness.native_extension();
    let entries = fs::read_dir(&source_dir)
        .map_err(|e| format!("cannot read agent source {}: {e}", source_dir.display()))?;

    let mut agents: Vec<DiscoveredAgent> = Vec::new();
    let mut seen_names: Vec<String> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("read agent entry: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink agent file: {}",
                entry.path().display()
            ));
        }
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(ext) {
            continue;
        }
        let Some(stem) = path.file_stem() else {
            continue;
        };
        let stem_str = stem.to_string_lossy();
        if stem_str.starts_with('.') {
            continue;
        }
        let Some(name) = AgentName::new(stem_str.as_ref()) else {
            return Err(format!("invalid agent name: {stem_str}"));
        };
        if seen_names.contains(&name.as_str().to_string()) {
            return Err(format!("duplicate agent name: {}", name.as_str()));
        }
        seen_names.push(name.as_str().to_string());
        agents.push(DiscoveredAgent {
            name,
            source_path: path,
            harness,
        });
    }

    agents.sort_by(|a, b| a.name.as_str().cmp(b.name.as_str()));
    if agents.is_empty() {
        return Err(format!(
            "no {} agents found in {}",
            ext,
            source_dir.display()
        ));
    }
    Ok(agents)
}

/// Discover agent names only (for artifact expansion).
pub fn discover_agent_names(
    harness: AgentHarness,
    workspace_root: &Path,
) -> Result<Vec<AgentName>, String> {
    discover_agents(harness, workspace_root)
        .map(|agents| agents.into_iter().map(|a| a.name).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-agent-disc-{name}-{nonce}"))
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn opencode_agents_discovered_from_md() {
        let ws = temp_root("oc");
        write_file(&ws.join("agents/repo-scout.md"), "# scout");
        write_file(&ws.join("agents/inspector.md"), "# inspector");
        let agents = discover_agents(AgentHarness::OpenCode, &ws).expect("discover");
        let _ = fs::remove_dir_all(&ws);
        assert_eq!(agents.len(), 2);
        assert!(agents.iter().any(|a| a.name.as_str() == "repo-scout"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_agent_source_directory_is_refused() {
        let ws = temp_root("sym-source");
        write_file(&ws.join("real-agents/scout.md"), "# scout");
        std::os::unix::fs::symlink(ws.join("real-agents"), ws.join("agents")).unwrap();
        let err = discover_agents(AgentHarness::OpenCode, &ws).unwrap_err();
        let _ = fs::remove_dir_all(&ws);
        assert!(
            err.contains("refusing symlink agent source directory"),
            "{err}"
        );
    }

    #[test]
    fn codex_agents_use_toml_extension() {
        let ws = temp_root("codex");
        write_file(
            &ws.join("templates/codex/agents/inspector.toml"),
            "name = \"inspector\"",
        );
        write_file(
            &ws.join("templates/codex/agents/verifier.toml"),
            "name = \"verifier\"",
        );
        let agents = discover_agents(AgentHarness::Codex, &ws).expect("discover");
        let _ = fs::remove_dir_all(&ws);
        for a in &agents {
            assert!(a.source_path.extension().and_then(|e| e.to_str()) == Some("toml"));
            assert!(a
                .source_path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".toml")));
        }
    }

    #[test]
    fn codex_ignores_md_files() {
        let ws = temp_root("codex-md");
        write_file(&ws.join("templates/codex/agents/bad.md"), "# bad");
        write_file(&ws.join("templates/codex/agents/good.toml"), "x=1");
        let agents = discover_agents(AgentHarness::Codex, &ws).expect("discover");
        let _ = fs::remove_dir_all(&ws);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name.as_str(), "good");
    }

    #[test]
    fn missing_source_is_error_not_empty() {
        let ws = temp_root("missing");
        let err = discover_agents(AgentHarness::Claude, &ws).unwrap_err();
        let _ = fs::remove_dir_all(&ws);
        assert!(err.contains("missing"));
    }

    #[test]
    fn invalid_agent_name_fails() {
        let ws = temp_root("invalid-name");
        write_file(&ws.join("templates/claude/agents/Bad_Name.md"), "# bad");
        let err = discover_agents(AgentHarness::Claude, &ws).unwrap_err();
        let _ = fs::remove_dir_all(&ws);
        assert!(err.contains("invalid agent name"));
    }

    #[test]
    fn bundled_opencode_agent_count() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let agents = discover_agents(AgentHarness::OpenCode, &repo).expect("opencode");
        assert_eq!(agents.len(), 6);
    }

    #[test]
    fn bundled_claude_agent_count() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let agents = discover_agents(AgentHarness::Claude, &repo).expect("claude");
        assert_eq!(agents.len(), 5);
    }

    #[test]
    fn bundled_cursor_agent_count() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let agents = discover_agents(AgentHarness::Cursor, &repo).expect("cursor");
        assert_eq!(agents.len(), 6);
    }

    #[test]
    fn bundled_codex_toml_agent_count() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let agents = discover_agents(AgentHarness::Codex, &repo).expect("codex");
        assert_eq!(agents.len(), 4);
        for a in &agents {
            assert!(a.source_path.to_string_lossy().ends_with(".toml"));
        }
    }
}
