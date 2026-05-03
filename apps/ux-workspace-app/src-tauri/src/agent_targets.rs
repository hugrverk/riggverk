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
            label: "opencode config",
            kind: TargetKind::Config,
            target_rel: ".config/opencode/opencode.json",
            source_rel: "templates/opencode.json",
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
            description: "OpenCode rules + config only".into(),
            target_ids: vec!["opencode_rules".into(), "opencode_config".into()],
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
            description: "All supported rule targets + supported config targets".into(),
            target_ids: vec![
                "codex_rules".into(),
                "opencode_rules".into(),
                "auggie_rules".into(),
                "claude_rules".into(),
                "gemini_rules".into(),
                "opencode_config".into(),
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
        }
    }
}

#[derive(Clone, Copy)]
pub enum ConfigScriptMode {
    Diff,
    Apply,
}

pub fn config_sync_targets() -> Vec<ConfigSyncTarget> {
    vec![ConfigSyncTarget {
        id: "opencode_config",
        label: "opencode config",
        source_rel: "templates/opencode.json",
        target_rel: ".config/opencode/opencode.json",
        script: ConfigScript::OpenCode,
    }]
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
}
