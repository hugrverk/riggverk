use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::setup_lifecycle::SetupSurfaceId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessId {
    Codex,
    OpenCode,
    Claude,
    Cursor,
    /// The light tier (`light_harness`): GitHub Copilot, Pi and Kilo Code.
    Copilot,
    Pi,
    Kilo,
}

impl HarnessId {
    pub const ALL: &'static [HarnessId] = &[
        HarnessId::Codex,
        HarnessId::OpenCode,
        HarnessId::Claude,
        HarnessId::Cursor,
        HarnessId::Copilot,
        HarnessId::Pi,
        HarnessId::Kilo,
    ];

    /// The harnesses enabled on a fresh install, and for a settings file that names none. The
    /// light tier is opt-in.
    pub const DEFAULT_ON: &'static [HarnessId] = &[
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
            HarnessId::Copilot => "copilot",
            HarnessId::Pi => "pi",
            HarnessId::Kilo => "kilo",
        }
    }

    /// Whether the harness is in the light tier: skills reach and runtime health, described by
    /// `metadata/light-harnesses.json`.
    pub fn is_light(self) -> bool {
        matches!(self, HarnessId::Copilot | HarnessId::Pi | HarnessId::Kilo)
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
    /// The managed entry of an MCP file (the light tier).
    #[serde(rename = "mcp")]
    Mcp,
}

pub struct AgentSyncTarget {
    pub id: &'static str,
    pub label: &'static str,
    pub harness: HarnessId,
    pub kind: TargetKind,
    pub target_rel: &'static str,
    pub source_rel: &'static str,
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
    let mut all = vec![
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
    ];
    // The light tier's rows come from the descriptor, in its order: per harness the rules file,
    // then the MCP entry.
    for harness in crate::light_harness::light_harnesses() {
        all.push(AgentSyncTarget {
            id: &harness.rules.target_id,
            label: &harness.rules.target_label,
            harness: harness.id,
            kind: TargetKind::Rules,
            target_rel: &harness.rules.target_rel,
            source_rel: &harness.rules.source_rel,
        });
        all.push(AgentSyncTarget {
            id: &harness.mcp.target_id,
            label: &harness.mcp.target_label,
            harness: harness.id,
            kind: TargetKind::Mcp,
            target_rel: &harness.mcp.target_rel,
            source_rel: &harness.mcp.template_rel,
        });
    }
    all
}

impl AgentSyncTarget {
    /// The target's path for labels: `target_rel` (below the home folder), except that an
    /// OpenCode path is `$XDG_CONFIG_HOME/opencode/...` while that variable moves OpenCode's config
    /// folder (`platform_paths::opencode_config_dir`).
    pub fn display_rel(&self, home: Option<&Path>) -> String {
        let moved = home.is_some_and(crate::platform_paths::opencode_config_moved);
        match self.target_rel.strip_prefix(".config/opencode") {
            Some(rest) if moved && self.harness == HarnessId::OpenCode => {
                format!("$XDG_CONFIG_HOME/opencode{rest}")
            }
            _ => self.target_rel.to_string(),
        }
    }
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

/// Targets that stay OFF until the user opts in. `codex_config` rewrites the
/// user's approval and sandbox posture in `~/.codex/config.toml`. A light harness target is off
/// when its descriptor says so.
const DEFAULT_DISABLED_TARGET_IDS: &[&str] = &["codex_config"];

fn default_disabled(target_id: &str) -> bool {
    DEFAULT_DISABLED_TARGET_IDS.contains(&target_id)
        || crate::light_harness::rules_for_target(target_id)
            .is_some_and(|harness| !harness.rules.default_enabled)
        || crate::light_harness::mcp_for_target(target_id)
            .is_some_and(|harness| !harness.mcp.default_enabled)
}

pub fn default_enabled_ids() -> Vec<String> {
    targets()
        .iter()
        .map(|target| target.id)
        .filter(|id| !default_disabled(id))
        .map(str::to_string)
        .collect()
}

/// Setup surfaces gated by a target toggle. Skills surfaces and the workspace
/// bundle are not target-gated.
pub fn target_surfaces(target_id: &str) -> &'static [SetupSurfaceId] {
    match target_id {
        "codex_rules" => &[SetupSurfaceId::CodexRules],
        "codex_agents" => &[SetupSurfaceId::CodexAgents],
        "codex_config" => &[SetupSurfaceId::CodexConfig],
        "opencode_rules" => &[SetupSurfaceId::OpenCodeRules],
        "opencode_agents" => &[SetupSurfaceId::OpenCodeAgents],
        "opencode_config" => &[SetupSurfaceId::OpenCodeConfig],
        "claude_rules" => &[SetupSurfaceId::ClaudeRules],
        "claude_agents" => &[SetupSurfaceId::ClaudeAgents],
        "cursor_setup" => &[SetupSurfaceId::CursorAgents, SetupSurfaceId::CursorMcp],
        other => crate::light_harness::rules_for_target(other)
            .map(|harness| std::slice::from_ref(&harness.rules.surface))
            .or_else(|| {
                crate::light_harness::mcp_for_target(other)
                    .map(|harness| std::slice::from_ref(&harness.mcp.surface))
            })
            .unwrap_or(&[]),
    }
}

/// The target whose toggle gates `surface`, or `None` for ungated surfaces.
pub fn surface_target_id(surface: SetupSurfaceId) -> Option<&'static str> {
    targets()
        .iter()
        .map(|target| target.id)
        .find(|id| target_surfaces(id).contains(&surface))
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
    HarnessId::DEFAULT_ON.to_vec()
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

#[derive(Serialize, Clone)]
pub struct ConfigEditorSourceMeta {
    pub id: String,
    pub label: String,
    pub rel_path: String,
    pub helper: String,
}

#[derive(Clone)]
pub struct ConfigEditorSource {
    pub id: &'static str,
    pub label: &'static str,
    pub rel_path: &'static str,
    pub helper: &'static str,
}

static OPENCODE_CONFIG_EDITOR_SOURCES: &[ConfigEditorSource] = &[
    ConfigEditorSource {
        id: "base",
        label: "Base",
        rel_path: "templates/opencode.base.json",
        helper: "Model, provider, watcher, compaction.",
    },
    ConfigEditorSource {
        id: "policy",
        label: "Policy",
        rel_path: "templates/opencode.policy.json",
        helper: "Read, edit, bash, and secret-file permission source.",
    },
    ConfigEditorSource {
        id: "snapshot",
        label: "Snapshot",
        rel_path: "templates/opencode.json",
        helper: "Generated runtime config, composed from Base and Policy.",
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
    fn default_enabled_ids_cover_every_target_except_codex_config_and_kilo_mcp() {
        let mut expected: Vec<String> = targets()
            .iter()
            .map(|t| t.id.to_string())
            .filter(|id| id != "codex_config" && id != "kilo_mcp")
            .collect();
        let mut actual = default_enabled_ids();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected);
        for id in [
            "codex_rules",
            "codex_agents",
            "opencode_rules",
            "opencode_agents",
            "opencode_config",
            "claude_rules",
            "claude_agents",
            "cursor_setup",
            "copilot_mcp",
            "pi_mcp",
        ] {
            assert!(actual.contains(&id.to_string()), "{id} must default ON");
        }
        assert!(
            !actual.contains(&"kilo_mcp".to_string()),
            "Kilo's config file is credentials-adjacent: its MCP entry is opt-in"
        );
    }

    #[test]
    fn every_target_gates_surfaces_of_its_own_harness() {
        for target in targets() {
            let surfaces = target_surfaces(target.id);
            assert!(!surfaces.is_empty(), "{} gates no surface", target.id);
            for surface in surfaces {
                assert_eq!(
                    surface.harness(),
                    Some(target.harness),
                    "{} gates a surface of another harness: {surface:?}",
                    target.id
                );
                assert_eq!(surface_target_id(*surface), Some(target.id));
            }
        }
        assert!(target_surfaces("unknown_target").is_empty());
    }

    #[test]
    fn skills_and_workspace_surfaces_are_not_target_gated() {
        for surface in [
            SetupSurfaceId::Skills,
            SetupSurfaceId::ClaudeSkills,
            SetupSurfaceId::OpenCodeSkills,
            SetupSurfaceId::CodexSkills,
            SetupSurfaceId::CursorSkills,
            SetupSurfaceId::WorkspaceBundle,
        ] {
            assert_eq!(surface_target_id(surface), None, "{surface:?}");
        }
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
    fn opencode_config_target_syncs_generated_opencode_json() {
        let targets = config_targets();
        let opencode = targets
            .iter()
            .find(|t| t.id == "opencode_config")
            .expect("opencode_config must be a config target");
        assert_eq!(opencode.source_rel, "templates/opencode.json");
        assert_eq!(opencode.target_rel, ".config/opencode/opencode.json");
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
            "copilot_rules",
            "copilot_mcp",
            "pi_rules",
            "pi_mcp",
            "kilo_rules",
            "kilo_mcp",
        ]
        .into_iter()
        .collect();
        assert_eq!(ids, expected, "targets() must contain exactly 15 known IDs");
    }

    #[test]
    fn the_light_targets_come_from_the_descriptor_after_the_central_ones() {
        let all = targets();
        let ids: Vec<&str> = all.iter().map(|t| t.id).collect();
        assert_eq!(
            &ids[ids.len() - 6..],
            [
                "copilot_rules",
                "copilot_mcp",
                "pi_rules",
                "pi_mcp",
                "kilo_rules",
                "kilo_mcp"
            ],
            "descriptor order, per harness the rules file and then the MCP entry, after cursor_setup"
        );
        assert_eq!(ids[ids.len() - 7], "cursor_setup");
        let pi = all.iter().find(|t| t.id == "pi_rules").expect("pi_rules");
        assert_eq!(pi.harness, HarnessId::Pi);
        assert!(matches!(pi.kind, TargetKind::Rules));
        assert_eq!(pi.label, "pi rules");
        assert_eq!(pi.target_rel, ".pi/agent/AGENTS.md");
        assert_eq!(pi.source_rel, "templates/sync/pi-rules.md");
        assert_eq!(target_surfaces("kilo_rules"), [SetupSurfaceId::KiloRules]);
        assert_eq!(
            surface_target_id(SetupSurfaceId::CopilotRules),
            Some("copilot_rules")
        );
        assert_eq!(target_harness("copilot_rules"), Some(HarnessId::Copilot));
        let rules: Vec<&str> = rule_targets().iter().map(|t| t.id).collect();
        assert_eq!(
            rules.len(),
            6,
            "the three central and the three light rules targets"
        );
        for id in [
            "copilot_rules",
            "pi_rules",
            "kilo_rules",
            "copilot_mcp",
            "pi_mcp",
        ] {
            assert!(
                default_enabled_ids().contains(&id.to_string()),
                "{id} defaults ON"
            );
        }
        assert!(!default_enabled_ids().contains(&"kilo_mcp".to_string()));
        let kilo_mcp = all.iter().find(|t| t.id == "kilo_mcp").expect("kilo_mcp");
        assert_eq!(kilo_mcp.harness, HarnessId::Kilo);
        assert!(matches!(kilo_mcp.kind, TargetKind::Mcp));
        assert_eq!(kilo_mcp.target_rel, ".config/kilo/kilo.jsonc");
        assert_eq!(kilo_mcp.source_rel, "templates/mcp/kilo.playwright.json");
        assert_eq!(target_surfaces("kilo_mcp"), [SetupSurfaceId::KiloMcp]);
        assert_eq!(surface_target_id(SetupSurfaceId::PiMcp), Some("pi_mcp"));
        assert_eq!(target_harness("copilot_mcp"), Some(HarnessId::Copilot));
        assert_eq!(
            serde_json::to_value(TargetKind::Mcp).unwrap(),
            serde_json::json!("mcp")
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
        assert_eq!(base.rel_path, "templates/opencode.base.json");

        let policy = opencode_config_editor_source_by_id("policy").expect("policy source");
        assert_eq!(policy.rel_path, "templates/opencode.policy.json");

        let snapshot = opencode_config_editor_source_by_id("snapshot").expect("snapshot source");
        assert_eq!(snapshot.rel_path, "templates/opencode.json");
        assert!(opencode_config_editor_source_by_id("unknown").is_none());
    }

    #[test]
    fn opencode_config_editor_source_meta_serializable() {
        let meta = opencode_config_editor_source_meta_list();
        assert_eq!(meta.len(), 3);
        let snapshot = meta.iter().find(|m| m.id == "snapshot").unwrap();
        assert_eq!(snapshot.rel_path, "templates/opencode.json");
    }

    #[test]
    fn harness_ids_have_stable_wire_names_in_canonical_order() {
        let names: Vec<&str> = HarnessId::ALL.iter().map(|id| id.as_str()).collect();
        assert_eq!(
            names,
            ["codex", "opencode", "claude", "cursor", "copilot", "pi", "kilo"]
        );
        for id in HarnessId::ALL {
            assert_eq!(
                serde_json::to_string(id).unwrap(),
                format!("\"{}\"", id.as_str())
            );
        }
    }

    #[test]
    fn the_light_tier_is_opt_in_and_the_four_central_harnesses_stay_on() {
        assert_eq!(
            default_enabled_harness_ids(),
            vec![
                HarnessId::Codex,
                HarnessId::OpenCode,
                HarnessId::Claude,
                HarnessId::Cursor
            ]
        );
        for id in HarnessId::ALL {
            assert_eq!(
                id.is_light(),
                !HarnessId::DEFAULT_ON.contains(id),
                "{}",
                id.as_str()
            );
        }
    }

    #[test]
    fn enabled_harnesses_normalize_to_canonical_order_with_the_light_tier_last() {
        let raw = [
            HarnessId::Kilo,
            HarnessId::Claude,
            HarnessId::Pi,
            HarnessId::Claude,
            HarnessId::Codex,
        ];
        assert_eq!(
            normalize_enabled_harness_ids(&raw),
            vec![
                HarnessId::Codex,
                HarnessId::Claude,
                HarnessId::Pi,
                HarnessId::Kilo
            ]
        );
    }
}
