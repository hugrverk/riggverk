use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone, Copy, PartialEq)]
pub enum TargetKind {
    #[serde(rename = "rules")]
    Rules,
    #[serde(rename = "agents")]
    Agents,
    #[serde(rename = "config")]
    Config,
}

pub struct AgentSyncTarget {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: TargetKind,
    pub target_rel: &'static str,
    pub source_rel: &'static str,
}

impl AgentSyncTarget {
    pub fn script_flag(&self) -> Option<&'static str> {
        match self.id {
            "codex_rules" => Some("--codex"),
            "opencode_rules" => Some("--opencode"),
            "claude_rules" => Some("--claude"),
            _ => None,
        }
    }
}

#[derive(Serialize)]
pub struct AgentTargetMeta {
    pub id: String,
    pub label: String,
    pub kind: TargetKind,
    pub target_rel: String,
    pub source_rel: String,
}

pub fn targets() -> Vec<AgentSyncTarget> {
    vec![
        AgentSyncTarget {
            id: "codex_rules",
            label: "codex rules",
            kind: TargetKind::Rules,
            target_rel: ".codex/AGENTS.md",
            source_rel: "templates/sync/codex-rules.md",
        },
        AgentSyncTarget {
            id: "opencode_rules",
            label: "opencode rules",
            kind: TargetKind::Rules,
            target_rel: ".config/opencode/AGENTS.md",
            source_rel: "templates/sync/opencode-rules.md",
        },
        AgentSyncTarget {
            id: "claude_rules",
            label: "claude rules",
            kind: TargetKind::Rules,
            target_rel: ".claude/CLAUDE.md",
            source_rel: "templates/sync/claude-rules.md",
        },
        AgentSyncTarget {
            id: "opencode_agents",
            label: "opencode agents",
            kind: TargetKind::Agents,
            target_rel: ".config/opencode/agents",
            source_rel: "agents",
        },
        AgentSyncTarget {
            id: "claude_agents",
            label: "claude agents",
            kind: TargetKind::Agents,
            target_rel: ".claude/agents",
            source_rel: "templates/claude/agents",
        },
        AgentSyncTarget {
            id: "codex_agents",
            label: "codex agents",
            kind: TargetKind::Agents,
            target_rel: ".codex/agents",
            source_rel: "templates/codex/agents",
        },
        AgentSyncTarget {
            id: "opencode_config",
            label: "opencode config",
            kind: TargetKind::Config,
            target_rel: ".config/opencode/opencode.json",
            source_rel: "templates/opencode.json",
        },
        AgentSyncTarget {
            id: "codex_config",
            label: "codex config",
            kind: TargetKind::Config,
            target_rel: ".codex/config.toml",
            source_rel: "templates/codex/config.toml",
        },
        AgentSyncTarget {
            id: "cursor_setup",
            label: "cursor global agents",
            kind: TargetKind::Agents,
            target_rel: ".cursor/agents",
            source_rel: "templates/cursor/agents",
        },
    ]
}

pub fn rule_targets() -> Vec<AgentSyncTarget> {
    targets()
        .into_iter()
        .filter(|t| matches!(t.kind, TargetKind::Rules))
        .collect()
}

pub fn runtime_agent_targets() -> Vec<AgentSyncTarget> {
    targets()
        .into_iter()
        .filter(|t| matches!(t.kind, TargetKind::Agents))
        .filter(|t| t.id != "cursor_setup")
        .collect()
}

pub fn config_targets() -> Vec<AgentSyncTarget> {
    targets()
        .into_iter()
        .filter(|t| matches!(t.kind, TargetKind::Config))
        .collect()
}

pub fn editable_config_targets() -> Vec<AgentSyncTarget> {
    targets()
        .into_iter()
        .filter(|t| matches!(t.kind, TargetKind::Config))
        .filter(|t| t.id == "opencode_config")
        .collect()
}

pub fn default_enabled_rule_ids() -> Vec<String> {
    vec!["codex_rules".into(), "opencode_rules".into()]
}

pub fn default_enabled_config_ids() -> Vec<String> {
    vec!["opencode_config".into()]
}

pub fn default_enabled_ids() -> Vec<String> {
    let mut ids = default_enabled_rule_ids();
    ids.extend(default_enabled_config_ids());
    ids
}

pub fn normalize_enabled_ids(raw: &[String]) -> Vec<String> {
    let known: Vec<&str> = targets().iter().map(|t| t.id).collect();
    let mut seen = std::collections::HashSet::new();
    let mut result: Vec<String> = Vec::new();
    for id in known {
        if raw.iter().any(|r| r == id) && seen.insert(id) {
            result.push(id.to_string());
        }
    }
    result
}

pub fn home_dir() -> Result<PathBuf, String> {
    crate::cursor_profile_paths::resolve_user_home()
}

// ── config target registry ──

pub enum ConfigScript {
    OpenCode,
    Codex,
}

#[allow(dead_code)]
pub struct ConfigSyncTarget {
    pub id: &'static str,
    pub label: &'static str,
    pub source_rel: &'static str,
    pub target_rel: &'static str,
    pub script: ConfigScript,
}

impl ConfigSyncTarget {
    pub fn script_rel_and_args(&self, mode: ConfigScriptMode) -> (&'static str, Vec<&'static str>) {
        match self.script {
            ConfigScript::Codex => (
                "scripts/install-codex-config.sh",
                match mode {
                    ConfigScriptMode::Diff => vec!["--quiet", "--diff"],
                    ConfigScriptMode::Apply => vec!["--quiet", "--apply"],
                },
            ),
            ConfigScript::OpenCode => (
                "scripts/install-opencode-config.sh",
                opencode_install_args(mode, OpenCodeInstallScope::Full),
            ),
        }
    }
}

#[derive(Clone, Copy)]
pub enum ConfigScriptMode {
    Diff,
    Apply,
}

#[derive(Clone, Copy)]
pub enum OpenCodeInstallScope {
    Full,
    #[allow(dead_code)]
    AgentsOnly,
    ConfigOnly,
}

pub fn runtime_agents_install_args(mode: ConfigScriptMode) -> Vec<&'static str> {
    match mode {
        ConfigScriptMode::Diff => vec!["--quiet", "--diff"],
        ConfigScriptMode::Apply => vec!["--quiet", "--apply"],
    }
}

pub fn opencode_install_args(
    mode: ConfigScriptMode,
    scope: OpenCodeInstallScope,
) -> Vec<&'static str> {
    let mut args = match mode {
        ConfigScriptMode::Diff => vec!["--quiet", "--diff"],
        ConfigScriptMode::Apply => vec!["--quiet", "--apply"],
    };
    match scope {
        OpenCodeInstallScope::Full => {}
        OpenCodeInstallScope::AgentsOnly => args.push("--agents-only"),
        OpenCodeInstallScope::ConfigOnly => args.push("--config-only"),
    }
    args
}

pub fn config_sync_targets() -> Vec<ConfigSyncTarget> {
    vec![
        ConfigSyncTarget {
            id: "opencode_config",
            label: "opencode config",
            source_rel: "templates/opencode.json",
            target_rel: ".config/opencode/opencode.json",
            script: ConfigScript::OpenCode,
        },
        ConfigSyncTarget {
            id: "codex_config",
            label: "codex config",
            source_rel: "templates/codex/config.toml",
            target_rel: ".codex/config.toml",
            script: ConfigScript::Codex,
        },
    ]
}

// ── config editor sources ──

#[derive(Serialize, Clone)]
pub struct ConfigEditorSourceMeta {
    pub id: String,
    pub label: String,
    pub rel_path: String,
    pub editable: bool,
    pub helper: String,
}

#[derive(Clone)]
pub struct ConfigEditorSource {
    pub id: &'static str,
    pub label: &'static str,
    pub rel_path: &'static str,
    pub editable: bool,
    pub helper: &'static str,
}

static OPENCODE_CONFIG_EDITOR_SOURCES: &[ConfigEditorSource] = &[
    ConfigEditorSource {
        id: "base",
        label: "Base",
        rel_path: "templates/opencode.base.json",
        editable: true,
        helper: "Model, provider, watcher, compaction.",
    },
    ConfigEditorSource {
        id: "policy",
        label: "Policy",
        rel_path: "templates/opencode.policy.json",
        editable: true,
        helper: "Read, edit, bash, and secret-file permission source.",
    },
    ConfigEditorSource {
        id: "snapshot",
        label: "Snapshot",
        rel_path: "templates/opencode.json",
        editable: false,
        helper: "Generated runtime config. Edit Base or Policy instead.",
    },
];

pub fn opencode_config_editor_sources() -> Vec<ConfigEditorSource> {
    OPENCODE_CONFIG_EDITOR_SOURCES.to_vec()
}

pub fn opencode_config_editor_source_by_id(
    source_type: &str,
) -> Option<&'static ConfigEditorSource> {
    OPENCODE_CONFIG_EDITOR_SOURCES
        .iter()
        .find(|s| s.id == source_type)
}

pub fn opencode_config_editor_source_meta_list() -> Vec<ConfigEditorSourceMeta> {
    opencode_config_editor_sources()
        .into_iter()
        .map(|s| ConfigEditorSourceMeta {
            id: s.id.to_string(),
            label: s.label.to_string(),
            rel_path: s.rel_path.to_string(),
            editable: s.editable,
            helper: s.helper.to_string(),
        })
        .collect()
}
