use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessId {
    Codex,
    OpenCode,
    Claude,
    Cursor,
}

impl HarnessId {
    pub const ALL: &'static [HarnessId] = &[
        HarnessId::Codex,
        HarnessId::OpenCode,
        HarnessId::Claude,
        HarnessId::Cursor,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            HarnessId::Codex => "codex",
            HarnessId::OpenCode => "opencode",
            HarnessId::Claude => "claude",
            HarnessId::Cursor => "cursor",
        }
    }
}

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
    pub harness: HarnessId,
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
    pub harness: HarnessId,
    pub kind: TargetKind,
    pub target_rel: String,
    pub source_rel: String,
}

pub fn targets() -> Vec<AgentSyncTarget> {
    vec![
        AgentSyncTarget {
            id: "codex_rules",
            label: "codex rules",
            harness: HarnessId::Codex,
            kind: TargetKind::Rules,
            target_rel: ".codex/AGENTS.md",
            source_rel: "templates/sync/codex-rules.md",
        },
        AgentSyncTarget {
            id: "opencode_rules",
            label: "opencode rules",
            harness: HarnessId::OpenCode,
            kind: TargetKind::Rules,
            target_rel: ".config/opencode/AGENTS.md",
            source_rel: "templates/sync/opencode-rules.md",
        },
        AgentSyncTarget {
            id: "claude_rules",
            label: "claude rules",
            harness: HarnessId::Claude,
            kind: TargetKind::Rules,
            target_rel: ".claude/CLAUDE.md",
            source_rel: "templates/sync/claude-rules.md",
        },
        AgentSyncTarget {
            id: "opencode_agents",
            label: "opencode agents",
            harness: HarnessId::OpenCode,
            kind: TargetKind::Agents,
            target_rel: ".config/opencode/agents",
            source_rel: "agents",
        },
        AgentSyncTarget {
            id: "claude_agents",
            label: "claude agents",
            harness: HarnessId::Claude,
            kind: TargetKind::Agents,
            target_rel: ".claude/agents",
            source_rel: "templates/claude/agents",
        },
        AgentSyncTarget {
            id: "codex_agents",
            label: "codex agents",
            harness: HarnessId::Codex,
            kind: TargetKind::Agents,
            target_rel: ".codex/agents",
            source_rel: "templates/codex/agents",
        },
        AgentSyncTarget {
            id: "opencode_config",
            label: "opencode config",
            harness: HarnessId::OpenCode,
            kind: TargetKind::Config,
            target_rel: ".config/opencode/opencode.json",
            source_rel: "templates/opencode.json",
        },
        AgentSyncTarget {
            id: "codex_config",
            label: "codex config",
            harness: HarnessId::Codex,
            kind: TargetKind::Config,
            target_rel: ".codex/config.toml",
            source_rel: "templates/codex/config.toml",
        },
        AgentSyncTarget {
            id: "cursor_setup",
            label: "cursor global agents",
            harness: HarnessId::Cursor,
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

pub fn default_enabled_harness_ids() -> Vec<HarnessId> {
    HarnessId::ALL.to_vec()
}

pub fn normalize_enabled_harness_ids(raw: &[HarnessId]) -> Vec<HarnessId> {
    HarnessId::ALL
        .iter()
        .copied()
        .filter(|id| raw.contains(id))
        .collect()
}

pub fn target_harness(target_id: &str) -> Option<HarnessId> {
    targets()
        .into_iter()
        .find(|target| target.id == target_id)
        .map(|target| target.harness)
}

pub fn home_dir() -> Result<PathBuf, String> {
    crate::cursor_profile_paths::resolve_user_home()
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn default_enabled_ids_only_contain_known_targets() {
        let known: HashSet<&str> = targets().iter().map(|t| t.id).collect();
        for id in default_enabled_ids() {
            assert!(
                known.contains(id.as_str()),
                "Default enabled target '{}' is not a known target",
                id
            );
        }
    }

    #[test]
    fn codex_config_is_not_default_enabled() {
        assert!(
            !default_enabled_ids().contains(&"codex_config".to_string()),
            "Codex config must stay manual-review only by default"
        );
    }

    #[test]
    fn claude_agents_use_native_adapter_source() {
        let target = targets()
            .into_iter()
            .find(|target| target.id == "claude_agents")
            .expect("claude_agents target");
        assert_eq!(target.source_rel, "templates/claude/agents");
    }

    #[test]
    fn opencode_config_in_config_sync_targets() {
        let targets = config_sync_targets();
        let opencode = targets.iter().find(|t| t.id == "opencode_config");
        assert!(
            opencode.is_some(),
            "opencode_config must be in config_sync_targets"
        );
        let t = opencode.unwrap();
        assert_eq!(t.source_rel, "templates/opencode.json");
        assert_eq!(t.target_rel, ".config/opencode/opencode.json");
    }

    #[test]
    fn cursor_setup_not_in_config_sync_targets() {
        let targets = config_sync_targets();
        assert!(targets.iter().all(|t| t.id != "cursor_setup"));
    }

    #[test]
    fn config_sync_target_ids_are_unique() {
        let targets = config_sync_targets();
        let mut seen = HashSet::new();
        for t in &targets {
            assert!(
                seen.insert(t.id),
                "Duplicate config sync target id '{}'",
                t.id
            );
        }
    }

    #[test]
    fn config_sync_paths_are_relative_and_contained() {
        for t in config_sync_targets() {
            assert!(!t.source_rel.starts_with('/'));
            assert!(!t.target_rel.starts_with('/'));
            assert!(!t.source_rel.contains(".."));
            assert!(!t.target_rel.contains(".."));
        }
    }

    #[test]
    fn cursor_setup_is_agents_not_rules() {
        let rules = rule_targets();
        assert!(rules.iter().all(|t| t.id != "cursor_setup"));
        let cursor = targets()
            .into_iter()
            .find(|t| t.id == "cursor_setup")
            .expect("cursor_setup target");
        assert!(matches!(cursor.kind, TargetKind::Agents));
    }

    #[test]
    fn cursor_setup_not_in_runtime_agent_targets() {
        let runtime = runtime_agent_targets();
        assert!(
            runtime.iter().all(|t| t.id != "cursor_setup"),
            "cursor_setup must be excluded from runtime_agent_targets"
        );
    }

    #[test]
    fn all_target_ids_are_unique() {
        let all = targets();
        let mut seen = HashSet::new();
        for t in &all {
            assert!(
                seen.insert(t.id),
                "Duplicate target id '{}' across all targets",
                t.id
            );
        }
    }

    #[test]
    fn all_target_paths_are_relative_and_contained() {
        for t in targets() {
            assert!(
                !t.source_rel.starts_with('/'),
                "source_rel for '{}' must not be absolute: {}",
                t.id,
                t.source_rel
            );
            assert!(
                !t.target_rel.starts_with('/'),
                "target_rel for '{}' must not be absolute: {}",
                t.id,
                t.target_rel
            );
            assert!(
                !t.source_rel.contains(".."),
                "source_rel for '{}' must not contain parent traversal: {}",
                t.id,
                t.source_rel
            );
            assert!(
                !t.target_rel.contains(".."),
                "target_rel for '{}' must not contain parent traversal: {}",
                t.id,
                t.target_rel
            );
        }
    }

    #[test]
    fn unknown_target_ids_are_rejected_by_normalize() {
        let raw = vec![
            "opencode_rules".to_string(),
            "unknown_target".to_string(),
            "claude_agents".to_string(),
            "".to_string(),
        ];
        let normalized = normalize_enabled_ids(&raw);
        assert!(normalized.contains(&"opencode_rules".to_string()));
        assert!(normalized.contains(&"claude_agents".to_string()));
        assert!(!normalized.contains(&"unknown_target".to_string()));
        assert!(!normalized.contains(&"".to_string()));
    }

    #[test]
    fn normalize_empty_input_returns_empty() {
        let normalized = normalize_enabled_ids(&[]);
        assert!(normalized.is_empty());
    }

    #[test]
    fn normalize_unknown_only_returns_empty() {
        let normalized = normalize_enabled_ids(&["nonexistent".to_string()]);
        assert!(normalized.is_empty());
    }

    #[test]
    fn targets_contains_all_expected_ids() {
        let ids: std::collections::BTreeSet<&str> = targets().iter().map(|t| t.id).collect();
        let expected: std::collections::BTreeSet<&str> = [
            "codex_rules",
            "opencode_rules",
            "claude_rules",
            "opencode_agents",
            "claude_agents",
            "codex_agents",
            "opencode_config",
            "codex_config",
            "cursor_setup",
        ]
        .into_iter()
        .collect();
        assert_eq!(ids, expected, "targets() must contain exactly 9 known IDs");
    }

    #[test]
    fn opencode_install_args_supports_scoped_sync() {
        assert_eq!(
            opencode_install_args(ConfigScriptMode::Diff, OpenCodeInstallScope::AgentsOnly),
            vec!["--quiet", "--diff", "--agents-only"]
        );
        assert_eq!(
            opencode_install_args(ConfigScriptMode::Apply, OpenCodeInstallScope::ConfigOnly),
            vec!["--quiet", "--apply", "--config-only"]
        );
        assert_eq!(
            opencode_install_args(ConfigScriptMode::Diff, OpenCodeInstallScope::Full),
            vec!["--quiet", "--diff"]
        );
    }

    #[test]
    fn editable_config_targets_exclude_cursor_setup() {
        let ids: Vec<&str> = editable_config_targets().iter().map(|t| t.id).collect();
        assert_eq!(ids, &["opencode_config"]);
    }

    #[test]
    fn opencode_config_editor_sources_are_safe() {
        let sources = opencode_config_editor_sources();
        assert_eq!(sources.len(), 3);
        assert_eq!(
            sources.iter().map(|source| source.id).collect::<Vec<_>>(),
            vec!["base", "policy", "snapshot"]
        );
        for source in sources {
            assert!(!source.rel_path.starts_with('/'));
            assert!(!source.rel_path.contains(".."));
            assert!(!source.helper.is_empty());
        }
    }

    #[test]
    fn opencode_config_editor_source_metadata_matches_contract() {
        let base = opencode_config_editor_source_by_id("base").expect("base source");
        assert!(base.editable);
        assert_eq!(base.rel_path, "templates/opencode.base.json");

        let policy = opencode_config_editor_source_by_id("policy").expect("policy source");
        assert!(policy.editable);
        assert_eq!(policy.rel_path, "templates/opencode.policy.json");

        let snapshot = opencode_config_editor_source_by_id("snapshot").expect("snapshot source");
        assert!(!snapshot.editable);
        assert_eq!(snapshot.rel_path, "templates/opencode.json");
        assert!(opencode_config_editor_source_by_id("unknown").is_none());
    }

    #[test]
    fn opencode_config_editor_source_meta_serializable() {
        let meta = opencode_config_editor_source_meta_list();
        assert_eq!(meta.len(), 3);
        let snapshot = meta.iter().find(|m| m.id == "snapshot").unwrap();
        assert!(!snapshot.editable);
        assert_eq!(snapshot.rel_path, "templates/opencode.json");
    }
}
