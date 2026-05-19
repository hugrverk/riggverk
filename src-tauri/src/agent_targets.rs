use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
pub enum TargetKind {
    #[serde(rename = "rules")]
    Rules,
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
            "auggie_rules" => Some("--auggie"),
            "claude_rules" => Some("--claude"),
            "gemini_rules" => Some("--gemini"),
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
            source_rel: "templates/global-agent-rules.md",
        },
        AgentSyncTarget {
            id: "opencode_rules",
            label: "opencode rules",
            kind: TargetKind::Rules,
            target_rel: ".config/opencode/AGENTS.md",
            source_rel: "templates/global-agent-rules.md",
        },
        AgentSyncTarget {
            id: "auggie_rules",
            label: "auggie rules",
            kind: TargetKind::Rules,
            target_rel: ".augment/rules/global.md",
            source_rel: "templates/global-agent-rules.md",
        },
        AgentSyncTarget {
            id: "claude_rules",
            label: "claude rules",
            kind: TargetKind::Rules,
            target_rel: ".claude/CLAUDE.md",
            source_rel: "templates/global-agent-rules.md",
        },
        AgentSyncTarget {
            id: "gemini_rules",
            label: "gemini rules",
            kind: TargetKind::Rules,
            target_rel: ".gemini/GEMINI.md",
            source_rel: "templates/global-agent-rules.md",
        },
        AgentSyncTarget {
            id: "opencode_config",
            label: "opencode config + agents",
            kind: TargetKind::Config,
            target_rel: ".config/opencode/opencode.json",
            source_rel: "templates/opencode.json",
        },
        AgentSyncTarget {
            id: "cursor_setup",
            label: "cursor setup",
            kind: TargetKind::Config,
            target_rel: ".cursor/agents",
            source_rel: "templates/cursor/README.md",
        },
    ]
}

pub fn rule_targets() -> Vec<AgentSyncTarget> {
    targets()
        .into_iter()
        .filter(|t| matches!(t.kind, TargetKind::Rules))
        .collect()
}

pub fn config_targets() -> Vec<AgentSyncTarget> {
    targets()
        .into_iter()
        .filter(|t| matches!(t.kind, TargetKind::Config))
        .collect()
}

pub fn default_enabled_rule_ids() -> Vec<String> {
    vec![
        "codex_rules".into(),
        "opencode_rules".into(),
        "auggie_rules".into(),
    ]
}

pub fn default_enabled_config_ids() -> Vec<String> {
    vec!["opencode_config".into()]
}

pub fn default_enabled_ids() -> Vec<String> {
    let mut ids = default_enabled_rule_ids();
    ids.extend(default_enabled_config_ids());
    ids
}

#[derive(Serialize)]
pub struct TargetProfileMeta {
    pub id: String,
    pub label: String,
    pub description: String,
    pub target_ids: Vec<String>,
}

pub fn target_profiles() -> Vec<TargetProfileMeta> {
    vec![
        TargetProfileMeta {
            id: "opencode".into(),
            label: "OpenCode".into(),
            description: "OpenCode rules + config + agents".into(),
            target_ids: vec!["opencode_rules".into(), "opencode_config".into()],
        },
        TargetProfileMeta {
            id: "cursor".into(),
            label: "Cursor".into(),
            description:
                "Cursor global subagents. Project rules are installed by the Cursor setup script."
                    .into(),
            target_ids: vec!["cursor_setup".into()],
        },
        TargetProfileMeta {
            id: "all_rules".into(),
            label: "All rules".into(),
            description: "Codex, OpenCode, Claude, Gemini, Auggie rule targets".into(),
            target_ids: vec![
                "codex_rules".into(),
                "opencode_rules".into(),
                "auggie_rules".into(),
                "claude_rules".into(),
                "gemini_rules".into(),
            ],
        },
        TargetProfileMeta {
            id: "all_supported".into(),
            label: "All supported".into(),
            description: "All supported rule targets + OpenCode config + agents + Cursor setup"
                .into(),
            target_ids: vec![
                "codex_rules".into(),
                "opencode_rules".into(),
                "auggie_rules".into(),
                "claude_rules".into(),
                "gemini_rules".into(),
                "opencode_config".into(),
                "cursor_setup".into(),
            ],
        },
    ]
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
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => Ok(PathBuf::from(h)),
        _ => Err("HOME is not set".to_string()),
    }
}

// ── config target registry ──

pub enum ConfigScript {
    OpenCode,
    Cursor,
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
            ConfigScript::OpenCode => (
                "scripts/install-opencode-config.sh",
                match mode {
                    ConfigScriptMode::Diff => vec!["--quiet", "--diff"],
                    ConfigScriptMode::Apply => vec!["--quiet", "--apply"],
                },
            ),
            ConfigScript::Cursor => (
                "scripts/install-cursor-workspace.sh",
                match mode {
                    ConfigScriptMode::Diff => vec!["--quiet", "--global-agents"],
                    ConfigScriptMode::Apply => vec!["--quiet", "--apply", "--global-agents"],
                },
            ),
        }
    }
}

#[derive(Clone, Copy)]
pub enum ConfigScriptMode {
    Diff,
    Apply,
}

pub fn config_sync_targets() -> Vec<ConfigSyncTarget> {
    vec![
        ConfigSyncTarget {
            id: "opencode_config",
            label: "opencode config + agents",
            source_rel: "templates/opencode.json",
            target_rel: ".config/opencode/opencode.json",
            script: ConfigScript::OpenCode,
        },
        ConfigSyncTarget {
            id: "cursor_setup",
            label: "cursor setup",
            source_rel: "templates/cursor/README.md",
            target_rel: ".cursor/agents",
            script: ConfigScript::Cursor,
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

/// Returns the known editor sources for the opencode_config target.
/// This is separate from config_sync_targets() to preserve the runtime sync target.
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
    fn target_profiles_only_reference_known_targets() {
        let known: HashSet<&str> = targets().iter().map(|t| t.id).collect();
        for profile in target_profiles() {
            for target_id in &profile.target_ids {
                assert!(
                    known.contains(target_id.as_str()),
                    "Profile '{}' references unknown target '{}'",
                    profile.id,
                    target_id
                );
            }
        }
    }

    #[test]
    fn target_profiles_have_no_duplicate_target_ids() {
        for profile in target_profiles() {
            let mut seen = HashSet::new();
            for target_id in &profile.target_ids {
                assert!(
                    seen.insert(target_id.as_str()),
                    "Profile '{}' has duplicate target id '{}'",
                    profile.id,
                    target_id
                );
            }
        }
    }

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
    fn target_profile_ids_are_unique() {
        let mut seen = HashSet::new();
        for profile in target_profiles() {
            assert!(
                seen.insert(profile.id.clone()),
                "Duplicate profile id '{}'",
                profile.id
            );
        }
    }

    #[test]
    fn target_profile_labels_are_non_empty() {
        for profile in target_profiles() {
            assert!(!profile.id.is_empty(), "Profile has empty id");
            assert!(
                !profile.label.is_empty(),
                "Profile '{}' has empty label",
                profile.id
            );
            assert!(
                !profile.description.is_empty(),
                "Profile '{}' has empty description",
                profile.id
            );
            assert!(
                !profile.target_ids.is_empty(),
                "Profile '{}' has empty target_ids",
                profile.id
            );
        }
    }

    // ── config target registry tests ──

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
    fn cursor_setup_in_config_sync_targets() {
        let targets = config_sync_targets();
        let cursor = targets.iter().find(|t| t.id == "cursor_setup");
        assert!(
            cursor.is_some(),
            "cursor_setup must be in config_sync_targets"
        );
        let t = cursor.unwrap();
        assert_eq!(t.source_rel, "templates/cursor/README.md");
        assert_eq!(t.target_rel, ".cursor/agents");
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
    fn config_sync_source_rel_is_not_absolute() {
        for t in config_sync_targets() {
            assert!(
                !t.source_rel.starts_with('/'),
                "source_rel '{}' must not be absolute",
                t.source_rel
            );
            assert!(
                !t.target_rel.starts_with('/'),
                "target_rel '{}' must not be absolute",
                t.target_rel
            );
        }
    }

    #[test]
    fn config_sync_source_rel_does_not_contain_parent_refs() {
        for t in config_sync_targets() {
            assert!(
                !t.source_rel.contains(".."),
                "source_rel '{}' must not contain '..'",
                t.source_rel
            );
            assert!(
                !t.target_rel.contains(".."),
                "target_rel '{}' must not contain '..'",
                t.target_rel
            );
        }
    }

    #[test]
    fn unknown_config_target_rejected() {
        let targets = config_sync_targets();
        let unknown = targets.iter().find(|t| t.id == "nonexistent_config");
        assert!(
            unknown.is_none(),
            "unknown config target must not be in config_sync_targets"
        );
    }

    #[test]
    fn config_target_ids_unique_in_targets_registry() {
        let all = targets();
        let config_ids: Vec<&str> = all
            .iter()
            .filter(|t| matches!(t.kind, TargetKind::Config))
            .map(|t| t.id)
            .collect();
        let mut seen = HashSet::new();
        for id in &config_ids {
            assert!(
                seen.insert(*id),
                "Duplicate config target id '{}' in targets() registry",
                id
            );
        }
    }

    // ── config editor source tests ──

    #[test]
    fn opencode_config_editor_sources_has_all_three() {
        let sources = opencode_config_editor_sources();
        assert_eq!(sources.len(), 3);
        let ids: Vec<&str> = sources.iter().map(|s| s.id).collect();
        assert_eq!(ids, &["base", "policy", "snapshot"]);
    }

    #[test]
    fn opencode_config_editor_source_base_is_editable() {
        let sources = opencode_config_editor_sources();
        let base = sources.iter().find(|s| s.id == "base").unwrap();
        assert!(base.editable);
        assert_eq!(base.rel_path, "templates/opencode.base.json");
    }

    #[test]
    fn opencode_config_editor_source_policy_is_editable() {
        let sources = opencode_config_editor_sources();
        let policy = sources.iter().find(|s| s.id == "policy").unwrap();
        assert!(policy.editable);
        assert_eq!(policy.rel_path, "templates/opencode.policy.json");
    }

    #[test]
    fn opencode_config_editor_source_snapshot_is_not_editable() {
        let sources = opencode_config_editor_sources();
        let snapshot = sources.iter().find(|s| s.id == "snapshot").unwrap();
        assert!(!snapshot.editable);
        assert_eq!(snapshot.rel_path, "templates/opencode.json");
    }

    #[test]
    fn opencode_config_editor_source_paths_are_safe() {
        for s in opencode_config_editor_sources() {
            assert!(
                !s.rel_path.starts_with('/'),
                "rel_path '{}' must not be absolute",
                s.rel_path
            );
            assert!(
                !s.rel_path.contains(".."),
                "rel_path '{}' must not contain '..'",
                s.rel_path
            );
        }
    }

    #[test]
    fn opencode_config_editor_source_ids_have_helpers() {
        for s in opencode_config_editor_sources() {
            assert!(!s.helper.is_empty(), "source '{}' has empty helper", s.id);
        }
    }

    #[test]
    fn opencode_config_editor_source_by_id_finds_known() {
        for id in &["base", "policy", "snapshot"] {
            let found = opencode_config_editor_source_by_id(id);
            assert!(found.is_some(), "should find source '{}'", id);
            assert_eq!(found.unwrap().id, *id);
        }
    }

    #[test]
    fn opencode_config_editor_source_by_id_rejects_unknown() {
        let found = opencode_config_editor_source_by_id("unknown");
        assert!(found.is_none());
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
